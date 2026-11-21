import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklySavings, mergeSavings, savingsValue, SAVINGS_SERIES } from '../src/report-savings.js';
import { listPrice } from '../src/prices.js';

const columns = [{ t: Date.parse('2026-10-19T00:00Z'), prompts: 10, pricedPrompts: 8 }, { t: Date.parse('2026-10-26T00:00Z'), prompts: 20, pricedPrompts: 16 }];
const now = Date.parse('2026-10-30T00:00Z');
const model = 'claude-opus-5-5';

test('three series: the clearing, the reads handed over, and the reads already in the context', () => {
  assert.deepEqual(SAVINGS_SERIES.map(([k]) => k), ['compression', 'delegation', 'repeat']);
});

test("a pointed-at read saves the lead its write and every later read of it, and nothing is netted off", () => {
  const price = listPrice(model);
  // the session's own post-processed figure, cumulative as the Stop hook writes it each turn (delegated.js)
  const row = (t, tokens, laterTokens, extra = {}) => ({ op: 'session', session: 's', model, t, repeated: { reads: 1, tokens, laterTokens, ignored: 0, agents: [] }, ...extra });
  const of = events => weeklySavings({ columns, now, compression: [], events })[2].cells[1];
  const one = of([row('2026-10-27T10:00Z', 40000, 80000)]);
  assert.equal(one.tokens, 120000, 'the write once and the reads of it after');
  assert.ok(Math.abs(one.cost - (40000 * price.cacheWrite1h + 80000 * price.cacheRead) / 1e6) < 1e-9);
  assert.equal(one.estimatedTokens, one.tokens, 'sized from the file on disk, never measured');
  // no subagent ran, so nothing comes off: a session's own subagents are not this trigger's cost
  assert.equal(of([row('2026-10-27T10:00Z', 40000, 80000, { subagents: [{ agent: 'a1', model: 'claude-haiku-5-5', inputTokens: 5000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 40000, cacheWrite1hTokens: 40000 }] })]).cost, one.cost);
  // the figure grows with the session: each row accounts only what it added to the one before
  const grew = of([row('2026-10-27T10:00Z', 40000, 40000), row('2026-10-27T11:00Z', 60000, 150000)]);
  assert.equal(grew.tokens, 210000);
  assert.equal(grew.events, 2);
  // a session with no pointer, and one whose model has no price
  assert.equal(of([{ op: 'session', session: 's', model, t: '2026-10-27T10:00Z' }]).events, 0);
  const unpriced = of([row('2026-10-27T10:00Z', 40000, 0, { model: 'nobody-prices-this' })]);
  assert.equal(unpriced.unpricedTokens, 40000); assert.equal(unpriced.pricedEvents, 0);
  // and the other two series are untouched by it
  const all = weeklySavings({ columns, now, compression: [], events: [row('2026-10-27T10:00Z', 40000, 80000)] });
  assert.equal(all[0].cells[1].tokens, 0); assert.equal(all[1].cells[1].tokens, 0);
});

test('a delegated read saves the lead its write, netted against the subagent, and its read on every later call', () => {
  const sub = 'claude-haiku-5-5', lead = listPrice(model), cheap = listPrice(sub);
  const call = (at, extra = {}) => ({ at, op: 'proxy', status: 200, session: 's', model, turn: 3, input: 2, read: 200000, write: 500, out: 10, cleared: 0, ...extra });
  const compression = [
    call('2026-10-27T09:00Z'),                                   // before the firing: not a later call
    call('2026-10-27T10:05Z'), call('2026-10-27T10:06Z', { turn: 4 }),
    call('2026-10-27T10:07Z', { model: sub, read: 30000 }),      // the subagent's own call under the session's id
    call('2026-10-27T10:08Z', { status: 500 }),
    call('2026-10-27T11:00Z', { turn: 1 }),                      // a compaction: the read would have gone anyway
    call('2026-10-27T11:01Z', { turn: 1 }),
  ];
  const fire = { op: 'delegate', session: 's', t: '2026-10-27T10:00Z', kind: 'explore', files: ['core.py'], tokens: 40000, held: false, mode: 'handoff' };
  const of = events => weeklySavings({ columns, now, compression, events })[1].cells[1];
  // pinned handoff: the write at the lead's rate less the same read at the subagent's, then two later reads
  const pinned = of([{ ...fire, model: sub }]);
  const write = 40000 * (lead.cacheWrite1h - cheap.cacheWrite1h) / 1e6, reads = 2 * 40000 * lead.cacheRead / 1e6;
  assert.ok(Math.abs(pinned.cost - (write + reads)) < 1e-9);
  assert.equal(pinned.tokens, 3 * 40000, 'the write once and each later read');
  assert.equal(pinned.estimatedTokens, pinned.tokens, 'sized from the file on disk, never measured');
  // the fallback's own reported cost is what comes off the write
  assert.ok(Math.abs(of([{ ...fire, model: sub, cost: 0.2 }]).cost - (40000 * lead.cacheWrite1h / 1e6 - 0.2 + reads)) < 1e-9);
  // no model named for the subagent: the write half is zero, the later reads still count
  assert.ok(Math.abs(of([fire]).cost - reads) < 1e-9);
  // what is not a firing
  for (const not of [{ held: true }, { fired: false, declined: 'below-threshold' }, { fired: false, after: 'handoff' }, { fired: false, skipped: 'no-native-subagent' }, { error: 'timeout' }, { cached: true }]) {
    assert.equal(of([{ ...fire, ...not }]).events, 0, JSON.stringify(not));
  }
  // a handoff the model ignored: it read the same file itself afterwards, so nothing was kept out
  assert.equal(of([fire, { ...fire, t: '2026-10-27T10:01Z', fired: false, after: 'handoff' }]).events, 0);
  assert.equal(of([fire, { ...fire, t: '2026-10-27T10:01Z', fired: false, after: 'handoff', files: ['other.py'] }]).events, 3);
  // a session the proxy never carried: the model from its session row, the write half alone
  const desktop = weeklySavings({ columns, now, compression: [], events: [{ op: 'session', session: 's', model, t: '2026-10-27T12:00Z' }, { ...fire, model: sub }] })[1].cells[1];
  assert.ok(Math.abs(desktop.cost - write) < 1e-9);
  // and one with no model anywhere is a gap, not a zero
  const unknown = weeklySavings({ columns, now, compression: [], events: [fire] })[1].cells[1];
  assert.equal(unknown.unpricedTokens, 40000); assert.equal(unknown.pricedEvents, 0);
  // the clearing's own series is untouched by any of it
  assert.equal(weeklySavings({ columns, now, compression, events: [fire] })[0].cells[1].tokens, 0);
});

