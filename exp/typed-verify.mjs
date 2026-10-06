// The answer to "what does invalid mean": don't ask the model for a verdict at all.
// 1. Jev TYPES the note: which single surface would falsify it.  2. Code runs ONLY that check.  3. Verdict is DERIVED.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
const SRC='/Users/yoavshmariahu/src/thinker', KEY=process.env.JEVKEY;
const sh=c=>{try{return execSync(c,{cwd:SRC,maxBuffer:32*1024*1024,stdio:['ignore','pipe','ignore']}).toString();}catch{return '';}};
const byId=new Map();
for (const d of [`${SRC}/.thinker/notes`,`${SRC}/.thinker/local/notes`]) { if(!existsSync(d))continue;
  for (const f of readdirSync(d).filter(x=>x.endsWith('.json'))) { try{const n=JSON.parse(readFileSync(`${d}/${f}`,'utf8'));byId.set(n.id,n);}catch{} } }
const stale=[...byId.values()].filter(n=>n.status==='stale'&&n.verifiedCommit&&(n.deps||[]).length&&!n.archived).slice(0,20);
const rec = n => ({kind:n.kind,title:n.title,answers_the_questions:(n.answers||[]).slice(0,4),
  claim:(n.body||'').split('\n').filter(Boolean).slice(0,8).join(' ').slice(0,1000),
  code_it_points_at:(n.deps||[]).map(d=>d.symbol?`${d.path}:${d.symbol}`:d.path).slice(0,6)});
const DRIFT={a_symbol_moving:'A named function, constant or class it depends on is renamed, moved or removed.',
  a_number_changing:'A threshold, default, limit or version number it states is changed.',
  a_path_changing:'A file or directory path it names is moved or renamed.',
  a_flag_or_env_var_changing:'A command-line flag or environment variable name it states is renamed or dropped.',
  an_external_tool_changing:'A tool or service outside this repository changes its behaviour.'};

// ---------- STEP 1: type the notes (one batched call) ----------
const qs={};
stale.forEach((n,i)=>{
  qs[`drift${i}`]={type:'choice',instructions:`Which ONE change is the most likely way \`candidate_notes[${i}]\` becomes wrong? Name the most specific surface, not the broadest.`,criteria:DRIFT};
  qs[`subject_is_mechanism${i}`]={type:'noul',
    instructions:`Is the SUBJECT of \`candidate_notes[${i}]\` a mechanism in this codebase, such that deleting that mechanism would make the whole note pointless rather than merely inaccurate?`,
    criteria:{true:'The note exists only to describe a mechanism in this repository.',false:'The note would still mean something if that mechanism were gone.'}};
});
const t0=Date.now();
const res=await fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{authorization:`Bearer ${KEY}`,'content-type':'application/json'},
  body:JSON.stringify({model:'jev-latest',state:{candidate_notes:stale.map((n,i)=>({index:i,...rec(n)}))},questions:qs})});
const j=await res.json(); const typeMs=Date.now()-t0;
if(!j.answers){console.log('HTTP',res.status,JSON.stringify(j).slice(0,600));process.exit(1);}
console.log(`TYPING: ${stale.length} notes x 2 facets in ONE call, ${typeMs}ms, ${j.usage.input_tokens} tok, $${((j.usage.input_tokens/1e9)*42).toFixed(6)}\n`);

