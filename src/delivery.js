// What a pull request cost and what thinker saved on it.
//
// A session is linked to the pull request it was working on; what thinker saved in that session is then the
// pull request's: the tokens the clearing left out of the session's prompts, added up (compression.js), MEASURED
// and gross, as the card is, since a clear also rewrites the prompt cache. The estimated reading the knowledge
// notes avoided was a second figure until 2026-11-08.
//
// Nothing here calls a model, mines anything or spends a token. The pull requests come from the person's own
// `gh` login, read-only; the sessions come from the usage log; the savings come from records already written.
import { execFileSync } from 'node:child_process';
import { repoId } from './store.js';
import { readLog, sessionKey } from './usage.js';
import { rereadCost } from './rereads.js';
import { formatTokens } from './model-usage.js';
import { listPrice, formatDollars, costOf } from './prices.js';
import { compressionDir, readCompression, clearedBySession, clearingCostBySession, usageBySession, CLEARING_OP } from './compression.js';
import { proxyLogFile } from './proxy-service.js';
import { thinkerHome } from './update.js';
import { appendDelivery, readDelivery, positiveInteger } from './delivery-journal.js';

export const WINDOW_DAYS = 30;
// Savings per merged pull request, for the shape of the distribution in the telemetry.
export const SAVED_BUCKETS = [10_000, 50_000, 200_000, 1_000_000, null];
// Pages of the pull request listing one sync will read. A month of a very busy repository, and a ceiling on
// a step that runs by itself: the listing is sorted newest first, so what is cut off is the oldest.
export const MAX_PAGES = 20;

const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
// The average, not the median (2026-11-04, the owner's call). Half of the merged pull requests a session
// here worked on had no clearing and no note acted on, so the median landed on a zero and read as thinker
// saving nothing on the typical one, while the same window's total was 541M tokens. The mean says what the
// total says, divided by the pull requests it is spread over.
const mean = xs => { const a = xs.filter(finite); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
// `finite` refuses a negative, because a count of tokens is never one. A net dollar figure is: the clearing can
// cost more than it saves, and it did on the API-side path. So the signed mean is its own helper -- with the
// other one it read "+$0.59 on the average one" under a net of -$940, having dropped every losing pull request.
// a log row's token counters in the shape prices.js:costOf reads
const usageOf = e => ({ input: e.inputTokens, cacheRead: e.cacheReadTokens, cacheWrite: e.cacheWriteTokens, cacheWrite1h: e.cacheWrite1hTokens, output: e.outputTokens });
const meanSigned = xs => { const a = xs.filter(n => typeof n === 'number' && Number.isFinite(n)); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };
const hours = (from, to) => from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 3600_000) : null;

// ---------------------------------------------------------------------------
// What the sessions of this repository did, and what thinker saved in each.

