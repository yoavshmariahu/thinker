import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSession, simulate, replay, parsePolicies, renderReplay, POLICIES, WEIGHTS } from '../src/proxy-replay.js';

const req = (input, read, write, out = 10) => ({ t: 'request', input, read, write, out });
const res = tokens => ({ t: 'result', tokens });
const turn = { t: 'turn' }, compact = { t: 'compact' };

test('a clear re-writes the prefix once and every later request reads the cleared tokens no more', () => {
  const items = [turn, req(100, 0, 1000), res(60000), req(100, 61000, 0), res(100), req(100, 61100, 100), req(100, 61300, 50)];
  const as = simulate(items, null);
  assert.equal(as.requests, 4);
  assert.equal(as.base, 2150 + 6250 + 6460 + 6380);
  const r = simulate(items, { keep: 1, trigger: 50000, clearAtLeast: 50000 });
  assert.equal(r.base, as.base);
  // request 2: one result, kept; request 3: the 60k result is cleared, the system prompt (the first request's 1k write)
  // is still read, the rest (61.1k + 100 - 60k - 1k) written again at 2x; request 4: reads 1.3k instead of 61.3k
  assert.equal(r.billed, 2150 + 6250 + (100 + 100 + 400 + 50) + 380);
  assert.equal(r.clears, 1);
  assert.equal(r.cleared, 60000);
  // under the trigger nothing is cleared
  assert.equal(simulate(items, { keep: 1, trigger: 1e6, clearAtLeast: 50000 }).billed, as.base);
});

test('keep turn clears the earlier turns\' results and leaves the current turn\'s', () => {
  const twoTurns = [turn, res(60000), turn, res(100), req(100, 61000, 0)];
  const one = [turn, res(60000), res(100), req(100, 61000, 0)];
  const p = { keep: 'turn', keepMin: 0, trigger: 50000, clearAtLeast: 50000 };
  assert.equal(simulate(twoTurns, p).cleared, 60000, 'the first turn\'s result goes');
  assert.equal(simulate(one, p).cleared, 0, 'in one turn both are kept');
  assert.equal(simulate(twoTurns, { ...p, keepMin: 3 }).cleared, 0, 'keep-min holds the last three whatever the turn');
  // a compaction empties the slate: nothing before it is there to clear
  assert.equal(simulate([turn, res(60000), compact, turn, res(100), req(100, 61000, 0)], p).cleared, 0);
});

test('a transcript is read as requests, results, turns and compactions, a request once by its message id', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-replay-')), 't.jsonl');
  const usage = { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20, output_tokens: 7 };
  fs.writeFileSync(f, [
    { type: 'user', message: { content: 'fix it' } },
    { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'text', text: 'ok' }] } },
    { type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(400) }] } },
    { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'a reminder' }] } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'assistant', message: { id: 'm2', usage: { ...usage, cache_read_input_tokens: 500 }, content: [{ type: 'text', text: 'done' }] } },
  ].map(j => JSON.stringify(j)).join('\n') + '\n');
  const items = readSession(f);
  assert.deepEqual(items.map(i => i.t), ['turn', 'request', 'result', 'compact', 'request']);
  assert.equal(items[2].tokens, 144, '400 characters at 1.44 tokens for four (report.js:CALIBRATION)'); assert.equal(items[2].input, Math.round(2 * 1.44 / 4), 'the call that fetched it, for clear_tool_inputs'); assert.equal(items[1].think, Math.ceil(0 / 4.3)); assert.equal(items[1].model, null);
  assert.equal(items[1].read, 1000);
  const r = replay([f], { p: { keep: 0, trigger: 1, clearAtLeast: 1 } });
  assert.equal(r.all.sessions, 1);
  assert.equal(r.all.base, Math.round(2 * 5 + 0.1 * 1500 + 2 * 40 + 5 * 14));
  assert.equal(r.all.policies.p.clears, 0, 'the one result sits before the compaction, so nothing is ever clearable');
  assert.ok(r.byLength['under 60 requests'].sessions === 1);
  assert.match(renderReplay(r), /All: 1 sessions/);
});

test('policies are parsed from a spec, named ones as a base', () => {
  assert.deepEqual(parsePolicies(''), POLICIES);
  const p = parsePolicies('a=keep:2,trigger:50000,clear:40000;turn=trigger:80000');
  assert.deepEqual(p.a, { keep: 2, trigger: 50000, clearAtLeast: 40000 });
  assert.deepEqual(p.turn, { ...POLICIES.turn, trigger: 80000 });
  assert.throws(() => parsePolicies('x=keep:1'), /needs keep, trigger and clear/);
  assert.equal(WEIGHTS.read, 0.1);
});

