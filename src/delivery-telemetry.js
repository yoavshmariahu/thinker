// What leaves the machine about what thinker saved: two blocks from one walk of the repositories.
//
// `prs` -- the pull requests the sessions here produced: counts, token totals, the netted dollars at list
// prices (delivery.js `summary.cost`: cleared at the cache-read rate, less the cache writes after a clear),
// what each cost in model calls, whether it got a context clear and how much was cleared on it.
//
// `sessions` -- the same savings per session, which is the figure the pull request cannot give: most sessions
// belong to no pull request, and a long one is not a cheap one. Groups of sums, so every rate a dashboard
// shows is a ratio of sums (the Report's own rule), with the work denominator beside it (`prompts`, the
// session's own model calls) so cost per session and cost per prompt can be told apart.
//
// Both are grouped by the cut policy that made the saving (cutting.js:policyId), because the policies differ
// by more than rounding and nothing here can know when another machine updated to one. An unstamped saving
// (made before the policy was recorded) says so and is never pooled with a stamped one.
//
// Never the pull request's number, title, URL, branch, author or repository, and never a session id. A
// person's work in progress stays on their machine; what is counted is how many pull requests thinker was
// used on and how much it saved on them, which is the claim the project wants to be able to make.
import fs from 'node:fs';
import { Store, repoId } from './store.js';
import { readLog } from './usage.js';
import { deliveryReport, WINDOW_DAYS, SAVED_BUCKETS } from './delivery.js';
import { deliveryCheckouts } from './delivery-journal.js';

// The dollars a session's clearing netted, bucketed, so the spread shows and not only the mean: on this
// machine's own pull requests five of them were most of a fortnight's saving. The first bucket holds every
// session that broke even or lost, and `lossSessions` counts the losses on their own.
export const NET_BUCKETS = [0, 1, 5, 20, null];
const PR_ROWS = 50;

// A day's own figures, so a trend can be read and a total can be added up. The 30-day blocks below cannot:
// two snapshots a day apart differ by what came in AND by what rolled out of the window, and nothing tells
// the two apart -- which is why the proxy block grew its own `byDay` (telemetry.js:proxyMetrics). A day here
// belongs to one snapshot, so a dashboard takes the latest snapshot per device, explodes its days, and days
// from different devices and different days add up.
const dayGroup = () => ({ sessions: 0, clearedSessions: 0, prompts: 0, clearedTokens: 0, netUsd: 0, spendUsd: 0, spendSessions: 0, pricedSessions: 0 });
const dayOf = at => (typeof at === 'string' && at.length >= 10 && Number.isFinite(Date.parse(at)) ? at.slice(0, 10) : null);
const roundDays = byDay => {
  for (const d of Object.values(byDay)) {
    d.clearedTokens = Math.round(d.clearedTokens);
    for (const k of ['netUsd', 'spendUsd']) d[k] = Math.round(d[k] * 100) / 100;
  }
  return byDay;
};

