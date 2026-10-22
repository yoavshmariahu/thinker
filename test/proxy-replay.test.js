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
  assert.equal(items[2].tokens, 100);
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
