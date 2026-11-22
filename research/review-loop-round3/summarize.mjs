// Offline trace/control audit. Semantic and action-adherence judgments remain manual.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {hash} from './clients.mjs';import {route,stopReason} from './policy.mjs';import {questionsFor} from './questions.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));const raw=f=>fs.readFileSync(path.join(dir,f)),read=f=>JSON.parse(raw(f));
const p=read('protocol.json'),pins=read('inputs.sha256.json');
const files=['run.mjs','clients.mjs','policy.mjs','questions.mjs','protocol.json','prepare.py','transport.mjs','../review-loop-round2/policy.mjs','../review-loop-round2/questions.json'];
const hashes=Object.fromEntries(files.map(f=>[f,hash(raw(f))]));
for(const[f,h]of Object.entries(pins))assert.equal(hash(raw(f)),h);
const amendments=read('transport-amendment.json');const compatible=h=>JSON.stringify(h)===JSON.stringify(hashes)||amendments.acceptedPriorHashes.some(x=>JSON.stringify(x)===JSON.stringify(h));
for(const prior of amendments.acceptedPriorHashes){
 assert.equal(prior['run.mjs'],hash(raw('results/transport-amendment/run.before.mjs.txt')));
 assert.ok([hash(raw('results/transport-amendment/clients.before.mjs.txt')),hash(raw('results/interface-recovery/clients.original.mjs.txt'))].includes(prior['clients.mjs']));
 for(const[f,h]of Object.entries(prior))if(!['run.mjs','clients.mjs'].includes(f))assert.equal(h,hashes[f]);
}
assert.equal(raw('results/transport-amendment/clients.before.mjs.txt').toString(),raw('results/interface-recovery/clients.original.mjs.txt').toString().replace("['error','warning','info'].includes(f.severity)","typeof f.severity==='string'&&f.severity.length>0"));
assert.equal(raw('clients.mjs').toString(),raw('results/transport-amendment/clients.before.mjs.txt').toString().replace("import {jevEvaluate,jevKey,JEV_ENDPOINT} from '../../src/jev.js';","import {jevKey,JEV_ENDPOINT} from '../../src/jev.js';\nimport {jevEvaluate} from './transport.mjs';"));
const totals={},rows=[],tools=[];
const add=(dst,u)=>{for(const[k,v]of Object.entries(u||{}))if(typeof v==='number')dst[k]=(dst[k]||0)+v;};
const assessments=fs.existsSync(path.join(dir,'assessments.json'))?read('assessments.json'):null;
for(const id of p.cases)for(let rep=0;rep<p.repetitions;rep++)for(const arm of ['self','graph']){
 const base=`results/paired/${id}.${arm}.rep${rep}`;if(!fs.existsSync(path.join(dir,base+'.json')))continue;
 const r=read(base+'.json'),initial=read('tasks/'+id+'.json');assert.equal(r.valid,true);assert.ok(compatible(r.hashes));assert.equal(r.stateHash,hash(initial));
 let state=structuredClone(initial),action='initial',ei=0,ji=0,seen=new Set(),commands=0;
 const t=totals[arm]??={arms:0,executorCalls:0,jevCalls:0,toolStarts:0,elapsedMs:0,executorUsage:{},jevUsage:{},outcomes:{}};
 t.arms++;t.elapsedMs+=r.elapsedMs;t.outcomes[r.outcome]=(t.outcomes[r.outcome]||0)+1;
 for(let i=0;i<r.trace.length;i++){
  const e=r.trace[i];assert.equal(e.type,'execution');assert.equal(e.action,action);
  const request=read(base+`.executor-${ei}.request.json`),events=read(base+`.executor-${ei}.events.json`);
  assert.equal(request.model,p.models.executor);assert.equal(request.effort,p.models.executorReasoningEffort);
  assert.ok(request.args.includes(p.models.executor));assert.ok(request.args.includes('model_reasoning_effort="high"'));assert.ok(request.args.includes('read-only'));
  assert.equal(e.model,p.models.executor);assert.equal(e.effort,p.models.executorReasoningEffort);
  const starts=events.filter(x=>x.type==='item.started'&&x.item?.type==='command_execution');assert.equal(starts.length,e.toolCalls);
  commands+=starts.length;t.executorCalls++;ei++;for(const u of e.usage)add(t.executorUsage,u);
  for(const event of events.filter(x=>x.type==='item.completed'&&x.item?.type==='command_execution'))tools.push({id,arm,rep,execution:ei-1,action,command:event.item.command,exitCode:event.item.exit_code,outputHash:hash(event.item.aggregated_output||'')});
  if(e.incomplete){assert.equal(r.outcome,e.incomplete);assert.equal(i,r.trace.length-1);break;}
  state={...state,findings:e.result.findings,coverage:e.result.coverage,limitations:e.result.limitations,roundsUsed:state.roundsUsed+1,history:[...state.history,{action,contribution:e.result.contribution}]};
  const j=r.trace[++i];let decision;
  if(arm==='graph'){
   assert.equal(j.type,'judgment');const req=read(base+`.judge-${state.roundsUsed}.request.json`);
   assert.deepEqual(req,{model:p.models.routing,state,questions:questionsFor(state)});assert.equal(j.requestHash,hash(req));assert.equal(j.response.model,p.models.routing);
   decision=route(j.response.answers,state);assert.deepEqual(j.decision,decision);t.jevCalls++;ji++;add(t.jevUsage,j.response.usage);
  }else{assert.equal(j.type,'self_decision');decision=j.decision;assert.equal(decision.action,e.result.next_action);}
  action=decision.action;const signature=hash({action,findings:state.findings,source:state.source});const stop=stopReason(action,state.roundsUsed,signature,seen);
  if(stop){assert.equal(i,r.trace.length-1);assert.equal(stop,r.outcome);assert.deepEqual(r.unresolved,decision.unresolved);break;}seen.add(signature);
 }
 assert.deepEqual(state,r.finalState);assert.equal(commands,r.toolCount);assert.ok(ei<=3&&ji<=3&&commands<=24);t.toolStarts+=commands;
 if(arm==='graph'&&r.outcome==='finalize')assert.equal(r.unresolved.length,0);
 const a=assessments?.arms.find(x=>x.id===id&&x.rep===rep&&x.arm===arm);
 if(assessments){assert.ok(a);assert.equal(a.artifactSha256,hash(raw(base+'.json')));t.strictPass=(t.strictPass||0)+Number(a.strictPass);}
 rows.push({id,arm,rep,outcome:r.outcome,executorCalls:ei,jevCalls:ji,toolStarts:commands,elapsedMs:r.elapsedMs,strictPass:a?.strictPass});
}
for(const id of p.cases)for(let rep=0;rep<p.repetitions;rep++){
 const names=['self','graph'].map(a=>`results/paired/${id}.${a}.rep${rep}.executor-0.request.json`);
 if(names.every(f=>fs.existsSync(path.join(dir,f))))assert.deepEqual(read(names[0]),read(names[1]));
}
const open={calls:0,usage:{}};
for(const id of p.openLoop.cases){const r=read('results/open-loop/'+id+'.json'),state=read('open-inputs/'+id+'.json');const originalClient=hash(raw('results/interface-recovery/clients.original.mjs.txt'));const originalRun=hash(raw('results/transport-amendment/run.before.mjs.txt'));const originalHashes={...hashes,'clients.mjs':originalClient,'run.mjs':originalRun};delete originalHashes['transport.mjs'];assert.deepEqual(r.hashes,originalHashes);assert.equal(r.stateHash,hash(state));assert.deepEqual(r.decision,route(r.response.answers,state));open.calls++;add(open.usage,r.response.usage);}
const result={complete:rows.length===16,limits:'Development cases, invocation-only executor identity, manual unblinded quality audit; no general benefit claim.',totals,openLoop:open,rows};
fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(result,null,2)+'\n');fs.writeFileSync(path.join(dir,'tool-audit.json'),JSON.stringify(tools,null,2)+'\n');console.log(JSON.stringify({complete:result.complete,totals},null,2));
