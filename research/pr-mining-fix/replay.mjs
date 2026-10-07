import fs from 'node:fs';
import path from 'node:path';
import {prepareNotes} from '../../src/note-learning.js';
import {judgeWithJev} from '../../src/jev-decisions.js';
import {jevKey,JEV_ENDPOINT} from '../../src/jev.js';
if(process.env.THINKER_TEST!=='1')throw Error('THINKER_TEST=1 required');
const label=process.argv[2];if(!/^[a-z0-9-]+$/.test(label||''))throw Error('run label required');
const dest=path.resolve('research/pr-mining-fix/raw',label);fs.mkdirSync(dest);const source=path.resolve('bench/runs/pr-mining-fix');
const corpus=JSON.parse(fs.readFileSync(path.join(source,'prs.json'))).tasks['click-3364'].prs;
const append=(name,x)=>fs.appendFileSync(path.join(dest,name),JSON.stringify(x)+'\n');
let active;
const cfg={enabled:true,key:jevKey(),model:'jev-1.13.0',learningTimeoutMs:10000,fetchImpl:async(url,options)=>{
 if(url!==JEV_ENDPOINT)throw Error('unexpected destination');const request=JSON.parse(options.body),start=performance.now();
 try {const r=await fetch(url,{...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(15000)].filter(Boolean))});const response=await r.json();append('transport.jsonl',{active,request,response,status:r.status,wallMs:performance.now()-start});if(response.model&&response.model!=='jev-1.13.0')throw Error('model mismatch');return {ok:r.ok,status:r.status,json:async()=>response};}
 catch(error){append('transport.jsonl',{active,request,error:error.message,wallMs:performance.now()-start});throw error;}
}};
const store={config:()=>({jev:cfg,maintain:{dailyTokens:1e9}}),list:()=>[],log:r=>append('usage.jsonl',{active,...r})};
const results=[];
for(const model of ['opus','sol','gemini']){
 const dir=path.join(source,`partial-caches/click-3364-${model}-pr-cache/.thinker/state/learning-pending`);
 for(const file of fs.readdirSync(dir).sort()){
  const row=JSON.parse(fs.readFileSync(path.join(dir,file))),num=Number(row.source.ref.split('#')[1]),pr=corpus.find(p=>p.number===num);
  active={model,pr:num,file,title:row.note.title};
  const evidence=`PR #${pr.number}: ${pr.title}\n\nDESCRIPTION:\n${(pr.body||'').replace(/<!--[\s\S]*?-->/g,'').slice(0,5000)}\n\nREVIEW COMMENTS:\n${pr.comments.join('\n')||'(none)'}\n\nDIFF:\n${pr.diff.slice(0,45000)}`;
  const result=await prepareNotes(store,[row.note],{evidence,accounting:{phase:'init'},judge:async(s,req)=>{const r=await judgeWithJev(s,req);append('judgments.jsonl',{active,request:req,response:r});return r;}});
  const r={...active,result};results.push(r);fs.writeFileSync(path.join(dest,'results.json'),JSON.stringify(results,null,2));console.log(model,num,'accepted',result.notes.length,'deferred',result.deferred.map(d=>d.reason).join(';'));
 }
}