// One pass over the usage log: each session's client, model, branches and heads, and what it cost by its last
// `session` row.
export function sessionsOf(store, { since = '', log = null, home = thinkerHome(), env = process.env } = {}) {
  const events = (log || readLog(store)).filter(e => e.origin === repoId(store.repo) && e.t >= since);
  const sessions = new Map();
  const of = key => {
    if (!sessions.has(key)) sessions.set(key, { id: key, client: null, model: null, firstAt: null, lastAt: null, branches: new Set(), heads: new Set(), tokens: null, ownTokens: null, subagents: [], prompts: 0, complete: false });
    return sessions.get(key);
  };
  for (const e of events) {
    const key = e.session && e.session !== 'unknown' ? sessionKey(e.session) : null;
    if (!key) continue;
    const x = of(key);
    x.firstAt = x.firstAt || e.t; x.lastAt = e.t;
    if (e.client) x.client = e.client;
    if (e.branch) x.branches.add(e.branch);
    if (e.head) x.heads.add(e.head);
    if (e.op === 'session') {
      // Each turn logs the session again with the transcript's totals so far: the last record is the session.
      if (e.model) x.model = e.model;
      const total = e.totalTokens ?? e.tokens?.totalTokens;
      if (finite(total)) { x.ownTokens = total; x.complete = e.tokenCoverage !== 'partial'; x.usage = usageOf(e); }
      if (finite(e.turns)) x.prompts = Math.max(x.prompts, e.turns);
      // the session's subagents, each on its own model (transcripts.js:subagentStats); the last row has them all
      if (Array.isArray(e.subagents)) x.subagents = e.subagents.filter(a => a && typeof a === 'object');
      // what the model read again after a cut took it out (rereads.js), counted by the Stop hook over the transcript so far
      if (e.rereads && typeof e.rereads === 'object' && finite(e.rereads.reads)) x.rereads = e.rereads;
    }
    // A desktop clear mirrored into the log at the end of a turn (compression.js:mirrorClearing), for the
    // sessions the proxy never served and whose card record has since been pruned. Cumulative, so the newest
    // row is the session's figure and rows are never added.
    if (e.op === CLEARING_OP && e.cleared > 0 && (!x.logged || e.cleared >= x.logged.cleared)) x.logged = e;
  }
  const clearing = clearingFor({ home, env, since });
  // What the proxy itself saw of each session, for the clients that keep no transcript (compression.js:
  // usageBySession). Read once, like the clearing.
  let served = new Map();
  try { for (const [id, x] of usageBySession(proxyLogFile(home, env), { since })) served.set(sessionKey(id), x); } catch { served = new Map(); }
  const config = (() => { try { return store.config(); } catch { return {}; } })();
  const rewriteCost = rewriteCostFor({ home, env, since, config });
  for (const x of sessions.values()) {
    // agent tokens: the person's own conversation and every subagent it ran, since each was a model call made for
    // the same work; the parent's figure stays beside it (`ownTokens`), and a subagent with no counter is left out
    // A session whose own record carries no usage -- every client without a transcript -- is priced from the
    // proxy's rows for that session, which are the same model calls. The transcript always wins where there
    // is one: it is the agent's own account of the session and it covers calls made before the proxy was in
    // the path. `servedCalls` says how many answers the proxy saw, so a partial route is visible rather than
    // quietly counted as the whole session.
    if (!finite(x.ownTokens)) {
      const p = served.get(x.id);
      if (p && p.calls > 0) {
        x.usage = p.usage;
        x.ownTokens = p.usage.input + p.usage.output;
        x.prompts = Math.max(x.prompts, p.calls);
        x.servedCalls = p.calls;
        x.usageFrom = 'proxy';
        x.complete = true;
        if (!x.model && p.model) x.model = p.model;
      }
    }
    const subTokens = x.subagents.reduce((a, s) => a + (finite(s.totalTokens) ? s.totalTokens : 0), 0);
    x.subagentTokens = subTokens;
    x.tokens = finite(x.ownTokens) ? x.ownTokens + subTokens : null;
    const c = clearing(x.id);
    // the proxy's log and the live record first (`clearingFor`), then the log's own mirror of a desktop clear
    x.cleared = Math.max(c.cleared, x.logged?.cleared || 0);
    x.policy = c.policy || x.logged?.policy || null;
    x.policyChanged = Boolean(c.policyChanged || x.logged?.policyChanged);
    x.rewrite = rewriteCost(x.id) || rewriteOfLogged(x.logged, config);
    // a desktop session's record names the model the API answered with, where no hook logged one
    if (!x.model && x.rewrite?.model) x.model = x.rewrite.model;
    if (!x.model && x.logged?.model) x.model = x.logged.model;
    if (!x.model && c.model) x.model = c.model;   // the model the proxy's own clearing rows name
    delete x.logged;
    // Dollars, at the session's own model's list rates: a cleared token saved a cache read; the writes after a clear
    // and what the model read again after a cut took it out are what it cost (prices.js, rereads.js). One rule: net is
    // cleared at the cache-read rate, less the cache writes after a clear, less the re-reads of cleared files.
    const price = listPrice(x.model, { config });
    x.cost = price
      ? { saved: ((x.cleared || 0) * price.cacheRead) / 1e6, rewrite: x.rewrite?.usd || 0, reread: rereadCost(x.rereads, price), priced: true }
      : { saved: 0, rewrite: 0, reread: 0, priced: false };
    x.cost.net = x.cost.saved - x.cost.rewrite - x.cost.reread;
    // What the session's own calls cost, in dollars at list prices by token type (fresh input, cache reads, cache
    // writes by TTL, output; prices.js:costOf), the subagents each at their own model. The owner's call, 2026-11-08: a
    // pull request's cost is said in dollars and not in tokens, since tokens add reads, writes and output as if they
    // were one thing. null unless the session's counters are complete and every model in it has a price.
    const subs = x.subagents.filter(a => finite(a.totalTokens));
    const subSpend = subs.map(a => costOf(usageOf(a), listPrice(a.model, { config })));
    x.cost.spend = price && finite(x.ownTokens) && x.complete && x.usage && subSpend.every(v => v != null)
      ? costOf(x.usage, price) + subSpend.reduce((a, v) => a + v, 0) : null;
    x.branches = [...x.branches]; x.heads = [...x.heads];
  }
  return sessions;
}

