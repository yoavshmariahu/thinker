// Provider-reported usage only. Missing counters are null, never an estimate of zero.
import { costOf } from './prices.js';
const count = (...xs) => xs.find(x => typeof x === 'number' && Number.isFinite(x) && x >= 0) ?? null;
const sum = xs => xs.length && xs.every(x => x !== null) ? xs.reduce((a, b) => a + b, 0) : null;

export function normalizeModelUsage(provider, usage) {
  if (Array.isArray(usage)) {
    const rows = usage.map(u => normalizeModelUsage(provider, u));
    return Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].map(k => [k, sum(rows.map(r => r[k]))]));
  }
  const u = usage && typeof usage === 'object' ? usage : {};
  if (u.models) return normalizeModelUsage(provider, Object.values(u.models).map(m => m.tokens || m.usage || m));
  const cacheReadTokens = count(u.cache_read_input_tokens, u.cached_input_tokens, u.cachedInputTokens, u.cachedContentTokenCount, u.cached, u.input_tokens_details?.cached_tokens);
  const cacheWriteTokens = count(u.cache_creation_input_tokens, u.cacheWriteTokens);
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
  store.log({ op: 'model', purpose, phase, ...context, provider: response.provider,
    model: response.model, usage: response.usage ?? null,
    tokens: normalizeModelUsage(response.provider, response.usage), cost: count(response.cost),
    failed: !!response.failed });
}

export function emptySpend() {
  return { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    totalTokens: 0, unknownTokenCalls: 0, reportedCost: 0, unknownCostCalls: 0, estimatedCost: 0, unpricedCalls: 0 };
}

// `price` (prices.js) prices a record whose provider reported tokens but no cost; a record with
// neither, or on a model with no price, is counted as unpriced rather than as free.
export function addSpend(total, e, price = null) {
  total.calls++;
  if (e.failed) total.failed++;
  const tokens = e.tokens && typeof e.tokens === 'object' ? e.tokens : normalizeModelUsage(e.provider, e.usage);
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) total[k] += count(tokens[k]) || 0;
  if (count(tokens.totalTokens) === null) total.unknownTokenCalls++;
  // Legacy mining batches used 0 even when no provider reported cost.
  const cost = e.op === 'mine-prs' && e.cost === 0 ? null : count(e.cost);
  if (cost !== null) { total.reportedCost += cost; return; }
  total.unknownCostCalls++;
  const est = costOf(tokens, price);
  if (est === null) total.unpricedCalls++;
  else total.estimatedCost += est;
}
