import test from 'node:test';
import assert from 'node:assert/strict';
import {route, stopReason} from './policy.mjs';
const a = (support='supported', coverage='accounted_for', intent='settled', action='finalize') => Object.fromEntries(Object.entries({claim_support:support,coverage,intent_status:intent,next_action:action}).map(([k,v])=>[k,{choice:v,confidence:0.2}]));
const state = {findings:[{message:'A claim'}]};
test('finalize cannot override an unresolved support judgment',()=>{
  for(const support of ['overclaimed','contradicted','insufficient']) {
    assert.equal(route(a(support),state,'v2').action,'finalize');
    assert.equal(route(a(support),state,'v3').action,'verify_existing');
  }
});
test('coverage gaps and unknown coverage prevent finalization',()=>{
  for(const coverage of ['gap','unknown']) assert.equal(route(a('supported',coverage),state,'v3').action,'investigate_remaining');
});
test('conflicting intent takes precedence even with no findings',()=>{
  const d=route(a('supported','accounted_for','needs_human'),{findings:[]},'v3');
  assert.equal(d.action,'manual_review');assert(d.unresolved.length);
});
test('a bounded clean report can finish despite diffuse action confidence',()=>{
  const d=route(a(),{findings:[]},'v3');assert.equal(d.action,'finalize');assert.deepEqual(d.unresolved,[]);
});
test('exhaustion retains the unresolved concern and cannot become a pass',()=>{
  const d=route(a('overclaimed'),state,'v3');assert.equal(stopReason(d,2,'new',new Set()),'incomplete_budget');assert(d.unresolved.length);
});
test('repeat unchanged evidence stops and new hypotheses cannot reset budget',()=>{
  const d=route(a('overclaimed'),state,'v3');assert.equal(stopReason(d,1,'same',new Set(['same'])),'incomplete_stalled');
  assert.equal(stopReason({...d,action:'inspect_callers'},2,'different',new Set()),'incomplete_budget');
});
test('unknown or missing model decisions cannot authorize a transition',()=>{
  assert.throws(()=>route({},state,'v3'));assert.throws(()=>route(a('supported','accounted_for','settled','edit_source'),state,'v3'));
});
test('support concern without existing claims routes to investigation',()=>{
  assert.equal(route(a('insufficient'),{findings:[]},'v3').action,'investigate_remaining');
});
