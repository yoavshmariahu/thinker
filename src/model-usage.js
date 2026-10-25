import crypto from 'node:crypto';
import { impactContext, tryImpact } from './impact-journal.js';
// Provider-reported usage only. Missing counters are null, never an estimate of zero. Everything is
// counted in tokens: the agents run on subscriptions as often as on metered keys, so a dollar figure
// derived from list prices told most people what they would not pay. Provider-reported cost is kept
// in the log as data (`cost`), never estimated, and not shown.
const count = (...xs) => xs.find(x => typeof x === 'number' && Number.isFinite(x) && x >= 0) ?? null;
const sum = xs => xs.length && xs.every(x => x !== null) ? xs.reduce((a, b) => a + b, 0) : null;

export function normalizeModelUsage(provider, usage) {
  if (Array.isArray(usage)) {
    const rows = usage.map(u => normalizeModelUsage(provider, u));
    return Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].map(k => [k, sum(rows.map(r => r[k]))]));
  }
  const u = usage && typeof usage === 'object' ? usage : {};
  if (u.models) return normalizeModelUsage(provider, Object.values(u.models).map(m => m.tokens || m.usage || m));
  const cacheReadTokens = count(u.cache_read_input_tokens, u.cached_input_tokens, u.cachedInputTokens, u.cachedContentTokenCount, u.cached, u.input_tokens_details?.cached_tokens, u.prompt_tokens_details?.cached_tokens);
  const cacheWriteTokens = count(u.cache_creation_input_tokens, u.cache_write_input_tokens, u.cacheWriteTokens);
  let inputTokens = count(u.input_tokens, u.inputTokens, u.prompt_tokens, u.promptTokenCount, u.prompt, u.input);
  // Anthropic's input_tokens excludes both cache reads and writes. Codex's includes them.
  if (inputTokens !== null && (provider === 'claude' || provider === 'anthropic' || 'cache_creation_input_tokens' in u || 'cache_read_input_tokens' in u)) {
    inputTokens += (cacheReadTokens || 0) + (cacheWriteTokens || 0);
  }
  let outputTokens = count(u.output_tokens, u.outputTokens, u.completion_tokens, u.candidatesTokenCount, u.candidates, u.output);
  if (outputTokens !== null && (u.candidates !== undefined || u.candidatesTokenCount !== undefined)) outputTokens += count(u.thoughts, u.thoughtsTokenCount) || 0;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    totalTokens: sum([inputTokens, outputTokens]) ?? count(u.total_tokens, u.totalTokenCount, u.total) };
}

// Final result counters are cumulative; never add assistant-message counters to them.
export function streamModelUsage(provider, stdout) {
  const events = String(stdout).split('\n').flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  if (provider === 'codex') {
    const turns = events.filter(e => e.type === 'turn.completed');
    return { usage: turns.length ? turns.map(e => e.usage || null) : null, cost: null };
  }
  const result = events.filter(e => e.type === 'result').pop();
  return { usage: result?.usage || result?.stats || null, cost: count(result?.total_cost_usd) };
}

export function logModelUsage(store, { purpose, phase = 'maintenance', store: _store, ...context }, response) {
  const { calls, ...impact } = impactContext.getStore() || {};
  const event = { op: 'model', eventId: crypto.randomUUID(), purpose, phase, ...context, ...impact, provider: response.provider,
    model: response.model, usage: response.usage ?? null,
    tokens: normalizeModelUsage(response.provider, response.usage), cost: count(response.cost),
    failed: !!response.failed };
  store.log(event);
  const recorded = tryImpact(store, event);
  if (recorded && calls) calls.push(recorded);
}

// The tokens a model answer reported (llm.js puts them on every answer as `tokens`); null when the
// provider gave no counters, which is never read as zero.
export const tokensOf = res => { const t = res?.tokens?.totalTokens; return typeof t === 'number' && Number.isFinite(t) ? t : null; };

// A token count for people: 850, 7k, 24k, 1.3M.
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n)}`;
}

export function emptySpend() {
  return { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, unknownTokenCalls: 0, reportedCost: 0, unknownCostCalls: 0 };
}

// Provider-reported cost is summed where a provider gave one (`reportedCost`, data for the
// JSON and telemetry only) and counted as unknown otherwise; it is never estimated from tokens.
export function addSpend(total, e) {
  total.calls++;
  if (e.failed) total.failed++;
  const tokens = e.tokens && typeof e.tokens === 'object' ? e.tokens : normalizeModelUsage(e.provider, e.usage);
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) total[k] += count(tokens[k]) || 0;
  if (count(tokens.totalTokens) === null) total.unknownTokenCalls++;
  // Legacy mining batches used 0 even when no provider reported cost.
  const cost = e.op === 'mine-prs' && e.cost === 0 ? null : count(e.cost);
  if (cost !== null) total.reportedCost += cost; else total.unknownCostCalls++;
}

// What a token of model work is worth beside a token of the agent's reading, for the net figure
// alone: the saving lands on the agent's model (Fable, Opus), the learning runs on Haiku or Sonnet,
// a cache read costs a tenth of fresh input and an output token five times it. Relative list prices
// per input token, Claude Opus 5.5 = 1 (Anthropic's table of 2026-10-06); ratios, never shown as
// money. A model not listed (another provider's, an alias nobody priced) is null and is counted one
// token for one, as before.
const RATES = [
  [/fable|mythos/, 2.5, 0.0625],
  [/opus-5-5|opus-5\.5|^opus$/, 1, 0.05],
  [/opus/, 1.25, 0.125],
  [/sonnet-[34]/, 0.75, 0.075],
  [/sonnet/, 0.5, 0.05],
  [/haiku-[34]/, 0.25, 0.025],
  [/haiku/, 0.025, 0.0025],
];
export function relativeRate(model) {
  const m = String(model || '').toLowerCase().replace(/^(claude|anthropic|cursor)\//, '');
  const hit = RATES.find(([re]) => re.test(m));
  if (!hit) return null;
  const [, input, cacheRead] = hit;
  return { input, output: input * 5, cacheRead, cacheWrite: input * 1.25 };
}

// One call's tokens at that rate, in Opus 5.5 input tokens. Input includes cache reads and writes
// (normalizeModelUsage), so fresh input is what is left of it.
export function weightedTokens(tokens, rate) {
  const n = k => count(tokens?.[k]) || 0;
  const read = n('cacheReadTokens'), write = n('cacheWriteTokens');
  const fresh = Math.max(0, n('inputTokens') - read - write);
  return fresh * rate.input + read * rate.cacheRead + write * rate.cacheWrite + n('outputTokens') * rate.output;
}

// Purposes of features since removed (Jev, review, its repair passes, exploration, the slimming
// prompt): their spend is history, not what keeping the cache costs now.
const RETIRED = /^(jev-|review$|repair$|mine-prs-repair$|explore$|route$|instructions-slim$)/;
export const retiredPurpose = purpose => RETIRED.test(String(purpose || ''));
