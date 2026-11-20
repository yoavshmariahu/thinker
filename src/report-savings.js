// Weekly savings use request dates, not PR merge dates or a session's final timestamp.
// These are estimates, separate from billed usage: never add the series to each other.
import { costOf, costOfInputSavings, listPrice } from './prices.js';
import { sessionKey } from './usage.js';
import { clearedOf, clearedEstimated, savedAs } from './cutting.js';

const empty = () => ({ tokens: 0, cost: 0, events: 0, pricedEvents: 0, unpricedTokens: 0, estimatedTokens: 0 });
// The cache-hits series (reading the notes avoided, an estimate) went with the notes on 2026-11-08.
// `delegation` since 2026-11-14 (the owner's ask): a read the trigger handed to a subagent never entered the
// lead's context, so the clearing can never clear it and no figure anywhere said it had saved anything -- the
// better delegation worked, the lower the footer read. The two series act on the same kind of token but never
// on the same token (a delegated read is not there to be cleared), which is why the footer may add them.
export const SAVINGS_SERIES = [['compression', 'Context compression'], ['delegation', 'Reads delegated']];

// What one delegated read saved, in one rule: the lead did not write it into its cache, and did not read it
// back on any later call. The write is netted against what the subagent paid for the same read -- its own
// reported cost where thinker ran it (`cost`, the fallback), the same tokens at the subagent's write rate where
// the host's agent is pinned to a model (`model`), and where neither is known the subagent is assumed to have
// paid what the lead would have, so the write half is zero and only the later reads count.
//
// Which rows are firings: not held out, not declined, not failed, not a repeat answered from the turn's cache,
// and not a handoff the model ignored -- a later `after: 'handoff'` row of the session naming the same file is
// the lead reading it anyway, and then nothing was kept out. That marker is only the lead reading it anyway
// since 2026-11-19 (delegate.js:decide): the turn's budget spent on other files is `after: 'budget'` and a
// batch's second call for a read still being explored is `after: 'in-flight'`, which is answered from the same
// report and keeps the file out exactly as the firing did, so neither takes a saving away.
const fired = e => e?.op === 'delegate' && e.session && e.tokens > 0 && !e.held && e.fired !== false
  && !e.declined && !e.skipped && !e.error && !e.cached;
const write1h = price => price.cacheWrite1h ?? price.cacheWrite ?? 2 * price.input;
const promptOf = r => (r.input || 0) + (r.read || 0) + (r.write || 0);
// A row the proxy logged for a model call it carried (a desktop clear's row and a mirrored one are sums).
const isCall = r => r?.op === 'proxy' && !r.recorded && r.session && typeof r.out === 'number' && r.status >= 200 && r.status < 300;

