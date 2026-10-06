// hook-jev arm on 20 of the 54 labelled tasks. Judge: gpt-6-sol, via the EXISTING labels (no new judge pass).
// Arms share one candidate pool per task. Only the ranking/packing policy differs.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { rank } from '/Users/yoavshmariahu/src/thinker/src/rank.js';
const R='/Users/yoavshmariahu/src/thinker', LAB=`${R}/bench/runs/ranking-lab-2026-10-04`, KEY=process.env.JEVKEY;
const SETS=[ {lab:'grafana3',  tasks:'grafana-hard',  notes:'grafana-v3',           take:10},
             {lab:'mitmproxy', tasks:'mitmproxy-hard',notes:'mitmproxy-systematic', take:5},
             {lab:'posthog',   tasks:'posthog-hard',  notes:'posthog-v3',           take:5} ];
// strip the harness preamble: RESULTS.md says the hook is handed the bare request
const bare = p => { const ps=p.split(/\n\s*\n/).map(s=>s.trim()).filter(Boolean);
  return ps.filter(s=>!/^Implement the following change/i.test(s)).join('\n\n') || p; };
const rec = n => ({kind:n.kind,title:n.title,answers_the_questions:(n.answers||[]).slice(0,5),
  claim:(n.body||'').split('\n').filter(Boolean).slice(0,6).join(' ').slice(0,900),
  code_it_points_at:(n.deps||[]).map(d=>d.symbol?`${d.path}:${d.symbol}`:d.path).slice(0,6)});
const REL={true:'The note states something the developer must know or do to carry out this specific request: where to make the change, a rule the change must respect, or the command to run.',
  false:'The note is about a neighbouring topic. It may share words with the request but does not bear on carrying it out.'};
