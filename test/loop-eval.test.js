import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopLimits, LOOP_DEFAULTS, acceptanceOf, criteriaBlock, checkerPrompt, verdict, feedback, usageDelta, stopReason } from '../bench/loop.js';

const ACC = [
  { id: 'a1', criterion: 'Tool calls get consecutive indices across the stream' },
  { id: 'a2', criterion: 'Provider tests pass', command: 'pytest tests/gateway/providers -q' },
  { id: 'a3', criterion: 'The running gateway returns two tool calls', check: 'e2e', essential: false },
];

test('loop limits default, read the runner flags, and refuse nonsense', () => {
  assert.deepEqual(loopLimits({}), LOOP_DEFAULTS);
  assert.deepEqual(loopLimits({ iterations: '3', 'iteration-min': '5', 'session-min': '20', 'token-cap': '2000000' }), { iterations: 3, iterationMin: 5, sessionMin: 20, tokenCap: 2000000 });
  assert.throws(() => loopLimits({ iterations: '0' }), /iterations/);
  assert.throws(() => loopLimits({ 'session-min': 'x' }), /sessionMin/);
});

test('acceptance criteria are essential unless marked otherwise, and incomplete entries are dropped', () => {
  const a = acceptanceOf({ acceptance: [...ACC, { id: 'a4' }, null] });
  assert.deepEqual(a.map(c => [c.id, c.essential]), [['a1', true], ['a2', true], ['a3', false]]);
  assert.deepEqual(acceptanceOf({}), []);
});

test('the solver and the checker are shown the criteria, the checker never the answer', () => {
  const a = acceptanceOf({ acceptance: ACC });
  const block = criteriaBlock(a);
  for (const c of a) assert.ok(block.includes(c.criterion));
  assert.match(block, /checked with: pytest tests\/gateway\/providers -q/);
  const p = checkerPrompt('Fix the stream indices.', a);
  assert.match(p, /a3: The running gateway/); assert.match(p, /a1 \(essential\)/);
  assert.doesNotMatch(p, /a3 \(essential\)/, 'an optional criterion is not called essential');
});

test('done means every essential criterion met; an unreported criterion is not met', () => {
  const a = acceptanceOf({ acceptance: ACC });
  assert.equal(verdict(a, [{ id: 'a1', met: true, evidence: 'ran' }, { id: 'a2', met: true, evidence: 'green' }]).done, true, 'the optional e2e criterion does not block done');
  const v = verdict(a, [{ id: 'a1', met: true, evidence: 'ran' }]);
  assert.equal(v.done, false);
  assert.equal(v.results.find(r => r.id === 'a2').evidence, 'not reported by the checker');
  assert.equal(verdict(a, 'garbage').done, false);
});

test('feedback names the unmet criteria with the checker\'s evidence, and nothing met', () => {
  const a = acceptanceOf({ acceptance: ACC });
  const f = feedback(a, verdict(a, [{ id: 'a1', met: true, evidence: 'ok' }, { id: 'a2', met: false, evidence: 'test_stream failed: index 0 != 1' }]));
  assert.match(f, /a2: Provider tests pass/); assert.match(f, /index 0 != 1/);
  assert.match(f, /a3 \(optional\)/);
  assert.doesNotMatch(f, /a1:/);
});

test('a resumed iteration\'s usage is its difference from the thread total', () => {
  // codex exec resume reports the thread total on every turn (codex-cli 0.162.1)
  const t1 = { input_tokens: 15573, cached_input_tokens: 12288, output_tokens: 5 };
  const t2 = { input_tokens: 32188, cached_input_tokens: 27648, output_tokens: 12 };
  assert.deepEqual(usageDelta(null, t1), { input_tokens: 15573, cached_input_tokens: 12288, output_tokens: 5 });
  assert.deepEqual(usageDelta(t1, t2), { input_tokens: 16615, cached_input_tokens: 15360, output_tokens: 7 });
});

test('the loop stops at done, then at the first limit hit', () => {
  const limits = { iterations: 3, iterationMin: 10, sessionMin: 30, tokenCap: 1e6 };
  const at = o => stopReason({ done: false, n: 1, limits, elapsedMs: 0, solverInTokens: 0, timedOut: false, ...o });
  assert.equal(at({ done: true, n: 3 }), 'done');
  assert.equal(at({}), null);
  assert.equal(at({ timedOut: true }), 'iteration_timeout');
  assert.equal(at({ elapsedMs: 30 * 60_000 }), 'session_timeout');
  assert.equal(at({ solverInTokens: 1e6 }), 'token_cap');
  assert.equal(at({ n: 3 }), 'max_iterations');
  assert.equal(stopReason({ done: false, n: 2, limits: { ...limits, tokenCap: null }, elapsedMs: 0, solverInTokens: 9e9, timedOut: false }), null, 'no token cap, no token stop');
});
