import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delegatedOf } from '../src/delegated.js';
import { weeklySavings } from '../src/report-savings.js';
import { listPrice, costOf } from '../src/prices.js';
import { noteFiring } from '../src/delegate.js';

const T = m => Date.parse(`2026-11-15T10:${String(m).padStart(2, '0')}:00Z`);
const call = (m, extra = {}) => ({ t: T(m), agent: 'main', ...extra });
const read = (m, file, chars) => ({ t: 'tool', name: 'Read', input: { file_path: file }, result: 'x'.repeat(chars), at: T(m) });
const prompt = m => ({ t: 'prompt', text: 'p', at: T(m) });
const fire = (m, tokens = 40000, file = '/r/core.py') => ({ t: T(m), tokens, files: [file], agent: 'Explore' });

test('delegatedOf: the write once, the reads from the second later call, until a cut or a compaction', () => {
  const calls = [call(0), call(2), call(3), call(4), call(5), call(9)];
  const p = { events: [prompt(0), prompt(8)], calls };
  assert.equal(delegatedOf(p, []), null, 'nothing fired, nothing recorded');
  // five later calls: the first would have written it, four would have read it back
  assert.deepEqual(delegatedOf(p, [fire(1)]), { reads: 1, tokens: 40000, laterTokens: 4 * 40000, ignored: 0, agents: [] });
  // a cut at minute 4.5 would have taken it: calls 2, 3, 4 are later, so two reads
  assert.equal(delegatedOf(p, [fire(1)], { cuts: [T(4) + 30000] }).laterTokens, 2 * 40000);
  // so would a compaction (the call after it is flagged)
  assert.equal(delegatedOf({ ...p, calls: [call(0), call(2), call(3), call(4, { compaction: true }), call(5)] }, [fire(1)]).laterTokens, 40000);
  // a subagent's calls are not the lead's
  assert.equal(delegatedOf({ ...p, calls: [...calls, call(6, { agent: 'a1' }), call(7, { agent: 'a1' })] }, [fire(1)]).laterTokens, 4 * 40000);
});

test('delegatedOf: a file the lead read whole anyway kept nothing out; a ranged read of it still did', () => {
  const calls = [call(0), call(2), call(3)];
  const whole = { events: [prompt(0), read(2, '/r/core.py', 60000)], calls };   // ~26.7k tokens of a 40k file
  assert.deepEqual(delegatedOf(whole, [fire(1)]), { reads: 0, tokens: 0, laterTokens: 0, ignored: 1, agents: [] });
  const ranged = { events: [prompt(0), read(2, '/r/core.py', 3000)], calls };
  assert.equal(delegatedOf(ranged, [fire(1)]).reads, 1);
  // a relative path names the same file; another file is another file
  assert.equal(delegatedOf({ events: [prompt(0), { t: 'tool', name: 'Bash', input: { command: 'cat core.py' }, result: 'x'.repeat(90000), at: T(2) }], calls }, [fire(1)]).ignored, 1);
  assert.equal(delegatedOf({ events: [prompt(0), read(2, '/r/other.py', 90000)], calls }, [fire(1)]).ignored, 0);
});

test('delegatedOf: the subagent charged is the one the turn started after the denial, of the firing\'s type, once', () => {
  const p = { events: [prompt(0), prompt(6)], calls: [call(0), call(2)] };
  const subagents = [
    { agent: 'before', type: 'Explore', at: T(0) + 1000 },        // started before the firing: the lead's own
    { agent: 'other', type: 'general-purpose', at: T(1) + 1000 }, // another type
    { agent: 'mine', type: 'Explore', at: T(1) + 2000 },
    { agent: 'unprompted', type: 'Explore', at: T(3) },           // a second one in the turn: one firing, one subagent
    { agent: 'next-turn', type: 'Explore', at: T(7) },
  ];
  assert.deepEqual(delegatedOf(p, [fire(1)], { subagents }).agents, ['mine']);
  assert.deepEqual(delegatedOf(p, [fire(1), fire(2, 20000, '/r/b.py')], { subagents }).agents, ['mine', 'unprompted']);
});

