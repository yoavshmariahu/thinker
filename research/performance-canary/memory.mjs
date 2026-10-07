import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Store} from '../../src/store.js';
import {prepareNotes} from '../../src/note-learning.js';
import {saveNotes,distillEvents,condense} from '../../src/distill.js';
import {parseTranscript} from '../../src/transcripts.js';
import {refineLearningPlan} from '../../src/learning-evidence.js';
import {orient,lookup} from '../../src/ops.js';
import {symbolText} from '../../src/deps.js';
import {jevKey,JEV_ENDPOINT} from '../../src/jev.js';
if(process.env.THINKER_TEST!=='1')throw Error('THINKER_TEST=1 required');
const ROOT=path.resolve(import.meta.dirname,'../..'),OUT=path.join(ROOT,'research/performance-canary'),RAW=path.join(OUT,'raw'),STATE=path.join(OUT,'state');
if(process.argv[2]==='build'&&fs.existsSync(path.join(OUT,'STOPPED.json')))throw Error('Canary stopped: do not rebuild frozen caches.');
const read=p=>JSON.parse(fs.readFileSync(p));const save=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2)+'\n');
const key=jevKey();if(!key)throw Error('personal Jev key required; hosted proxy is not used');
function storeFor(repo){
 const store=new Store(repo).init(),original=store.config.bind(store);
 const cfg={enabled:true,key,model:'jev-1.13.0',searchTimeoutMs:5000,learningTimeoutMs:5000,fetchImpl:async(url,options)=>{
  if(url!==JEV_ENDPOINT||url!=='https://api.typesafe.ai/v1/systemone')throw Error('Unexpected inference destination');
  const start=performance.now();const r=await fetch(url,options);if(!r.ok)throw Error(`Jev HTTP ${r.status}`);const j=await r.json();
  fs.appendFileSync(path.join(repo,'.thinker','perf-jev.jsonl'),JSON.stringify({model:j.model,usage:j.usage,durationMs:performance.now()-start})+'\n');
  if(j.model!=='jev-1.13.0')throw Error('Jev model mismatch');return {ok:true,json:async()=>j};
 }};
 store.config=()=>({...original(),jev:cfg,maintain:{...original().maintain,dailyTokens:1e9}});return store;
}
const [mode,cohort,...query]=process.argv.slice(2);
if(mode==='lookup'){
 const store=storeFor(process.cwd());const r=await lookup(store,{query:[cohort,...query].join(' '),budget:1500,maxNotes:3});console.log(r.text||'(no matching notes)');
}else if(mode==='build'){
 for(const t of read(path.join(OUT,'tasks.json'))){
  const learnName=`${t.id}-${cohort}-learn`,name=`${t.id}-${cohort}-thinker`,dest=path.join(RAW,name+'-retrieval.json');if(fs.existsSync(dest))continue;
  const learned=read(path.join(RAW,learnName+'.json'));if(!learned.valid)throw Error('Invalid learning session');
  const repo=path.join(STATE,learnName),store=storeFor(repo),start=performance.now();
  const transcript=path.join(RAW,learnName+(cohort==='gemini'?'.transcript.jsonl':'.events.jsonl'));
  const {events}=parseTranscript(transcript);
  const accounting={store,phase:'init'};
  const planFile=path.join(RAW,learnName+'-learning-plan.json');
  const priorPlan=fs.existsSync(planFile)?read(planFile):null;
  const plan=priorPlan?.evidenceSelection?.status==='selected'?priorPlan:await refineLearningPlan(store,events,{mode:'full',served:[],discover:true,trace:condense(events)},{accounting});
  fs.appendFileSync(path.join(RAW,learnName+'-plan-attempts.jsonl'),JSON.stringify(plan)+'\n');
  save(path.join(RAW,learnName+'-learning-plan.json'),plan);
  if(plan.evidenceSelection?.status==='unavailable')throw Error('Jev evidence selection unavailable');
  Object.assign(process.env,{THINKER_LLM:{opus:'claude',sol:'codex',gemini:'gemini'}[cohort],THINKER_LLM_MODEL:learned.model,THINKER_CLAUDE_EFFORT:'high',THINKER_CODEX_REASONING_EFFORT:'high',THINKER_GEMINI_EFFORT:'high',THINKER_NO_LIMIT_WAIT:'1',THINKER_EVAL_TRACE_DIR:path.join(RAW,'distill-traces')});
  fs.mkdirSync(process.env.THINKER_EVAL_TRACE_DIR,{recursive:true});delete process.env.MAX_THINKING_TOKENS;
  const distilledFile=path.join(RAW,learnName+'-distilled.json');
  let distilled;
  if(fs.existsSync(distilledFile))distilled=read(distilledFile);
  else try{distilled=await distillEvents(events,{model:learned.model,repoHint:repo,evidence:plan.trace,compact:plan.compact??false,accounting:{...accounting,purpose:'distill'}});}catch(error){distilled={notes:[],assessments:[],tokens:null,evidence:plan.trace,valid:false,error:String(error.message)};}
  if(!fs.existsSync(distilledFile))save(distilledFile,distilled);
  const prepared=await prepareNotes(store,distilled.notes,{evidence:distilled.evidence,accounting});
  const saved=saveNotes(store,prepared.notes,{source:{type:'agent',ref:learnName},reconciled:prepared.reconciled});
  const build={prepared,saved,setupError:distilled.error||null,distillationTokens:distilled.tokens,wallMs:performance.now()-start};save(path.join(RAW,learnName+'-build.json'),build);
  const source=path.join(repo,'.thinker','notes');const local=path.join(repo,'.thinker','local','notes');
  // Store may save into local/notes; export the merged in-memory corpus explicitly.
  const notes=store.list();
  const immutable=path.join(RAW,learnName+'-notes');fs.mkdirSync(immutable,{recursive:true});
  const target=path.join(STATE,name),copy=path.join(target,'.thinker','notes');fs.mkdirSync(copy,{recursive:true});
  const hashes={};for(const n of notes){const file=n.id+'.json',text=JSON.stringify(n,null,2)+'\n';fs.writeFileSync(path.join(immutable,file),text);fs.writeFileSync(path.join(copy,file),text);hashes[file]=crypto.createHash('sha256').update(text).digest('hex');}
  save(path.join(RAW,learnName+'-note-hashes.json'),hashes);
  const targetStore=storeFor(target),r0=performance.now(),r=await orient(targetStore,{task:t.prompt,budget:750,maxNotes:2,freshOnly:true,client:'performance-canary'});
  const logs=fs.existsSync(path.join(target,'.thinker','log.jsonl'))?fs.readFileSync(path.join(target,'.thinker','log.jsonl'),'utf8'):'';
  if(/"op":"jev-error"/.test(logs))throw Error('Jev serving failed; do not silently substitute another ranker');
  save(dest,{text:r.text,included:r.included.map(n=>n.id),retrievalMs:performance.now()-r0,noteCount:notes.length,buildMs:build.wallMs});console.log(name,'notes',notes.length,'served',r.included.length);
 }
}else throw Error('build <cohort> | lookup <query>');
