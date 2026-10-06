// Serving that reads facets FROM DISK. Per-prompt cost is now only: type the request + score candidates.
import { readFileSync, readdirSync } from 'node:fs';
import { rank } from '/Users/yoavshmariahu/src/thinker/src/rank.js';
const DIR='exp/typed-noteset', KEY=process.env.JEVKEY;
const NOTES=readdirSync(DIR).filter(f=>f.endsWith('.json')).map(f=>JSON.parse(readFileSync(`${DIR}/${f}`,'utf8')));
const byId=new Map(NOTES.map(n=>[n.id,n]));
const TRIGGER={locating_code:'Finding where something is implemented or handled.',
  running_or_building:'Running, building, testing or deploying something.',
  changing_safely:'About to change code, needing to know what constrains the change.',
  reviewing_a_change:'Checking a change that was already made.',
  wiring_or_installing:'Installing or configuring the tool or an agent integration.',
  interpreting_output:'Understanding output, a log, a metric or a report.'};
const REL={true:'The note states something the developer must know or do to carry out this specific request: where to make the change, a rule the change must respect, or the command to run.',
  false:'The note is about a neighbouring topic. It may share words with the request but does not bear on carrying it out.'};
const rec = n => ({kind:n.kind,title:n.title,answers_the_questions:(n.answers||[]).slice(0,5),
  claim:(n.body||'').split('\n').filter(Boolean).slice(0,6).join(' ').slice(0,900),
  code_it_points_at:(n.deps||[]).map(d=>d.symbol?`${d.path}:${d.symbol}`:d.path).slice(0,6),
  freshness:n.status==='stale'?'stale':'fresh'});
const post=b=>fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{authorization:`Bearer ${KEY}`,'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const GATE=0.6;
const res=[]; let tok=0;
for (const q of JSON.parse(readFileSync('exp/queries-gold.json','utf8'))){
  const cands=rank(NOTES,{query:q.query,mode:'orient'}).slice(0,8).map(r=>r.note);
  if(!cands.length) continue;
  const gold=new Set(q.gold||[]);
  const qs={request_trigger:{type:'choice',instructions:'Which kind of task is `developer_request`?',criteria:TRIGGER}};
  cands.forEach((n,i)=>{qs[`rel${i}`]={type:'noul',
    instructions:{request:q.query,question:`Would the note at \`candidate_notes[${i}]\` help a developer carry out \`request\`? Weigh its \`claim\` and \`answers_the_questions\`; \`code_it_points_at\` tells you which code it governs.`},criteria:REL};});
  const t0=Date.now(); const j=await post({model:'jev-latest',state:{developer_request:q.query,candidate_notes:cands.map((n,i)=>({index:i,...rec(n)}))},questions:qs}); const ms=Date.now()-t0;
  if(!j.answers){console.log('fail',JSON.stringify(j).slice(0,200));continue;}
  tok+=j.usage.input_tokens;
  const rt=j.answers.request_trigger, trust=rt.confidence>=GATE;
  const rows=cands.map((n,i)=>{const F=n.facets||{};               // <-- READ FROM DISK, not computed
    const fit=F.trigger?.[rt.choice] ?? 1, rel=j.answers[`rel${i}`].noul;
    return {id:n.id,title:n.title,rel,fit,inert:F.inert??0,
      d:rel*(trust?(fit>=0.5?1:0.6):1)*((F.inert??0)>0.5?0.5:1)};});
  const sc=(k)=>{const s=rows.filter(r=>r[k]>=0.5);return{served:s.length,hit:s.filter(r=>gold.has(r.id)).length,fp:s.filter(r=>!gold.has(r.id)).length};};
  const B=sc('rel'), D=sc('d');
  res.push({B,D,gold:gold.size,ms,tok:j.usage.input_tokens});
  console.log(`### ${q.query}\n    request ${rt.choice}@${rt.confidence.toFixed(2)}${trust?'':' (UNGATED)'}  ${ms}ms  ${j.usage.input_tokens}tok   B: ${B.hit}/${gold.size} hit ${B.fp} fp   D: ${D.hit}/${gold.size} hit ${D.fp} fp`);
}
const sum=k=>({served:res.reduce((s,x)=>s+x[k].served,0),hit:res.reduce((s,x)=>s+x[k].hit,0),fp:res.reduce((s,x)=>s+x[k].fp,0)});
const g=res.reduce((s,x)=>s+x.gold,0);
console.log('');
for(const k of ['B','D']){const s=sum(k);console.log(`arm ${k}: recall ${s.hit}/${g}  false-pos ${s.fp}  served ${s.served}  precision ${s.served?(s.hit/s.served).toFixed(2):'n/a'}`);}
console.log(`per-prompt: median ${res.map(r=>r.ms).sort((a,b)=>a-b)[Math.floor(res.length/2)]}ms, $${(((tok/res.length)/1e9)*42).toFixed(7)}  (note typing already paid, on disk)`);

console.log(`\n=== FACET SANITY CHECK on the full store (no model calls) ===`);
console.log(`\ninert > 0.5 -- claimed pure background, should never be served:`);
NOTES.filter(n=>n.facets?.inert>0.5).sort((a,b)=>b.facets.inert-a.facets.inert).forEach(n=>console.log(`  ${n.facets.inert.toFixed(2)} [${n.kind}] ${n.title.slice(0,72)}`));
console.log(`\nmachine > 0.5 -- claimed one machine's state, which the distiller is told to rule out:`);
NOTES.filter(n=>n.facets?.machine>0.5).sort((a,b)=>b.facets.machine-a.facets.machine).forEach(n=>console.log(`  ${n.facets.machine.toFixed(2)} [${n.kind}] ${n.title.slice(0,72)}`));
console.log(`\nan_external_tool_changing -- unverifiable by dep hashing (first 12 of ${NOTES.filter(n=>n.facets?.drift==='an_external_tool_changing').length}):`);
NOTES.filter(n=>n.facets?.drift==='an_external_tool_changing').slice(0,12).forEach(n=>console.log(`  conf ${n.facets.driftConfidence.toFixed(2)} [${n.kind}/${n.status||'fresh'}] ${n.title.slice(0,66)}`));
