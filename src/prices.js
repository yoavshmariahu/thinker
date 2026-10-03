// What a token costs, so that reading avoided and model work done can be put in the same
// unit. Prices are dollars per million tokens, Anthropic's list prices for the API
// (platform.claude.com/docs/en/about-claude/pricing, read 2026-09). Cache writes are
// 1.25 × input (the 5-minute cache); cache reads are the published figure where there is
// one and a tenth of input otherwise. Other vendors' models are not listed here: their
// prices go in THINKER_HOME/prices.json or under `prices` in .thinker/config.json, keyed by
// model id, e.g. {"gpt-6-sol": {"input": 2, "output": 8}}. A model with no price is
// counted as unpriced, never as free.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

// Short names an agent CLI reports or a config names (`sonnet`, `haiku`, `opus`): the current model of that line.
const ALIASES = { fable: 'claude-fable-5-1', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-4-5' };

const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const normalize = p => p && typeof p === 'object' && num(p.input) !== null && num(p.output) !== null
  ? { input: p.input, output: p.output, cacheRead: num(p.cacheRead) ?? p.input / 10, cacheWrite: num(p.cacheWrite) ?? p.input * 1.25 }
  : null;

// The user's own prices, read once per process: the machine's file, then a repository's config on top.
let userPrices = null;
export function loadPrices({ home = process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), config = {} } = {}) {
  if (!userPrices) {
    userPrices = {};
    try { Object.assign(userPrices, JSON.parse(fs.readFileSync(path.join(home, 'prices.json'), 'utf8'))); } catch {}
  }
  return { ...userPrices, ...(config.prices && typeof config.prices === 'object' ? config.prices : {}) };
}
export const resetPrices = () => { userPrices = null; };

// The price of a model id as an agent reports it: exact, then by alias, then the longest listed id the
// name starts with (date suffixes, `-latest`, provider prefixes like `anthropic.` or `us.anthropic.`).
export function priceOf(model, { config } = {}) {
  if (!model) return null;
  const table = { ...PRICES, ...loadPrices({ config }) };
  let m = String(model).toLowerCase().trim();
  m = m.replace(/^(?:[a-z]{2}\.)?anthropic\./, '').replace(/-(?:latest|\d{8})$/, '');
  if (table[m]) return normalize(table[m]);
  const alias = ALIASES[m] || Object.entries(ALIASES).find(([k]) => m === `claude-${k}`)?.[1];
  if (alias && table[alias]) return normalize(table[alias]);
  const hit = Object.keys(table).filter(k => m.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return hit ? normalize(table[hit]) : null;
}

// Dollars for normalized token counters (model-usage.js) at a price; null when the price or the
// counters are unknown. `inputTokens` includes cache reads and writes, so they are priced apart.
export function costOf(tokens, price) {
  if (!price || !tokens) return null;
  const inp = num(tokens.inputTokens), out = num(tokens.outputTokens);
  if (inp === null || out === null) return null;
  const read = num(tokens.cacheReadTokens) || 0, write = num(tokens.cacheWriteTokens) || 0;
  const plain = Math.max(0, inp - read - write);
  return (plain * price.input + read * price.cacheRead + write * price.cacheWrite + out * price.output) / 1e6;
}

// Dollars for tokens an agent would have read into its context, at the model's input price.
export const readCost = (tokens, price) => price && num(tokens) !== null ? tokens * price.input / 1e6 : null;