test('compression counts cumulative avoided reads on every successful request, scoped to its repository', () => {
  const row = { at: '2026-10-27T10:00Z', op: 'proxy', status: 200, session: 's', model, cleared: 1000 };
  const compression = [row, { ...row, at: '2026-10-28T10:00Z' }, { ...row, session: 'other' }, { ...row, status: 500 }, { ...row, truncated: true }, { ...row, at: '2026-11-02T00:00Z' }, { ...row, at: '2026-10-20T00:00Z', model: 'unpriced' }];
  const s = weeklySavings({ columns, now, compression, events: [{ session: 'trace-s.jsonl', t: '2026-10-20', op: 'request' }] });
  assert.deepEqual(s[0].cells.map(c => c.tokens), [1000, 2000]);
  assert.equal(s[0].cells[1].cost, 2000 * listPrice(model).cacheRead / 1e6);
  assert.equal(s[0].cells[0].unpricedTokens, 1000);
  assert.equal(savingsValue(s[0].cells[0], columns[0], {}, { total: true }), null);
  assert.equal(savingsValue(s[0].cells[0], columns[0], {}, { cost: false, total: true }), 1000);
  const merged = mergeSavings([{ savings: s }, { savings: s }, {}], 2);
  assert.equal(merged[0].cells[1].tokens, 4000);
  assert.equal(savingsValue(merged[0].cells[1], columns[1], {}, { cost: false }), 200);
  assert.equal(savingsValue(merged[0].cells[1], columns[1], { tokens: 10000 }, { cost: false, share: true }), .4);
});

test('a session moving between repositories contributes each compression request only once', () => {
  const ownership = [{ session: 's', origin: 'first', t: '2026-10-20' }, { session: 's', origin: 'second', t: '2026-10-27' }];
  const compression = ['2026-10-21', '2026-10-28'].map(at => ({ at, session: 's', status: 200, model, cleared: 1000 }));
  const views = ['first', 'second'].map(origin => ({ savings: weeklySavings({ columns, now, ownership, origin, compression, sessions: [{ session: 's' }] }) }));
  assert.deepEqual(views[0].savings[0].cells.map(c => c.tokens), [1000, 0]);
  assert.deepEqual(views[1].savings[0].cells.map(c => c.tokens), [0, 1000]);
  assert.deepEqual(mergeSavings(views, 2)[0].cells.map(c => c.tokens), [1000, 1000]);
});

// 2026-11-18: the Report prices a cleared token by what its request would have paid for it, as the delivery ledger does
test('a cleared token is a write on a request that wrote its whole context again, and a read otherwise', () => {
  const row = { at: '2026-10-28T10:00Z', op: 'proxy', status: 200, session: 's', model, cleared: 1000 };
  const compression = [{ ...row, read: 90_000, write: 500, write1h: 500 }, { ...row, at: '2026-10-28T12:00Z', read: 0, write: 90_000, write1h: 90_000 }];
  const cell = weeklySavings({ columns, now, compression, events: [{ session: 'trace-s.jsonl', t: '2026-10-20', op: 'request' }] })[0].cells[1];
  const p = listPrice(model);
  assert.equal(cell.tokens, 2000);
  assert.ok(Math.abs(cell.cost - (1000 * p.cacheRead + 1000 * p.cacheWrite1h) / 1e6) < 1e-12);
  assert.equal(p.cacheWrite1h / p.cacheRead, 40, 'forty reads to the written token on Opus 5.5');
});
