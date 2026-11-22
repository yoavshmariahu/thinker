import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {preflight,judge,execute,hash,save} from '../review-loop-round3/clients.mjs';import {route,stopReason} from '../review-loop-round3/policy.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));const read=f=>JSON.parse(fs.readFileSync(path.join(dir,f)));
const mode=process.argv[2],p=read('protocol.json'),pins=read('inputs.sha256.json');
if(!['controls','paired'].includes(mode))throw Error('Specify mode');
if(process.env.THINKER_TEST!=='1'||process.env.THINKER_TELEMETRY!=='off'||process.env.THINKER_PILOT_LIVE!=='1')throw Error('Explicit test-mode live opt-in required');
process.env.THINKER_LOG='off';process.env.THINKER_NO_LEARN='1';preflight(p);
const files=['run.mjs','protocol.json','prepare.py','selection.json','../review-loop-round3/clients.mjs','../review-loop-round3/transport.mjs','../review-loop-round3/policy.mjs','../review-loop-round3/questions.mjs','../review-loop-round2/policy.mjs','../review-loop-round2/questions.json'];
const hashes=Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(dir,f)))]));
for(const[f,h]of Object.entries(pins))if(hash(fs.readFileSync(path.join(dir,f)))!==h)throw Error('Input pin mismatch');
const compatible=old=>JSON.stringify(old)===JSON.stringify(hashes);
const stage=(cwd,state,extra={})=>{
 fs.mkdirSync(cwd,{recursive:true});
 for(const[f,source]of Object.entries({...state.source,...extra})){
  if(path.isAbsolute(f)||f.split('/').includes('..'))throw Error('Unsafe fixture path');
  const file=path.join(cwd,f);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);
 }
 save(path.join(cwd,'TASK.json'),{task:state.task,contracts:state.contracts,sourceFiles:Object.keys(state.source)});fs.writeFileSync(path.join(cwd,'CHANGE.diff'),state.diff);
};
const begun=Date.now(),out=path.join(dir,'results',mode);fs.mkdirSync(out,{recursive:true});
if(mode==='controls'){
 for(let rep=0;rep<p.controls.repetitions;rep++)for(const id of p.controls.cases){
  const initial=read('controls/'+id+'.json'),prefix=path.join(out,`${id}.rep${rep}`);
  if(fs.existsSync(prefix+'.json'))throw Error('Refusing control overwrite');
  let state=structuredClone(initial.state),valid=true,outcome='complete',tools=0;const trace=[],start=Date.now();
  const cwd=path.join(dir,'.runtime',`control-${id}-rep${rep}`);stage(cwd,state,initial.extraFiles);
  try{for(const [i,step]of initial.steps.entries()){
   if(step.addSource)state={...state,source:{...state.source,...step.addSource},task:step.task};stage(cwd,state,initial.extraFiles);
   const suppliedState=structuredClone(state),remaining=p.execution.maxArmSeconds*1000-(Date.now()-start);
   if(remaining<=0){outcome='incomplete_time';break;}
   const e=await execute(step.action,state,cwd,prefix+`.executor-${i}`,p,Math.min(remaining,p.execution.maxExecutorCallSeconds*1000),p.execution.maxToolCalls-tools);
   trace.push({type:'execution',action:step.action,suppliedState,...e});tools+=e.toolCalls;
   if(e.incomplete){outcome=e.incomplete;break;}
   for(const[f,s]of Object.entries({...state.source,...initial.extraFiles}))if(fs.readFileSync(path.join(cwd,f),'utf8')!==s)throw Error('Fixture modified');
   state={...state,findings:e.result.findings,coverage:e.result.coverage,limitations:e.result.limitations,roundsUsed:state.roundsUsed+1,history:[...state.history,{action:step.action,contribution:e.result.contribution}]};
  }}catch(e){valid=false;outcome='invalid';trace.push({type:'error',error:String(e.message)});}
  const row={id,rep,valid,outcome,hashes,stateHash:hash(initial),elapsedMs:Date.now()-start,toolCount:tools,trace,finalState:state};save(prefix+'.json',row);
  console.log(JSON.stringify({id,rep,valid,outcome,actions:trace.filter(t=>t.type==='execution').map(t=>t.action),nextAction:trace.at(-1)?.result?.next_action,elapsedMs:row.elapsedMs}));
  if(!valid)throw Error('Stopped on invalid control; artifacts retained');
 }
}else{
 for(let rep=0;rep<p.repetitions;rep++)for(const[i,id]of p.cases.entries())for(const arm of (rep+i)%2?['graph','self']:['self','graph']){
  if(Date.now()-begun>p.execution.maxModeSeconds*1000)throw Error('Mode budget exhausted');
  const prefix=path.join(out,`${id}.${arm}.rep${rep}`),initial=read('tasks/'+id+'.json');
  if(fs.existsSync(prefix+'.json')){const old=JSON.parse(fs.readFileSync(prefix+'.json'));if(!old.valid||!compatible(old.hashes)||old.stateHash!==hash(initial))throw Error('Cannot resume invalid/mismatched arm');console.log(JSON.stringify({id,arm,rep,resumed:true}));continue;}
  const cwd=path.join(dir,'.runtime',`${id}.${arm}.rep${rep}`);stage(cwd,initial);
  let state=structuredClone(initial),valid=true,outcome='incomplete',unresolved=[],toolCount=0;const start=Date.now(),trace=[],seen=new Set();let action='initial';
  const remaining=()=>p.execution.maxArmSeconds*1000-(Date.now()-start);
  try{while(true){
   if(remaining()<=0){outcome='incomplete_time';break;}
   const e=await execute(action,state,cwd,prefix+`.executor-${state.roundsUsed}`,p,Math.min(remaining(),p.execution.maxExecutorCallSeconds*1000),p.execution.maxToolCalls-toolCount);
   trace.push({type:'execution',action,...e});toolCount+=e.toolCalls;
   if(e.incomplete){outcome=e.incomplete;break;}
   state={...state,findings:e.result.findings,coverage:e.result.coverage,limitations:e.result.limitations,roundsUsed:state.roundsUsed+1,history:[...state.history,{action,contribution:e.result.contribution}]};
   let decision;
   if(arm==='graph'){
    if(remaining()<=0){outcome='incomplete_time';break;}
    const j=await judge(state,prefix+`.judge-${state.roundsUsed}`,p,Math.min(remaining(),p.execution.maxJevCallSeconds*1000));decision=route(j.response.answers,state);trace.push({type:'judgment',...j,decision});
   }else{decision={action:e.result.next_action,reason:'Executor manages its own follow-up; no Jev or semantic gates.',unresolved:[]};trace.push({type:'self_decision',decision});}
   unresolved=decision.unresolved;action=decision.action;
   const signature=hash({action,findings:state.findings,source:state.source});const stop=stopReason(action,state.roundsUsed,signature,seen);
   if(stop){outcome=stop;break;}seen.add(signature);
  }}catch(e){valid=false;outcome='invalid';trace.push({type:'error',error:String(e.message)});}
  // Detect any staged-file mutation; read scope is audited from actual command traces.
  for(const[f,s]of Object.entries(initial.source))if(fs.readFileSync(path.join(cwd,f),'utf8')!==s){valid=false;outcome='invalid';trace.push({type:'error',error:'Staged source changed'});}
  const r={id,arm,rep,valid,outcome,unresolved,hashes,stateHash:hash(initial),elapsedMs:Date.now()-start,toolCount,trace,finalState:state};save(prefix+'.json',r);
  console.log(JSON.stringify({id,arm,rep,valid,outcome,actions:trace.filter(t=>t.type==='execution').map(t=>t.action),findings:state.findings.length,toolCount,elapsedMs:r.elapsedMs}));
  if(!valid)throw Error('Stop on invalid arm; artifacts retained');
 }
}
