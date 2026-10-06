import test from 'node:test';
import assert from 'node:assert/strict';
import { startThoroughness, finishThoroughness, renderThoroughness } from '../src/review-thoroughness.js';
import { GATES } from '../src/gates.js';
import { buildReview } from '../src/review-post.js';
import { renderVerification } from '../src/verification.js';

const gate = score => ({ source: 'jev', gates: Object.fromEntries(Object.entries(GATES).map(([k,v]) => [k,{p: score, run: score >= v.act}])) });
const change = {files:[]};

test('audit records effective overrides, skipped work and recommendations without claiming tests ran', () => {
  const a = startThoroughness(gate(0.59999), {verify: true, callers: false}, {verify: true, callers: false}, change, []);
  const v = a.decisions.find(d => d.step === 'verify');
  assert.equal(v.score, 0.59999);
  assert.equal(v.recommended, false);
  assert.equal(v.selected, true);
  assert.equal(v.source, 'caller');
  assert.equal(v.caseReason, null);
  finishThoroughness({ thoroughness: a, verdicts: [{}], errors: [], chunks: 1 });
  assert.equal(v.status, 'no-eligible-findings');
  assert.equal(a.decisions.find(d => d.step === 'callers').status, 'skipped');
  assert.equal(a.decisions.find(d => d.step === 'tests').status, 'recommended-only');
  assert.match(renderThoroughness(a), /Test recommendations do not establish execution/);
});

test('fallback, dry run and baseline are visible and never attributed to Jev', () => {
  for (const [g, opts, source] of [[{source:'error'}, {}, 'fallback'], [null, {dry:true}, 'dry-run'], [null,{baseline:true},'baseline']]) {
    const a = startThoroughness(g, {}, {verify:false}, change, [], opts);
    assert.ok(a.decisions.every(d => d.source === source));
    assert.equal(a.gateInput, null);
    finishThoroughness({thoroughness:a,verdicts:[],errors:[],chunks:1},opts);
    assert.equal(a.summary.calls, 0);
  }
});

test('PR and proof reports show original claims and verifier limitations without exposing stored code context', () => {
  const a = startThoroughness(gate(0.9), {}, {verify:true}, change, []);
  a.verifications.push({before:{file:'src/a.js',line:8,severity:'error',message:'Recovery breaks <script>',evidence:'initial evidence'},after:{severity:'warning'},outcome:'retained',reason:'Local failure confirmed; downstream recovery not shown.',tokens:30,elapsedMs:50,context:{around:'PRIVATE_CONTEXT_SENTINEL'}});
  finishThoroughness({thoroughness:a,verdicts:[{}],errors:[],chunks:1});
  const r = {thoroughness:a,findings:[],counts:{error:0,warning:0,info:0},notes:{consulted:1},errors:[]};
  const outputs = [buildReview(r,{quiet:false}).body, renderVerification({status:'passed',checks:[],review:r})];
  for (const body of outputs) {
    assert.match(body, /error → warning/);
    assert.match(body, /downstream recovery not shown/);
    assert.match(body, /Added value: not yet adjudicated/);
    assert.doesNotMatch(body, /PRIVATE_CONTEXT_SENTINEL|<script>/);
  }
});
