// The accountant: the one place thinker's savings are counted (the owner, 2026-11-22: "we need to build a single
// source of truth. we should have an accountant module that is fully responsible for tracking savings", and then
// "consolidate any savings logic into the accountant").
//
// What set it off: asked what it had saved in a fortnight, thinker's chat said $38. That was the reads handed to
// cheaper agents, the one figure it had been given; the status line's own count for the same fourteen days was
// $167, of which $129 was context the clearing took out. Nothing was wrong with either sum. They were two
// computations in two modules reading two sets of records, and a third and a fourth lived beside them (a pull
// request's saving in delivery.js, a session's clearing in compression.js). A figure nobody can check against the
// one beside it is the thing this module ends.
//
// The rule, held by test/savings.test.js: a saving is priced here and nowhere else. No other module calls
// prices.js:costOfInputSavings, nets a saving against what it cost, or adds savings up over a window. The parts of
// thinker that act keep the records of what they did (the proxy's rows and the clearing's session record in
// compression.js, the delegation trigger's rows in the log, a decision in context-suggest.js); every door that says
// what was saved -- the status line, `thinker savings`, `thinker report`, the chat, Recent activity, `thinker prs`
// and the comment it posts, the telemetry -- asks here.
//
// In this file, in order:
//   the records     one reader for the machine's or a repository's (`records`), so no two doors count over
//                   different sets of sessions
//   the rules       what each kind of saving is and how it is priced: context cleared (and what a clear cost: the
//                   cache rewrite, the re-reads), reads delegated, reads already in context, a change to what
//                   loads into every prompt
//   the sums        by week (the Report's table), by window (the ledger: today, the last fortnight, lifetime), by
//                   session, and netted for a pull request's sessions
//   the book        the kept ledger the footers read (<THINKER_HOME>/state/savings.json)
//   the words       the one line, the status row, the split, a session's handoffs, a change's impact
//
// Weekly savings use request dates, not PR merge dates or a session's final timestamp.
// These are estimates at API list prices, separate from billed usage. The series may be added to each other: they
// act on the same kind of token and never on the same token (below).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isTestMode } from './test-mode.js';
import { costOf, costOfInputSavings, listPrice, formatDollars } from './prices.js';
import { repoId } from './store.js';
import { readLog, sessionKey } from './usage.js';
import { chargedRewrite, clearedOf, clearedEstimated, savedAs, wroteCold } from './cutting.js';
import { clearingRows, compressionDir, compressionRecords, desktopRecords, loggedClearing, readCompression } from './compression.js';
import { thinkerHome } from './update.js';
import { appVersion, proxyLogFile } from './proxy-service.js';
import { formatTokens } from './model-usage.js';

// --- the records ---------------------------------------------------------------------------------------------------------
// What a count is made over: the usage log's events -- a repository's own, or with `all` the machine's -- the
// clearing's rows for the sessions they name (compression.js:clearingRows: the proxy's log, a desktop session's own
// record, a clear mirrored into the usage log), and the prices in force there. One reader, so that no two doors
// count over different sets of sessions; a test with no home and no log of its own has no clearing rows.
// `log`, `compression`, `config`: given by a caller that has them already, and by tests in place of the files.
export function records(store, { all = false, home = null, env = process.env, log = null, compression = null, config = null } = {}) {
  if (!config) { try { config = store.config(); } catch { config = {}; } }
  const events = log || (all ? readLog(store, { all: true }) : readLog(store));
  const rows = compression || (env.THINKER_TEST === '1' && !env.THINKER_HOME && !env.THINKER_PROXY_LOG ? []
    : clearingRows(proxyLogFile(home || undefined, env), compressionDir(home || undefined), { events, key: sessionKey }));
  return { events, compression: rows, config };
}

