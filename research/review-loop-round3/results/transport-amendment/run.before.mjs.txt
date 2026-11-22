import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {preflight,judge,execute,hash,save} from './clients.mjs';import {route,stopReason} from './policy.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));const read=f=>JSON.parse(fs.readFileSync(path.join(dir,f)));
const mode=process.argv[2],p=read('protocol.json'),pins=read('inputs.sha256.json');
if(!['open-loop','paired'].includes(mode))throw Error('Specify mode');
if(process.env.THINKER_TEST!=='1'||process.env.THINKER_TELEMETRY!=='off'||process.env.THINKER_PILOT_LIVE!=='1')throw Error('Explicit test-mode live opt-in required');
process.env.THINKER_LOG='off';process.env.THINKER_NO_LEARN='1';preflight(p);
const files=['run.mjs','clients.mjs','policy.mjs','questions.mjs','protocol.json','prepare.py','../review-loop-round2/policy.mjs','../review-loop-round2/questions.json'];
const hashes=Object.fromEntries(files.map(f=>[f,hash(fs.readFileSync(path.join(dir,f)))]));
for(const[f,h]of Object.entries(pins))if(hash(fs.readFileSync(path.join(dir,f)))!==h)throw Error('Input pin mismatch');
const begun=Date.now(),out=path.join(dir,'results',mode);fs.mkdirSync(out,{recursive:true});
if(mode==='open-loop'){
 for(const id of p.openLoop.cases){const prefix=path.join(out,id);if(fs.existsSync(prefix+'.json'))throw Error('Refusing overwrite');const state=read('open-inputs/'+id+'.json');const j=await judge(state,prefix+'.judge',p);const decision=route(j.response.answers,state);save(prefix+'.json',{id,hashes,stateHash:hash(state),...j,decision});console.log(JSON.stringify({id,answers:j.response.answers,decision}));}
}else{
 for(let rep=0;rep<p.repetitions;rep++)for(const[i,id]of p.cases.entries())for(const arm of (rep+i)%2?['graph','self']:['self','graph']){
  if(Date.now()-begun>p.execution.maxModeSeconds*1000)throw Error('Mode budget exhausted');
  const prefix=path.join(out,`${id}.${arm}.rep${rep}`),initial=read('tasks/'+id+'.json');
  if(fs.existsSync(prefix+'.json')){const old=JSON.parse(fs.readFileSync(prefix+'.json'));if(!old.valid||JSON.stringify(old.hashes)!==JSON.stringify(hashes)||old.stateHash!==hash(initial))throw Error('Cannot resume invalid/mismatched arm');console.log(JSON.stringify({id,arm,rep,resumed:true}));continue;}
  const cwd=path.join(dir,'.runtime',`${id}.${arm}.rep${rep}`);fs.mkdirSync(cwd,{recursive:true});
  for(const[f,source]of Object.entries(initial.source)){if(path.isAbsolute(f)||f.split('/').includes('..'))throw Error('Unsafe fixture path');const file=path.join(cwd,f);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);}
  save(path.join(cwd,'TASK.json'),{task:initial.task,contracts:initial.contracts,sourceFiles:Object.keys(initial.source)});fs.writeFileSync(path.join(cwd,'CHANGE.diff'),initial.diff);
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
