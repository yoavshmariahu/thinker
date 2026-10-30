// What a pull request cost and what thinker saved on it.
//
// A session is linked to the pull request it was working on; what thinker saved in that session is then the
// pull request's. Two figures, kept apart because they are not the same kind of evidence:
//
//   cleared   MEASURED. The tokens the API left out of the session's prompts after the context proxy cleared
//             them, added up (compression.js). Gross, as the card is: a clear also rewrites the prompt cache.
//   reading   ESTIMATED. One read per file behind each note the session was seen to act on (usage.js).
//
// Nothing here calls a model, mines anything or spends a token. The pull requests come from the person's own
// `gh` login, read-only; the sessions come from the usage log; the savings come from records already written.
import { execFileSync } from 'node:child_process';
import { repoId } from './store.js';
import { readLog, sessionKey, savingOf } from './usage.js';
import { formatTokens } from './model-usage.js';
import { compressionDir, readCompression, clearedBySession } from './compression.js';
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
const median = xs => { const a = xs.filter(finite).sort((x, y) => x - y); return a.length ? (a[Math.floor(a.length / 2)] + a[Math.floor((a.length - 1) / 2)]) / 2 : null; };
const hours = (from, to) => from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 3600_000) : null;

// ---------------------------------------------------------------------------
// What the sessions of this repository did, and what thinker saved in each.

// One pass over the usage log. The servings carry their own estimate (`est`, written when they were served);
// only the ones the end-of-session assessment marked `confirmed` are counted, exactly as `usage.js` counts
// them for the machine as a whole, so the two can never disagree about what a note saved.
export function sessionsOf(store, { since = '', log = null, home = thinkerHome(), env = process.env } = {}) {
  const events = (log || readLog(store)).filter(e => e.origin === repoId(store.repo) && e.t >= since);
  const sessions = new Map(), verdicts = new Map();
  const of = key => {
    if (!sessions.has(key)) sessions.set(key, { id: key, client: null, model: null, firstAt: null, lastAt: null, branches: new Set(), heads: new Set(), notes: new Map(), tokens: null, prompts: 0, complete: false });
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
    if (['orient', 'lookup', 'late'].includes(e.op)) {
      const ids = e.served || [];
      ids.forEach((id, i) => { if (!x.notes.has(id)) x.notes.set(id, e.est?.[i] || Object.values(savingOf(e.repo || store.repo, safeGet(store, id)))); });
    } else if (e.op === 'attest') {
      if (!verdicts.has(key)) verdicts.set(key, new Map());
      for (const a of e.applied || []) verdicts.get(key).set(a.id, a.verdict);
      if (e.model) x.model = e.model;
    } else if (e.op === 'session') {
      // Each turn logs the session again with the transcript's totals so far: the last record is the session.
      if (e.model) x.model = e.model;
      const total = e.totalTokens ?? e.tokens?.totalTokens;
      if (finite(total)) { x.tokens = total; x.complete = e.tokenCoverage !== 'partial'; }
      if (finite(e.turns)) x.prompts = Math.max(x.prompts, e.turns);
    }
  }
  const cleared = clearedFor({ home, env, since });
  for (const x of sessions.values()) {
    let calls = 0, tokens = 0, servings = 0, actedOn = 0;
    for (const [id, est] of x.notes) if (verdicts.get(x.id)?.get(id) === 'confirmed') { servings++; actedOn++; calls += est[0] || 0; tokens += est[1] || 0; }
    x.reading = { calls, tokens, servings };
    x.served = x.notes.size; x.actedOn = actedOn;
    x.cleared = cleared(x.id);
    x.branches = [...x.branches]; x.heads = [...x.heads];
  }
  return sessions;
}

const safeGet = (store, id) => { try { return store.get(id); } catch { return null; } };

// What the context proxy's clearing saved in a session: the proxy's own log first, since it is the durable
// record, and the card's state file only where the log's tail no longer reaches (compression.js).
export function clearedFor({ home = thinkerHome(), env = process.env, since = '' } = {}) {
  let logged = new Map();
  try { for (const [id, row] of clearedBySession(proxyLogFile(home, env), { since })) logged.set(sessionKey(id), row.cleared); } catch { logged = new Map(); }
  const dir = compressionDir(home);
  return id => {
    let state = 0;
    try { state = readCompression(dir, id)?.saved || 0; } catch { state = 0; }
    const a = logged.get(id) || 0;
    return Math.max(finite(a) ? a : 0, finite(state) ? state : 0);
  };
}

// ---------------------------------------------------------------------------
// Which pull request a session belongs to.