// What the context proxy's clearing saved in a session: the proxy's own log first, since it is the durable
// record, and the card's state file only where the log's tail no longer reaches (compression.js).
export function clearingFor({ home = thinkerHome(), env = process.env, since = '' } = {}) {
  let logged = new Map();
  try { for (const [id, row] of clearedBySession(proxyLogFile(home, env), { since })) logged.set(sessionKey(id), row); } catch { logged = new Map(); }
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
      policy: named?.policy || null, policyChanged: Boolean(a?.policyChanged || state?.policyChanged) };
  };
}

// What a session's clearing saved, as a number, for the readers that want only that.
export function clearedFor(opts = {}) { const clearing = clearingFor(opts); return id => clearing(id).cleared; }

// What a mirrored desktop clear cost, priced here because the row carries the write tokens the mod counted
// and the model that answered (compression.js:loggedClearingCost prices the same row for the Report).
function rewriteOfLogged(logged, config) {
  if (!logged?.cost) return null;
  const price = listPrice(logged.model, { config });
  const write = logged.cost.write || 0;
  return { rewrites: logged.cost.rewrites || 0, write, usd: price ? writeCostOf(write, price) : 0,
    unpriced: price || !write ? 0 : 1, ...(logged.model ? { model: logged.model } : {}) };
}

// What the clearing cost in that session: the cache writes on the calls from its first clear onwards
// (compression.js:clearingCostBySession). The proxy's log knows this for the sessions it served; a desktop
// session never reaches the proxy, and its record (the clearing mod's, in the card's state directory) keeps
// the same count since 2026-11-06, read where the log has no rows for the session. A session the log's tail
// no longer reaches, or a record from before the mod counted, has no cost figure, and `costed` on the report
// says how many did.
export function rewriteCostFor({ home = thinkerHome(), env = process.env, since = '', config } = {}) {
  let logged = new Map();
  try { for (const [id, x] of clearingCostBySession(proxyLogFile(home, env), { since, config, dir: compressionDir(home), key: sessionKey })) logged.set(sessionKey(id), x); } catch { logged = new Map(); }
  return id => logged.get(id) || null;
}

// ---------------------------------------------------------------------------
// Which pull request a session belongs to.

// In order of how much the evidence is worth. A person's own link beats anything read from git; a commit the
// session was sitting on is proof it was working there; a branch name is strong but can be reused, so the
// pull request whose life the session falls inside is preferred over a later one with the same branch.
// Commits a session sitting there is proof it was working on this pull request. The listing gives the head
// and the merge commit; the whole list comes only with `--pr n`. The base is where the branch started, so a
// session there says nothing.
const writeCostOf = (write, price) => (write || 0) * (price.cacheWrite1h ?? 2 * price.input) / 1e6;

const prCommits = p => [...(p.commits || []), p.head, p.mergeCommit].filter(sha => sha && sha !== p.base);

