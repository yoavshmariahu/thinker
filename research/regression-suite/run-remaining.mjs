// Three-slot pool. Adopt ongoing isolated cohorts after a supervisor handoff.
// Frozen per-case models stay unchanged; a free slot can run any pending cohort.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
if(process.env.THINKER_TEST!=='1')throw Error('THINKER_TEST=1 required');
const repos={grafana:'/Users/yoavshmariahu/src/thinker/bench/repos/grafana',posthog:'/Users/yoavshmariahu/src/thinker/bench/repos/posthog',pandas:'bench/suite-repos/pandas',sklearn:'bench/suite-repos/scikit-learn',pydantic:'bench/suite-repos/pydantic'};
const jobs=Object.entries(repos).flatMap(([name,repo])=>['opus','sol','gemini'].map(cohort=>({name,repo,cohort,key:`${name}/${cohort}`,wt:`bench/suite-worktrees/${name}-${cohort}`})));
const complete=j=>{try{const r=JSON.parse(fs.readFileSync(`research/regression-suite/${j.key}/results.json`));return r.length===5&&r.every(r=>r.baseline?.validModel&&r.cached?.validModel);}catch{return false;}};
const active=new Map(),finished=new Set(),failed=new Set();
const log=(j,event,extra={})=>{const row={at:new Date().toISOString(),job:j.key,event,...extra};console.log(JSON.stringify(row));fs.appendFileSync('research/regression-suite/pool-events.jsonl',JSON.stringify(row)+'\n');};
for(const j of jobs){if(fs.existsSync(j.wt)){active.set(j.key,{job:j,adopted:true});log(j,'adopted');}else if(complete(j))finished.add(j.key);}
if(active.size>3)throw Error('More than three active cohorts; inspect before proceeding');
while(finished.size+failed.size<jobs.length){
 for(const [key,a] of active){
  if(a.adopted&&!fs.existsSync(a.job.wt)){
   active.delete(key);if(complete(a.job)){finished.add(key);log(a.job,'complete');}else{failed.add(key);log(a.job,'invalid');}
  }else if(!a.adopted&&a.exited){
   active.delete(key);if(a.code===0&&complete(a.job)){finished.add(key);log(a.job,'complete');}else{failed.add(key);log(a.job,'invalid',{code:a.code});}
  }
 }
 for(const j of jobs){
  if(active.size>=3)break;
  if(active.has(j.key)||finished.has(j.key)||failed.has(j.key))continue;
  const fd=fs.openSync(`research/regression-suite/${j.name}/${j.cohort}.txt`,'a');
  const a={job:j,adopted:false,exited:false};active.set(j.key,a);log(j,'start');
  const child=spawn(process.execPath,['research/regression-suite/run-cohort.mjs',j.name,j.cohort,j.repo],{env:process.env,stdio:['ignore',fd,fd]});
  child.on('exit',code=>{fs.closeSync(fd);a.exited=true;a.code=code;});
 }
 if(active.size)await new Promise(r=>setTimeout(r,3000));
}
console.log(JSON.stringify({completed:finished.size,failed:[...failed]}));
if(failed.size)process.exitCode=1;