// In order of how much the evidence is worth. A person's own link beats anything read from git; a commit the
// session was sitting on is proof it was working there; a branch name is strong but can be reused, so the
// pull request whose life the session falls inside is preferred over a later one with the same branch.
// Commits a session sitting there is proof it was working on this pull request. The listing gives the head
// and the merge commit; the whole list comes only with `--pr n`. The base is where the branch started, so a
// session there says nothing.
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
  const cleared = clearedFor({ home, since });
  for (const e of events) {
    if (e.op !== 'observation' || !e.session || e.t < since) continue;
    const key = sessionKey(e.session);
    if (!sessions.has(key)) sessions.set(key, { id: key, client: e.client || null, model: null, firstAt: e.t, lastAt: e.t, branches: [], heads: [], notes: new Map(), tokens: null, prompts: 0, complete: false, reading: { calls: 0, tokens: 0, servings: 0 }, served: 0, actedOn: 0, cleared: cleared(key) });
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
      p.saved.reading.tokens += x.reading.tokens * share;
      p.saved.reading.calls += x.reading.calls * share;
      p.saved.reading.servings += x.reading.servings * share;
      p.notes.served += x.served; p.notes.actedOn += x.actedOn;
    }
  }

  for (const p of all) {
    p.saved.cleared = Math.round(p.saved.cleared);
    p.saved.reading.tokens = Math.round(p.saved.reading.tokens);
    p.saved.reading.calls = Math.round(p.saved.reading.calls);
    p.saved.reading.servings = Math.round(p.saved.reading.servings);
    p.saved.total = p.saved.cleared + p.saved.reading.tokens;
    p.tokens.agent = Math.round(p.tokens.agent);
    p.tokens.prompts = Math.round(p.tokens.prompts);
    p.tokens.complete = p.sessions.length > 0 && p.tokens.unknownSessions === 0 && p.sessions.every(s => s.complete);
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
    summary: {
      merged: merged.length,
      mergedSeen: inWindow.length,
      mergedAssisted: merged.filter(p => p.assisted).length,
      open: selected.filter(p => p.state === 'OPEN' && p.sessions.length).length,
      worked: worked.length,
      saved: {
        cleared: sum(merged, p => p.saved.cleared),
        reading: sum(merged, p => p.saved.reading.tokens),
        total: sum(merged, p => p.saved.total),
        basis: 'cleared is measured; reading avoided is an estimate',
      },
      tokens: { agent: sum(merged, p => p.tokens.agent), complete: merged.filter(p => p.tokens.complete).length },
      medianSavedPerMergedPr: median(merged.map(p => p.saved.total)),
      medianTokensPerMergedPr: median(merged.filter(p => p.tokens.complete).map(p => p.tokens.agent)),
      medianHoursToMerge: median(merged.map(p => p.hoursToMerge)),
      sessions: { linked: sum(selected, p => p.sessions.length), unlinked: unlinked.length },
    },
    unlinkedSessions: unlinked.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt))),
  };
}

const blank = p => ({ state: 'UNKNOWN', ...p, sessions: [], tokens: { agent: 0, prompts: 0, unknownSessions: 0, complete: false }, saved: { cleared: 0, reading: { calls: 0, tokens: 0, servings: 0 }, total: 0 }, notes: { served: 0, actedOn: 0 } });
const summary = x => ({ id: x.id, client: x.client, model: x.model, lastAt: x.lastAt, tokens: finite(x.tokens) ? x.tokens : null, prompts: x.prompts, complete: !!x.complete, cleared: x.cleared, reading: x.reading.tokens, served: x.served, actedOn: x.actedOn });


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

export function ghAvailable(repo) {
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
  L.push(`  cleared         ${n(s.saved.cleared)} tokens the API left out of their prompts (measured)`);
  L.push(`  reading avoided ${n(s.saved.reading)} tokens of files the notes meant nobody read (estimate)`);
  L.push(`  together        ${n(s.saved.total)} tokens${s.merged ? ` · ${n(s.medianSavedPerMergedPr)} on the median one` : ''}`);
  L.push('', 'What they cost');
  L.push(`  agent tokens    ${n(s.tokens.agent)} over ${s.sessions.linked} linked ${s.sessions.linked === 1 ? 'session' : 'sessions'}: every prompt and every answer added up, the same way the saving is`);
  L.push(`  median merged   ${n(s.medianTokensPerMergedPr)} tokens · ${s.medianHoursToMerge == null ? 'unknown' : s.medianHoursToMerge.toFixed(1) + 'h'} from opened to merged · ${s.tokens.complete}/${s.merged} with complete counters`);
  if (s.sessions.unlinked) L.push('', `${s.sessions.unlinked} ${s.sessions.unlinked === 1 ? 'session belongs' : 'sessions belong'} to no pull request yet. thinker prs sync reads them from GitHub; thinker prs link --session <id> --pr <n> says so by hand.`);
  // Only the pull requests some session here worked on: the repository's others have nothing to say.
  if (detail) for (const p of r.prs.filter(p => p.sessions.length || r.prs.length === 1)) {
    L.push('', `#${p.number} ${p.title || ''} · ${p.state}`, p.url || '');
    L.push(`  saved      ${n(p.saved.total)} tokens = ${n(p.saved.cleared)} cleared + ${n(p.saved.reading.tokens)} reading avoided (${p.saved.reading.servings} ${p.saved.reading.servings === 1 ? 'serving' : 'servings'} acted on)`);
    L.push(`  cost       ${n(p.tokens.agent)} agent tokens over ${p.sessions.length} ${p.sessions.length === 1 ? 'session' : 'sessions'}${p.sessions.length && !p.tokens.complete ? ' · incomplete counters' : ''}`);
    L.push(`  notes      ${p.notes.served} served · ${p.notes.actedOn} acted on`);
    for (const x of p.sessions) L.push(`    ${x.id}  ${n(x.tokens)} tokens · ${n(x.cleared)} cleared · ${n(x.reading)} reading · ${Math.round(x.share * 100)}% (${x.link})`);
  }
  for (const w of r.warnings) L.push(`Warning: ${w}`);
  if (!r.prs.length) L.push('', 'No pull requests recorded yet. Run thinker prs sync to read them from GitHub.');
  return L.join('\n');
}
