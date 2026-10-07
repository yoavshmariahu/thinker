import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Store} from '../../src/store.js';
import {minePrs} from '../../src/commands/learn.js';
import {orient,lookup} from '../../src/ops.js';
import {execFileSync} from 'node:child_process';
import {jevKey,JEV_ENDPOINT} from '../../src/jev.js';
if(process.env.THINKER_TEST!=='1')throw Error('THINKER_TEST=1 required');
const ROOT=path.resolve(import.meta.dirname,'../..'),OUT=path.resolve(process.env.THINKER_PERF_DIR||path.join(ROOT,'research/performance-canary')),RAW=path.join(OUT,'raw'),STATE=path.join(OUT,'state');
if(process.argv[2]==='build'&&fs.existsSync(path.join(OUT,'STOPPED.json')))throw Error('Canary stopped: do not rebuild frozen caches.');
const read=p=>JSON.parse(fs.readFileSync(p));const save=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
if(process.argv[2]==='build'&&process.env.THINKER_PERF_SUPERVISED!=='1')throw Error('Use pipeline.py build for supervised cache construction');
if(process.argv[2]==='build')execFileSync('python3',['-c','from guardrails import checked_execution,run_dir; checked_execution(run_dir())'],{cwd:import.meta.dirname,env:process.env});
const key=jevKey();if(!key)throw Error('personal Jev key required; hosted proxy is not used');
function storeFor(repo){
 const store=new Store(repo).init(),original=store.config.bind(store);
 const cfg={enabled:true,key,model:'jev-1.13.0',searchTimeoutMs:5000,learningTimeoutMs:5000,fetchImpl:async(url,options)=>{
  if(url!==JEV_ENDPOINT||url!=='https://api.typesafe.ai/v1/systemone')throw Error('Unexpected inference destination');
  const start=performance.now(),request=JSON.parse(options.body);
  const record=entry=>fs.appendFileSync(path.join(repo,'.thinker','perf-jev.jsonl'),JSON.stringify({request,...entry,durationMs:performance.now()-start})+'\n');
  let r,j;
  try {r=await fetch(url,options);j=await r.json();}
  catch(error){record({status:r?.status,error:error.message});throw error;}
  record({status:r.status,model:j.model,usage:j.usage,response:j});
  if(r.ok&&j.model!=='jev-1.13.0')throw Error('Jev model mismatch');return {ok:r.ok,status:r.status,json:async()=>j};
 }};
 store.config=()=>({...original(),jev:cfg,maintain:{...original().maintain,dailyTokens:1e9}});return store;
}
const [mode,cohort,...query]=process.argv.slice(2);
if(mode==='lookup'){
 const store=storeFor(process.cwd());const r=await lookup(store,{query:[cohort,...query].join(' '),budget:1500,maxNotes:3});console.log(r.text||'(no matching notes)');
}else if(mode==='build'){
 const execution=read(path.join(OUT,'execution.json')),corpus=read(path.join(OUT,'prs.json'));
 if(execution.cacheSource!=='recent-merged-prs'||execution.cacheBuildPath!=='minePrs')throw Error('Only recent PR mining is allowed; session distillation is forbidden');
 const model=execution.models[cohort];if(!model)throw Error('Unknown model cohort');
 const shim=path.join(STATE,`pr-build-bin-${cohort}`);fs.mkdirSync(shim,{recursive:true});
 const quote=s=>"'"+s.replaceAll("'", "'\\''")+"'";
 fs.writeFileSync(path.join(shim,'gh'),'#!/bin/sh\nexec python3 '+quote(path.join(ROOT,'research/performance-canary/frozen_gh.py'))+' "$@"\n',{mode:0o755});
 process.env.PATH=shim+path.delimiter+process.env.PATH;
 for(const t of read(path.join(OUT,'tasks.json'))){
  const cacheName=`${t.id}-${cohort}-pr-cache`,name=`${t.id}-${cohort}-thinker`,prefix=`${t.id}-${cohort}-pr`,dest=path.join(RAW,name+'-retrieval.json');
  if(fs.existsSync(dest)||fs.existsSync(path.join(RAW,prefix+'-build.json')))throw Error('Existing cache attempt: use a fresh run; no silent reuse');
  const repo=path.join(STATE,cacheName),store=storeFor(repo),start=performance.now(),input=corpus.tasks[t.id];
  if(store.list().length)throw Error('PR cache must start empty');
  Object.assign(process.env,{THINKER_FROZEN_PR_TASK:t.id,THINKER_LLM:{opus:'claude',sol:'codex',gemini:'gemini'}[cohort],THINKER_LLM_MODEL:model,THINKER_CLAUDE_EFFORT:'high',THINKER_CODEX_REASONING_EFFORT:'high',THINKER_GEMINI_EFFORT:'high',THINKER_NO_LIMIT_WAIT:'1',THINKER_EVAL_TRACE_DIR:path.join(RAW,'pr-model-traces')});
  fs.mkdirSync(process.env.THINKER_EVAL_TRACE_DIR,{recursive:true});delete process.env.MAX_THINKING_TOKENS;
  const records=[], originalLog=store.log.bind(store);
  store.log=record=>{records.push(record);return originalLog(record);};
  let result;
  const receipt={cacheBuildPath:'minePrs',cacheSource:'recent-merged-prs',model,effort:'high',prsSha256:execution.prsSha256};
  try {
    result=await minePrs({repo,store,flags:{},out:console.log},input.repository,{repo,before:input.before,limit:input.limit,model,phase:'init'});
    if(result.failed||records.some(r=>r.op==='model'&&(r.failed||r.model!==(r.provider==='typesafe'?'jev-1.13.0':model))))throw Error('Failed or mismatched PR cache model call');
    if(!result.saved||!store.list().length)throw Error('PR cache readiness failed: no saved notes');
  } catch(error) {
    save(path.join(RAW,prefix+'-build.json'),{...receipt,valid:false,setupError:error.message,records,result});
    try{fs.writeFileSync(path.join(OUT,'STOPPED.json'),JSON.stringify({reason:error.message}),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
    throw error;
  }
  const processedPrs=[...new Set(records.filter(r=>r.op==='model'&&r.purpose==='mine-prs'&&!r.failed).map(r=>`${input.repository}#${r.pr}`))];
  const build={...receipt,valid:true,processedPrs,saved:store.list().map(n=>n.id),setupError:null,records,prTokens:result.tokens,wallMs:performance.now()-start};save(path.join(RAW,prefix+'-build.json'),build);
  // Store may save into local/notes; export the merged in-memory corpus explicitly.
  const notes=store.list();
  const immutable=path.join(RAW,prefix+'-notes');fs.mkdirSync(immutable,{recursive:true});
  const target=path.join(STATE,name),targetStore=storeFor(target);
  if(targetStore.list().length)throw Error('Target cache must start empty');
  const hashes={};for(const n of notes){const file=n.id+'.json',text=JSON.stringify(n,null,2)+'\n';fs.writeFileSync(path.join(immutable,file),text);targetStore.put(n);hashes[file]=crypto.createHash('sha256').update(text).digest('hex');}
  save(path.join(RAW,prefix+'-note-hashes.json'),hashes);
  const r0=performance.now(),r=await orient(targetStore,{task:t.prompt,budget:750,maxNotes:2,freshOnly:true,client:'performance-canary'});
  const logs=fs.existsSync(path.join(target,'.thinker','log.jsonl'))?fs.readFileSync(path.join(target,'.thinker','log.jsonl'),'utf8'):'';
  const error=/"op":"jev-error"/.test(logs)?'Jev serving failed; do not silently substitute another ranker':!r.included.length||!r.text?.trim()?'Cache readiness failed: no notes served':null;
  save(dest,{valid:!error,error,text:r.text,included:r.included.map(n=>n.id),retrievalMs:performance.now()-r0,noteCount:notes.length,buildMs:build.wallMs});
  if(error)throw Error(error);
  console.log(name,'notes',notes.length,'served',r.included.length);
 }
}else throw Error('build <cohort> | lookup <query>');