export function linkFor(session, prs, links) {
  const manual = links.get(session.id);
  if (manual) return manual.map(a => ({ ...a, how: 'manual' }));
  const byCommit = prs.filter(p => prCommits(p).some(sha => session.heads.includes(sha)));
  if (byCommit.length === 1) return [{ pr: byCommit[0].number, share: 1, how: 'commit' }];
  const byBranch = prs.filter(p => p.branch && session.branches.includes(p.branch));
  const pool = byCommit.length > 1 ? byCommit : byBranch;
  if (!pool.length) return [];
  const how = pool === byCommit ? 'commit' : 'branch';
  const t = session.lastAt || session.firstAt || '';
  const during = pool.filter(p => (!p.createdAt || p.createdAt <= t) && (!(p.mergedAt || p.closedAt) || t <= (p.mergedAt || p.closedAt)));
  const pick = (during.length ? during : pool).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.number - a.number)[0];
  return [{ pr: pick.number, share: 1, how }];
}

// ---------------------------------------------------------------------------
// The report.

export function deliveryReport(store, { days = WINDOW_DAYS, pr, now = Date.now(), home = thinkerHome(), log = null } = {}) {
  days = positiveInteger(days, 'days');
  if (pr !== undefined) pr = positiveInteger(pr, 'PR');
  const since = new Date(now - days * 86400_000).toISOString();
  const { events, warnings } = readDelivery(store);
  const records = new Map(), links = new Map();
  for (const e of events) {
    if (e.op === 'pr') records.set(e.pr.number, { ...(records.get(e.pr.number) || {}), ...e.pr });
    else if (e.op === 'link') links.set(sessionKey(e.session), e.allocations);
  }
  // An observation is the only record of a session that served nothing and was never assessed.
  const sessions = sessionsOf(store, { since, log, home });
  const clearing = clearingFor({ home, since });
  const config = (() => { try { return store.config(); } catch { return {}; } })();
  const rewriteCost = rewriteCostFor({ home, since, config });
  // An observation carries no model, so a session known only this way can be priced for what the clearing
  // cost it but not for what the clearing saved it: the rates are the model's. `costed` counts the ones that
  // are priced, and a report whose sessions are all of this kind says so rather than showing a loss.
  const costOfObserved = key => {
    const rewrite = rewriteCost(key);
    return { saved: 0, rewrite: rewrite?.usd || 0, reread: 0, net: -(rewrite?.usd || 0), priced: false, spend: null };
  };
  for (const e of events) {
    if (e.op !== 'observation' || !e.session || e.t < since) continue;
    const key = sessionKey(e.session);
    if (!sessions.has(key)) sessions.set(key, { id: key, client: e.client || null, model: null, firstAt: e.t, lastAt: e.t, branches: [], heads: [], tokens: null, prompts: 0, complete: false, ...clearing(key), rewrite: rewriteCost(key), cost: costOfObserved(key) });
    const x = sessions.get(key);
    x.lastAt = x.lastAt && x.lastAt > e.t ? x.lastAt : e.t;
    if (e.branch && !x.branches.includes(e.branch)) x.branches.push(e.branch);
    if (e.head && !x.heads.includes(e.head)) x.heads.push(e.head);
  }

  const all = [...records.values()].map(p => blank(p));
  const byPr = new Map(all.map(p => [p.number, p]));
  // A link can name a pull request that was never synced; it is still a pull request this machine worked on.
  const ensure = n => { if (!byPr.has(n)) { const p = blank({ number: n, state: 'UNKNOWN' }); all.push(p); byPr.set(n, p); } return byPr.get(n); };

  const unlinked = [];
  for (const x of sessions.values()) {
    const allocations = linkFor(x, all, links);
    if (!allocations.length) { unlinked.push(summary(x)); continue; }
    for (const a of allocations) {
      const p = ensure(a.pr), share = a.share;
      p.sessions.push({ ...summary(x), share, link: a.how });
      if (finite(x.tokens)) p.tokens.agent += x.tokens * share; else p.tokens.unknownSessions++;
      p.tokens.prompts += x.prompts * share;
      p.saved.cleared += x.cleared * share;
      if (x.cleared > 0) p.policies.add(x.policy || 'unstamped');
      p.cost.saved += x.cost.saved * share;
      p.cost.rewrite += x.cost.rewrite * share;
      p.cost.reread += (x.cost.reread || 0) * share;
      if (x.rereads?.reads) p.rereads += x.rereads.reads * share;
      if (x.cost.priced) p.cost.priced++; else p.cost.unpriced++;
      if (x.cost.spend != null) p.cost.spend += x.cost.spend * share; else p.cost.spendUnknown++;
    }
  }

  for (const p of all) {
    p.saved.cleared = Math.round(p.saved.cleared);
    p.saved.total = p.saved.cleared;
    p.cost.net = p.cost.saved - p.cost.rewrite - p.cost.reread;
    p.rereads = Math.round(p.rereads);
    p.tokens.agent = Math.round(p.tokens.agent);
    p.tokens.prompts = Math.round(p.tokens.prompts);
    p.tokens.complete = p.sessions.length > 0 && p.tokens.unknownSessions === 0 && p.sessions.every(s => s.complete);
    // the dollar figure is whole only when every session of the pull request could be priced; a partial one is never shown as the cost
    p.cost.spendComplete = p.sessions.length > 0 && p.cost.spendUnknown === 0;
    // The cut policy behind this pull request's saving: one policy, 'mixed' where its sessions cleared under
    // two (an update mid-flight), null where it was never cleared at all. The question "did this pull request
    // get a clear, and under which policy" is then one field, and a comparison can drop what it cannot place.
    p.policy = p.policies.size === 1 ? [...p.policies][0] : p.policies.size > 1 ? 'mixed' : null;
    delete p.policies;
    p.cleared = p.saved.cleared > 0;
    p.hoursToMerge = hours(p.createdAt, p.mergedAt);
    p.assisted = p.saved.total > 0;
    p.sessions.sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));
  }

  const selected = all.filter(p => pr !== undefined ? p.number === pr : (p.mergedAt || p.closedAt || p.updatedAt || p.sessions.at(-1)?.lastAt || '') >= since);
  const inWindow = selected.filter(p => p.mergedAt && (pr !== undefined || p.mergedAt >= since));
  // Every figure below is about the pull requests this machine actually worked on. The repository's other
  // pull requests are counted once, as `mergedSeen`, so a quiet week here cannot read as a cheap week there:
  // a merged pull request no session of this machine touched says nothing about what thinker is worth.
  const merged = inWindow.filter(p => p.sessions.length);
  const worked = selected.filter(p => p.sessions.length);
  const sum = (list, f) => list.reduce((n, p) => n + f(p), 0);
  return {
    schema: 1,
    scope: repoId(store.repo),
    since, generatedAt: new Date(now).toISOString(), windowDays: days, warnings,
    prs: selected.sort((a, b) => b.number - a.number),
    // Every session of the window, once each, whether or not it belongs to a pull request. A linked session is
    // in `prs[].sessions` too, there with its share of the pull request; this list is the sessions themselves,
    // which is what a per-session figure has to be averaged over (delivery-telemetry.js:sessionMetrics).
    sessions: [...sessions.values()].map(summary),
    summary: {
      merged: merged.length,
      mergedSeen: inWindow.length,
      mergedAssisted: merged.filter(p => p.assisted).length,
      open: selected.filter(p => p.state === 'OPEN' && p.sessions.length).length,
      worked: worked.length,
      saved: {
        cleared: sum(merged, p => p.saved.cleared),
        total: sum(merged, p => p.saved.total),
        basis: 'cleared is measured',
      },
      tokens: { agent: sum(merged, p => p.tokens.agent), complete: merged.filter(p => p.tokens.complete).length },
      rereads: sum(merged, p => p.rereads),
      // Dollars, netted (compression.js:clearingCostBySession). The one figure that answers "was it worth it",
      // because tokens cannot: the clearing's own saving and its own cost are not the same kind of token.
      cost: {
        saved: sum(merged, p => p.cost.saved),
        rewrite: sum(merged, p => p.cost.rewrite),
        reread: sum(merged, p => p.cost.reread),
        net: sum(merged, p => p.cost.net),
        costed: merged.filter(p => p.cost.priced).length,
        basis: 'cleared at the cache-read rate, less the cache writes after a clear, less the re-reads of cleared files, at list prices',
        // what the merged pull requests cost in model calls, over the ones whose every session is priced
        spend: sum(merged.filter(p => p.cost.spendComplete), p => p.cost.spend),
        spendComplete: merged.filter(p => p.cost.spendComplete).length,
      },
      meanSpendPerMergedPr: mean(merged.filter(p => p.cost.spendComplete).map(p => p.cost.spend)),
      meanNetPerMergedPr: meanSigned(merged.map(p => p.cost.net)),
      meanSavedPerMergedPr: mean(merged.map(p => p.saved.total)),
      meanTokensPerMergedPr: mean(merged.filter(p => p.tokens.complete).map(p => p.tokens.agent)),
      meanHoursToMerge: mean(merged.map(p => p.hoursToMerge)),
      sessions: { linked: sum(selected, p => p.sessions.length), unlinked: unlinked.length },
    },
    unlinkedSessions: unlinked.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))),
  };
}

