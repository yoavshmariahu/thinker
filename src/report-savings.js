// Weekly savings use request dates, not PR merge dates or a session's final timestamp.
// These are estimates, separate from billed usage: never add the series to each other.
import { costOfInputSavings, listPrice } from './prices.js';
import { sessionKey } from './usage.js';

const empty = () => ({ tokens: 0, cost: 0, events: 0, pricedEvents: 0, unpricedTokens: 0, estimatedTokens: 0, hits: 0 });
export const SAVINGS_SERIES = [['cache', 'Cache hits'], ['compression', 'Context compression']];
export function weeklySavings({ columns, now, config, cache = [], events = [], compression = [], sessions = [], origin, ownership = [] }) {
  const series = SAVINGS_SERIES.map(([key, name]) => ({ key, name, cells: columns.map(empty) }));
  const at = t => columns.findIndex((c, i) => t >= c.t && t < (columns[i + 1]?.t ?? Infinity) && t <= now);
  const account = (kind, r, tokens, cost) => {
    const w = at(typeof r.at === 'number' ? r.at : Date.parse(r.at));
    if (w < 0) return;
    const c = series[kind].cells[w];
    c.tokens += tokens; c.events++;
    if (cost == null) c.unpricedTokens += tokens;
    else { c.cost += cost; c.pricedEvents++; }
    if (r.estimated) c.estimatedTokens += tokens;
  };
  for (const r of cache) account(0, r, r.tokens, costOfInputSavings(r, listPrice(r.model, { config })));
  const known = new Set(sessions.map(s => sessionKey(s.session)));
  for (const e of events) {
    if (e.session) known.add(sessionKey(e.session));
    const w = at(Date.parse(e.t));
    if (w >= 0 && ['orient', 'late', 'lookup'].includes(e.op)) series[0].cells[w].hits += e.served?.length || 0;
  }
  // A session may visit several repositories. Attribute each request once, to the
  // last repository its hooks named before that request (or its first known one).
  const owners = new Map();
  for (const e of ownership) if (e.session && e.origin && Number.isFinite(Date.parse(e.t))) {
    const key = sessionKey(e.session);
    if (!owners.has(key)) owners.set(key, []);
    owners.get(key).push({ t: Date.parse(e.t), origin: e.origin });
  }
  for (const timeline of owners.values()) timeline.sort((a, b) => a.t - b.t);
  const ownerAt = r => {
    const timeline = owners.get(sessionKey(r.session));
    if (!timeline?.length) return null;
    let lo = 0, hi = timeline.length, t = Date.parse(r.at);
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (timeline[mid].t <= t) lo = mid + 1; else hi = mid; }
    return timeline[Math.max(0, lo - 1)].origin;
  };
  for (const r of compression) {
    const owner = origin && ownerAt(r);
    if (owner && owner !== origin) continue;
    if (!known.has(sessionKey(r.session)) || r.truncated || !(r.status >= 200 && r.status < 300)) continue;
    // Anthropic reports tokens cleared; Responses records a byte-based estimate. Both
    // count the shorter prefix on each request, including subsequent cached reads.
    const estimated = r.protocol === 'responses', tokens = estimated ? r.estimatedRemovedTokens : r.cleared;
    if (!Number.isFinite(tokens) || tokens < 0) continue;
    account(1, { ...r, estimated }, tokens, costOfInputSavings({ cacheRead: tokens }, listPrice(r.model, { config })));
  }
  return series;
}

export function mergeSavings(views, n) {
  return SAVINGS_SERIES.map(([key, name]) => ({ key, name, cells: Array.from({ length: n }, (_, w) => {
    const sum = empty();
    for (const v of views) {
      const c = v.savings?.find(s => s.key === key)?.cells[w];
      for (const k of Object.keys(sum)) sum[k] += c?.[k] || 0;
    }
    return sum;
  }) }));
}

// Shared with the page: unpriced/missing observations are gaps, not zero savings.
export function savingsValue(c, column, totalCell, { cost = true, total = false, share = false } = {}) {
  if (!c || !(cost ? c.pricedEvents : c.events)) return null;
  const n = cost ? c.cost : c.tokens;
  const denominator = share ? (cost ? totalCell?.cost : totalCell?.tokens) : total ? 1 : (cost ? column.pricedPrompts : column.prompts);
  return denominator ? n / denominator : null;
}
