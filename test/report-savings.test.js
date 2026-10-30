import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputSavings } from '../src/cache-savings.js';
import { weeklySavings, mergeSavings, savingsValue } from '../src/report-savings.js';
import { listPrice } from '../src/prices.js';

const columns = [{ t: Date.parse('2026-10-19T00:00Z'), prompts: 10, pricedPrompts: 8 }, { t: Date.parse('2026-10-26T00:00Z'), prompts: 20, pricedPrompts: 16 }];
const now = Date.parse('2026-10-30T00:00Z');
const model = 'claude-opus-5-5';

test('cache savings follow each request across weeks and preserve note overhead after a clear', () => {
  const cache = [], notes = [{ id: 'a', at: '2026-10-20T00:00Z', tokens: 1000, noteTokens: 100 }];
  const requests = [columns[0].t + 86400000, columns[1].t].map(at => ({ at, model, input: 2000, cacheRead: 2000, notes: { a: 100 } }));
  const result = inputSavings(notes, requests, { clears: [columns[1].t], onSaving: r => cache.push(r), until: now });
  assert.equal(result.tokens, 800);
  const savings = weeklySavings({ columns, now, cache });
  assert.deepEqual(savings[0].cells.map(c => c.tokens), [900, -100]);
  assert.equal(savings[0].cells[0].cost, 900 * listPrice(model).cacheRead / 1e6);
  assert.equal(savings[0].cells[1].cost, -100 * listPrice(model).cacheRead / 1e6);
});

test('one-read fallbacks belong to the delivery week and keep their model price', () => {
  const cache = [];
  inputSavings([{ id: 'a', at: '2026-10-20', tokens: 1000, noteTokens: 100 }, { id: 'b', at: '2026-10-27', tokens: 500, noteTokens: 100 }], [], { model, onSaving: r => cache.push(r) });
  const s = weeklySavings({ columns, now, cache })[0];
  assert.deepEqual(s.cells.map(c => c.tokens), [900, 400]);
  assert.equal(s.cells[1].cost, 400 * listPrice(model).input / 1e6);
});

test('compression counts cumulative avoided reads on every successful request, scoped to its repository', () => {
  const row = { at: '2026-10-27T10:00Z', op: 'proxy', status: 200, session: 's', model, cleared: 1000 };
  const compression = [row, { ...row, at: '2026-10-28T10:00Z' }, { ...row, session: 'other' }, { ...row, status: 500 }, { ...row, truncated: true }, { ...row, at: '2026-11-02T00:00Z' }, { ...row, at: '2026-10-20T00:00Z', model: 'unpriced' }, { ...row, protocol: 'responses', estimatedRemovedTokens: 500 }];
  const s = weeklySavings({ columns, now, compression, events: [{ session: 'trace-s.jsonl', t: '2026-10-20', op: 'orient', served: ['a', 'b'] }] });
  assert.equal(s[0].cells[0].hits, 2);
  assert.deepEqual(s[1].cells.map(c => c.tokens), [1000, 2500]);
  assert.equal(s[1].cells[1].estimatedTokens, 500);
  assert.equal(s[1].cells[1].cost, 2500 * listPrice(model).cacheRead / 1e6);
  assert.equal(s[1].cells[0].unpricedTokens, 1000);
  assert.equal(savingsValue(s[1].cells[0], columns[0], {}, { total: true }), null);
  assert.equal(savingsValue(s[1].cells[0], columns[0], {}, { cost: false, total: true }), 1000);
  const merged = mergeSavings([{ savings: s }, { savings: s }, {}], 2);
  assert.equal(merged[1].cells[1].tokens, 5000);
  assert.equal(merged[0].cells[0].hits, 4);
  assert.equal(savingsValue(merged[1].cells[1], columns[1], {}, { cost: false }), 250);
  assert.equal(savingsValue(merged[1].cells[1], columns[1], { tokens: 10000 }, { cost: false, share: true }), .5);
});

test('a session moving between repositories contributes each compression request only once', () => {
  const ownership = [{ session: 's', origin: 'first', t: '2026-10-20' }, { session: 's', origin: 'second', t: '2026-10-27' }];
  const compression = ['2026-10-21', '2026-10-28'].map(at => ({ at, session: 's', status: 200, model, cleared: 1000 }));
  const views = ['first', 'second'].map(origin => ({ savings: weeklySavings({ columns, now, ownership, origin, compression, sessions: [{ session: 's' }] }) }));
  assert.deepEqual(views[0].savings[1].cells.map(c => c.tokens), [1000, 0]);
  assert.deepEqual(views[1].savings[1].cells.map(c => c.tokens), [0, 1000]);
  assert.deepEqual(mergeSavings(views, 2)[1].cells.map(c => c.tokens), [1000, 1000]);
});
