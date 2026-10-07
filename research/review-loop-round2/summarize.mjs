// Offline audit only. Manual semantic assessments are pinned to complete arm artifacts.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {route,stopReason} from './policy.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
const raw=f=>fs.readFileSync(path.join(dir,f));
const read=f=>JSON.parse(raw(f));
const hash=v=>createHash('sha256').update(Buffer.isBuffer(v)?v:JSON.stringify(v)).digest('hex');
const protocol=read('protocol.json'), pins=read('inputs.sha256.json'), assessments=read('assessments.json');
const hashes=Object.fromEntries(['run.mjs','clients.mjs','policy.mjs','questions.json','protocol.json'].map(f=>[f,hash(raw(f))]));
const questions=read('questions.json');
const totals={};
const addUsage=(dst,usage)=>{for(const [k,v] of Object.entries(usage)) if(typeof v==='number') dst[k]=(dst[k]||0)+v;};
const rows=[];
for(const id of protocol.cases){
 assert.equal(hash(raw(`scenarios/${id}.json`)),pins[id+'.json']);
 const scenario=read(`scenarios/${id}.json`);
 if(id.startsWith('A-')) assert.equal(hash(raw(`../review-loop-pilot/scenarios/${id}.json`)),pins[id+'.json']);
 const open=read(`results/open-loop/${id}.json`);
 assert.deepEqual(open.hashes,hashes);assert.equal(open.stateHash,hash(scenario.state));
 assert.equal(open.response.model,protocol.models.routing);
 for(const policy of protocol.closedLoop.policies) assert.deepEqual(open.decisions[policy],route(open.response.answers,scenario.state,policy));
 for(let rep=0;rep<2;rep++) for(const policy of ['v2','v3']){
  const base=`results/closed-loop/${id}.${policy}.rep${rep}`,r=read(base+'.json');
  const assessment=assessments.arms.find(a=>a.id===id&&a.rep===rep&&a.policy===policy);
  assert.ok(assessment);assert.equal(assessment.artifactSha256,hash(raw(base+'.json')));
  assert.equal(r.valid,true);assert.deepEqual(r.hashes,hashes);assert.equal(r.stateHash,hash(scenario.state));
  let state=structuredClone(scenario.state),seen=new Set(),ji=0,ei=0;
  const t=totals[policy]??={arms:0,criteriaMet:0,finalize:0,manual_review:0,executorCalls:0,jevCalls:0,elapsedMs:0,jevUsage:{},executorUsage:{}};
  t.arms++;t.criteriaMet+=Number(assessment.meetsFrozenCriterion);t[r.outcome]++;t.elapsedMs+=r.elapsedMs;
  for(let i=0;i<r.trace.length;i++){
   const j=r.trace[i];assert.equal(j.type,'judgment');
   const saved=read(base+`.judge-${ji}.json`),request=read(base+`.judge-${ji}.request.json`);
   assert.deepEqual(request,{model:protocol.models.routing,state,questions});assert.equal(saved.requestHash,hash(request));
   assert.deepEqual(saved.response,j.response);assert.equal(j.response.model,protocol.models.routing);
   assert.deepEqual(j.decision,route(j.response.answers,state,policy));
   t.jevCalls++;ji++;addUsage(t.jevUsage,j.response.usage);
   const signature=hash({action:j.decision.action,findings:state.findings,source:state.source});
   const stop=stopReason(j.decision,state.roundsUsed,signature,seen);
   if(stop){assert.equal(i,r.trace.length-1);assert.equal(stop,r.outcome);assert.deepEqual(r.unresolved,j.decision.unresolved);break;}
   seen.add(signature);
   const e=r.trace[++i],er=read(base+`.executor-${ei}.request.json`);
   assert.equal(e.type,'execution');assert.equal(e.action,j.decision.action);
   assert.equal(er.model,protocol.models.executor);assert.equal(er.effort,protocol.models.executorReasoningEffort);
   assert.equal(e.model,protocol.models.executor);assert.equal(e.effort,protocol.models.executorReasoningEffort);
   assert.ok(er.args.includes('model_reasoning_effort="high"'));assert.ok(er.args.includes(protocol.models.executor));
   t.executorCalls++;ei++;for(const u of e.usage)addUsage(t.executorUsage,u);
   if(e.action==='inspect_callers')state.source={...state.source,additionalCallerContext:scenario.additionalSource};
   state={...state,findings:e.result.findings,coverage:e.result.coverage,limitations:e.result.limitations,roundsUsed:state.roundsUsed+1,history:[...state.history,{action:e.action,contribution:e.result.contribution}]};
  }
  assert.ok(ji<=3&&ei<=2);assert.deepEqual(r.finalState,state);
  if(policy==='v3'&&r.outcome==='finalize')assert.equal(r.unresolved.length,0);
  rows.push({id,rep,policy,outcome:r.outcome,criterionMet:assessment.meetsFrozenCriterion,executorCalls:ei,jevCalls:ji,elapsedMs:r.elapsedMs});
 }
 // Identical first-action prompts and invocation settings for matched executed arms.
 for(let rep=0;rep<2;rep++){
  const names=['v2','v3'].map(p=>`results/closed-loop/${id}.${p}.rep${rep}.executor-0.request.json`);
  if(names.every(f=>fs.existsSync(path.join(dir,f))))assert.deepEqual(read(names[0]),read(names[1]));
 }
}
assert.equal(rows.length,20);assert.equal(assessments.arms.length,20);
const openLoop={calls:5,usage:{}};
for(const id of protocol.cases)addUsage(openLoop.usage,read(`results/open-loop/${id}.json`).response.usage);
const summary={scope:'Experimental five-case controller study, two repetitions. Not a production or held-out benchmark.',audits:'Passed source/input pins, replay, state transitions, ceilings, exact model/effort invocation pins, and matching first-action prompts where both arms execute.',modelIdentityLimit:'Executor identity validated from invocation only; CLI does not echo model.',totals,openLoop,rows};
fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({totals,openLoop},null,2));