test('noteFiring keeps the session\'s handoffs, and only real ones', () => {
  const st = {};
  noteFiring(st, { t: 1, tokens: 0, files: [] }); assert.equal(st.delegated, undefined);
  noteFiring(st, fire(1)); noteFiring(st, fire(2));
  assert.equal(st.delegated.length, 2);
});

test('a post-processed session is counted from its rows: each row adds what it added, the subagent at its own model', () => {
  const model = 'claude-opus-5-5', sub = 'claude-haiku-5-5', lead = listPrice(model);
  const columns = [{ t: Date.parse('2026-11-09T00:00Z') }], now = Date.parse('2026-11-16T00:00Z');
  const agent = { agent: 'a1', type: 'Explore', model: sub, inputTokens: 120000, cacheReadTokens: 60000, cacheWriteTokens: 59000, cacheWrite1hTokens: 0, outputTokens: 5000 };
  const subCost = costOf({ input: 120000, cacheRead: 60000, cacheWrite: 59000, cacheWrite1h: 0, output: 5000 }, listPrice(sub));
  const row = (t, delegated, subagents = [agent]) => ({ op: 'session', session: 's', model, t, delegated, subagents });
  const firing = { op: 'delegate', session: 's', t: '2026-11-15T10:01Z', kind: 'explore', files: ['core.py'], tokens: 40000, held: false, mode: 'handoff', model: sub };
  // the proxy saw 50 later calls; the transcript says 4 before a cut. The row wins, and the log row is not counted again.
  const compression = Array.from({ length: 50 }, (_, i) => ({ at: `2026-11-15T11:${String(i).padStart(2, '0')}Z`, op: 'proxy', status: 200, session: 's', model, turn: 3, input: 2, read: 200000, write: 500, out: 10, cleared: 0 }));
  const of = events => weeklySavings({ columns, now, compression, events })[1].cells[0];
  const one = of([firing, row('2026-11-15T10:05Z', { reads: 1, tokens: 40000, laterTokens: 80000, ignored: 0, agents: ['a1'] })]);
  const expect1 = (40000 * lead.cacheWrite1h + 80000 * lead.cacheRead) / 1e6 - subCost;
  assert.ok(Math.abs(one.cost - expect1) < 1e-9, `${one.cost} vs ${expect1}`);
  assert.equal(one.tokens, 120000);
  // the next turn's row is cumulative: only its increase is added
  const two = of([firing, row('2026-11-15T10:05Z', { reads: 1, tokens: 40000, laterTokens: 80000, agents: ['a1'] }), row('2026-11-15T10:20Z', { reads: 1, tokens: 40000, laterTokens: 160000, agents: ['a1'] })]);
  assert.ok(Math.abs(two.cost - (expect1 + 80000 * lead.cacheRead / 1e6)) < 1e-9);
  assert.equal(two.tokens, 200000);
  // the lead read the file after all: the later row takes the earlier figure back
  const undone = of([firing, row('2026-11-15T10:05Z', { reads: 1, tokens: 40000, laterTokens: 80000, agents: [] }, []), row('2026-11-15T10:20Z', { reads: 0, tokens: 0, laterTokens: 0, ignored: 1, agents: [] }, [])]);
  assert.ok(Math.abs(undone.cost) < 1e-9); assert.equal(undone.tokens, 0);
  // a subagent on a model with no price is a gap, not a free read
  const gap = of([row('2026-11-15T10:05Z', { reads: 1, tokens: 40000, laterTokens: 0, agents: ['a1'] }, [{ ...agent, model: 'no-such-model' }])]);
  assert.equal(gap.pricedEvents, 0); assert.equal(gap.unpricedTokens, 40000);
});
