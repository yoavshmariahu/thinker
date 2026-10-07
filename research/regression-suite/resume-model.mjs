// Resume a failed model queue while other model queues continue. No fallback.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const [cohort,start]=process.argv.slice(2);
if(process.env.THINKER_TEST!=='1'||!['opus','sol','gemini'].includes(cohort))throw Error('THINKER_TEST=1 and cohort required');
const repos={grafana:'/Users/yoavshmariahu/src/thinker/bench/repos/grafana',posthog:'/Users/yoavshmariahu/src/thinker/bench/repos/posthog',pandas:'bench/suite-repos/pandas',sklearn:'bench/suite-repos/scikit-learn',pydantic:'bench/suite-repos/pydantic'};
const names=Object.keys(repos),status=[];
for(const name of names.slice(names.indexOf(start))){
 console.log(`RESUME ${name}/${cohort}`);const fd=fs.openSync(`research/regression-suite/${name}/${cohort}.txt`,'a');
 const code=await new Promise(resolve=>{const p=spawn(process.execPath,['research/regression-suite/run-cohort.mjs',name,cohort,repos[name]],{env:process.env,stdio:['ignore',fd,fd]});p.on('exit',resolve);});
 fs.closeSync(fd);status.push({name,cohort,code,finishedAt:new Date().toISOString()});fs.writeFileSync(`research/regression-suite/${cohort}-resume-status.json`,JSON.stringify(status,null,2)+'\n');console.log(status.at(-1));
 if(code!==0){process.exitCode=1;break;}
}
