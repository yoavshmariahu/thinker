// A turn that runs for a hundred tool calls is cut into; a conversation's turn is not.
//
// The shape here is the one the container e2e found on 2026-11-13 (demo/e2e): one prompt, sixteen calls,
// context past the trigger, and every call refused `nothing-to-cut` because the whole conversation sat
// inside the turn in progress and the turn was protected whole. An autonomous job has no second prompt, so
// that protection never lifted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutCandidates, measurePrompt, PROXY_DEFAULTS } from '../src/proxy.js';
import { decideCut, openTurn, freshCut } from '../src/cutting.js';

const BIG = 'x'.repeat(120_000);   // ~53k tokens a result, so a few of them pass any trigger

// One prompt, then n read/result pairs and no second prompt: an autonomous job.
const job = n => {
  const ms = [{ role: 'user', content: [{ type: 'text', text: 'fix the ticket' }] }];
  for (let i = 0; i < n; i++) ms.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { path: `src/m${i}.py` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: BIG }] });
  return { model: 'claude-opus-5-5', messages: ms };
};
// The same work as a conversation: a prompt every few calls.
const chat = (turns, per) => {
  const ms = [];
  let k = 0;
  for (let t = 0; t < turns; t++) {
    ms.push({ role: 'user', content: [{ type: 'text', text: `step ${t}` }] });
    for (let i = 0; i < per; i++, k++) ms.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${k}`, name: 'Read', input: { path: `src/m${k}.py` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: BIG }] });
  }
  return { model: 'claude-opus-5-5', messages: ms };
};
const run = (body, cfg) => {
  const c = { ...PROXY_DEFAULTS, ...cfg };
  const m = measurePrompt(c, body);
  const open = openTurn(c, m);
  const cand = cutCandidates(body.messages, { keepMin: c.keepMin, cut: [], openTurn: open });
  return { m, open, cand, d: decideCut(freshCut('s'), c, m, { cand, open, model: body.model }) };
};

test('a one-prompt job is never cut as things stand, however large it grows', () => {
  const r = run(job(12), {});
  assert.ok(r.m.inTurn > PROXY_DEFAULTS.trigger, 'the turn alone is well past the trigger');
  assert.equal(r.m.prompt < PROXY_DEFAULTS.trigger, true, 'and the trigger never sees it: the prompt it measures leaves the turn out');
  assert.equal(r.open, false, 'off by default');
  assert.equal(r.cand.ids.length, 0, 'nothing is even a candidate');
  assert.equal(r.d.clear, false);
  assert.equal(r.d.reason, 'nothing-to-cut', 'which is exactly what the containers logged on all 16 calls');
});

test('with the long-turn rule on, the same job is cut and keeps the newest results', () => {
  const r = run(job(12), { longTurn: true });
  assert.equal(r.open, true, 'the turn put a trigger\'s worth of results in by itself');
  assert.equal(r.d.clear, true, 'and the cut fires inside the turn');
  assert.ok(r.d.cut.length >= 1);
  for (const id of ['t11', 't10', 't9']) assert.ok(!r.d.cut.includes(id), `the newest results are kept (${id}), as in any other stretch`);
  assert.ok(r.d.cut.includes('t0'), 'what it finished with first is what goes first');
  assert.match(r.d.policy, /-lt$/, 'and the saving names the policy that made it, so it is never compared with one made without');
});

test('a conversation is untouched: its turns never reach the rule', () => {
  const body = chat(4, 3);
  const off = run(body, {});
  const on = run(body, { longTurn: true });
  assert.ok(on.m.inTurn < PROXY_DEFAULTS.trigger, 'a turn of three reads is not a long turn');
  assert.equal(on.open, false);
  assert.deepEqual(on.d.cut, off.d.cut, 'the same cut either way');
  assert.equal(on.d.clear, off.d.clear);
  assert.equal(on.d.policy.endsWith('-lt'), true, 'the id still says the rule was on, because a reader must not have to guess');
});

test('inside a long turn the floor and the payback do the pacing a boundary used to do', () => {
  const cfg = { longTurn: true };
  const first = run(job(12), cfg);
  assert.equal(first.d.clear, true);
  // the same turn one call later, with what it already cut on the record: nothing new has piled up
  const rec = { ...freshCut('s'), cut: first.d.cut, turn: first.d.turn };
  const body = job(12);
  const m = measurePrompt({ ...PROXY_DEFAULTS, ...cfg }, body);
  const open = openTurn({ ...PROXY_DEFAULTS, ...cfg }, m);
  const cand = cutCandidates(body.messages, { keepMin: 3, cut: rec.cut, openTurn: open });
  const again = decideCut(rec, { ...PROXY_DEFAULTS, ...cfg }, m, { cand, open, model: body.model });
  assert.equal(again.clear, false, 'no second cut until another floor\'s worth of results is finished with');
  assert.ok(['nothing-to-cut', 'below-clear-minimum'].includes(again.reason), `paced by size, not by the turn (${again.reason})`);
});
