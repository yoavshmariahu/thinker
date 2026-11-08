import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklySavings, mergeSavings, savingsValue, SAVINGS_SERIES } from '../src/report-savings.js';
import { listPrice } from '../src/prices.js';

const columns = [{ t: Date.parse('2026-10-19T00:00Z'), prompts: 10, pricedPrompts: 8 }, { t: Date.parse('2026-10-26T00:00Z'), prompts: 20, pricedPrompts: 16 }];
const now = Date.parse('2026-10-30T00:00Z');
const model = 'claude-opus-5-5';

test('one series since the notes went: the clearing', () => {
  assert.deepEqual(SAVINGS_SERIES.map(([k]) => k), ['compression']);
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