// A session the Stop hook post-processed carries the answer on its own row (`delegated`, delegated.js: read out of
// the transcript when each turn ends, as the re-reads are): what was never written, the calls it would have been
// read back on, and which subagents did the reading, priced here at their own models from the same row. The row is
// cumulative, so each one accounts what it added to the one before, dated when it was written. Such a session is
// counted from its rows alone; the rule below it is for sessions from before the rows carried this.
const subUsage = a => ({ input: a.inputTokens, cacheRead: a.cacheReadTokens, cacheWrite: a.cacheWriteTokens, cacheWrite1h: a.cacheWrite1hTokens, output: a.outputTokens });
function recordedSavings(events, config) {
  const by = new Map(), own = new Map(), out = [];
  for (const e of events) {
    if (e?.op === 'session' && e.session && e.delegated) { const k = sessionKey(e.session); if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
    // thinker's own fallback subagent is no subagent of the host's: what it cost is on the firing's row
    if (fired(e) && Number.isFinite(e.cost)) { const k = sessionKey(e.session); if (!own.has(k)) own.set(k, []); own.get(k).push({ t: Date.parse(e.t), cost: e.cost }); }
  }
  for (const [k, rows] of by) {
    rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    let tokens = 0, cost = 0;
    for (const e of rows) {
      const d = e.delegated, t = Date.parse(e.t), price = listPrice(e.model, { config });
      if (!Number.isFinite(t)) continue;
      const nowTokens = (d.tokens || 0) + (d.laterTokens || 0);
      let nowCost = null;
      if (price) {
        const ids = new Set(d.agents || []);
        const subs = (e.subagents || []).filter(a => ids.has(a.agent)).map(a => costOf(subUsage(a), listPrice(a.model, { config })));
        const fallback = (own.get(k) || []).filter(x => x.t <= t).reduce((a, x) => a + x.cost, 0);
        if (subs.every(v => v != null)) nowCost = ((d.tokens || 0) * write1h(price) + (d.laterTokens || 0) * price.cacheRead) / 1e6 - subs.reduce((a, v) => a + v, 0) - fallback;
      }
      if (nowTokens !== tokens || (nowCost != null && nowCost !== cost)) out.push({ session: e.session, model: e.model, estimated: true, at: t, tokens: nowTokens - tokens, cost: nowCost == null ? null : nowCost - cost });
      tokens = nowTokens; if (nowCost != null) cost = nowCost;
    }
  }
  return { out, sessions: new Set(by.keys()) };
}

/**
 * The handoffs the lead went on to read itself: a later `after: 'handoff'` row of the session naming the same
 * file. Nothing was kept out of the prompt by one of those, so it is neither a saving here nor a delegation in
 * the day's count (telemetry.js:delegateMetrics counts the same rows as `ignored`, which is what makes the two
 * figures one rule). Only `after: 'handoff'` is the lead reading it anyway: since 2026-11-19 the turn's budget
 * spent on other files is `after: 'budget'` and a batch's second call for the same read is `after: 'in-flight'`,
 * which is answered from the report and keeps the file out exactly as the firing did (delegate.js:decide).
 */
export function readAnyway(events = []) {
  const ignored = new Map();
  for (const e of events) {
    if (e?.op !== 'delegate' || e.after !== 'handoff' || !e.session) continue;
    const k = sessionKey(e.session);
    if (!ignored.has(k)) ignored.set(k, []);
    ignored.get(k).push({ t: Date.parse(e.t), files: new Set(e.files || []) });
  }
  return (e, t = Date.parse(e?.t)) => (ignored.get(sessionKey(e?.session)) || [])
    .some(x => x.t >= t && (e?.files || []).some(f => x.files.has(f)));
}

export function delegationSavings({ events = [], compression = [], config } = {}) {
  const calls = new Map(), models = new Map();
  const readItself = readAnyway(events);
  const recorded = recordedSavings(events, config), out = recorded.out;
  for (const r of compression) {
    if (!isCall(r)) continue;
    const k = sessionKey(r.session);
    if (!calls.has(k)) calls.set(k, []);
    calls.get(k).push({ t: Date.parse(r.at), model: r.model, turn: r.turn, prompt: promptOf(r), at: r.at });
  }
  // The lead is the model that carried the most prompt: a session's rows hold its subagents' calls and its
  // title calls under the one id, and those are small. Later calls are the lead's alone.
  const lead = new Map();
  for (const [k, rows] of calls) {
    rows.sort((a, b) => a.t - b.t);
    const by = new Map();
    for (const r of rows) by.set(r.model, (by.get(r.model) || 0) + r.prompt);
    lead.set(k, [...by].sort((a, b) => b[1] - a[1])[0]?.[0] || null);
  }
  for (const e of events) if (e?.op === 'session' && e.session && e.model) models.set(sessionKey(e.session), e.model);
  for (const e of events) {
    if (!fired(e)) continue;
    const k = sessionKey(e.session), t = Date.parse(e.t), tokens = e.tokens;
    if (!Number.isFinite(t) || recorded.sessions.has(k)) continue;
    if (readItself(e, t)) continue;
    const model = lead.get(k) || models.get(k) || null, price = listPrice(model, { config });
    const row = { session: e.session, model, estimated: true };
    // the write the lead did not make, less what the subagent paid for the same read
    let cost = null;
    if (price) {
      const own = Number.isFinite(e.cost) ? e.cost : Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : null;
      const sub = own == null && e.model ? listPrice(e.model, { config }) : null;
      const lead1h = tokens * write1h(price) / 1e6;
      cost = own != null ? lead1h - own : sub ? lead1h - tokens * write1h(sub) / 1e6 : 0;
    }
    out.push({ ...row, at: t, tokens, cost });
    // and every later call of the lead that would have read it back, until a compaction would have taken it
    // out anyway (the turn count falls, since the conversation's prompts were summarised away)
    let prev = null;
    for (const r of calls.get(k) || []) {
      if (r.model !== model) continue;
      if (r.t <= t) { prev = r.turn ?? prev; continue; }
      if (Number.isFinite(r.turn) && Number.isFinite(prev) && r.turn < prev) break;
      if (Number.isFinite(r.turn)) prev = r.turn;
      out.push({ ...row, at: r.t, tokens, cost: costOfInputSavings({ cacheRead: tokens }, price) });
    }
  }
  return out;
}
export function weeklySavings({ columns, now, config, events = [], compression = [], sessions = [], origin, ownership = [] }) {
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
  const known = new Set(sessions.map(s => sessionKey(s.session)));
  for (const e of events) if (e.session) known.add(sessionKey(e.session));
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
    // Where the API cleared, it reported the tokens; since thinker cuts the context itself the row carries
    // the cut's own count, and Responses a byte-based estimate. All three count the shorter prefix on each
    // request, including subsequent cached reads (cutting.js:clearedOf).
    const estimated = clearedEstimated(r), tokens = clearedOf(r);
    if (!Number.isFinite(tokens) || tokens < 0) continue;
    // priced as what the request would have paid for them: a cache read, or a cache write on a request that
    // wrote its whole context again (cutting.js:savedAs), the same rule the delivery ledger prices a session by
    account(0, { ...r, estimated }, tokens, costOfInputSavings(savedAs(r, tokens), listPrice(r.model, { config })));
  }
  // `events` is already the repository's own where a repository asked (report.js reads its log), so a firing
  // needs no owner: it is counted where its hook logged it, with the session's later calls wherever they went.
  for (const d of delegationSavings({ events, compression, config })) account(1, d, d.tokens, d.cost);
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
