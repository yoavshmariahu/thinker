// Offline control and artifact audit; manual semantic assessments are kept separate.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {hash} from '../review-loop-round3/clients.mjs';import {route,stopReason} from '../review-loop-round3/policy.mjs';import {questionsFor} from '../review-loop-round3/questions.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url)),raw=f=>fs.readFileSync(path.join(dir,f)),read=f=>JSON.parse(raw(f));
const p=read('protocol.json');const files=['run.mjs','protocol.json','prepare.py','selection.json','../review-loop-round3/clients.mjs','../review-loop-round3/transport.mjs','../review-loop-round3/policy.mjs','../review-loop-round3/questions.mjs','../review-loop-round2/policy.mjs','../review-loop-round2/questions.json'];
const hashes=Object.fromEntries(files.map(f=>[f,hash(raw(f))]));for(const[f,h]of Object.entries(read('inputs.sha256.json')))assert.equal(hash(raw(f)),h);
const assessments=fs.existsSync(path.join(dir,'assessments.json'))?read('assessments.json'):null;
const add=(dst,u)=>{for(const[k,v]of Object.entries(u||{}))if(typeof v==='number')dst[k]=(dst[k]||0)+v;};
const totals={},rows=[],toolAudit=[];
// JSON omits undefined fields; compare to the JSON representation of the expected executor state.
function execution(e,base,index,state){
 const request=read(base+`.executor-${index}.request.json`),events=read(base+`.executor-${index}.events.json`);
 assert.equal(request.action,e.action);assert.equal(request.model,p.models.executor);assert.equal(request.effort,p.models.executorReasoningEffort);
 assert.equal(e.model,p.models.executor);assert.equal(e.effort,p.models.executorReasoningEffort);assert.ok(request.args.includes('read-only'));assert.ok(request.args.includes('model_reasoning_effort="high"'));
 const data=JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n')+1));assert.deepEqual(data,JSON.parse(JSON.stringify({...state,source:undefined,sourceFiles:Object.keys(state.source)})));
 const starts=events.filter(x=>x.type==='item.started'&&x.item?.type==='command_execution');assert.equal(e.toolCalls,starts.length);
 const commands=events.filter(x=>x.type==='item.completed'&&x.item?.type==='command_execution').map(x=>({command:x.item.command,exitCode:x.item.exit_code,outputHash:hash(x.item.aggregated_output||'')}));
 toolAudit.push({base,index,action:e.action,commands});return events;
}
const advance=(s,e)=>({...s,findings:e.result.findings,coverage:e.result.coverage,limitations:e.result.limitations,roundsUsed:s.roundsUsed+1,history:[...s.history,{action:e.action,contribution:e.result.contribution}]});
for(const id of p.cases)for(let rep=0;rep<p.repetitions;rep++)for(const arm of ['self','graph']){
 const base=`results/paired/${id}.${arm}.rep${rep}`;if(!fs.existsSync(path.join(dir,base+'.json')))continue;
 const r=read(base+'.json'),initial=read('tasks/'+id+'.json');assert.equal(r.valid,true);assert.deepEqual(r.hashes,hashes);assert.equal(r.stateHash,hash(initial));
 let state=structuredClone(initial),action='initial',ei=0,ji=0,toolCount=0,seen=new Set();
 const t=totals[arm]??={arms:0,executorCalls:0,jevCalls:0,toolStarts:0,elapsedMs:0,executorUsage:{},jevUsage:{},outcomes:{}};t.arms++;t.elapsedMs+=r.elapsedMs;t.outcomes[r.outcome]=(t.outcomes[r.outcome]||0)+1;
 for(let i=0;i<r.trace.length;i++){
  const e=r.trace[i];assert.equal(e.type,'execution');assert.equal(e.action,action);execution(e,base,ei,state);ei++;t.executorCalls++;toolCount+=e.toolCalls;for(const u of e.usage)add(t.executorUsage,u);
  if(e.incomplete){assert.equal(r.outcome,e.incomplete);break;}state=advance(state,e);
  const j=r.trace[++i];let decision;
  if(arm==='graph'){
   assert.equal(j.type,'judgment');const request=read(base+`.judge-${state.roundsUsed}.request.json`);assert.deepEqual(request,{model:p.models.routing,state,questions:questionsFor(state)});assert.equal(j.requestHash,hash(request));assert.equal(j.response.model,p.models.routing);decision=route(j.response.answers,state);assert.deepEqual(decision,j.decision);ji++;t.jevCalls++;add(t.jevUsage,j.response.usage);
  }else{assert.equal(j.type,'self_decision');decision=j.decision;assert.equal(decision.action,e.result.next_action);}
  action=decision.action;const signature=hash({action,findings:state.findings,source:state.source}),stop=stopReason(action,state.roundsUsed,signature,seen);
  if(stop){assert.equal(i,r.trace.length-1);assert.equal(r.outcome,stop);assert.deepEqual(r.unresolved,decision.unresolved);break;}seen.add(signature);
 }
 assert.deepEqual(state,r.finalState);assert.equal(toolCount,r.toolCount);assert.ok(ei<=3&&ji<=3&&toolCount<=24);t.toolStarts+=toolCount;
 if(arm==='graph'&&r.outcome==='finalize')assert.equal(r.unresolved.length,0);
 const a=assessments?.paired.find(x=>x.id===id&&x.arm===arm&&x.rep===rep);if(assessments){assert.ok(a);assert.equal(a.artifactSha256,hash(raw(base+'.json')));t.strictPass=(t.strictPass||0)+Number(a.strictPass);}
 rows.push({id,rep,arm,outcome:r.outcome,executorCalls:ei,jevCalls:ji,toolStarts:toolCount,elapsedMs:r.elapsedMs,strictPass:a?.strictPass});
}
for(const id of p.cases)for(let rep=0;rep<p.repetitions;rep++){
 const names=['self','graph'].map(a=>`results/paired/${id}.${a}.rep${rep}.executor-0.request.json`);if(names.every(f=>fs.existsSync(path.join(dir,f))))assert.deepEqual(read(names[0]),read(names[1]));
}
const controls={episodes:0,executorCalls:0,toolStarts:0,elapsedMs:0,executorUsage:{},rows:[]};
for(const id of p.controls.cases)for(let rep=0;rep<p.controls.repetitions;rep++){
 const base=`results/controls/${id}.rep${rep}`;if(!fs.existsSync(path.join(dir,base+'.json')))continue;
 const r=read(base+'.json'),input=read('controls/'+id+'.json');assert.equal(r.valid,true);assert.deepEqual(r.hashes,hashes);assert.equal(r.stateHash,hash(input));let state=structuredClone(input.state),tools=0,observedDecoyRead=false,observedClientRead=false;
 for(const[i,e]of r.trace.entries()){
  const step=input.steps[i];assert.equal(e.action,step.action);if(step.addSource)state={...state,source:{...state.source,...step.addSource},task:step.task};assert.deepEqual(e.suppliedState,state);
  const events=execution(e,base,i,state);const text=events.filter(x=>x.type==='item.completed'&&x.item?.type==='command_execution').map(x=>x.item.aggregated_output||'').join('\n');
  observedDecoyRead ||= text.includes('R4_SCOPE_DECOY_SEEN');observedClientRead ||= text.includes("return 'deleted-despite-cancel'");
  controls.executorCalls++;tools+=e.toolCalls;for(const u of e.usage)add(controls.executorUsage,u);if(e.incomplete)break;state=advance(state,e);
 }
 assert.deepEqual(r.finalState,state);assert.equal(tools,r.toolCount);assert.ok(tools<=24);controls.episodes++;controls.toolStarts+=tools;controls.elapsedMs+=r.elapsedMs;
 const a=assessments?.controls.find(x=>x.id===id&&x.rep===rep);if(assessments){assert.ok(a);assert.equal(a.artifactSha256,hash(raw(base+'.json')));controls.passed=(controls.passed||0)+Number(a.passed===true);controls.ambiguous=(controls.ambiguous||0)+Number(a.passed===null);controls.failed=(controls.failed||0)+Number(a.passed===false);controls.coreAdherencePass=(controls.coreAdherencePass||0)+Number(a.coreAdherencePass);}
 controls.rows.push({id,rep,outcome:r.outcome,observedDecoyRead,observedClientRead,passed:a?.passed,coreAdherencePass:a?.coreAdherencePass});
}
const summary={complete:rows.length===16&&controls.episodes===6,scope:'Four fresh-to-graph tasks, two repetitions; separate synthetic control challenges. No broad holdout or production-readiness claim.',totals,paired:rows,controls};
fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');fs.writeFileSync(path.join(dir,'tool-audit.json'),JSON.stringify(toolAudit,null,2)+'\n');console.log(JSON.stringify({complete:summary.complete,totals,controls},null,2));
