import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
if(process.env.THINKER_TEST!=='1')throw Error('THINKER_TEST=1 required');
const repos={grafana:'/Users/yoavshmariahu/src/thinker/bench/repos/grafana',posthog:'/Users/yoavshmariahu/src/thinker/bench/repos/posthog',pandas:'bench/suite-repos/pandas',sklearn:'bench/suite-repos/scikit-learn',pydantic:'bench/suite-repos/pydantic'};
const status=[];
const save=()=>fs.writeFileSync('research/regression-suite/run-status.json',JSON.stringify(status,null,2)+'\n');
const complete=(name,cohort)=>{try{const r=JSON.parse(fs.readFileSync(`research/regression-suite/${name}/${cohort}/results.json`));return r.length===5&&r.every(r=>r.baseline?.validModel&&r.cached?.validModel);}catch{return false;}};
await Promise.all(['opus','sol','gemini'].map(async cohort=>{
 for(const [name,repo] of Object.entries(repos)){
  const wt=path.resolve('bench/suite-worktrees',`${name}-${cohort}`);
  // During a supervisor handoff, let the already-running cohort finish first.
  // Never delete its worktree or duplicate its calls. A stale worktree requires inspection.
  while(fs.existsSync(wt))await new Promise(r=>setTimeout(r,5000));
  if(complete(name,cohort)){status.push({name,cohort,code:0,resumedComplete:true});save();continue;}
  console.log(`${new Date().toISOString()} START ${name}/${cohort}`);
  const row=await new Promise(resolve=>{
   const file=path.resolve('research/regression-suite',name,cohort+'.txt'),fd=fs.openSync(file,'a');
   const child=spawn(process.execPath,['research/regression-suite/run-cohort.mjs',name,cohort,repo],{env:process.env,stdio:['ignore',fd,fd]});
   child.on('exit',(code,signal)=>{fs.closeSync(fd);const row={name,cohort,code,signal,finishedAt:new Date().toISOString()};console.log(JSON.stringify(row));resolve(row);});
  });
  status.push(row);save();
  if(row.code!==0){console.log(`PAUSED ${cohort}: invalid cohort; inspect before resuming`);process.exitCode=1;break;}
 }
}));
