import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => JSON.parse(fs.readFileSync(path.join(dir, f)));
const hash = x => createHash('sha256').update(x).digest('hex');
const protocol = read('protocol.json');
const assessments = read('assessments.json');
const pins = read('inputs.sha256.json');
const summary = {status: 'experimental pilot complete', terminology: protocol.terminology, cases: [], totals: {}};
const metrics = row => {
  let executorCalls = 0, executorInputTokens = 0, executorOutputTokens = 0, executorCachedInputTokens = 0, jevCalls = 0, jevInputTokens = 0, jevOutputTokens = 0;
  for (const t of row.trace) {
    if (t.type === 'execution') {
      assert.equal(t.model, protocol.models.executor); assert.equal(t.effort, protocol.models.executorReasoningEffort);
      executorCalls++;
      for (const u of t.usage) {executorInputTokens += u.input_tokens; executorOutputTokens += u.output_tokens; executorCachedInputTokens += u.cached_input_tokens || 0;}
    }
    if (t.type === 'judgment') {
      assert.equal(t.response.model, protocol.models.routing); jevCalls++;
      jevInputTokens += t.response.usage.input_tokens; jevOutputTokens += t.response.usage.output_tokens;
    }
  }
  return {executorCalls, executorInputTokens, executorOutputTokens, executorCachedInputTokens, jevCalls, jevInputTokens, jevOutputTokens, elapsedMs: row.elapsedMs};
};
for (const id of protocol.cases) {
  const raw = fs.readFileSync(path.join(dir, 'scenarios', id + '.json'));
  assert.equal(hash(raw), pins[id + '.json']);
  const expected = hash(JSON.stringify(JSON.parse(raw).state));
  const original = read(`results/closed-loop/${id}.fixed_verify.json`);
  const v1 = read(`results/closed-loop/${id}.jev_routed.json`);
  const v2 = read(`results/closed-loop-v2/${id}.jev_routed.json`);
  const row = {id, openLoop: read(`results/open-loop/${id}.json`).response.answers, arms: {}, assessment: assessments[id]};
  for (const [name, r] of [['fixed_verify', original], ['jev_v1', v1], ['jev_v2', v2]]) {
    assert(r.valid); assert.equal(r.stateHash, expected);
    assert.equal(r.protocolHash, hash(fs.readFileSync(path.join(dir, 'protocol.json'))));
    const knownHarnesses = ['run.mjs', 'harness-v1.mjs.txt'].map(f => hash(fs.readFileSync(path.join(dir, f))));
    assert(knownHarnesses.includes(r.sourceHash), 'Unknown harness revision');
    if (name === 'jev_v2') assert.equal(r.policyHash, hash(fs.readFileSync(path.join(dir, 'protocol-v2.json'))));
    assert(r.finalState.roundsUsed <= 2);
    const m = metrics(r);
    row.arms[name] = {outcome: r.outcome, actions: r.trace.filter(t => t.type === 'execution').map(t => t.action), ...m};
    summary.totals[name] ||= Object.fromEntries(Object.keys(m).map(k => [k, 0]));
    for (const [k, value] of Object.entries(m)) summary.totals[name][k] += value;
  }
  if (v2.trace.some(t => t.type === 'execution' && t.action === 'verify_existing')) {
    assert.deepEqual(read(`results/closed-loop/${id}.fixed_verify.executor-0.request.json`), read(`results/closed-loop-v2/${id}.jev_routed.executor-0.request.json`));
  }
  summary.cases.push(row);
}
summary.probes = read('results/probes/results.json');
summary.invalidAttempts = [
  {kind: 'sandbox DNS failure', modelCallsCompleted: 0, artifact: 'results/invalid-sandbox-attempt'},
  {kind: 'harness rejected benign CLI warnings', modelCallsCompleted: 1, artifact: 'results/invalid-warning-parser-attempt', usage: read('results/invalid-warning-parser-attempt/A-10349.fixed_verify.executor-0.events.json').filter(e => e.type === 'turn.completed').map(e => e.usage)}
];
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary.totals, null, 2));