const post=b=>fetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{authorization:`Bearer ${KEY}`,'content-type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());

const work=[];
for (const S of SETS){
  const labels=JSON.parse(readFileSync(`${LAB}/labels-${S.lab}.json`,'utf8'));
  const ceil=JSON.parse(readFileSync(`${LAB}/ceiling-${S.lab}.json`,'utf8'));
  const l6=new Map(ceil.tasks.map(t=>[t.id,t.l6||{}]));
  const td=JSON.parse(readFileSync(`${R}/bench/tasks/${S.tasks}.json`,'utf8'));
  const tasks=(Array.isArray(td)?td:td.tasks);
  const dir=`${R}/bench/notesets/${S.notes}/notes`;
  const note=id=>existsSync(`${dir}/${id}.json`)?JSON.parse(readFileSync(`${dir}/${id}.json`,'utf8')):null;
  let n=0;
  for (const id of Object.keys(labels)){                 // file order = deterministic selection
    if (n>=S.take) break;
    const t=tasks.find(x=>x.id===id); if(!t) continue;
    const L=labels[id].labels||{}, pool=(labels[id].pool||[]).map(note).filter(Boolean);
    if (pool.length<2) continue;
    work.push({set:S.lab, id, request:bare(t.prompt), pool, L, l6:l6.get(id)||{}}); n++;
  }
  console.log(`${S.lab}: ${n} tasks taken of ${Object.keys(labels).length}`);
}
const lab=(W,id)=>{const v=W.L[id]; return v==null?0:(typeof v==='object'?(v.label??0):v);};
console.log(`\n${work.length} tasks, ${work.reduce((s,w)=>s+w.pool.length,0)} candidates total`);
const impTotal=work.reduce((s,w)=>s+w.pool.filter(n=>lab(w,n.id)===2).length,0);
const usefulTasks=work.filter(w=>w.pool.some(n=>lab(w,n.id)>=1)).length;
console.log(`important notes in these pools: ${impTotal}   tasks with at least one useful note: ${usefulTasks}/${work.length}\n`);

let tok=0; const lat=[];
for (const w of work){
  const qs={}; w.pool.forEach((n,i)=>{qs[`r${i}`]={type:'noul',
    instructions:{request:w.request,question:`Would the note at \`candidate_notes[${i}]\` help a developer carry out \`request\`? Weigh its \`claim\` and \`answers_the_questions\`; \`code_it_points_at\` tells you which code it governs.`},criteria:REL};});
  const t0=Date.now();
  const j=await post({model:'jev-latest',state:{developer_request:w.request,candidate_notes:w.pool.map((n,i)=>({index:i,...rec(n)}))},questions:qs});
  if(!j.answers){ console.log(`  !! ${w.id} ${JSON.stringify(j).slice(0,160)}`); w.jev=null; continue; }
  lat.push(Date.now()-t0); tok+=j.usage.input_tokens;
  w.jev=w.pool.map((n,i)=>({id:n.id,s:j.answers[`r${i}`].noul}));
  process.stdout.write(`\r  scored ${lat.length}/${work.length}`);
}
console.log(`\n\njev: ${tok} input tok, $${((tok/1e9)*42).toFixed(5)}, median ${lat.sort((a,b)=>a-b)[Math.floor(lat.length/2)]}ms/task\n`);

function evaluate(name, pick){
  let served=0, useful=0, imp=0, blank=0; const impSeen=new Set();
  for (const w of work){
    const got=pick(w); if(got===null) continue;
    const poolUseful=w.pool.some(n=>lab(w,n.id)>=1);
    if(!got.length){ continue; }
    served+=got.length;
    for (const id of got){ const l=lab(w,id); if(l>=1) useful++; if(l===2){imp++; impSeen.add(w.set+'/'+id);} }
    if(!poolUseful) blank++;
  }
  const hitTasks=work.filter(w=>{const g=pick(w); return g&&g.some(id=>lab(w,id)>=1);}).length;
  return {name,served,useful,imp,impSeen:impSeen.size,blank,hitTasks,
    us:served?(useful/served):0, is:served?(imp/served):0};
}
const arms=[
  evaluate('bm25-top2', w=>rank(w.pool,{query:w.request,mode:'orient'}).slice(0,2).map(r=>r.note.id)),
  evaluate('bm25-top1', w=>rank(w.pool,{query:w.request,mode:'orient'}).slice(0,1).map(r=>r.note.id)),
  evaluate('jev-1  (floor .5)', w=>w.jev&&w.jev.filter(x=>x.s>=0.5).sort((a,b)=>b.s-a.s).slice(0,1).map(x=>x.id)),
  evaluate('jev-2  (floor .5)', w=>w.jev&&w.jev.filter(x=>x.s>=0.5).sort((a,b)=>b.s-a.s).slice(0,2).map(x=>x.id)),
  evaluate('jev-1  (floor .7)', w=>w.jev&&w.jev.filter(x=>x.s>=0.7).sort((a,b)=>b.s-a.s).slice(0,1).map(x=>x.id)),
  evaluate('l6-1   (floor 0)*', w=>Object.keys(w.l6).length?Object.entries(w.l6).filter(([,v])=>v>=0).sort((a,b)=>b[1]-a[1]).slice(0,1).map(([k])=>k):null),
];
console.log('arm                  served  useful-share  important-share  important notes  tasks hit  served-when-none-useful');
for (const a of arms) console.log(
  `${a.name.padEnd(20)} ${String(a.served).padStart(5)}      ${a.us.toFixed(2)}          ${a.is.toFixed(2)}        ${String(a.impSeen).padStart(2)}/${impTotal}          ${String(a.hitTasks).padStart(2)}/${work.length}        ${a.blank}`);
writeFileSync('exp/hook-jev-arm-results.json',JSON.stringify({tasks:work.length,impTotal,usefulTasks,arms},null,2));
console.log('\n* l6 = ms-marco cross-encoder scores as stored in the lab run; which text variant they were computed on is unverified, so indicative only, NOT the production ce1 default.');
console.log('judge: gpt-6-sol (existing labels, no new judge pass). 20 of 54 tasks, stratified by largest remainder, file order.');
