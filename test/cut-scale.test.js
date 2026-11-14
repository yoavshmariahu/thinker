// The two guards scale with what a rewrite costs against a read (cutting.js:cutScale, scaledPolicy).
// What these tests are for: that an Anthropic route is untouched, that a cheap-rewrite route cuts earlier
// and in smaller batches, that PAYBACK still refuses a small cut whose tail dwarfs it, and that a guard the
// person pinned is never moved under them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutScale, scaledPolicy, decideCut, priceCut, policyId, freshCut, BASE_RATIO, SCALE_MIN, PAYBACK } from '../src/cutting.js';
import { statedRates } from '../src/prices.js';
import { makeRatesResolver } from '../src/gateway-rates.js';
import { PROXY_DEFAULTS, proxyConfig } from '../src/proxy.js';

const GLM = { read: 0.5, write: 1.0 };
const cand = (tokens, recache, n = 1) => ({ ids: Array.from({ length: n }, (_, i) => `t${i}`), tokens, recache, chars: tokens * 2, firstChanged: 0 });
const rec = (over = {}) => ({ ...freshCut('s'), turn: 0, at: Date.now(), ...over });

test('an Anthropic route keeps the guards and the policy id it already had', () => {
  assert.equal(BASE_RATIO, 20);
  assert.equal(cutScale({ model: 'claude-opus-5-5', ttl: '1h' }), 1);
  const cfg = { ...PROXY_DEFAULTS };
  const eff = scaledPolicy(cfg, { model: 'claude-opus-5-5', ttl: '1h' });
  assert.equal(eff, cfg, 'the same object: nothing is derived where the ratio is the one the guards were set against');
  assert.equal(policyId(eff), 'r2-t140k-f60k-p25-deep');
  assert.equal(eff.scale, undefined);
  // the cache TTL may not move a guard: the desktop mod holds this policy from mirrored constants and
  // cannot know a rate, so only a route with resolved prices of its own ever scales
  for (const ttl of ['1h', '5m']) assert.equal(cutScale({ model: 'claude-opus-5-5', ttl }), 1);
});

test("GLM's stated prices put the guards ten times lower, and the policy id says so", () => {
  const rates = statedRates('glm-5.3');
  assert.deepEqual({ read: rates.read, write: rates.write }, GLM, 'write at the input price, read at half');
  assert.equal(cutScale({ model: 'glm-5.3', rates }), 0.1);
  const eff = scaledPolicy({ ...PROXY_DEFAULTS }, { model: 'glm-5.3', rates });
  assert.equal(eff.trigger, 14000);
  assert.equal(eff.clearAtLeast, 6000);
  assert.equal(eff.scale, 0.1);
  assert.equal(policyId(eff), 'r2-t14k-f6k-p25-deep', 'never pooled with an Anthropic saving');
});

test('the clamp holds a route with no caching at all off the floor', () => {
  assert.equal(cutScale({ rates: { read: 1, write: 1 } }), SCALE_MIN);
  assert.equal(scaledPolicy({ ...PROXY_DEFAULTS }, { rates: { read: 1, write: 1 } }).trigger, 14000);
  // a rate that cannot be read is not a licence to move anything
  for (const rates of [{ read: 0, write: 1 }, { read: 0.5, write: 0 }]) assert.equal(cutScale({ rates }), 1);
});

