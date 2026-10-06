// v2: trigger as MULTI-LABEL Nouls (not one Choice), and the agreement penalty gated on request confidence.
// Arm B  = structured record -> one relevance Noul per candidate        (the result that replicated)
// Arm D  = B + typed request/note facet agreement, combined in CODE
// Same candidates, same gold labels, same model. Only the declared intervention differs.
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { rank } from '/Users/yoavshmariahu/src/thinker/src/rank.js';
const SRC='/Users/yoavshmariahu/src/thinker', KEY=process.env.JEVKEY, byId=new Map();
for (const d of [`${SRC}/.thinker/notes`,`${SRC}/.thinker/local/notes`]) { if(!existsSync(d))continue;
  for (const f of readdirSync(d).filter(x=>x.endsWith('.json'))) { try{const n=JSON.parse(readFileSync(`${d}/${f}`,'utf8'));byId.set(n.id,n);}catch{} } }
const NOTES=[...byId.values()];
const QUERIES=JSON.parse(readFileSync('exp/queries-gold.json','utf8'));
const rec = n => ({kind:n.kind,title:n.title,answers_the_questions:(n.answers||[]).slice(0,5),
  claim:(n.body||'').split('\n').filter(Boolean).slice(0,6).join(' ').slice(0,900),
  code_it_points_at:(n.deps||[]).map(d=>d.symbol?`${d.path}:${d.symbol}`:d.path).slice(0,6),
  freshness:n.status==='stale'?'stale':'fresh'});
const TRIGGER={locating_code:'Finding where something is implemented or handled.',
  running_or_building:'Running, building, testing or deploying something.',
  changing_safely:'About to change code, needing to know what constrains the change.',
  reviewing_a_change:'Checking a change that was already made.',
  wiring_or_installing:'Installing or configuring the tool or an agent integration.',
  interpreting_output:'Understanding output, a log, a metric or a report.'};
const REL={true:'The note states something the developer must know or do to carry out this specific request: where to make the change, a rule the change must respect, or the command to run.',
  false:'The note is about a neighbouring topic. It may share words with the request but does not bear on carrying it out.'};
