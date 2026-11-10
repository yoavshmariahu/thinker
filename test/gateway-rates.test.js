import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPrices, rateTracker, makeRatesResolver } from '../src/gateway-rates.js';
import { priceCut, decideCut, freshCut, cutResponse } from '../src/cutting.js';

const obs = (fresh, read, write, out, cost) => ({ fresh, read, write, out, cost });
// prices per token: fresh $1, read $0.1, write $2, out $3 (relative units; the fit is scale-free)
const price = r => r.fresh + 0.1 * r.read + 2 * r.write + 3 * r.out;
const sample = n => Array.from({ length: n }, (_, i) => {
  const r = obs(1000 + i * 100, i % 3 === 0 ? 0 : 500 + (i % 5) * 200, i % 2 === 0 ? 0 : 100 + (i % 4) * 50, 20 + (i % 7) * 10, 0);
  return { ...r, cost: price(r) };
});

test('the fit recovers the gateway\'s own prices from its answers', () => {
  const rows = sample(12);
  const fit = fitPrices(rows);
  assert.ok(fit);
  assert.equal(fit.observations, 12);
  assert.deepEqual(fit.unidentified, []);
  assert.ok(Math.abs(fit.fresh - 1) < 1e-6, `fresh ${fit.fresh}`);
  assert.ok(Math.abs(fit.read - 0.1) < 1e-6, `read ${fit.read}`);
  assert.ok(Math.abs(fit.write - 2) < 1e-6, `write ${fit.write}`);
  assert.ok(Math.abs(fit.out - 3) < 1e-6, `out ${fit.out}`);
});

test('a write the gateway never reports is unidentified, never a measured zero', () => {
  // implicit caching: writes happen but carry no separate price and no reported tokens
  const rows = Array.from({ length: 12 }, (_, i) => {
    const r = obs(1000 + i * 100, i % 2 === 0 ? 0 : 400 + (i % 5) * 200, 0, 20 + i, 0);
    return { ...r, cost: r.fresh + 0.5 * r.read + 3 * r.out };
  });
  const fit = fitPrices(rows);
  assert.deepEqual(fit.unidentified, ['write']);
  const rates = makeRatesResolver({ tracker: { fit: () => fit } })('m');
  assert.equal(rates.source, 'measured');
  assert.ok(Math.abs(rates.read - 0.5) < 1e-6);
  // the rewrite there costs full input price: named, not silent, and not Anthropic's 2.0
  assert.equal(rates.write, 1);
  assert.deepEqual(rates.assumed, ['write']);
});

test('a write the fit measures at zero is a measured zero', () => {
  const rows = sample(12).map((r, i) => ({ ...r, cost: r.fresh + 0.1 * r.read + 3 * r.out })); // writes are free
  const fit = fitPrices(rows);
  assert.deepEqual(fit.unidentified, []);
  assert.equal(fit.write, 0);
  const rates = makeRatesResolver({ tracker: { fit: () => fit } })('m');
  assert.equal(rates.write, 0);
  assert.equal(rates.assumed, undefined);
});

test('config beats the fit beats the Anthropic defaults', () => {
  const tracker = { fit: () => ({ fresh: 1, read: 0.1, write: 2, out: 3, unidentified: [], observations: 12 }) };
  const r = makeRatesResolver({ tracker })('m');
  assert.deepEqual([r.source, r.read, r.write], ['measured', 0.1, 2]);
  const star = makeRatesResolver({ tracker, configured: { '*': { read: 0.25, write: 1 } } })('anything');
  assert.deepEqual([star.source, star.read, star.write], ['config', 0.25, 1]);
  const exact = makeRatesResolver({ tracker, configured: { '*': { read: 9, write: 9 }, m: { read: 0.2, write: 1.25 } } })('m');
  assert.deepEqual([exact.source, exact.read, exact.write], ['config', 0.2, 1.25]);
  // an invalid config entry is nobody's word: the fit answers
  const bad = makeRatesResolver({ tracker, configured: { m: { read: 'free' } } })('m');
  assert.equal(bad.source, 'measured');
  // no fit, no config: null, and the shared policy keeps its constants
  assert.equal(makeRatesResolver({})('m'), null);
  assert.equal(makeRatesResolver({ tracker: { fit: () => null } })('m'), null);
});

test('the tracker keeps the last observations and refits, and refuses to fit on too little', () => {
  const t = rateTracker();
  assert.equal(t.fit('m'), null);
  for (const r of sample(8)) t.observe('m', { input: r.fresh + r.read + r.write, read: r.read, write: r.write, out: r.out, cost: r.cost });
  const fit = t.fit('m');
  assert.ok(fit && Math.abs(fit.read - 0.1) < 1e-6);
  // usage without a price is not an observation: no cost field, no fit change
  t.observe('m', { input: 999, read: 0, write: 0, out: 9 });
  assert.equal(t.fit('m').observations, 8);
});

const cand = { ids: ['x'], tokens: 50000, chars: 200000, recache: 300000, firstChanged: 2 };
test('priceCut honors the rates it is given', () => {
  // Anthropic ratios: 300k recache at 2.0 against 50k tokens at 0.1 repays in 120 calls -- refused
  const anthropic = priceCut({}, cand, { ttl: '1h' });
  assert.equal(anthropic.payback, 120);
  assert.equal(anthropic.pays, false);
  // the same boundary at an implicit-cache provider's prices: write 1.0, read 0.5 repays in 12
  const implicit = priceCut({}, cand, { rates: { read: 0.5, write: 1 } });
  assert.equal(implicit.payback, 12);
  assert.equal(implicit.pays, true);
  assert.equal(priceCut({}, cand, { cold: true, rates: { read: 0.5, write: 1 } }).cost, 0);
});

test('decideCut prices, names and records the rates behind a clear and a refusal', () => {
  const rec = freshCut('s');
  const cfg = { trigger: 1, clearAtLeast: 1, keepMin: 3, holdout: 0, clearDeep: true };
  const clear = decideCut(rec, cfg, { prompt: 500000, turn: 1 }, { cand, rates: { read: 0.5, write: 1, source: 'measured' } });
  assert.equal(clear.clear, true);
  assert.deepEqual(clear.rates, { read: 0.5, write: 1, source: 'measured' });
  const held = decideCut(freshCut('s'), cfg, { prompt: 500000, turn: 1 }, { cand, rates: { read: 0.1, write: 10, source: 'config' } });
  assert.equal(held.reason, 'payback');
  assert.deepEqual(held.held.rates, { read: 0.1, write: 10, source: 'config' });
  assert.equal(decideCut(rec, cfg, { prompt: 500000, turn: 1 }, { cand }).rates, undefined, 'no rates resolved: the row carries none');
});

test('the record\'s savings are read at the rates the clear was priced with', () => {
  const rec = freshCut('s');
  rec.cut = ['x'];
  rec.rates = { read: 0.5, write: 1, source: 'measured' };
  cutResponse(rec, {}, { clientCut: { tokens: 1000 } }, { read: 10 });
  assert.ok(Math.abs(rec.saved - 500) < 1e-9, `saved ${rec.saved}`);
  // without stored rates, the model's Anthropic rate as before
  const plain = freshCut('s');
  plain.cut = ['x']; plain.model = 'claude-opus-4';
  cutResponse(plain, {}, { clientCut: { tokens: 1000 } }, { read: 10 });
  assert.equal(plain.saved, 100);
});