// ---------- STEP 2+3: code runs only the named check, and derives the verdict ----------
const NUM=/(?<![\w.])(\d+\.\d+|\d{1,6})(?![\w.])/g;
function currentDepText(n){
  let t='';
  for (const p of [...new Set((n.deps||[]).map(d=>d.path))].slice(0,6))
    if (existsSync(`${SRC}/${p}`)) t += readFileSync(`${SRC}/${p}`,'utf8');
  return t;
}
function check(n, drift){
  const body=n.body||'', deps=n.deps||[];
  if (drift==='an_external_tool_changing') return {verdict:'unverifiable', why:'describes behaviour outside this repository; no code hash can falsify it'};
  if (drift==='a_path_changing'){
    const missing=[...new Set(deps.map(d=>d.path))].filter(p=>!existsSync(`${SRC}/${p}`));
    return missing.length ? {verdict:'update', why:`path(s) gone: ${missing.join(', ')}`} : {verdict:'still_valid', why:'every path it names still exists'};
  }
  if (drift==='a_symbol_moving'){
    const syms=[...new Set(deps.filter(d=>d.symbol).map(d=>d.symbol))];
    if(!syms.length) return {verdict:'still_valid', why:'names no symbol to lose'};
    const gone=syms.filter(s=>!sh(`git grep -l -F -- ${JSON.stringify(s)} -- src test bench action scripts 2>/dev/null`).trim());
    return gone.length ? {verdict:'invalid', why:`symbol(s) absent from the repo: ${gone.join(', ')}`}
                       : {verdict:'still_valid', why:`all ${syms.length} symbol(s) still present`};
  }
  if (drift==='a_number_changing'){
    const code=currentDepText(n);
    const nums=[...new Set([...body.matchAll(NUM)].map(m=>m[1]))].filter(x=>x.length>1&&Number(x)!==0&&Number(x)!==1);
    if(!nums.length) return {verdict:'still_valid', why:'states no checkable number'};
    const absent=nums.filter(x=>!code.includes(x));
    return absent.length ? {verdict:'update', why:`number(s) no longer in the code it rests on: ${absent.slice(0,4).join(', ')}`}
                         : {verdict:'still_valid', why:`all ${nums.length} number(s) still appear in the code`};
  }
  if (drift==='a_flag_or_env_var_changing'){
    const names=[...new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)].map(m=>m[1]).concat([...body.matchAll(/(--[a-z][a-z0-9-]{2,})/g)].map(m=>m[1])))];
    if(!names.length) return {verdict:'still_valid', why:'names no flag or env var'};
    const gone=names.filter(x=>!sh(`git grep -l -F -- ${JSON.stringify(x)} -- src test bench action scripts install.sh package.json 2>/dev/null`).trim());
    return gone.length ? {verdict:'update', why:`flag/env no longer in the repo: ${gone.slice(0,4).join(', ')}`}
                       : {verdict:'still_valid', why:`all ${names.length} flag(s)/var(s) still referenced`};
  }
  return {verdict:'unknown', why:'no check for this drift surface'};
}

const out=[];
for (const [i,n] of stale.entries()){
  const drift=j.answers[`drift${i}`], mech=j.answers[`subject_is_mechanism${i}`].noul;
  let r=check(n, drift.choice);
  // promote update -> invalid when the note exists only to describe a mechanism that is gone
  if (r.verdict==='update' && mech>0.7 && /gone|absent/.test(r.why)) r={verdict:'invalid', why:r.why+' and the note exists only to describe it'};
  out.push({title:n.title, drift:drift.choice, dc:drift.confidence, mech, ...r});
}
writeFileSync('exp/typed-verify-results.json',JSON.stringify(out,null,2));
console.log('verdict       drift surface               conf mech  why');
for(const r of out) console.log(`${r.verdict.padEnd(13)} ${r.drift.padEnd(27)} ${r.dc.toFixed(2)} ${r.mech.toFixed(2)}  ${r.why.slice(0,76)}`);
const d={}; for(const r of out) d[r.verdict]=(d[r.verdict]||0)+1;
console.log(`\nn=${out.length}  ${JSON.stringify(d)}`);
console.log(`  model-asked-for-a-verdict run earlier: {"still_valid":3,"update":16,"invalid":1}`);
console.log(`  AGENTS.md incumbent Haiku:             64% still_valid`);
const ds={}; for(const r of out) ds[r.drift]=(ds[r.drift]||0)+1;
console.log(`\ndrift surfaces: ${JSON.stringify(ds)}`);
console.log(`unverifiable from code (wasted verify spend today): ${out.filter(r=>r.verdict==='unverifiable').length}/${out.length}`);
console.log(`model calls needed for a body rewrite (verdict=update only): ${out.filter(r=>r.verdict==='update').length}/${out.length}`);
