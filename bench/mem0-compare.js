// Two paired read-only Click tasks; each system learns independently from raw sessions.
import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {estTokens} from '../src/rank.js';import {Store} from '../src/store.js';import {orient} from '../src/ops.js';import {complete} from '../src/llm.js';import {run} from './mem0-sessions.js';
const root=path.resolve(import.meta.dirname,'..'),raw=path.join(root,'research/mem0-comparison/raw');
const spec=JSON.parse(fs.readFileSync(path.join(root,'bench/tasks/click.json')));
const ids=['E1-flag-parsing','E5-runner-exit'];const repo=path.join(root,'bench/worktrees/click-source');
process.env.THINKER_NOTES_DIR=path.join(root,'bench/mem0-state/thinker-notes');
const store=new Store(repo);const retrieval={};
for(const id of ids){
 const task=spec.tasks.find(t=>t.id===id);
 for(const arm of ['thinker','mem0']){
  const dest=path.join(raw,`${id}-${arm}-retrieval.json`);
  if(fs.existsSync(dest)){retrieval[id+arm]=JSON.parse(fs.readFileSync(dest));continue;}
  const timings=[];let context='',result;
  for(let i=0;i<11;i++){
   const start=performance.now();
   if(arm==='thinker'){
    result=await orient(store,{task:task.prompt,budget:750,recordUsage:false,backgroundVerify:false});context=result.text;
   }else{
    const r=await fetch('http://127.0.0.1:18881/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:task.prompt,user_id:'click-independent',top_k:20})});
    if(!r.ok)throw Error(await r.text());result=await r.json();
    const parts=[];let used=0;
    for(const item of result.results){const text=item.memory;const tokens=estTokens(text);if(used+tokens>750)continue;parts.push(text);used+=tokens;}context=parts.join('\n\n');
   }
   timings.push(performance.now()-start);
  }
  const record={context,result,timings_ms:timings,first_ms:timings[0],warm_median_ms:(()=>{const t=timings.slice(1).sort((a,b)=>a-b);return (t[4]+t[5])/2})(),context_chars:context.length};
  fs.writeFileSync(dest,JSON.stringify(record,null,2));retrieval[id+arm]=record;
 }
}
// Retrieve before solvers and alternate arm order. No solver receives the reference answers.
const records=[];
for(const [i,id] of ids.entries())for(const arm of (i%2?['mem0','thinker']:['thinker','mem0'])){
 const task=spec.tasks.find(t=>t.id===id), r=retrieval[id+arm];
 const cwd=path.join(root,'bench/worktrees',id+'-'+arm);
 if(!fs.existsSync(cwd))execFileSync('git',['worktree','add','--detach',cwd,'HEAD'],{cwd:repo,stdio:'ignore'});
 const prompt=`Answer the coding question using this repository. You may inspect the code to verify or fill gaps. Do not modify files.\n\nMEMORIES FROM EARLIER SESSIONS:\n${r.context||'(none retrieved)'}\n\nQUESTION:\n${task.prompt}`;
 const record=await run(id+'-'+arm,prompt,cwd);
 records.push({task:id,arm,...record,retrieval_ms:r.first_ms,warm_retrieval_ms:r.warm_median_ms,context_chars:r.context_chars});
}
const schema={type:'object',properties:{score:{type:'number',enum:[0,0.5,1]},missing:{type:'array',items:{type:'string'}},wrong:{type:'array',items:{type:'string'}},reason:{type:'string'}},required:['score','missing','wrong','reason']};
for(const record of records){
 const task=spec.tasks.find(t=>t.id===record.task);const dest=path.join(raw,record.id+'.judge.json');
 if(!fs.existsSync(dest)){
  const j=await complete({model:'claude-sonnet-5-5',system:'Grade the answer against the expert reference. Score 1 if every key fact is present and no incorrect claims; 0.5 if the main point is correct but important details are missing or wrong; 0 if the main point is wrong. Extra correct detail is fine. Ignore wording differences.',prompt:`QUESTION:\n${task.prompt}\nREFERENCE:\n${task.gold}\nANSWER:\n${record.result}`,schema});
  fs.writeFileSync(dest,JSON.stringify({grade:j.json,usage:j.usage,model:j.model},null,2));
 }
 record.grade=JSON.parse(fs.readFileSync(dest)).grade;
}
fs.writeFileSync(path.join(raw,'summary.json'),JSON.stringify(records.map(r=>({task:r.task,arm:r.arm,wall_s:r.wall_ms/1000,api_s:r.duration_api_ms/1000,tools:r.tools,usage:r.usage,modelUsage:r.modelUsage,retrieval_ms:r.retrieval_ms,warm_retrieval_ms:r.warm_retrieval_ms,context_chars:r.context_chars,grade:r.grade})),null,2));
console.log('COMPLETE');
