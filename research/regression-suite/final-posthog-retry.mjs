// One final same-configuration attempt, after all other jobs are started and a
// slot is free. Continue remaining frozen cases even if this one remains invalid.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
if(process.env.THINKER_TEST!=='1')throw Error('THINKER_TEST=1 required');
const names=['grafana','posthog','pandas','sklearn','pydantic'],models=['opus','sol','gemini'];
const complete=(n,m)=>{try{const r=JSON.parse(fs.readFileSync(`research/regression-suite/${n}/${m}/results.json`));return r.length===5&&r.every(x=>x.baseline?.validModel&&x.cached?.validModel);}catch{return false;}};
const deadline=Date.now()+2*60*60*1000;
for(;;){
 let active=0,unstarted=0;
 for(const n of names)for(const m of models){const exists=fs.existsSync(`bench/suite-worktrees/${n}-${m}`);if(exists)active++;if(n==='posthog'&&m==='gemini')continue;if(!exists&&!complete(n,m))unstarted++;}
 if(!unstarted&&active<3&&!fs.existsSync('bench/suite-worktrees/posthog-gemini'))break;
 if(Date.now()>deadline)throw Error('No free slot before deadline; inspect other cohorts');
 await new Promise(r=>setTimeout(r,5000));
}
console.log('Final same-model PostHog/Gemini attempt starting');
const fd=fs.openSync('research/regression-suite/posthog/gemini.txt','a');
const code=await new Promise(resolve=>{const p=spawn(process.execPath,['research/regression-suite/run-cohort.mjs','posthog','gemini','/Users/yoavshmariahu/src/thinker/bench/repos/posthog'],{env:{...process.env,THINKER_EVAL_CONTINUE_ERRORS:'1'},stdio:['ignore',fd,fd]});p.on('exit',resolve);});
fs.closeSync(fd);fs.writeFileSync('research/regression-suite/final-retry-status.json',JSON.stringify({code,finishedAt:new Date().toISOString()},null,2)+'\n');console.log({code});if(code!==0)process.exitCode=1;