// --- the series: context cleared, reads delegated, reads already in context --------------------------------------------
const empty = () => ({ tokens: 0, cost: 0, events: 0, pricedEvents: 0, unpricedTokens: 0, estimatedTokens: 0 });
// The cache-hits series (reading the notes avoided, an estimate) went with the notes on 2026-11-08.
// `delegation` since 2026-11-14 (the owner's ask): a read the trigger handed to a subagent never entered the
// lead's context, so the clearing can never clear it and no figure anywhere said it had saved anything -- the
// better delegation worked, the lower the footer read. The two series act on the same kind of token but never
// on the same token (a delegated read is not there to be cleared), which is why the footer may add them.
// `repeat` since 2026-11-21 (the owner's ask, "we need to be able to count the savings we get from this"): a read
// the pointer answered with the copy the model already had never entered the context a second time, so -- as with
// a delegated read -- the clearing can never clear it and no figure said it had saved anything. Three series now,
// and the same rule holds between them: they act on the same kind of token, never on the same token (a read that
// was pointed at is not there to be cleared, and a pointer and a handoff never answer one call: `noteDecided`),
// which is why the footer may add them.
export const SAVINGS_SERIES = [['compression', 'Context compression'], ['delegation', 'Reads delegated'], ['repeat', 'Reads already in context']];

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
// `field` is which of the session's two post-processed figures this is walking, and `netted` whether a subagent
// was paid for it: a handoff's saving is netted against the run that did the reading, and a pointer's is not --
// nothing ran, the bytes were already in the context (delegate.js, "the same file, read again").
function recordedSavings(events, config, { field = 'delegated', netted = true } = {}) {
  const by = new Map(), own = new Map(), out = [];
  for (const e of events) {
    if (e?.op === 'session' && e.session && e[field]) { const k = sessionKey(e.session); if (!by.has(k)) by.set(k, []); by.get(k).push(e); }
    // thinker's own fallback subagent is no subagent of the host's: what it cost is on the firing's row
    if (fired(e) && Number.isFinite(e.cost)) { const k = sessionKey(e.session); if (!own.has(k)) own.set(k, []); own.get(k).push({ t: Date.parse(e.t), cost: e.cost }); }
  }
  for (const [k, rows] of by) {
    rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    let tokens = 0, cost = 0;
    for (const e of rows) {
      const d = e[field], t = Date.parse(e.t), price = listPrice(e.model, { config });
      if (!Number.isFinite(t)) continue;
      const nowTokens = (d.tokens || 0) + (d.laterTokens || 0);
      let nowCost = null;
      if (price) {
        const gross = ((d.tokens || 0) * write1h(price) + (d.laterTokens || 0) * price.cacheRead) / 1e6;
        if (!netted) nowCost = gross;
        else {
          const ids = new Set(d.agents || []);
          const subs = (e.subagents || []).filter(a => ids.has(a.agent)).map(a => costOf(subUsage(a), listPrice(a.model, { config })));
          const fallback = (own.get(k) || []).filter(x => x.t <= t).reduce((a, x) => a + x.cost, 0);
          if (subs.every(v => v != null)) nowCost = gross - subs.reduce((a, v) => a + v, 0) - fallback;
        }
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
/**
 * What each session handed to cheaper agents, and what that saved (the owner's ask, 2026-11-21: "show per session how
 * much work has been delegated to cheaper agents and resulted in savings"). The saving is the "Reads delegated"
 * series itself (delegationSavings), its rows added by session instead of by week, so a session's figure can never
 * disagree with the Report's. Beside it, how much was handed over: the handoffs that were made and kept (a read the
 * lead went on to make itself is not one, as in the series), by kind, the tokens of the reads, and the models they
 * went to where the row names one. `saved` is null where any part of the session's saving has no list price: a
 * partial dollar figure is never shown. `title` is the session's first request as the log keeps it (its first 200
 * characters), so a person can tell which session a line is.
 */
const handed = e => e?.op === 'delegate' && e.session && !e.held && e.fired !== false && !e.declined && !e.skipped && !e.error && !e.cached;
export function delegationBySession({ events = [], compression = [], config, since = 0 } = {}) {
  const by = new Map();
  const of = s => { const k = sessionKey(s); if (!by.has(k)) by.set(k, { session: s, at: 0, reads: 0, runs: 0, handed: 0, models: new Set(), tokens: 0, saved: 0, unpriced: false, lead: null, client: null, title: '' }); return by.get(k); };
  for (const r of delegationSavings({ events, compression, config })) {
    const g = of(r.session);
    g.tokens += r.tokens || 0;
    if (r.model) g.lead = r.model;
    if (r.cost == null) g.unpriced = true; else g.saved += r.cost;
  }
  const readItself = readAnyway(events), titles = new Map();
  for (const e of events) {
    if (e?.op === 'request' && e.session && e.task && !titles.has(sessionKey(e.session))) titles.set(sessionKey(e.session), String(e.task));
    if (!handed(e)) continue;
    const t = Date.parse(e.t);
    if (!Number.isFinite(t) || readItself(e, t)) continue;
    const g = of(e.session);
    if (e.kind === 'verify') g.runs++; else { g.reads++; g.handed += e.tokens || 0; }
    if (e.model) g.models.add(e.model);
    if (e.client) g.client = e.client;
    if (t > g.at) g.at = t;
  }
  return [...by.entries()].filter(([, g]) => g.reads + g.runs > 0 && g.at >= since)
    // `lead`: the session's own model where the log or the proxy recorded one; `client`: the agent it ran in. With
    // them a session left out of the dollars can say which it is: a model nobody recorded, or one with no list price.
    .map(([k, g]) => ({ session: g.session, at: g.at, reads: g.reads, runs: g.runs, handed: g.handed, models: [...g.models].sort(), tokens: g.tokens, saved: g.unpriced ? null : g.saved, lead: g.lead, client: g.client, title: titles.get(k) || '' }))
    .sort((a, b) => b.at - a.at);
}

/**
 * One session's handoffs in full, for somebody asking about it (chat.js): each read or test run that was handed over
 * and kept, with its files, its size and where it went; how many more the lead read itself anyway; the lead's model;
 * and the saving with the tokens it is counted over. The same rows and the same rule as delegationBySession.
 */
export function delegationDetail({ events = [], compression = [], config, session } = {}) {
  const key = sessionKey(session), readItself = readAnyway(events);
  const mine = events.filter(e => e?.session && sessionKey(e.session) === key);
  const handoffs = [], lead = mine.filter(e => e.op === 'session' && e.model).at(-1)?.model || null;
  let ignored = 0;
  for (const e of mine) {
    if (!handed(e)) continue;
    if (readItself(e, Date.parse(e.t))) { ignored++; continue; }
    handoffs.push({ at: e.t, kind: e.kind === 'verify' ? 'test run' : 'read', files: (e.files || []).slice(0, 6), tokens: e.tokens || 0, to: e.model || e.agent || null });
  }
  const rows = delegationSavings({ events, compression, config }).filter(r => sessionKey(r.session) === key);
  return { handoffs, ignored, lead: rows.find(r => r.model)?.model || lead, tokens: rows.reduce((a, r) => a + (r.tokens || 0), 0), saved: rows.some(r => r.cost == null) ? null : rows.reduce((a, r) => a + r.cost, 0), counted: rows.length, title: mine.find(e => e.op === 'request' && e.task)?.task || '' };
}

/**
 * What the pointers of a session kept out, from the session's own row (`repeated`, delegate.js and delegated.js:
 * the write it never made and the read of it avoided on every later call of the lead, counted as zero where the
 * lead went on to read the file whole anyway, and stopped where a cut or a compaction would have taken the first
 * copy out regardless). Nothing is netted: no subagent ran, no model was called, and the pointer is a sentence.
 *
 * Session rows only, and deliberately: this trigger has no history to price from rows (it ships with the
 * figure), and a saving read twice would be a figure nobody could check.
 */
export function repeatSavings({ events = [], config } = {}) {
  return recordedSavings(events, config, { field: 'repeated', netted: false }).out;
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
  // the pointers, from the sessions' own rows, counted where their hook logged them as the handoffs are
  for (const r of repeatSavings({ events, config })) account(2, r, r.tokens, r.cost);
  return series;
}

// The Report's table for one repository: its own firings and sessions, and a clear counted where the session was
// when the request was made (the machine's log says where each session went, `ownership`). `events`: the machine's
// log as it was read, for a caller that needs it again.
export function repositorySavings(store, { columns, now = Date.now(), sessions = [], config = null } = {}) {
  const all = records(store, { all: true, config });
  return { series: weeklySavings({ columns, now, config: all.config, events: readLog(store), compression: all.compression, sessions, origin: repoId(store.repo), ownership: all.events }), events: all.events };
}

// One series by UTC day, for the telemetry: the tokens it kept out and the dollars, on the day each was saved. A
// saving in a session whose model has no list price is in `unpricedTokens` and in no dollar figure. `events`: the
// log the caller already read.
export function savingsByDay(series, store, { events = null, since = '', now = Date.now(), home = null, env = process.env } = {}) {
  const book = records(store, { all: true, home, env, log: events, ...(series === 'repeat' ? { compression: [] } : {}) });
  const byDay = {};
  for (const r of series === 'repeat' ? repeatSavings(book) : delegationSavings(book)) {
    if (!Number.isFinite(r.at) || r.at > now) continue;
    const at = new Date(r.at).toISOString();
    if (at < since) continue;
    const d = byDay[at.slice(0, 10)] ||= { savedTokens: 0, savedUsd: 0, unpricedTokens: 0 };
    d.savedTokens += r.tokens || 0;
    if (r.cost == null) d.unpricedTokens += r.tokens || 0; else d.savedUsd += r.cost;
  }
  return byDay;
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

// --- context cleared: what it saved, and what a clear cost ---------------------------------------------------------------
// The clearing's records are compression.js's (the proxy's log rows, the session's own record, a desktop clear
// mirrored into the usage log); what they come to is counted here. A cleared token is worth what its request would
// have paid for it (cutting.js:savedAs: a cache read, or a cache write where the request wrote its whole context
// again), at the model that answered that request. What a clear cost is the cache write of the request that made the
// cut, and what the model read again afterwards (rereads.js). Net is the first less the other two (`netOf`).
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export function clearedBySession(file, { since = '', config } = {}) {
  const out = new Map();
  for (const r of compressionRecords(file)) {
    const cleared = clearedOf(r);
    if (!(cleared > 0) || (since && r.at && r.at < since)) continue;
    const prev = out.get(r.session) || { cleared: 0, requests: 0, usd: 0, pricedTokens: 0, coldUsd: 0, coldRequests: 0 };
    // What the row saved, at the model that answered that row -- the ledger's and the Report's rule
    // (accountant.js:weeklySavings). A session is not one model: its subagents and its routes to another
    // provider run on their own, and the rewrites after a clear are already priced row by row. Pricing the
    // whole session's cleared tokens at the one model its last `session` row named put a machine's 339M
    // cleared tokens at $0.01 a million against rewrites charged at the model that made them (2026-11-16).
    const price = listPrice(r.model, { config });
    // And at what the request would have paid for it (cutting.js:savedAs, 2026-11-18): a cache read, or a cache
    // write on a request that read nothing back and wrote its whole context again. `coldUsd` is that second
    // kind on its own, so a reader can see how much of a saving came from a cache that had expired -- it is
    // part of `usd`, not beside it.
    const worth = price ? costOfInputSavings(savedAs(r, cleared), price) : 0, cold = wroteCold(r);
    out.set(r.session, { cleared: prev.cleared + cleared, requests: prev.requests + 1,
      usd: prev.usd + worth, pricedTokens: prev.pricedTokens + (price ? cleared : 0),
      coldUsd: prev.coldUsd + (cold ? worth : 0), coldRequests: prev.coldRequests + (cold ? 1 : 0),
      // The model the API answered with, from the rows themselves. Without it a session is priced only when
      // the usage log's own `session` row names one, and on this machine that left 96% of the cleared tokens
      // in a five-day window unpriced -- so the netted dollars were computed from a handful of sessions and
      // read as noise. The proxy has known the model all along; nothing asked it.
      ...(r.model || prev.model ? { model: r.model || prev.model } : {}),
      // the policy the rows name (cutting.js:policyId), the newest winning, and a mark where a session spans two
      ...(r.policy || prev.policy ? { policy: r.policy || prev.policy } : {}),
      ...((prev.policy && r.policy && prev.policy !== r.policy) || prev.policyChanged ? { policyChanged: true } : {}) });
  }
  return out;
}

// a write after a clear is a one-hour write for the agents the proxy serves, as proxy-replay.js prices it
const writeCostOf = (write, price) => (write || 0) * (price.cacheWrite1h ?? 2 * price.input) / 1e6;

// What a desktop session's clears cost, read from the record: the mod counts, on every request from its first
// clear onward, the requests charged to a clear and the cache-write tokens they carried (register.tsx:charge,
// by cutting.js:chargedRewrite), and keeps the model that answered. Priced as the proxy's rows are, below. A record
// with no `cost` block is from before the mod counted it: no cost figure, rather than a zero that reads as free.
export function desktopClearingCost(dir, { covered = new Set(), since = '', key = s => String(s), config } = {}) {
  const out = new Map();
  for (const { record: r, at } of desktopRecords(dir, { covered, key })) {
    if (!r.cost || (since && at < since)) continue;
    const x = { rewrites: r.cost.rewrites || 0, write: r.cost.write || 0, usd: 0, unpriced: 0, ...(r.model ? { model: r.model } : {}) };
    const price = listPrice(r.model, { config });
    if (price) x.usd += writeCostOf(x.write, price); else if (x.write > 0) x.unpriced++;
    out.set(r.session, x);
  }
  return out;
}

// What a mirrored clear cost, priced as the proxy's rows and the records are (`desktopClearingCost`).
export function loggedClearingCost(events, { covered = new Set(), key = s => String(s), since = '', config } = {}) {
  const out = new Map();
  for (const [id, e] of loggedClearing(events, { key, since })) {
    if (covered.has(id) || !e.cost) continue;
    const x = { rewrites: e.cost.rewrites || 0, write: e.cost.write || 0, usd: 0, unpriced: 0, ...(e.model ? { model: e.model } : {}) };
    const price = listPrice(e.model, { config });
    if (price) x.usd += writeCostOf(x.write, price); else if (x.write > 0) x.unpriced++;
    out.set(id, x);
  }
  return out;
}

// With `dir`, the sessions the log has no rows for are read from their records (desktopClearingCost): a clear
// made inside a desktop session is charged its writes as a proxied one is, so no door shows it gross.
export function clearingCostBySession(file, { since = '', config, dir = null, key = s => String(s), events = [] } = {}) {
  const out = new Map(), covered = new Set(), highest = new Map();
  const rows = compressionRecords(file);
  for (const r of rows) {
    covered.add(key(r.session));
    // read before the window is applied, so a figure that stood before it is not taken for a new cut inside it
    const high = highest.get(r.session) || 0, now = clearedOf(r);
    if (now > high) highest.set(r.session, now);
    if (since && r.at && r.at < since) continue;
    // Only the rewrite a cut caused is the clearing's cost (the owner's call, 2026-11-16). A cut changes the
    // prefix once, on the request that makes it; every request after it sends the same replacements byte for
    // byte and reads the cache back. So a rewrite on any later request -- a compaction, the agent editing its
    // own history, a cache that lapsed part-way -- was coming with or without the clearing. The request that
    // made a cut carries the decision (`clear`); a row from before the cut was thinker's own carries neither
    // that nor `clientCut`, and there the mark is the cleared figure rising past the session's highest so far.
    const madeCut = r.clear ? true : !r.clientCut && now > high;
    if (!madeCut || !chargedRewrite(r)) continue;
    // A cold cut's own call is not the clearing's cost. Past the cache's hour the request writes its whole
    // context again whether or not anything was replaced, which is exactly why `decideCut` prices that cut at
    // zero (cutting.js, the cold branch) -- and then this door charged the very same write to the clearing.
    // Measured on this machine: both Fable cuts of the five days to 2026-11-11 were cold, each wrote its
    // context with a cache read of ZERO (202k and 349k, nothing to read back), and no call after either one
    // rewrote a prefix at all -- 0 of 227 over 100k of context. Those two writes were the whole of the $11.01
    // charged against $3.89 saved, and at Fable's 80 reads to a written token they read as the clearing
    // losing money on a session it had not cost a token. The two doors have to price a cold cut alike.
    if (r.clear?.cold) continue;
    // and a write that read nothing back is the expired cache's for the same reason (cutting.js:chargedRewrite)
    const price = listPrice(r.model, { config });
    const x = out.get(r.session) || { rewrites: 0, write: 0, usd: 0, unpriced: 0 };
    x.rewrites++; x.write += r.write || 0;
    if (price) x.usd += writeCostOf(r.write, price); else x.unpriced++;
    out.set(r.session, x);
  }
  if (dir) for (const [id, x] of desktopClearingCost(dir, { covered, since, key, config })) { out.set(id, x); covered.add(id); }
  for (const [id, x] of loggedClearingCost(events, { covered, since, key, config })) out.set(id, x);
  return out;
}

// What the context proxy's clearing saved in a session: the proxy's own log first, since it is the durable
// record, and the card's state file only where the log's tail no longer reaches (compression.js).
export function clearingFor({ home = thinkerHome(), env = process.env, since = '', config } = {}) {
  let logged = new Map();
  try { for (const [id, row] of clearedBySession(proxyLogFile(home, env), { since, config })) logged.set(sessionKey(id), row); } catch { logged = new Map(); }
  const dir = compressionDir(home);
  return id => {
    let state = null;
    try { state = readCompression(dir, id); } catch { state = null; }
    // The record is the session's whole life, so it may only be read inside the window the log's rows are read
    // over -- otherwise a clear made days before `since` counts as a saving inside it. On this machine a
    // five-day window drew in 16 sessions cleared 8 to 13 days earlier, 425M of its 441M tokens, which is how
    // a question about the last five days got answered with a fortnight's clears (`desktopClearRows` and
    // `desktopClearingCost` have dated their rows all along; this door did not).
    const at = state?.lastAt ?? state?.firstAt;
    const dated = typeof at === 'number' ? new Date(at).toISOString() : at;
    if (state && since && dated && dated < since) state = null;
    const a = logged.get(id);
    const cleared = Math.max(finite(a?.cleared) ? a.cleared : 0, finite(state?.saved) ? state.saved : 0);
    // Which cut policy saved it (cutting.js:policyId), off whichever record carried the figure -- the log
    // first, as above. Null for a clear made before the policy was stamped on the row, which is not the same
    // as a clear under today's policy: a reader comparing savings leaves those out rather than pooling them.
    const named = a?.policy ? a : state?.policy ? state : null;
    return { cleared, model: a?.model || state?.model || null,
      // what the log's own rows saved, each at its own model, and how many of the cleared tokens that covers;
      // `coldUsd` is the part of it saved on requests that wrote their whole context again (cutting.js:wroteCold)
      usd: a?.usd || 0, pricedTokens: a?.pricedTokens || 0, coldUsd: a?.coldUsd || 0,
      policy: named?.policy || null, policyChanged: Boolean(a?.policyChanged || state?.policyChanged) };
  };
}

// What a session's clearing saved, as a number, for the readers that want only that.
export function clearedFor(opts = {}) { const clearing = clearingFor(opts); return id => clearing(id).cleared; }

// What a mirrored desktop clear cost, priced here because the row carries the write tokens the mod counted
// and the model that answered (accountant.js:loggedClearingCost prices the same row for the Report).
export function rewriteOfLogged(logged, config) {
  if (!logged?.cost) return null;
  const price = listPrice(logged.model, { config });
  const write = logged.cost.write || 0;
  return { rewrites: logged.cost.rewrites || 0, write, usd: price ? writeCostOf(write, price) : 0,
    unpriced: price || !write ? 0 : 1, ...(logged.model ? { model: logged.model } : {}) };
}

// What the clearing cost in that session: the cache writes on the calls from its first clear onwards
// (accountant.js:clearingCostBySession). The proxy's log knows this for the sessions it served; a desktop
// session never reaches the proxy, and its record (the clearing mod's, in the card's state directory) keeps
// the same count since 2026-11-06, read where the log has no rows for the session. A session the log's tail
// no longer reaches, or a record from before the mod counted, has no cost figure, and `costed` on the report
// says how many did.
export function rewriteCostFor({ home = thinkerHome(), env = process.env, since = '', config } = {}) {
  let logged = new Map();
  try { for (const [id, x] of clearingCostBySession(proxyLogFile(home, env), { since, config, dir: compressionDir(home), key: sessionKey })) logged.set(sessionKey(id), x); } catch { logged = new Map(); }
  return id => logged.get(id) || null;
}

// What a session's clearing came to in dollars: { saved, cold, rewrite, reread, priced, net }.
// `clearing`: the session's entry from clearingFor (the log's rows priced one by one: `usd` over `pricedTokens`);
// `cleared`: its cleared tokens from every record; `rewrite`: what its cuts cost (rewriteCostFor, rewriteOfLogged);
// `rereads`: the session's own count of what it read again (rereads.js).
// Saved is priced row by row where the proxy's log has the rows, each row at the model that answered it, as the
// weekly table prices it and as the rewrites are charged. What the rows do not cover -- a desktop clear known from
// its record alone, a row whose model has no price -- is priced at the session's own model, and a session with such
// a remainder and no priced model stays unpriced: a partial dollar figure is never given.
export function sessionSaving({ cleared = 0, clearing = {}, rewrite = null, rereads = null, model = null, config } = {}) {
  const c = clearing || {}, price = listPrice(model, { config });
  const byRow = Math.min(c.pricedTokens || 0, cleared || 0), rest = (cleared || 0) - byRow;
  const cost = price || (byRow > 0 && rest === 0)
    ? { saved: (byRow > 0 ? c.usd * (byRow / c.pricedTokens) : 0) + (price ? rest * price.cacheRead / 1e6 : 0),
      // of `saved`, what was saved on requests that wrote their whole context again; a clear known from its
      // record alone has no request to read that off, and is priced as reads
      cold: byRow > 0 ? (c.coldUsd || 0) * (byRow / c.pricedTokens) : 0,
      rewrite: rewrite?.usd || 0, reread: price ? rereadCost(rereads, price) : 0, priced: true }
    : { saved: 0, cold: 0, rewrite: 0, reread: 0, priced: false };
  cost.net = netOf(cost);
  return cost;
}
// The net of a saving: what was saved, less the cache writes its cuts caused, less what was read again. One rule,
// for a session, a pull request and every sum of them.
export const netOf = c => (c?.saved || 0) - (c?.rewrite || 0) - (c?.reread || 0);
// The same rule in words, for the doors that say it under the figure.
export const NET_BASIS = 'cleared at the cache-read rate (the cache-write rate on a request that wrote its whole context again), less the cache writes after a clear, less the re-reads of cleared files, at list prices';
// A session's saving added into a group's (a pull request holds a share of a session that worked on two), and the
// savings of several groups as one: the dollars add, and the net of a sum is the sum of the nets.
export function addSaving(into, cost, share = 1) {
  into.saved += (cost?.saved || 0) * share; into.rewrite += (cost?.rewrite || 0) * share; into.reread += (cost?.reread || 0) * share;
  return into;
}
export const sumSavings = list => ({
  saved: list.reduce((a, c) => a + (c?.saved || 0), 0), rewrite: list.reduce((a, c) => a + (c?.rewrite || 0), 0),
  reread: list.reduce((a, c) => a + (c?.reread || 0), 0), net: list.reduce((a, c) => a + (c?.net || 0), 0),
});

// What a session's re-reads of cleared files cost, in dollars at list (rereads.js counts them): the write once, the reads after at the cache-read rate (prices.js).
export function rereadCost(rereads, price) {
  if (!rereads || !price || !(rereads.reads > 0)) return 0;
  const write = (rereads.tokens || 0) * (price.cacheWrite1h ?? 2 * price.input);
  const read = (rereads.laterTokens || 0) * price.cacheRead;
  return (write + read) / 1e6;
}

// --- a change to what loads into every prompt: what it saved ------------------------------------------------------------
// A decision on a part of the context (a section shortened, a tool made a reference: context-suggest.js keeps the
// decisions) is measured on that part alone: what it cost a prompt in the sessions before against the sessions since
// (`actionEffect`, over the Report's session rows). Dollars a day are those tokens over the prompts a day here at
// what an input token costs here (`dollarsADay`); until sessions since can say, the figure is what the Context
// report expected and is said as "about" (`impactSaid`).
const DAY = 86_400_000;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (s, n = 160) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// What compressing a tool's output measured: the tool's row under the compression against its row from before
// (tool-outputs.js:aggregateOutputs, one row a setting, each over the sessions that ran under it), the compressed row
// the latest one with a level. `perCall` is what compression acts on, the size of a result; `perPrompt` is what the
// person pays on an average prompt, the results times the calls that read them again, and moves with how the sessions
// since used the tool as well. A delta is before minus since, positive a saving; `window` is the prompt delta over the
// prompts since. null until both periods have a session in the window.
export function outputComparison(rows, name) {
  const mine = rows.filter(r => r.name === name), before = mine.find(r => !r.level), after = mine.filter(r => r.level).sort((a, b) => (b.from || 0) - (a.from || 0))[0];
  if (!before || !after || !before.sessions || !after.sessions) return null;
  const pick = r => ({ level: r.level || null, sessions: r.sessions, prompts: r.prompts ?? null, from: r.from ?? null, to: r.to ?? null, calls: r.calls, perCall: r.perCall, perPrompt: r.perPrompt, wasted: r.wasted ?? null });
  const d = k => ({ before: before[k], after: after[k], delta: before[k] - after[k], share: before[k] ? (before[k] - after[k]) / before[k] : null });
  return { name, before: pick(before), after: pick(after), perCall: d('perCall'), perPrompt: d('perPrompt'), window: (before.perPrompt - after.perPrompt) * (after.prompts || 0), few: after.sessions < 5 };
}

// From when an action is in effect, and until when: a dismissal and a pull request not merged never were, nor a section's
// change still running in the background or failed (context-suggest.js:startSectionJob); a merged one from its merge; a
// change written when its job was done from then; anything else from the decision, until it was reverted.
export const effectSpan = (e, now) => e.decision === 'dismissed' || (e.job && e.job.state !== 'done') ? null
  : e.pr ? (e.pr.state === 'merged' && e.pr.at ? { from: Date.parse(e.pr.at), to: now } : null)
  : { from: Date.parse(e.job?.finishedAt || e.at), to: e.revertedAt ? Date.parse(e.revertedAt) : now };

// What the one thing an action changed costs in a session (sessionRows, reportView), on one side of it: a section its
// tokens on that side times the session's model calls where the session read its file (the entry's `tokens`, recorded
// from the edit: 0 after a removal); a skill, MCP server, plugin or built-in tool its tokens a call times the calls where
// the session loaded it (harness.js `loaded`); a tool's outputs what that tool's results cost the session (tool-outputs.js
// `by`). null where the row cannot say (a section decided before the tokens were recorded).
export function itemCost(e, r, side) {
  if (e.kind === 'section') { const t = e.tokens?.[side]; if (t == null) return null; const file = e.file || e.key.replace(/^section:/, '').split(':')[0]; return (r.files || []).includes(file) ? t * (r.calls || 0) : 0; }
  if (e.kind === 'output') { const name = e.key.replace(/^output:/, ''); return Object.entries(r.outputs || {}).reduce((a, [k, t]) => a + (k === name || k.startsWith(`${name}@`) ? t : 0), 0); } // a compressed tool's key carries its level (tool-outputs.js:splitKey)
  return (r.sources || {})[e.key] || 0;
}

// What an action saved, attributed to it alone: the cost of the thing it changed (itemCost) per prompt over the window's
// sessions before the decision (`before`) and over those since it was in effect (`after`, until its revert), each side the
// sum over its sessions divided by their prompts, with its sessions, prompts and dates; `delta` before minus since a prompt,
// positive a saving, `share` of what a whole prompt cost before; `window` the delta over the prompts since (`since`: the thing over those prompts at
// the before rate against as it was); `few` under five sessions a side. null
// while a side has no session, the action is not in effect, or the thing cannot be costed. Independent of every other
// action: a tool switched off is measured on that tool's tokens, not on what the prompts cost in all.
export function actionEffect(e, sessionRows = [], now = Date.now(), { until = null } = {}) {
  const span = effectSpan(e, now); if (!span) return null;
  if (until != null && until < span.to) span.to = until; // a later decision on the same thing takes over from there
  const before = sessionRows.filter(r => r.t < span.from), after = sessionRows.filter(r => r.t >= span.from && r.t < span.to);
  if (!before.length || !after.length) return null;
  const side = (xs, k) => { const cs = xs.map(r => itemCost(e, r, k)); if (cs.some(c => c == null)) return null; const prompts = xs.reduce((a, r) => a + Math.max(1, r.prompts || 0), 0); const total = cs.reduce((a, c) => a + c, 0); return { sessions: xs.length, prompts, from: Math.min(...xs.map(r => r.t)), to: Math.max(...xs.map(r => r.t)), total, perPrompt: Math.round(total / prompts) }; };
  const b = side(before, 'before'), a = side(after, 'after');
  if (!b || !a) return null;
  const delta = b.perPrompt - a.perPrompt;
  // `share`: the saving against what a whole prompt cost before the decision (`whole.before`, the sessions' input over
  // their prompts), not against the thing's own size, so a small cut of a large part counts for what it is (the owner's
  // ask, 2026-10-24); the same share in the Total view, the window being the delta over the prompts since
  const whole = { before: Math.round(before.reduce((x, r) => x + r.input, 0) / b.prompts), after: Math.round(after.reduce((x, r) => x + r.input, 0) / a.prompts) };
  // `since`: the thing over the prompts since the decision, at the before rate (`atBefore`, what it would have cost) and as
  // it was (`total`, after.total); `window` is exactly their gap (the Total view's Saved is its Before minus its After)
  return { from: span.from, to: e.revertedAt ? span.to : null, before: b, after: a, delta, share: whole.before ? delta / whole.before : null, whole, since: { prompts: a.prompts, atBefore: Math.round(b.total / b.prompts * a.prompts), total: a.total }, window: Math.round(b.total / b.prompts * a.prompts) - a.total, few: b.sessions < 5 || a.sessions < 5 };
}

// The history with what each decision saved (actionEffect over the view's session rows), as both doors list it. A decision
// on a thing decided again later (sed compressed on Tuesday, then again on Thursday) is measured until the later one is in
// effect, so the two rows share no session.
export function withEffects(history, sessionRows = [], now = Date.now()) {
  const later = e => history.filter(o => o !== e && o.key === e.key && Date.parse(o.at) > Date.parse(e.at)).map(o => effectSpan(o, now)?.from).filter(t => t != null);
  return history.map(e => { const ts = later(e); return { ...e, effect: actionEffect(e, sessionRows, now, { until: ts.length ? Math.min(...ts) : null }) }; });
}

// What a change wastes a day here, in dollars: the tokens that went on it unused over the report's window, at what an
// input token cost here (context-view.js:rateOf, the Report's rule), a day of that window. null where nothing is priced.
export const wastePerDay = (c, rate) => (rate == null || !c.total || !c.days ? null : (c.total * rate) / c.days);

// The prompts a day a repository runs, over the last week of the Report's session rows; and what a number of tokens
// off every prompt comes to in dollars a day at the input rate there. null where nothing is priced.
export const promptsADay = (rows = [], now = Date.now()) => rows.filter(r => r.t >= now - 7 * DAY).reduce((a, r) => a + Math.max(1, r.prompts || 0), 0) / 7;
export const dollarsADay = (perPrompt, { promptsPerDay, rate } = {}) => (rate != null && promptsPerDay ? perPrompt * promptsPerDay * rate : null);
// What one thing came to in two repositories, as one figure: the dollars a day added, the tokens a prompt the average
// over their prompts. What still waits on a pull request (`wait`, `pending`) is the first one's.
export const mergeImpacts = (a, b) => {
  const n = (a.promptsPerDay || 0) + (b.promptsPerDay || 0);
  return { ...a, perPrompt: n ? (a.perPrompt * (a.promptsPerDay || 0) + b.perPrompt * (b.promptsPerDay || 0)) / n : a.perPrompt, perDay: a.perDay == null && b.perDay == null ? null : (a.perDay || 0) + (b.perDay || 0), promptsPerDay: n, measured: Boolean(a.measured && b.measured) };
};

// What a line came to, in a few words (the owner's ask, 2026-11-21: "one line summary of the action and its impact,
// e.g. -10k tokens per prompt, $45/day"). Tokens off every prompt are the decision's own measured effect once the
// sessions since can say (accountant.js:actionEffect: the thing's cost a prompt before against after), and until then what
// the Context report expected of it, said as "about". A day's dollars are those tokens over the prompts a day here at what an
// input token costs here (report-snapshot.js:inputRateHere, the Report's rate), and are left out where nothing is priced.
export function impactSaid(i) {
  if (!i) return '';
  if (!i.perPrompt) return '';
  const saved = i.perPrompt > 0, day = i.perDay != null && Math.abs(i.perDay) >= 0.005 ? ` · ${formatDollars(Math.abs(i.perDay))}/day${saved ? '' : ' more'}` : '';
  // `wait`: the part of it that is not in effect until a pull request merges (a batch: its tools are, its sections are not)
  const w = i.wait, waits = !w || !w.perPrompt ? '' : ` (${w.perDay != null && Math.abs(w.perDay) >= 0.005 ? `${formatDollars(Math.abs(w.perDay))}/day` : `${formatTokens(Math.abs(Math.round(w.perPrompt)))} tokens`} of it once ${w.pr ? `PR #${w.pr}` : 'its pull request'} merges)`;
  return `${i.measured ? '' : 'about '}${saved ? '−' : '+'}${formatTokens(Math.abs(Math.round(i.perPrompt)))} tokens per prompt${day}${waits || (i.pending ? ' once merged' : '')}`;
}

// --- reads delegated, by session -----------------------------------------------------------------------------------------
// Per session: how much of its reading and test running went to a cheaper agent, and what that saved (the owner's
// ask, 2026-11-21). The saving is the "Reads delegated" series itself, its rows added by session (delegationBySession),
// so a session's figure can never disagree with the weekly table. Kept a minute a repository in this process, since
// the page asks every half minute.
const handedCache = new Map();
export const cutTitle = t => short(String(t || '').replace(/<[^>]{1,40}>[\s\S]*?<\/[^>]{1,40}>/g, ' '), 70);
export function delegatedSaid(d) {
  const what = [d.reads ? plural(d.reads, 'read') : '', d.runs ? plural(d.runs, 'test run') : ''].filter(Boolean).join(' and ');
  const worth = [d.handed ? `${formatTokens(d.handed)} tokens handed over` : '', d.saved == null || Math.abs(d.saved) < 0.005 ? '' : d.saved > 0 ? `${formatDollars(d.saved)} saved` : `cost ${formatDollars(-d.saved)} more`].filter(Boolean).join(' · ');
  // a session with no dollar figure says which it is: its own model was never recorded, or has no list price
  const why = d.saved != null ? '' : d.lead ? `no list price for ${d.lead}, so no dollars` : `${d.client === 'opencode' ? 'an OpenCode session: ' : ''}its own model was not recorded, so no dollars`;
  return { text: `Handed ${what} to ${d.models?.length === 1 ? d.models[0] : 'cheaper agents'}`, impactSaid: [worth, why].filter(Boolean).join(' · ') };
}
// the dollars are over the sessions that can be priced; one whose lead model is not known to the log, or has no list
// price, is counted (`unpriced`) and left out of them, never added at zero
// (`unrecorded`: of those, the ones whose own model was never recorded; `opencode`: of those, OpenCode's, which keep no
// transcript to read a model from). `sumHanded`: several repositories' totals as one, the counts and the dollars adding.
const HANDED = ['sessions', 'reads', 'runs', 'handed', 'saved', 'unpriced', 'unrecorded', 'opencode'];
export const handedTotal = sessions => {
  const sum = f => sessions.reduce((a, d) => a + (f(d) || 0), 0), n = f => sessions.filter(f).length, lost = d => d.saved == null;
  return { sessions: sessions.length, reads: sum(d => d.reads), runs: sum(d => d.runs), handed: sum(d => d.handed), saved: sum(d => d.saved), unpriced: n(lost), unrecorded: n(d => lost(d) && !d.lead), opencode: n(d => lost(d) && !d.lead && d.client === 'opencode') };
};
export const sumHanded = totals => Object.fromEntries(HANDED.map(k => [k, totals.reduce((a, t) => a + (t?.[k] || 0), 0)]));
export function delegatedView(store, { now = Date.now(), days = RECENT_DAYS, log, compression, home = thinkerHome(), max = 30 } = {}) {
  const key = `${store.repo}\t${home}`, had = handedCache.get(key);
  if (!log && !compression && had && now - had.at >= 0 && now - had.at < 60_000) return had.value;
  let sessions = [];
  try {
    sessions = delegationBySession({ ...records(store, { home, log, compression }), since: now - days * DAY }).map(d => ({ id: `s:${d.session}`, at: new Date(d.at).toISOString(), title: cutTitle(d.title), reads: d.reads, runs: d.runs, handed: d.handed, models: d.models, saved: d.saved, lead: d.lead || null, client: d.client || null, steer: 'delegation', ...delegatedSaid(d) }));
  } catch {}
  const value = { days, total: handedTotal(sessions), sessions: sessions.slice(0, max) };
  if (!log && !compression) handedCache.set(key, { at: now, value });
  return value;
}

// The window's delegated work in one line, for both doors.
// why sessions carry no dollars: the model they ran on was never recorded (every OpenCode session that did not come
// through the proxy: it keeps no transcript to read one from), or it has no list price
const leftOut = t => {
  const they = t.unpriced === 1 ? 'it' : 'they', rec = t.unrecorded || 0, oc = t.opencode || 0;
  if (!rec) return `no list price is known for ${t.unpriced === 1 ? 'its' : 'their'} model`;
  const whose = oc ? `${oc === t.unpriced ? (oc === 1 ? ', an OpenCode session' : ', all OpenCode sessions') : `, ${oc} of them OpenCode sessions`}` : '';
  return rec === t.unpriced ? `the model ${they} ran on was never recorded${whose}` : `the model ${rec} of them ran on was never recorded${whose}, and the rest ran on one with no list price`;
};
export function delegatedTotalSaid(d) {
  const t = d?.total;
  if (!t?.sessions) return '';
  return `${plural(t.sessions, 'session')} over ${plural(d.days, 'day')}: ${[t.reads ? plural(t.reads, 'read') : '', t.runs ? plural(t.runs, 'test run') : ''].filter(Boolean).join(' and ')} handed to cheaper agents${t.handed ? `, ${formatTokens(t.handed)} tokens` : ''}${Math.abs(t.saved || 0) < 0.005 ? '' : t.saved > 0 ? ` · ${formatDollars(t.saved)} saved` : ` · cost ${formatDollars(-t.saved)} more`}${t.unpriced ? ` (${plural(t.unpriced, 'session')} left out of the dollars: ${leftOut(t)})` : ''}`;
}

// --- the book ----------------------------------------------------------------------------------------------------------
// What thinker has saved in dollars, for the footer surfaces: today, and over the whole log.
//
// The figures are the Report page's own savings table (weeklySavings, above), asked for two
// windows instead of six weeks: one column from midnight, one from the beginning of the log. Every series
// there is counted -- the context clearing at the prompt-cache read rate (the write rate on a request that wrote its whole context again, 2026-11-18), and since 2026-11-14 the reads the
// delegation trigger kept out of the lead's context (delegationSavings, above) -- so the footer
// can never disagree with `thinker report`.
// Nothing is priced here that is not priced there (the owner's call, 2026-11-05: the footer shows money,
// which the rest of the product deliberately does not, and the one way to keep that honest is to show
// the Report's own arithmetic rather than invent a second one). prices.js holds why dollars are rare:
// most agents run on a subscription, so this is an API-list-price equivalent of context that never had
// to be read, not a bill anybody was spared.
//
// Why a kept file rather than a figure worked out when asked: the full pass is a read of the machine's
// log (16 MB, 34k events here) and of every session the savings records name, about a second. The
// statusline is drawn as the person types and the hooks run on every turn, so neither may do that. The
// Stop hook starts a refresh in the background at most every REFRESH_MS (`thinker savings --refresh`),
// every surface reads this file, and a figure a few minutes old is the right trade for a footer.
//
// The ledger is the machine's, not a repository's, and sits beside the notice cadence under
// THINKER_HOME: lifetime means every checkout thinker has ever run in, which is what a person means by
// it. The suite must not write under the developer's home, so a test run with no THINKER_HOME of its
// own keeps it in the cache it is working in (notice-cadence.js does the same).
export const REFRESH_MS = 10 * 60_000;
// The window between today and lifetime, for somebody asking what was saved "lately" (the chat): the activity's own
// fortnight (upkeep.js:UPKEEP.feedDays).
export const RECENT_DAYS = 14;
// A refresh that dies leaves its lock behind; another may start once the lock is this old.
const LOCK_MS = 5 * 60_000;

const ledgerHome = () => (isTestMode() && !process.env.THINKER_HOME ? null : process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'));
export const savingsFile = store => path.join(ledgerHome() || store.dir, 'state', 'savings.json');
const lockFile = store => path.join(ledgerHome() || store.dir, 'state', 'savings.lock');

// The day the person is in, in their own timezone: "today" on a footer means the day they are working
// through, so the window starts at local midnight and the stamp is the local date, never UTC's.
export const dayKey = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const dayStart = (now = Date.now()) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

const emptyCell = () => ({ cost: 0, tokens: 0, unpricedTokens: 0, cleared: { cost: 0, tokens: 0 }, delegated: { cost: 0, tokens: 0 }, repeated: { cost: 0, tokens: 0 } });

// One window's row: the clearing, with the tokens behind the dollars. A row with observations but no price adds its
// tokens to `unpricedTokens` rather than nothing, so an unpriced model is a gap the output can name, not a silent zero.
function cellOf(series) {
  const out = emptyCell();
  for (const [key] of SAVINGS_SERIES) {
    const c = series.find(s => s.key === key)?.cells[0];
    if (!c) continue;
    if (key === 'compression') { out.cleared.cost = c.cost; out.cleared.tokens = c.tokens; }
    if (key === 'delegation') { out.delegated.cost = c.cost; out.delegated.tokens = c.tokens; }
    if (key === 'repeat') { out.repeated.cost = c.cost; out.repeated.tokens = c.tokens; }
    out.cost += c.cost; out.tokens += c.tokens; out.unpricedTokens += c.unpricedTokens || 0;
  }
  return out;
}

// What the clearing cost on the whole machine since `since`: the cache writes of the requests that made a cut
// (clearingCostBySession: the proxy's log, a desktop session's record, the log's mirror) and what sessions read again
// after a cut took it out, each session's own count at its own model. A test with no home has no log to read.
function clearingCostSince({ events, config }, since, { home = null, env = process.env } = {}) {
  const from = new Date(since).toISOString();
  let rewrite = 0, reread = 0;
  if (!(env.THINKER_TEST === '1' && !env.THINKER_HOME && !env.THINKER_PROXY_LOG)) {
    try { for (const x of clearingCostBySession(proxyLogFile(home || undefined, env), { since: from, config, dir: compressionDir(home || undefined), key: sessionKey, events }).values()) rewrite += x.usd || 0; } catch { rewrite = 0; }
  }
  // a session's `rereads` is its running count: the newest row of each session inside the window is the session's
  const last = new Map();
  for (const e of events) if (e.op === 'session' && e.session && e.t >= from && e.rereads?.reads > 0) last.set(sessionKey(e.session), e);
  for (const e of last.values()) reread += rereadCost(e.rereads, listPrice(e.model, { config }));
  return { rewrite, reread };
}
// A window's cell with what the clearing cost over it and the net of the two: the saving of every series, less the
// cache writes the cuts caused, less the re-reads.
const netted = (cell, { rewrite, reread }) => ({ ...cell, rewrite, reread, net: netOf({ saved: cell.cost, rewrite, reread }) });

// The whole pass: the machine's log and the proxy's clearing records, bucketed into the windows. Read-only.
// Both windows are measured the same way, since the proxy reports what it took out; the day's figure differed from
// lifetime only while the cache series existed (it selected servings not yet assessed), which went on 2026-11-08.
export function computeSavings(store, { now = Date.now() } = {}) {
  // the machine's records: every repository's log, and the clearing's rows for the sessions it names
  const { events, compression, config } = records(store, { all: true });
  // `origin: null` counts every repository's clearing: this is the machine's ledger, and a clear is not
  // attributed to a checkout here as it is in a repository's report.
  const windowOf = from => cellOf(weeklySavings({ columns: [{ t: from }], now, config, events, compression, sessions: [], origin: null, ownership: events }));
  return {
    at: now, day: dayKey(now),
    // The version that wrote the ledger, so the surfaces that pin a line can name it without reading
    // thinker's own package.json: the Claude Code mod runs inside the agent and sees this file alone.
    version: appVersion() || undefined,
    today: windowOf(dayStart(now)),
    // the fortnight between them, with what the clearing cost over it: the footers show a saving gross, and
    // somebody asking what was saved lately is owed the net beside it (`netted`)
    recent: netted(windowOf(now - RECENT_DAYS * DAY), clearingCostSince({ events, config }, now - RECENT_DAYS * DAY)), recentDays: RECENT_DAYS,
    lifetime: windowOf(0),
    from: events[0]?.t || null,
  };
}

const read = store => { try { const s = JSON.parse(fs.readFileSync(savingsFile(store), 'utf8')); return s && s.lifetime && s.today ? s : null; } catch { return null; } };

// The kept ledger, with what the reader must know to word it: `sameDay` says the `today` figures are
// this day's and not a stamp left from yesterday, `current` that a refresh is not due yet.
export function readSavings(store, { now = Date.now() } = {}) {
  const s = read(store);
  if (!s) return null;
  return { ...s, sameDay: s.day === dayKey(now), current: s.day === dayKey(now) && now - s.at <= REFRESH_MS };
}

// The ledger for somebody answering now (chat.js): the kept one where it is current and carries every window, else
// worked out here and held in this process until a refresh would be due. Never written from here: the file is the
// Stop hook's to refresh, and it carries the version of the copy that wrote it for the status line.
const held = new Map();
export function savingsNow(store, { now = Date.now() } = {}) {
  const kept = readSavings(store, { now });
  if (kept?.current && kept.recent) return kept;
  const key = savingsFile(store), had = held.get(key);
  if (had && now - had.at >= 0 && now - had.at < REFRESH_MS) return had;
  const l = computeSavings(store, { now });
  held.set(key, l);
  return l;
}

export function writeSavings(store, ledger) {
  const f = savingsFile(store), tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(ledger));
    fs.renameSync(tmp, f);
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} } // a footer must never fail a turn
  return ledger;
}

export const savingsDue = (store, { now = Date.now() } = {}) => !readSavings(store, { now })?.current;

// Held while a refresh runs, so the Stop hooks of several sessions do not each start one.
function takeLock(store, { now = Date.now() } = {}) {
  const f = lockFile(store);
  try { if (now - fs.statSync(f).mtimeMs < LOCK_MS) return false; } catch {}
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(process.pid)); return true; } catch { return false; }
}
const dropLock = store => { try { fs.rmSync(lockFile(store), { force: true }); } catch {} };

export function refreshSavings(store, { now = Date.now(), force = false } = {}) {
  if (!force && !takeLock(store, { now })) return readSavings(store, { now });
  try { return writeSavings(store, computeSavings(store, { now })); }
  finally { if (!force) dropLock(store); }
}

// From a hook: recompute in the background when it is due, at most one process at a time. No model
// call and no network, so it runs the same way inside a desktop app, where no agent CLI is signed in.
export function refreshSavingsInBackground(store, { cli, now = Date.now() } = {}) {
  if (isTestMode() && process.env.THINKER_SAVINGS !== 'on') return false;
  if (!savingsDue(store, { now }) || !takeLock(store, { now })) return false;
  try {
    spawn(process.execPath, [cli, 'savings', '--refresh', '--quiet', '--repo', store.repo], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch { dropLock(store); return false; }
}

// How the figures are worded, in one place, because five surfaces say them (the Claude Code statusline,
// the Codex desktop card, the Cursor table, the end-of-turn line and `thinker savings`).
//
// A ledger whose day has turned says nothing about today: the refresh it needs has not run, and a
// person who worked this morning would read a figure from yesterday as this morning's. Lifetime is
// still true, so that is said alone rather than the whole line being dropped.
export function savingsLine(ledger, { now = Date.now() } = {}) {
  if (!ledger?.lifetime) return '';
  const lifetime = ledger.lifetime.cost, today = ledger.today?.cost;
  if (!ledger.lifetime.tokens && !ledger.lifetime.unpricedTokens) return '';
  const sameDay = ledger.sameDay ?? ledger.day === dayKey(now);
  const parts = [];
  if (sameDay && Number.isFinite(today)) parts.push(`saved today ${formatDollars(today)}`);
  parts.push(`lifetime ${formatDollars(lifetime)}`);
  return parts.join(' · ');
}

// The statusline's own form: shorter, since it sits under the prompt beside everything else the
// session pins there, and named so it is read as thinker's and not the host's. The name in words, not
// the brain the rest of thinker's lines carry (the owner's ask, 2026-11-06): the status row is a line
// of small type beside the host's own, where a lone glyph is a puzzle and a word is a label.
// The version rides this line and no other (the owner's ask, 2026-11-10): a person running thinker has
// no other way to see which one they are running -- the agents never name it -- and the status row is
// the one surface that is on screen the whole session. It is the ledger's own version where there is
// one, so the row names the copy that counted the figures beside it.
export function savingsStatus(ledger, { now = Date.now() } = {}) {
  const line = savingsLine(ledger, { now });
  const version = ledger?.version || appVersion();
  return line ? `thinker${version ? ` v${version}` : ''}: ${line}` : '';
}

// The split, for `thinker savings` and the cards' detail: what each row contributed, and the tokens
// behind it, so a total nobody can check is never the only thing said.
// A window's net in words, where it was worked out (the fortnight): what the clears cost against what was saved.
export function savingsNet(cell) {
  if (!cell || cell.net == null) return '';
  const took = [cell.rewrite ? `${formatDollars(cell.rewrite)} of cache writes the clears caused` : '', cell.reread ? `${formatDollars(cell.reread)} of cleared files read again` : ''].filter(Boolean);
  return took.length ? `net ${formatDollars(cell.net)} after ${took.join(' and ')}` : `net ${formatDollars(cell.net)}: the clears cost nothing over it`;
}
export function savingsDetail(cell) {
  if (!cell) return '';
  const row = (name, c) => `${name} ${formatDollars(c.cost)} (${formatTokens(c.tokens)} tokens)`;
  // the delegated and pointed rows only where there is one: most machines run without the trigger, and a ledger
  // written before a series existed has no such cell
  return [row('context cleared', cell.cleared),
    ...(cell.delegated?.tokens ? [row('reads delegated', cell.delegated)] : []),
    ...(cell.repeated?.tokens ? [row('reads already in context', cell.repeated)] : [])].join(' · ');
}