test('a 60k batch that Anthropic refuses as below-trigger is cut on GLM, and priced as paying', () => {
  const cfg = { ...PROXY_DEFAULTS };
  const m = { prompt: 40000, turn: 1 };
  const c = cand(20000, 24000);
  const anth = decideCut(rec(), cfg, m, { cand: c, ttl: '1h', model: 'claude-opus-5-5' });
  assert.equal(anth.clear, false);
  assert.equal(anth.reason, 'below-trigger');
  assert.equal(anth.policy, 'r2-t140k-f60k-p25-deep');

  const rates = statedRates('glm-5.3');
  const glm = decideCut(rec(), cfg, m, { cand: c, ttl: '1h', model: 'glm-5.3', rates });
  assert.equal(glm.clear, true, 'past a 14k trigger with a 20k batch over a 6k floor');
  assert.equal(glm.scale, 0.1);
  assert.equal(glm.policy, 'r2-t14k-f6k-p25-deep');
  // 24k rewritten at 1.0, less the 24k read it displaces and the 20k read of what it removes, against 20k
  // read back at 0.5 a call: repaid on the first later call. It priced at 3 while the rewrite was charged
  // whole, which is the correction of 2026-11-13 (cutting.js:priceCut).
  assert.equal(glm.payback, 1);
  assert.equal(priceCut(m, c, { model: 'glm-5.3', rates }).payback, 1);
});

test('payback still refuses a small batch whose tail dwarfs it, so the cheap route cuts early, not late', () => {
  const cfg = { ...PROXY_DEFAULTS };
  const rates = statedRates('glm-5.3');
  // The tail has to dwarf the cut by more than it used to for this to be refused: at GLM's rates the
  // corrected cost takes the displaced read off the rewrite, so a 7k cut behind a 180k tail -- refused when
  // this test was written, at a payback of 52 -- now prices at exactly 25 and is made. 300k still refuses.
  const late = decideCut(rec(), cfg, { prompt: 320000, turn: 1 }, { cand: cand(7000, 300000), ttl: '1h', model: 'glm-5.3', rates });
  assert.equal(late.clear, false);
  assert.equal(late.reason, 'payback', 'over the scaled floor, and still not worth its rewrite');
  assert.ok(late.held.payback > PAYBACK);
  // the same batch at the boundary where the tail is still small is taken
  const early = decideCut(rec(), cfg, { prompt: 60000, turn: 1 }, { cand: cand(7000, 40000), ttl: '1h', model: 'glm-5.3', rates });
  assert.equal(early.clear, true);
  assert.ok(early.payback <= PAYBACK);
});

test('a guard the person pinned is never scaled, and only the pinned one holds still', () => {
  const pinned = proxyConfig({ trigger: 120000 });
  assert.deepEqual(pinned.pinned, { trigger: true });
  const eff = scaledPolicy(pinned, { model: 'glm-5.3', rates: statedRates('glm-5.3') });
  assert.equal(eff.trigger, 120000, 'their number, untouched');
  assert.equal(eff.clearAtLeast, 6000, 'the one they did not set still follows the route');
  const both = proxyConfig({}, { THINKER_PROXY_TRIGGER: '90000', THINKER_PROXY_CLEAR_AT_LEAST: '50000' });
  assert.deepEqual(both.pinned, { trigger: true, clearAtLeast: true });
  const effBoth = scaledPolicy(both, { model: 'glm-5.3', rates: statedRates('glm-5.3') });
  assert.equal(effBoth.trigger, 90000);
  assert.equal(effBoth.clearAtLeast, 50000);
  assert.equal(proxyConfig({}).pinned, undefined, 'the defaults are not pinned');
});

test('the resolver falls back to the stated price list, which is all a direct provider route has', () => {
  const resolve = makeRatesResolver({ tracker: null, configured: null, prices: statedRates });
  assert.deepEqual(resolve('glm-5.3'), { read: 0.5, write: 1, source: 'price-list' });
  assert.equal(resolve('claude-opus-5-5'), null, 'Anthropic stays on the TTL-aware rates');
  assert.equal(resolve('nothing-anyone-prices'), null);
  // the person's own rates still win over the list
  const configured = makeRatesResolver({ configured: { 'glm-5.3': { read: 0.2, write: 1 } }, prices: statedRates });
  assert.deepEqual(configured('glm-5.3'), { read: 0.2, write: 1, source: 'config' });
  assert.equal(cutScale({ model: 'glm-5.3', rates: configured('glm-5.3') }), 0.25, 'a fifth off instead of half moves the guards with it');
});
