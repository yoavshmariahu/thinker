// Persist facets onto notes, versioned by facetKey -- the same pattern phraseNotes uses for `search`/`says`.
// Writes ONLY into the isolated copy under bench/jev-eval/typed-noteset/. The live cache is never opened for writing.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const DIR='bench/jev-eval/typed-noteset', KEY=process.env.JEVKEY;
const FACET_KEY='jev-facets-v2';   // bump this and every note is retyped

const TRIGGER={locating_code:'Finding where something is implemented or handled.',
  running_or_building:'Running, building, testing or deploying something.',
  changing_safely:'About to change code, needing to know what constrains the change.',
  reviewing_a_change:'Checking a change that was already made.',
  wiring_or_installing:'Installing or configuring the tool or an agent integration.',
  interpreting_output:'Understanding output, a log, a metric or a report.'};
const DRIFT={a_symbol_moving:'A named function, constant or class it depends on is renamed, moved or removed.',
  a_number_changing:'A threshold, default, limit or version number it states is changed.',
  a_path_changing:'A file or directory path it names is moved or renamed.',
  a_flag_or_env_var_changing:'A command-line flag or environment variable name it states is renamed or dropped.',
  an_external_tool_changing:'A tool or service outside this repository changes its behaviour.'};

const rec = n => ({kind:n.kind,title:n.title,answers_the_questions:(n.answers||[]).slice(0,4),
  claim:(n.body||'').split('\n').filter(Boolean).slice(0,8).join(' ').slice(0,900),
  code_it_points_at:(n.deps||[]).map(d=>d.symbol?`${d.path}:${d.symbol}`:d.path).slice(0,6)});

const files=readdirSync(DIR).filter(f=>f.endsWith('.json'));
const todo=[];
for (const f of files){ const n=JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'));
  if (n.facetKey===FACET_KEY) continue;                 // already typed at this schema version
  todo.push({f,n}); }
console.log(`${files.length} notes in the isolated store, ${todo.length} to type at ${FACET_KEY}\n`);

function build(batch){ const qs={};
  batch.forEach(({n},i)=>{
    for (const [k,desc] of Object.entries(TRIGGER)) qs[`t_${k}_${i}`]={type:'noul',
      instructions:`Would \`candidate_notes[${i}]\` help a developer whose task is this: ${desc}`,
      criteria:{true:'It bears on that kind of task.',false:'It does not bear on that kind of task.'}};
    qs[`inert${i}`]={type:'noul',instructions:`Is \`candidate_notes[${i}]\` purely background -- nothing a developer would do differently because of it?`,
      criteria:{true:'Changes no action; context only.',false:'Changes what the developer does.'}};
    qs[`machine${i}`]={type:'noul',instructions:`Is \`candidate_notes[${i}]\` about the state of one particular machine or account rather than about the codebase?`,
      criteria:{true:'Describes one machine, one install, or one account.',false:'Describes the codebase or a tool\'s general behaviour.'}};
    qs[`drift${i}`]={type:'choice',instructions:`Which ONE change is the most likely way \`candidate_notes[${i}]\` becomes wrong? Name the most specific surface, not the broadest.`,criteria:DRIFT};
    qs[`blast${i}`]={type:'score',instructions:`If a developer ignored \`candidate_notes[${i}]\`, how bad would the consequence be?`,
      criteria:['No consequence; a slower route at worst.','Wasted time: they rediscover it or backtrack.',
        'A broken build, failed test or wrong output, caught before shipping.',
        'Damage reaching users, data or another person: a bad deploy, lost work, a silent wrong result.']};
  });
  return {model:'jev-latest',state:{candidate_notes:batch.map(({n},i)=>({index:i,...rec(n)}))},questions:qs};
}
const post=b=>fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{authorization:`Bearer ${KEY}`,'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());

const SIZE=12, CONC=4; let tok=0, typed=0, failed=0; const lat=[];
const batches=[]; for(let i=0;i<todo.length;i+=SIZE) batches.push(todo.slice(i,i+SIZE));
for (let i=0;i<batches.length;i+=CONC){
  const group=batches.slice(i,i+CONC);
  const out=await Promise.all(group.map(async b=>{const t0=Date.now(); try{ return {b,j:await post(build(b)),ms:Date.now()-t0}; }catch(e){ return {b,err:String(e)}; }}));
  for (const {b,j,ms,err} of out){
    if (err||!j?.answers){ failed+=b.length; continue; }
    tok+=j.usage.input_tokens; lat.push(ms);
    b.forEach(({f,n},k)=>{
      n.facets={
        trigger:Object.fromEntries(Object.keys(TRIGGER).map(x=>[x,+j.answers[`t_${x}_${k}`].noul.toFixed(3)])),
        inert:+j.answers[`inert${k}`].noul.toFixed(3),
        machine:+j.answers[`machine${k}`].noul.toFixed(3),
        drift:j.answers[`drift${k}`].choice, driftConfidence:+j.answers[`drift${k}`].confidence.toFixed(3),
        blast:+j.answers[`blast${k}`].score.toFixed(3),
      };
      n.facetKey=FACET_KEY; n.facetedAt=new Date().toISOString();
      writeFileSync(`${DIR}/${f}`, JSON.stringify(n,null,2)); typed++; });
  }
  process.stdout.write(`\r  typed ${typed}/${todo.length}${failed?`  (${failed} failed)`:''}`);
}
console.log(`\n\n${typed} notes typed, ${failed} failed`);
console.log(`${tok} input tok  $${((tok/1e9)*42).toFixed(5)}  = $${(((tok/1e9)*42)/Math.max(typed,1)).toFixed(7)}/note`);
console.log(`median call ${lat.sort((a,b)=>a-b)[Math.floor(lat.length/2)]}ms over ${lat.length} calls`);
const all=readdirSync(DIR).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(`${DIR}/${f}`,'utf8'))).filter(n=>n.facets);
const dc={}; for(const n of all) dc[n.facets.drift]=(dc[n.facets.drift]||0)+1;
console.log(`\ndrift surfaces across ${all.length} typed notes: ${JSON.stringify(dc)}`);
console.log(`  unverifiable from code (an_external_tool_changing): ${dc.an_external_tool_changing||0}`);
console.log(`inert > 0.5 (background only, should not be served):  ${all.filter(n=>n.facets.inert>0.5).length}`);
console.log(`machine > 0.5 (one machine's state, not the codebase): ${all.filter(n=>n.facets.machine>0.5).length}`);
const lbl={}; for(const n of all) for(const [k,v] of Object.entries(n.facets.trigger)) if(v>=0.5) lbl[k]=(lbl[k]||0)+1;
console.log(`trigger labels at >=0.5: ${JSON.stringify(lbl)}`);
console.log(`mean labels per note: ${(Object.values(lbl).reduce((a,b)=>a+b,0)/all.length).toFixed(2)} of 6`);