const blank = p => ({ state: 'UNKNOWN', ...p, sessions: [], policies: new Set(), tokens: { agent: 0, prompts: 0, unknownSessions: 0, complete: false }, saved: { cleared: 0, total: 0 }, rereads: 0, cost: { saved: 0, rewrite: 0, reread: 0, net: 0, priced: 0, unpriced: 0, spend: 0, spendUnknown: 0, spendComplete: false } });
const summary = x => ({ id: x.id, cost: x.cost, spend: x.cost?.spend ?? null, rewrites: x.rewrite?.rewrites || 0, rereads: x.rereads?.reads || 0, client: x.client, model: x.model, firstAt: x.firstAt, lastAt: x.lastAt, tokens: finite(x.tokens) ? x.tokens : null, subagents: (x.subagents || []).length, subagentTokens: x.subagentTokens || 0, prompts: x.prompts, complete: !!x.complete, cleared: x.cleared, policy: x.policy ?? null, ...(x.policyChanged ? { policyChanged: true } : {}) });


// ---------------------------------------------------------------------------
// A person's own word on where a session belongs.

export function linkSession(store, session, allocations, { home = thinkerHome() } = {}) {
  if (!session || session === true) throw new Error('--session <id> is required');
  if (!Array.isArray(allocations) || !allocations.length) throw new Error('At least one PR allocation is required');
  const known = sessionsOf(store, { home }).has(sessionKey(session)) || readDelivery(store).events.some(e => e.op === 'observation' && e.session && sessionKey(e.session) === sessionKey(session));
  if (!known) throw new Error('Unknown recorded session ID; thinker prs --json lists the sessions it knows');
  const seen = new Set();
  for (const a of allocations) {
    a.pr = positiveInteger(a.pr, 'PR');
    if (!finite(a.share) || a.share <= 0 || a.share > 1 || seen.has(a.pr)) throw new Error('Allocations must have unique PRs and shares between 0 and 1');
    seen.add(a.pr);
  }
  if (Math.abs(allocations.reduce((n, a) => n + a.share, 0) - 1) > 1e-9) throw new Error('Allocation shares must sum to 1');
  return appendDelivery(store, { op: 'link', session: sessionKey(session), allocations });
}