const post=b=>fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{authorization:`Bearer ${KEY}`,'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());

// gather candidates once; identical for both arms
const work=QUERIES.map(q=>({q, cands:rank(NOTES,{query:q.query,mode:'orient'}).slice(0,8).map(r=>({note:r.note,rel:r.rel}))})).filter(w=>w.cands.length);
const allNotes=[...new Set(work.flatMap(w=>w.cands.map(c=>c.note.id)))].map(id=>byId.get(id));

// ---- PRECOMPUTED, STORED ONCE PER NOTE (not a per-prompt cost) ----
const nq={}; allNotes.forEach((n,i)=>{
  for(const [k,desc] of Object.entries(TRIGGER)) nq[`t_${k}_${i}`]={type:'noul',
    instructions:`Would \`candidate_notes[${i}]\` help a developer whose task is this: ${desc}`,
    criteria:{true:'It bears on that kind of task.',false:'It does not bear on that kind of task.'}};
  nq[`inert${i}`]={type:'noul',instructions:`Is \`candidate_notes[${i}]\` purely background -- nothing a developer would do differently because of it?`,
    criteria:{true:'Changes no action; context only.',false:'Changes what the developer does.'}};
});
let t0=Date.now();
const nj=await post({model:'jev-latest',state:{candidate_notes:allNotes.map((n,i)=>({index:i,...rec(n)}))},questions:nq});
if(!nj.answers){console.log('note-typing failed',JSON.stringify(nj).slice(0,400));process.exit(1);}
const facet=new Map(allNotes.map((n,i)=>[n.id,{labels:Object.fromEntries(Object.keys(TRIGGER).map(k=>[k,nj.answers[`t_${k}_${i}`].noul])),inert:nj.answers[`inert${i}`].noul}]));
console.log(`NOTE TYPING (amortised, stored on the note): ${allNotes.length} notes, ${Date.now()-t0}ms, ${nj.usage.input_tokens} tok, $${((nj.usage.input_tokens/1e9)*42).toFixed(6)}`);
console.log(`  = $${(((nj.usage.input_tokens/1e9)*42)/allNotes.length).toFixed(7)}/note, paid once at creation\n`);

const res=[];
for (const {q,cands} of work){
  const gold=new Set(q.gold||[]);
  // --- one call per prompt: type the request + score every candidate ---
  const qs={request_trigger:{type:'choice',instructions:'Which kind of task is `developer_request`?',criteria:TRIGGER}};
  cands.forEach((c,i)=>{qs[`rel${i}`]={type:'noul',
    instructions:{request:q.query,question:`Would the note at \`candidate_notes[${i}]\` help a developer carry out \`request\`? Weigh its \`claim\` and \`answers_the_questions\`; \`code_it_points_at\` tells you which code it governs.`},
    criteria:REL};});
  t0=Date.now();
  const j=await post({model:'jev-latest',state:{developer_request:q.query,candidate_notes:cands.map((c,i)=>({index:i,...rec(c.note)}))},questions:qs});
  const ms=Date.now()-t0;
  if(!j.answers){console.log('fail',JSON.stringify(j).slice(0,300));continue;}
  const rt=j.answers.request_trigger;
  const GATE=0.6;                       // only trust the request typing when Jev is confident about it
  const rows=cands.map((c,i)=>{const f=facet.get(c.note.id);
    const fit=f.labels[rt.choice] ?? 0;  // multi-label: how well does the note serve THIS task shape
    const rel=j.answers[`rel${i}`].noul;
    const trust=rt.confidence>=GATE;
    const d=rel*(trust?(fit>=0.5?1:0.6):1)*(f.inert>0.5?0.5:1);
    return {id:c.note.id,title:c.note.title,rel,d,agree:!trust?null:fit>=0.5,fit,trigger:Object.entries(f.labels).filter(([,v])=>v>=0.5).map(([k])=>k).join('+')||'none',inert:f.inert};});
  const score=(arm,th=0.5)=>{const s=rows.filter(r=>r[arm]>=th);
    return {served:s.length,hit:s.filter(r=>gold.has(r.id)).length,fp:s.filter(r=>!gold.has(r.id)).length};};
  const B=score('rel'), D=score('d');
  res.push({q:q.query,gold:gold.size,B,D,ms,tok:j.usage.input_tokens});
  console.log(`### ${q.query}`);
  console.log(`    request typed: ${rt.choice}@${rt.confidence.toFixed(2)}   ${ms}ms  ${j.usage.input_tokens}tok`);
  console.log(`    B relevance-only : served ${B.served}  hit ${B.hit}/${gold.size}  fp ${B.fp}`);
  console.log(`    D +facet-agree   : served ${D.served}  hit ${D.hit}/${gold.size}  fp ${D.fp}`);
  for(const r of [...rows].sort((a,b)=>b.d-a.d)) console.log(
    `      ${gold.has(r.id)?'GOLD':'    '} rel ${r.rel.toFixed(2)} -> D ${r.d.toFixed(2)} fit ${r.fit.toFixed(2)} ${r.agree===null?'UNGATED':r.agree?'agree  ':'MISMATCH'} ${r.trigger.slice(0,30).padEnd(30)} ${r.title.slice(0,36)}`);
  console.log('');
}
writeFileSync('exp/typed-serving-v2-results.json',JSON.stringify(res,null,2));
const sum=a=>({served:res.reduce((s,x)=>s+x[a].served,0),hit:res.reduce((s,x)=>s+x[a].hit,0),fp:res.reduce((s,x)=>s+x[a].fp,0)});
const g=res.reduce((s,x)=>s+x.gold,0), tok=res.reduce((s,x)=>s+x.tok,0);
for(const a of ['B','D']){const s=sum(a);
  console.log(`arm ${a}: recall ${s.hit}/${g}  false-pos ${s.fp}  served ${s.served}  precision ${s.served?(s.hit/s.served).toFixed(2):'n/a'}`);}
console.log(`\nper-prompt: median ${res.map(r=>r.ms).sort((a,b)=>a-b)[Math.floor(res.length/2)]}ms, ${Math.round(tok/res.length)} tok, $${(((tok/res.length)/1e9)*42).toFixed(7)}/prompt`);
