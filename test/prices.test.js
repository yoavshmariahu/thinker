import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRICES, priceOf, costOf, readCost, resetPrices } from '../src/prices.js';
import { emptySpend, addSpend } from '../src/model-usage.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-prices-')));
function withEnv(vars, fn) {
  const prev = {}; for (const k in vars) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k in prev) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

test('a model id finds its price exactly, by alias, by prefix, and never by guess', () => {
  withEnv({ THINKER_HOME: tmp() }, () => {
    resetPrices();
    assert.equal(priceOf('claude-haiku-4-5').input, 1);
    assert.equal(priceOf('claude-haiku-4-5-20251001').input, 1);        // date suffix
    assert.equal(priceOf('us.anthropic.claude-sonnet-5-5').output, 10);  // Bedrock prefix
    assert.equal(priceOf('claude-sonnet-5').input, 2);                   // not mistaken for 5-5
    assert.equal(priceOf('sonnet').input, PRICES['claude-sonnet-5-5'].input);
    assert.equal(priceOf('gpt-6-sol'), null);
    assert.equal(priceOf(null), null);
    assert.equal(priceOf(''), null);
  });
});

test('other vendors are priced only by the user, from the machine file or the repository config', () => {
  const home = tmp();
  fs.writeFileSync(path.join(home, 'prices.json'), JSON.stringify({ 'gpt-6-sol': { input: 2, output: 8 } }));
  withEnv({ THINKER_HOME: home }, () => {
    resetPrices();
    const p = priceOf('gpt-6-sol');
    assert.deepEqual(p, { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 });  // cache prices by the usual ratios
    assert.equal(priceOf('gpt-6-luna'), null);
    assert.equal(priceOf('gpt-6-luna', { config: { prices: { 'gpt-6-luna': { input: 1, output: 4 } } } }).output, 4);
    assert.equal(priceOf('gpt-6-luna', { config: { prices: { 'gpt-6-luna': { input: 'cheap' } } } }), null);  // a malformed price is no price
  });
  resetPrices();
});

test('cost from normalized counters prices cache reads and writes apart from plain input', () => {
  const p = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  // inputTokens includes the cached parts (model-usage.js)
  assert.equal(costOf({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 400_000, cacheWriteTokens: 100_000 }, p), (500_000 * 1 + 400_000 * 0.1 + 100_000 * 1.25 + 100_000 * 5) / 1e6);
  assert.equal(costOf({ inputTokens: 1000, outputTokens: null }, p), null);
  assert.equal(costOf({ inputTokens: 1000, outputTokens: 10 }, null), null);
  assert.equal(readCost(1_000_000, p), 1);
  assert.equal(readCost(1_000_000, null), null);
});

test('spend with no reported cost is priced from its tokens, or counted as unpriced', () => {
  const t = emptySpend();
  addSpend(t, { op: 'model', model: 'claude-haiku-4-5', cost: 0.02, tokens: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010 } }, priceOf('claude-haiku-4-5'));
  addSpend(t, { op: 'model', model: 'claude-haiku-4-5', cost: null, tokens: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 } }, priceOf('claude-haiku-4-5'));
  addSpend(t, { op: 'model', model: 'gpt-6-sol', cost: null, tokens: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 } }, null);
  addSpend(t, { op: 'model', model: 'claude-haiku-4-5', cost: null, tokens: { inputTokens: null, outputTokens: null, totalTokens: null } }, priceOf('claude-haiku-4-5'));
  assert.equal(t.calls, 4);
  assert.equal(t.reportedCost, 0.02);
  assert.equal(t.unknownCostCalls, 3);
  assert.equal(t.estimatedCost, 1);
  assert.equal(t.unpricedCalls, 2);
});