// ---------------------------------------------------------------------------
// Reading the pull requests, through the person's own gh login. Read-only: nothing is ever posted.

// `gh api --paginate` follows the link header in one process. Every call here is a process of its own, and
// a process is most of what a call costs: 30 days of this repository is four pages of listing, which was
// four spawns and most of a minute before the flag.
export const githubReader = repo => (endpoint, { paginate = false } = {}) =>
  JSON.parse(execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), endpoint], { cwd: repo, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }));

// A repository whose origin is on github.com: what syncPrs can read at all.
export function githubOrigin(repo) {
  try { return /^github\.com\/[^/]+\/[^/]+$/.test(repoId(repo)); } catch { return false; }
}

// Whether the sync can run here: a github.com origin and a `gh` login. Checked before maintenance calls it,
// since the batch swallows a step's error and counts it: on a repository with no GitHub origin every queued
// learning job read as failed, retried five times and was given up on (found through Devin, 2026-11-01).
export function ghAvailable(repo) {
  if (!githubOrigin(repo)) return false;
  try { execFileSync('gh', ['auth', 'status'], { cwd: repo, stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; }
}

// The listing alone, which already carries the branch, the head, the base, the merge commit and the times --
// everything the linking and the figures need. A pull request's own page and its commit list are read only
// when one is named (`--pr n`), where the cost is a single call and the commits make the match certain.
// Without that a month of this repository was one page call and two more per pull request, over two minutes,
// which is no good for a step that runs by itself; it is now a call per hundred pull requests, about six
// seconds for five hundred.
export async function syncPrs(store, { pr, days = WINDOW_DAYS, request = null, now = Date.now(), home = thinkerHome() } = {}) {
  const origin = repoId(store.repo), slug = origin.replace(/^github\.com\//, '');
  if (!/^github\.com\/[^/]+\/[^/]+$/.test(origin)) throw new Error('Reading pull requests needs a github.com origin');
  request = request || githubReader(store.repo);
  const since = new Date(now - positiveInteger(days, 'days') * 86400_000).toISOString();
  const root = `repos/${slug}`;
  let listed = [], commitsOf = new Map();
  if (pr !== undefined) {
    const one = await request(`${root}/pulls/${positiveInteger(pr, 'PR')}`);
    listed = [one];
    try { commitsOf.set(one.number, (await request(`${root}/pulls/${one.number}/commits?per_page=100`, { paginate: true })).flat().map(c => c.sha)); } catch { /* the branch and the head still link it */ }
  } else {
    // Newest first, a page at a time, stopping at the window. Not `--paginate`: that follows the link header
    // to the end of the repository's history, which on a busy one is hundreds of pages for a month of work.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await request(`${root}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
      listed.push(...batch.filter(p => p.updated_at >= since));
      if (batch.length < 100 || batch.at(-1).updated_at < since) break;
    }
  }
  let synced = 0;
  for (const p of listed) {
    appendDelivery(store, { op: 'pr', pr: {
      number: p.number, title: p.title, url: p.html_url,
      state: p.merged_at ? 'MERGED' : String(p.state).toUpperCase(),
      createdAt: p.created_at, updatedAt: p.updated_at, mergedAt: p.merged_at, closedAt: p.closed_at,
      base: p.base?.sha, head: p.head?.sha, branch: p.head?.ref,
      mergeCommit: p.merged_at ? p.merge_commit_sha : null,
      ...(commitsOf.has(p.number) ? { commits: commitsOf.get(p.number) } : {}),
      ...(p.additions === undefined ? {} : { additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files }),
      author: p.user?.login,
    } });
    synced++;
  }
  return { synced, detailed: commitsOf.size };
}

// ---------------------------------------------------------------------------

export function renderDelivery(r, { detail = false } = {}) {
  const n = v => v == null ? 'unknown' : formatTokens(Math.round(v));
  const s = r.summary, L = [`Pull requests · ${r.scope} · last ${r.windowDays} days`, ''];
  L.push(`Merged with work recorded here: ${s.merged}${s.mergedSeen ? ` of ${s.mergedSeen} merged in the repository` : ''}`);
  L.push(`Still open: ${s.open}`);
  L.push('', `Saved on those ${s.merged} merged pull ${s.merged === 1 ? 'request' : 'requests'}`);
  L.push(`  cleared         ${n(s.saved.cleared)} tokens the clearing left out of their prompts (measured)${s.merged ? ` · ${n(s.meanSavedPerMergedPr)} on the average one` : ''}`);
  // The dollars, netted: the only figure that says whether the clearing paid, since what it saves is a cache
  // read and what it costs is a cache write, and a token of one is not a token of the other.
  const c = s.cost;
  if (c && (c.saved || c.rewrite)) {
    const d = v => formatDollars(v);
    L.push('', `In dollars, at list prices${c.costed < s.merged ? ` (${c.costed} of ${s.merged} on a model with a price)` : ''}`);
    L.push(`  saved           ${d(c.saved)} the clearing saved: cleared tokens at the cache-read rate`);
    L.push(`  rewrites        ${d(-c.rewrite)} the calls after a clear paid to write the cache again`);
    L.push(`  re-reads        ${d(-(c.reread || 0))} ${s.rereads ? `${s.rereads} ${s.rereads === 1 ? 'file' : 'files'} read again after a clear took ${s.rereads === 1 ? 'it' : 'them'} out: written once, read on every later call` : 'no file read again after a clear took it out'}`);
    L.push(`  net             ${d(c.net)}${s.merged ? ` · ${d(s.meanNetPerMergedPr)} on the average one` : ''}`);
  }
  L.push('', 'What they cost');
  L.push(`  agent tokens    ${n(s.tokens.agent)} over ${s.sessions.linked} linked ${s.sessions.linked === 1 ? 'session' : 'sessions'}: every prompt and every answer added up, subagents included, the same way the saving is`);
  L.push(`  average merged  ${n(s.meanTokensPerMergedPr)} tokens · ${s.meanHoursToMerge == null ? 'unknown' : s.meanHoursToMerge.toFixed(1) + 'h'} from opened to merged · ${s.tokens.complete}/${s.merged} with complete counters`);
  if (s.sessions.unlinked) L.push('', `${s.sessions.unlinked} ${s.sessions.unlinked === 1 ? 'session belongs' : 'sessions belong'} to no pull request yet. thinker prs sync reads them from GitHub; thinker prs link --session <id> --pr <n> says so by hand.`);
  // Only the pull requests some session here worked on: the repository's others have nothing to say.
  if (detail) for (const p of r.prs.filter(p => p.sessions.length || r.prs.length === 1)) {
    L.push('', `#${p.number} ${p.title || ''} · ${p.state}`, p.url || '');
    L.push(`  saved      ${n(p.saved.cleared)} tokens cleared`);
    L.push(`  cost       ${n(p.tokens.agent)} agent tokens over ${p.sessions.length} ${p.sessions.length === 1 ? 'session' : 'sessions'}${p.sessions.length && !p.tokens.complete ? ' · incomplete counters' : ''}`);
    if (p.cost.priced) L.push(`  net        ${formatDollars(p.cost.net)} = ${formatDollars(p.cost.saved)} saved less ${formatDollars(p.cost.rewrite)} of cache writes after a clear${p.cost.reread ? ` less ${formatDollars(p.cost.reread)} of re-reads (${p.rereads})` : ''}${p.cost.unpriced ? ` (${p.cost.unpriced} ${p.cost.unpriced === 1 ? 'session' : 'sessions'} on an unpriced model)` : ''}`);
    for (const x of p.sessions) L.push(`    ${x.id}  ${n(x.tokens)} tokens${x.subagents ? ` (${n(x.subagentTokens)} in ${x.subagents} ${x.subagents === 1 ? 'subagent' : 'subagents'})` : ''} · ${n(x.cleared)} cleared · ${x.rewrites ? `${x.rewrites} ${x.rewrites === 1 ? 'rewrite' : 'rewrites'} after a clear · ` : ''}${x.rereads ? `${x.rereads} ${x.rereads === 1 ? 're-read' : 're-reads'} · ` : ''}${Math.round(x.share * 100)}% (${x.link})`);
  }
  for (const w of r.warnings) L.push(`Warning: ${w}`);
  if (!r.prs.length) L.push('', 'No pull requests recorded yet. Run thinker prs sync to read them from GitHub.');
  return L.join('\n');
}