const group = () => ({
  sessions: 0, prompts: 0, agentTokens: 0, tokenComplete: 0,
  clearedSessions: 0, clearedTokens: 0, clearRequests: 0,
  savedUsd: 0, rewriteUsd: 0, rereadUsd: 0, rereads: 0, rereadSessions: 0, netUsd: 0, pricedSessions: 0, lossSessions: 0,
  spendUsd: 0, spendSessions: 0,
});
const bumpGroup = (g, x) => {
  g.sessions++; g.prompts += x.prompts || 0;
  if (Number.isFinite(x.tokens)) { g.agentTokens += x.tokens; if (x.complete) g.tokenComplete++; }
  if (x.cleared > 0) { g.clearedSessions++; g.clearedTokens += x.cleared; }
  g.clearRequests += x.rewrites || 0;
  // files read again after a cut took them out (rereads.js): the count, and the sessions it happened in
  if (x.rereads > 0) { g.rereads += x.rereads; g.rereadSessions++; }
  if (x.cost?.priced) {
    g.pricedSessions++;
    g.savedUsd += x.cost.saved || 0; g.rewriteUsd += x.cost.rewrite || 0; g.rereadUsd += x.cost.reread || 0; g.netUsd += x.cost.net || 0;
    if ((x.cost.net || 0) < 0) g.lossSessions++;
  }
  if (x.spend != null) { g.spendUsd += x.spend; g.spendSessions++; }
  return g;
};
const roundGroup = g => {
  for (const k of ['agentTokens', 'clearedTokens']) g[k] = Math.round(g[k]);
  for (const k of ['savedUsd', 'rewriteUsd', 'rereadUsd', 'netUsd', 'spendUsd']) g[k] = Math.round(g[k] * 100) / 100;
  return g;
};
// a saving whose policy was never recorded is its own key, never folded into today's
const policyKey = x => (x.cleared > 0 ? (x.policyChanged ? 'mixed' : x.policy || 'unstamped') : 'none');