test('inputs go with their results, the earlier turns\' thinking rides the same clear, and dollars follow the model\'s list price', () => {
  const r = (input, read, write, out = 10, extra = {}) => ({ t: 'request', input, read, write, out, model: 'claude-opus-5-5', think: 1000, text: 0, ...extra });
  // the reads follow what entered the context: the first request's 1,000 (the prefix), its 1,000 of thinking, the 60k
  // result with its 20k call, the second request's thinking, the second turn's 50, the small result with its call
  const items = [
    { t: 'turn', tokens: 50 }, r(100, 0, 1000), { t: 'result', tokens: 60000, input: 20000 }, r(100, 82000, 0),
    { t: 'turn', tokens: 50 }, r(100, 83050, 50), { t: 'result', tokens: 100, input: 10 }, r(100, 84160, 100),
  ];
  const base = { keep: 'turn', keepMin: 0, trigger: 50000, clearAtLeast: 50000 };
  const plain = simulate(items, base), withInputs = simulate(items, { ...base, inputs: true }), withThinking = simulate(items, { ...base, inputs: true, thinking: 'piggyback' });
  // the second turn's first request clears the first turn's result (60k); with inputs its call's 20k too; with thinking the
  // first turn's two thinking blocks (2k) as well, on the same request, so one break
  assert.equal(plain.clears, 1); assert.equal(plain.cleared, 60000); assert.equal(plain.inputs, 0); assert.equal(plain.thinkingClears, 0);
  assert.equal(withInputs.cleared, 60000); assert.equal(withInputs.inputs, 20000); assert.ok(withInputs.billed < plain.billed, 'the inputs are read no more either');
  assert.equal(withThinking.thinkingClears, 1); assert.equal(withThinking.thinking, 2000); assert.ok(withThinking.billed < withInputs.billed);
  assert.equal(withThinking.clears, 1, 'no clear of its own');
  // the cache holds up to the first removed item (the first request's thinking): the prefix (1,000) and the first turn's
  // text (50) are read; at the clearing request 83,050 - 82,000 = 1,050 is left to read, all of it held, so the write is
  // the request's own 50; the request after reads 84,160 - 82,000
  assert.equal(withThinking.billed, (100 + 0 + 2 * 1000 + 50) + (100 + 0.1 * 82000 + 0 + 50) + (100 + 0.1 * 1050 + 2 * 50 + 50) + (100 + 0.1 * 2160 + 2 * 100 + 50));
  // the results alone: 60k cleared, 23,050 left to read at the clearing request, of which the prefix, the turn text and
  // (the first request's thinking, 1,000, sits before the result and is kept too, so 2,050 is held)
  assert.equal(plain.billed, (100 + 0 + 2 * 1000 + 50) + (100 + 0.1 * 82000 + 0 + 50) + (100 + 0.1 * 2050 + 2 * (50 + 23050 - 2050) + 50) + (100 + 0.1 * 24160 + 2 * 100 + 50));
  // dollars at Opus 5.5's list rates: $4 input, $0.20 a cache read, $8 a 1h write, $20 output per million
  assert.ok(Math.abs(plain.baseUsd - ((400 * 4 + (82000 + 83050 + 84160) * 0.2 + (1000 + 50 + 100) * 8 + 40 * 20) / 1e6)) < 1e-9);
  assert.ok(plain.usd > plain.baseUsd, 'in dollars the results-only clear costs more than it saves here: the rewrite at $8 against reads at $0.20');
  assert.ok(withThinking.usd < plain.usd);
  assert.equal(simulate([{ t: 'turn' }, { ...r(100, 0, 1000), model: 'mystery-9' }], null).baseUsd, null, 'an unpriced model has no dollars');
  // the spec names the two: inputs on, thinking piggyback or off
  const p = parsePolicies('a=keep:turn,trigger:50000,clear:50000,inputs:on,thinking:piggyback;inputs-thinking=thinking:off');
  assert.deepEqual(p.a, { keep: 'turn', trigger: 50000, clearAtLeast: 50000, inputs: true, thinking: 'piggyback' });
  assert.equal(p['inputs-thinking'].thinking, undefined, 'a named policy as the base, one field turned off'); assert.equal(p['inputs-thinking'].inputs, true);
  assert.throws(() => parsePolicies('x=keep:1,trigger:1,clear:1,thinking:sliding'), /piggyback or off/);
  assert.deepEqual(Object.keys(POLICIES), ['shipped', 'inputs', 'inputs-thinking', 'count-3', 'turn']);
  const out = renderReplay(replay([], POLICIES));
  assert.match(out, /^All: 0 sessions, 0 billed-equivalent tokens as recorded/); assert.match(out, /inputs-thinking  keep turn \(min 3\)  trigger 100000 clear 80000 \+inputs \+thinking: saves   0\.0% billed-eq, 0 sessions costlier, 0 clears, 0 results cleared/);
});