export function deliveryMetrics(store, { all = true, now = Date.now(), home } = {}) {
  const candidates = new Map(), visited = new Set(), excluded = new Set();
  const add = checkout => {
    if (typeof checkout !== 'string' || visited.has(checkout) || !fs.existsSync(checkout)) return;
    visited.add(checkout);
    let s; try { s = checkout === store.repo ? store : new Store(checkout, { readonly: true }); } catch { return; }
    // A repository's own opt-out holds even when another repository triggered the upload.
    const key = repoId(checkout);
    let off = false; try { off = s.config().telemetry === false; } catch { off = false; }
    if (off) { excluded.add(key); return; }
    const list = candidates.get(key) || [];
    if (!list.some(x => x.repo === checkout)) list.push(s);
    candidates.set(key, list);
  };
  add(store.repo);
  if (all) {
    for (const e of readLog(store, { all: true })) add(e.repo);
    // A checkout whose sessions were recorded before it ever served a note is only in the journal.
    for (const checkout of deliveryCheckouts(store)) add(checkout);
  }
  const out = {
    schemaVersion: 3, windowDays: WINDOW_DAYS,
    repositories: 0, repositoriesWithPrs: 0, unreadableRepositories: 0,
    merged: 0, mergedSeen: 0, mergedAssisted: 0, open: 0, worked: 0,
    clearedTokens: 0, savedTokens: 0,
    agentTokens: 0, completeTokenPrs: 0,
    // Dollars, netted, over the merged pull requests' sessions (the owner's ask, 2026-11-06: net savings per
    // device on the dashboard). Signed: a loss reads as a loss. `costedPrs` is how many of the merged pull
    // requests could be priced at all; a session known only from an observation names no model.
    savedUsd: 0, rewriteUsd: 0, rereadUsd: 0, netUsd: 0, costedPrs: 0,
    // What those pull requests cost in model calls, in dollars at list prices by token type (delivery.js
    // `cost.spend`), over the ones whose every session could be priced -- `spendPrs` is that count and the
    // only honest denominator for a cost per pull request. A pull request with one unpriced session is in
    // neither figure, never counted at zero.
    spendUsd: 0, spendPrs: 0,
    // Whether a pull request got a context clear, and how much was cleared on it. `clearedPrs` counts the
    // merged ones with a clear behind them; `clearedTokens` above is how much, over all of them.
    clearedPrs: 0,
    linkedSessions: 0, unlinkedSessions: 0,
    hoursToMerge: 0, hoursToMergeSamples: 0,
    savedBuckets: SAVED_BUCKETS.map(upper => ({ upper, count: 0 })),
    // The merged pull requests themselves, newest first, numbers only: a mean cannot show that five pull
    // requests were most of a month's saving, and a median needs the rows. Nothing here names one.
    rows: [],
    // By the cut policy behind the saving (cutting.js:policyId): 'none' never cleared, 'unstamped' cleared
    // before the policy was recorded, 'mixed' cleared under two.
    byPolicy: {},
    // by the UTC day the pull request merged; days add up, so a cost per pull request can be trended and a
    // total saving added, which a 30-day rolling figure can never be
    byDay: {},
  };
  // Savings per session: every session of the window, once each, whether or not it belongs to a pull request.
  // Groups of sums -- a rate is the dashboard's own division, never a mean of per-session ratios. `cleared`
  // and `uncleared` split a session by what actually happened to it, not by the arm it was assigned to: on
  // this machine 230 of 249 sessions on the clearing's side had never had a clear, and comparing the arms
  // compared untouched sessions with untouched sessions (the owner's correction, 2026-11-10).
  const sessions = {
    schemaVersion: 1, windowDays: WINDOW_DAYS, unreadableSessions: 0,
    all: group(), cleared: group(), uncleared: group(),
    byPolicy: {}, byClient: {},
    netBuckets: NET_BUCKETS.map(upper => ({ upper, count: 0 })),
    // by the UTC day of the session's last request, as the Report places a session in a week; days add up
    byDay: {},
  };
  const rows = [];
  const countSession = x => {
    const key = policyKey(x), client = String(x.client || 'unknown');
    const day = dayOf(x.lastAt);
    if (day) {
      const d = sessions.byDay[day] ||= dayGroup();
      d.sessions++; d.prompts += x.prompts || 0;
      if (x.cleared > 0) { d.clearedSessions++; d.clearedTokens += x.cleared; }
      if (x.cost?.priced) { d.pricedSessions++; d.netUsd += x.cost.net || 0; }
      if (x.spend != null) { d.spendUsd += x.spend; d.spendSessions++; }
    }
    bumpGroup(sessions.all, x);
    bumpGroup(x.cleared > 0 ? sessions.cleared : sessions.uncleared, x);
    bumpGroup(sessions.byPolicy[key] ||= group(), x);
    bumpGroup(sessions.byClient[client] ||= group(), x);
    if (x.cleared > 0 && x.cost?.priced) sessions.netBuckets.find(b => b.upper === null || x.cost.net <= b.upper).count++;
  };
  for (const [origin, stores] of candidates) {
    if (excluded.has(origin)) continue;
    try {
      // Worktrees of one repository share a journal. Take the checkout that knows the most, and never add
      // the same pull request twice from two of them.
      const reports = stores.map(s => deliveryReport(s, { days: WINDOW_DAYS, now, ...(home ? { home } : {}) }));
      const report = reports.sort((a, b) => b.summary.sessions.linked - a.summary.sessions.linked || b.prs.length - a.prs.length)[0];
      out.repositories++;
      if (report.warnings.length) out.unreadableRepositories++;
      if (report.prs.length) out.repositoriesWithPrs++;
      const s = report.summary;
      out.merged += s.merged; out.mergedSeen += s.mergedSeen; out.mergedAssisted += s.mergedAssisted; out.open += s.open; out.worked += s.worked;
      out.clearedTokens += s.saved.cleared; out.savedTokens += s.saved.total;
      out.agentTokens += s.tokens.agent; out.completeTokenPrs += s.tokens.complete;
      out.savedUsd += s.cost?.saved || 0; out.rewriteUsd += s.cost?.rewrite || 0; out.rereadUsd += s.cost?.reread || 0; out.netUsd += s.cost?.net || 0; out.costedPrs += s.cost?.costed || 0;
      out.spendUsd += s.cost?.spend || 0; out.spendPrs += s.cost?.spendComplete || 0;
      out.linkedSessions += s.sessions.linked; out.unlinkedSessions += s.sessions.unlinked;
      for (const p of report.prs.filter(p => p.sessions.length && p.mergedAt && p.mergedAt >= report.since)) {
        out.savedBuckets.find(b => b.upper === null || p.saved.total <= b.upper).count++;
        if (p.cleared) out.clearedPrs++;
        if (typeof p.hoursToMerge === 'number' && Number.isFinite(p.hoursToMerge)) { out.hoursToMerge += p.hoursToMerge; out.hoursToMergeSamples++; }
        const key = p.policy || 'none';
        const g = out.byPolicy[key] ||= { prs: 0, clearedPrs: 0, clearedTokens: 0, agentTokens: 0, sessions: 0, savedUsd: 0, rewriteUsd: 0, rereadUsd: 0, netUsd: 0, spendUsd: 0, spendPrs: 0 };
        g.prs++; if (p.cleared) g.clearedPrs++;
        g.clearedTokens += p.saved.cleared; g.agentTokens += p.tokens.agent; g.sessions += p.sessions.length;
        if (p.cost?.priced) { g.savedUsd += p.cost.saved; g.rewriteUsd += p.cost.rewrite; g.rereadUsd += p.cost.reread || 0; g.netUsd += p.cost.net; }
        if (p.cost?.spendComplete) { g.spendUsd += p.cost.spend; g.spendPrs++; }
        const day = dayOf(p.mergedAt);
        if (day) {
          const d = out.byDay[day] ||= { prs: 0, clearedPrs: 0, clearedTokens: 0, netUsd: 0, spendUsd: 0, spendPrs: 0, sessions: 0, prompts: 0 };
          d.prs++; if (p.cleared) d.clearedPrs++;
          d.clearedTokens += p.saved.cleared; d.sessions += p.sessions.length; d.prompts += p.tokens.prompts;
          if (p.cost?.priced) d.netUsd += p.cost.net;
          if (p.cost?.spendComplete) { d.spendUsd += p.cost.spend; d.spendPrs++; }
        }
        rows.push({
          at: p.mergedAt, cleared: Boolean(p.cleared), policy: p.policy || null,
          clearedTokens: Math.round(p.saved.cleared), agentTokens: p.tokens.complete ? Math.round(p.tokens.agent) : null,
          sessions: p.sessions.length, prompts: Math.round(p.tokens.prompts),
          spendUsd: p.cost?.spendComplete ? Math.round(p.cost.spend * 100) / 100 : null,
          netUsd: p.cost?.priced ? Math.round(p.cost.net * 100) / 100 : null,
          hours: typeof p.hoursToMerge === 'number' && Number.isFinite(p.hoursToMerge) ? Math.round(p.hoursToMerge * 100) / 100 : null,
        });
      }
      for (const x of report.sessions) countSession(x);
    } catch { out.unreadableRepositories++; sessions.unreadableSessions++; }
  }
  for (const k of ['clearedTokens', 'savedTokens', 'agentTokens']) out[k] = Math.round(out[k]);
  out.hoursToMerge = Math.round(out.hoursToMerge * 100) / 100;
  for (const k of ['savedUsd', 'rewriteUsd', 'rereadUsd', 'netUsd', 'spendUsd']) out[k] = Math.round(out[k] * 100) / 100;
  for (const g of Object.values(out.byPolicy)) {
    for (const k of ['clearedTokens', 'agentTokens']) g[k] = Math.round(g[k]);
    for (const k of ['savedUsd', 'rewriteUsd', 'rereadUsd', 'netUsd', 'spendUsd']) g[k] = Math.round(g[k] * 100) / 100;
  }
  // newest merge first, and only as many as the payload carries: a row is five numbers, and the sums above
  // are over every pull request whether or not its row is here (`merged` says how many that was)
  out.rows = rows.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, PR_ROWS).map(({ at, ...r }) => r);
  roundDays(out.byDay); roundDays(sessions.byDay);
  roundGroup(sessions.all); roundGroup(sessions.cleared); roundGroup(sessions.uncleared);
  for (const g of Object.values(sessions.byPolicy)) roundGroup(g);
  for (const g of Object.values(sessions.byClient)) roundGroup(g);
  return { prs: out, sessions };
}
