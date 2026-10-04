import { execFileSync } from 'node:child_process';
import { repoId } from './store.js';
import { readLog, sessionKey } from './usage.js';
import { formatTokens } from './model-usage.js';
import { appendImpact, readImpact } from './impact-journal.js';

const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const median = xs => { const a = xs.filter(finite).sort((a, b) => a - b); return a.length ? (a[Math.floor(a.length / 2)] + a[Math.floor((a.length - 1) / 2)]) / 2 : null; };
export function positiveInteger(value, label) {
  const n = Number(value);
  if (typeof value === 'boolean' || !Number.isSafeInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`);
  return n;
}

export function impactReport(store, { days = 30, pr, now = Date.now() } = {}) {
  days = positiveInteger(days, 'days');
  if (pr !== undefined) pr = positiveInteger(pr, 'PR');
  const since = new Date(now - days * 86400_000).toISOString();
  const { events, warnings } = readImpact(store);
  const history = readLog(store), sessions = new Map(), links = new Map(), prs = new Map(), reviews = new Map(), decisions = new Map(), models = new Map();
  const exposures = new Map(), assessments = new Map(), observations = new Map();
  // Legacy session events remain useful but are never upgraded to complete total-token coverage.
  for (const e of [...history, ...events].sort((a, b) => a.t.localeCompare(b.t))) {
    const key = e.session && sessionKey(e.session);
    if (e.op === 'session' && key && key !== 'unknown') {
      sessions.set(key, e);
    }
    if (key && ['session', 'impact-observation'].includes(e.op)) {
      const obs = observations.get(key) || [];
      if (e.head) obs.push({ head: e.head, branch: e.branch, t: e.t });
      observations.set(key, obs);
    }
    if (key && ['orient', 'lookup', 'late'].includes(e.op) && e.served?.length) {
      const ids = exposures.get(key) || new Set(); e.served.forEach(id => ids.add(id)); exposures.set(key, ids);
    }
    if (key && e.op === 'attest') {
      const ids = assessments.get(key) || new Set();
      for (const a of e.applied || []) if (a.verdict === 'confirmed') ids.add(a.id);
      assessments.set(key, ids);
    }
    if (e.op === 'impact-pr') prs.set(e.pr.number, e.pr);
    if (e.op === 'impact-link') links.set(key, e.allocations);
    if (e.op === 'impact-review') reviews.set(e.runId, e);
    if (e.op === 'impact-decision') decisions.set(`${e.pr}:${e.finding}`, e);
    if (e.op === 'model') models.set(e.eventId || JSON.stringify(e), e);
  }
  // A head seen once is not proof of contribution: it might be the starting commit. Require
  // movement between observed heads, both belonging to exactly one PR. Branch names alone never suffice.
  const autoLinks = new Set();
  for (const [key, obs] of observations) {
    if (links.has(key)) continue;
    const heads = [...new Set(obs.map(o => o.head))];
    if (heads.length < 2) continue;
    const matches = [...prs.values()].filter(p => heads.every((h, i) => p.commits?.includes(h) || i === 0 && p.base === h) && heads.slice(1).every(h => p.commits?.includes(h)));
    if (matches.length === 1) { links.set(key, [{ pr: matches[0].number, share: 1 }]); autoLinks.add(key); }
  }
  const all = [...prs.values()].map(p => ({ ...p, sessions: [], reviews: [], findings: [], tokens: { agent: 0, review: 0, other: 0, known: 0, complete: false, unknownCalls: 0 }, cacheNotes: [], actedOnNotes: [] }));
  const byPr = new Map(all.map(p => [p.number, p]));
  // Explicit links and local reviews can precede GitHub sync.
  const ensure = n => {
    if (!byPr.has(n)) { const p = { number: n, state: 'UNKNOWN', sessions: [], reviews: [], findings: [], tokens: { agent: 0, review: 0, other: 0, known: 0, complete: false, unknownCalls: 0 }, cacheNotes: [], actedOnNotes: [] }; all.push(p); byPr.set(n, p); }
    return byPr.get(n);
  };
  const unassigned = [];
  for (const [key, e] of sessions) {
    const allocations = links.get(key) || [];
    const total = e.totalTokens ?? e.tokens?.totalTokens;
    if (!allocations.length) { if (e.t >= since) unassigned.push({ session: key, tokens: finite(total) ? total : null, inputTokens: e.inputTokens ?? null }); continue; }
    for (const a of allocations) {
      const p = ensure(a.pr), known = finite(total);
      p.sessions.push({ id: key, model: e.model || null, client: e.client || null, share: a.share, allocation: autoLinks.has(key) ? 'commit-evidence' : 'explicit', tokens: known ? total * a.share : null, inputTokens: e.inputTokens ?? null, complete: known && e.tokenCoverage !== 'partial', observedAt: e.t, observations: observations.get(key) || [] });
      if (known) p.tokens.agent += total * a.share;
      p.cacheNotes.push(...(exposures.get(key) || [])); p.actedOnNotes.push(...(assessments.get(key) || []));
    }
  }
  const overhead = { tokens: 0, unknownCalls: 0 }, unassignedReview = [];
  const callsByRun = new Map();
  for (const m of models.values()) {
    if (m.impactRun) { const a = callsByRun.get(m.impactRun) || []; a.push(m); callsByRun.set(m.impactRun, a); }
    else if (m.t >= since) { const total = m.tokens?.totalTokens; if (finite(total)) overhead.tokens += total; else overhead.unknownCalls++; }
  }
  for (const r of reviews.values()) {
    if (!r.pr) { if (r.t >= since) unassignedReview.push(r); continue; }
    const p = ensure(r.pr), calls = callsByRun.get(r.runId);
    let tokens = 0, unknown = 0;
    if (calls?.length) for (const c of calls) { if (finite(c.tokens?.totalTokens)) tokens += c.tokens.totalTokens; else unknown++; }
    else if (finite(r.tokens)) tokens = r.tokens;
    else unknown++;
    if (!calls?.length && r.errors?.length && !unknown) unknown++;
    p.tokens.review += tokens; p.tokens.unknownCalls += unknown;
    p.reviews.push({ ...r, recordedTokens: tokens, unknownCalls: unknown });
    for (const f of r.findings || []) {
      let finding = p.findings.find(x => x.id === f.id);
      if (!finding) { finding = { ...f, firstSeen: r.completedAt || r.t, reviewedHead: r.head, runs: [], validity: 'pending', resolution: 'open' }; p.findings.push(finding); }
      finding.runs.push(r.runId);
    }
  }
  // A crash before a review result must not hide its model usage.
  for (const [id, calls] of callsByRun) if (!reviews.has(id)) for (const c of calls) {
    const p = c.impactPr && ensure(c.impactPr);
    if (p) p.updatedAt = p.updatedAt || c.t;
    if (p) { if (finite(c.tokens?.totalTokens)) p.tokens.review += c.tokens.totalTokens; else p.tokens.unknownCalls++; }
    else if (c.t >= since) { if (finite(c.tokens?.totalTokens)) overhead.tokens += c.tokens.totalTokens; else overhead.unknownCalls++; }
  }
  for (const p of all) {
    for (const f of p.findings) {
      const decision = decisions.get(`${p.number}:${f.id}`);
      if (decision) Object.assign(f, { validity: decision.validity, resolution: decision.resolution, decisionEvidence: decision.evidence, fixCommit: decision.fixCommit, fixedAt: decision.fixedAt, confirmation: decision.confirmation, duplicateOf: decision.duplicateOf });
      f.caughtAndFixed = f.validity === 'confirmed' && f.resolution === 'fixed' && !!p.mergedAt && !!f.fixCommit && !!f.fixedAt && Date.parse(f.fixedAt) <= Date.parse(p.mergedAt) && Date.parse(f.fixedAt) >= Date.parse(f.firstSeen) && (p.commits?.includes(f.fixCommit) || p.mergeCommit === f.fixCommit);
    }
    p.cacheNotes = [...new Set(p.cacheNotes)]; p.actedOnNotes = [...new Set(p.actedOnNotes)];
    p.tokens.known = p.tokens.agent + p.tokens.review + p.tokens.other;
    p.tokens.complete = warnings.length === 0 && p.sessions.length > 0 && p.sessions.every(s => s.complete) && p.tokens.unknownCalls === 0;
    p.openToMergeHours = p.createdAt && p.mergedAt ? Math.max(0, (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3600_000) : null;
    p.readyToMergeHours = p.readyAt && p.mergedAt ? Math.max(0, (Date.parse(p.mergedAt) - Date.parse(p.readyAt)) / 3600_000) : null;
    p.bugsCaughtAndFixed = p.findings.filter(f => f.caughtAndFixed).length;
  }
  const selected = all.filter(p => pr !== undefined ? p.number === pr : (p.mergedAt || p.updatedAt || p.reviews.at(-1)?.t || p.sessions.at(-1)?.observedAt || '') >= since);
  const merged = selected.filter(p => p.mergedAt && (pr !== undefined || p.mergedAt >= since)), complete = merged.filter(p => p.tokens.complete);
  return { schema: 1, scope: repoId(store.repo), source: 'local and explicitly imported evidence; contributor and subagent coverage may be incomplete', since, generatedAt: new Date(now).toISOString(), warnings, prs: selected.sort((a, b) => b.number - a.number), summary: { merged: merged.length, cacheAssisted: merged.filter(p => p.cacheNotes.length).length, reviewed: merged.filter(p => p.reviews.length).length, tokenCoverage: { complete: complete.length, merged: merged.length, meaning: 'complete counters for linked recorded sessions, not all contributor work' }, medianTokensPerMergedPr: median(complete.map(p => p.tokens.known)), knownTokensOnMergedPrs: merged.reduce((n, p) => n + p.tokens.known, 0), bugsCaughtAndFixed: merged.reduce((n, p) => n + p.bugsCaughtAndFixed, 0), cacheSupportedFixes: merged.reduce((n, p) => n + p.findings.filter(f => f.caughtAndFixed && (f.note || f.notes?.length)).length, 0), findingOutcomes: Object.fromEntries(['pending', 'confirmed', 'dismissed', 'duplicate'].map(v => [v, selected.reduce((n, p) => n + p.findings.filter(f => f.validity === v).length, 0)])), medianReadyToMergeHours: median(merged.map(p => p.readyToMergeHours)), medianOpenToMergeHours: median(merged.map(p => p.openToMergeHours)), openOrAbandonedKnownTokens: selected.filter(p => !p.mergedAt).reduce((n, p) => n + p.tokens.known, 0), improvement: null }, overhead, unassignedSessions: unassigned, unassignedReviews: unassignedReview };
}

export function linkSession(store, session, allocations) {
  if (!session || session === true) throw new Error('--session <id> is required');
  if (!Array.isArray(allocations) || !allocations.length) throw new Error('At least one PR allocation is required');
  const available = impactReport(store).unassignedSessions.some(s => s.session === sessionKey(session)) || readLog(store).some(e => e.op === 'session' && sessionKey(e.session || '') === sessionKey(session)) || readImpact(store).events.some(e => e.op === 'session' && sessionKey(e.session || '') === sessionKey(session));
  if (!available) throw new Error('Unknown recorded session ID');
  const seen = new Set();
  for (const a of allocations) { a.pr = positiveInteger(a.pr, 'PR'); if (!finite(a.share) || a.share <= 0 || a.share > 1 || seen.has(a.pr)) throw new Error('Allocations must have unique PRs and shares between 0 and 1'); seen.add(a.pr); }
  if (Math.abs(allocations.reduce((n, a) => n + a.share, 0) - 1) > 1e-9) throw new Error('Allocation shares must sum to 1');
  return appendImpact(store, { op: 'impact-link', session: sessionKey(session), allocations });
}

export function decideFinding(store, { pr, finding, validity, resolution = 'open', evidence, fixCommit, duplicateOf }) {
  pr = positiveInteger(pr, 'PR');
  const p = impactReport(store, { pr }).prs[0], f = p?.findings.find(f => f.id === finding);
  if (!f) throw new Error('Unknown finding; inspect thinker impact --pr <number> --json');
  if (!['pending', 'confirmed', 'dismissed', 'duplicate'].includes(validity)) throw new Error('Validity must be pending, confirmed, dismissed, or duplicate');
  if (!['open', 'fixed', 'accepted-risk', 'not-applicable'].includes(resolution)) throw new Error('Resolution must be open, fixed, accepted-risk, or not-applicable');
  if (typeof evidence !== 'string' || !evidence.trim()) throw new Error('--evidence <reason> is required');
  if (validity === 'duplicate' && (!p.findings.some(x => x.id === duplicateOf && x.id !== finding && x.validity !== 'duplicate'))) throw new Error('--duplicate-of must identify a different nonduplicate finding on this PR');
  let fixedAt;
  if (resolution === 'fixed') {
    if (!/^[a-f0-9]{7,40}$/i.test(fixCommit || '')) throw new Error('--fix <commit SHA> is required for a fixed finding');
    const git = args => execFileSync('git', args, { cwd: store.repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
    fixCommit = git(['rev-parse', '--verify', `${fixCommit}^{commit}`]);
    fixedAt = new Date(git(['show', '-s', '--format=%cI', fixCommit])).toISOString();
    if (Date.parse(fixedAt) < Date.parse(f.firstSeen)) throw new Error('The fixing commit predates the finding');
    if (p.mergedAt && Date.parse(fixedAt) > Date.parse(p.mergedAt)) throw new Error('The fixing commit is after this PR merged');
    if (!p.commits?.includes(fixCommit) && p.mergeCommit !== fixCommit) throw new Error('The fixing commit is not in the synced PR; run thinker impact sync --pr <number>');
  }
  return appendImpact(store, { op: 'impact-decision', pr, finding, validity, resolution, evidence, fixCommit, fixedAt, duplicateOf, confirmation: 'human-reported' });
}

// Read-only GitHub access through the user's existing gh login. No review comments are posted.
export function githubReader(repo) {
  return endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 20 * 1024 * 1024 }));
}
export async function syncImpact(store, { pr, days = 30, request = githubReader(store.repo), now = Date.now() } = {}) {
  const origin = repoId(store.repo), slug = origin.replace(/^github\.com\//, '');
  if (!/^github\.com\/[^/]+\/[^/]+$/.test(origin)) throw new Error('Impact sync currently requires a github.com origin');
  const since = new Date(now - positiveInteger(days, 'days') * 86400_000).toISOString();
  const root = `repos/${slug}`, pulls = [];
  if (pr !== undefined) pulls.push(await request(`${root}/pulls/${positiveInteger(pr, 'PR')}`));
  else for (let page = 1; ; page++) {
    const batch = await request(`${root}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
    pulls.push(...batch.filter(p => p.updated_at >= since));
    if (batch.length < 100 || batch.at(-1).updated_at < since) break;
  }
  const paginate = async endpoint => { const all = []; for (let page = 1; ; page++) { const batch = await request(`${endpoint}?per_page=100&page=${page}`); all.push(...batch); if (batch.length < 100) return all; } };
  let synced = 0;
  for (const item of pulls) {
    const p = pr !== undefined ? item : await request(`${root}/pulls/${item.number}`);
    const commits = await paginate(`${root}/pulls/${p.number}/commits`);
    const timeline = await paginate(`${root}/issues/${p.number}/timeline`);
    const ready = timeline.filter(e => e.event === 'ready_for_review').at(-1);
    // GitHub's current draft flag does not establish whether a PR was created as a draft.
    // With no readiness event, keep the metric unknown rather than guessing from created_at.
    appendImpact(store, { op: 'impact-pr', pr: { number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? 'MERGED' : String(p.state).toUpperCase(), createdAt: p.created_at, updatedAt: p.updated_at, mergedAt: p.merged_at, closedAt: p.closed_at, readyAt: ready?.created_at || null, base: p.base?.sha, head: p.head?.sha, branch: p.head?.ref, mergeCommit: p.merged_at ? p.merge_commit_sha : null, commits: commits.map(c => c.sha), additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files, author: p.user?.login, commitsComplete: commits.length === p.commits } });
    synced++;
  }
  return { synced };
}

export function renderImpact(r, { detail = false } = {}) {
  const n = v => v == null ? 'unknown' : formatTokens(v);
  const s = r.summary, lines = [`Delivery · ${r.scope}`, `${r.source}`, '', `PRs merged: ${s.merged} (${s.cacheAssisted} cache-assisted; ${s.reviewed} reviewed)`, `Median tokens / merged PR: ${n(s.medianTokensPerMergedPr)}`, `Complete counters: ${s.tokenCoverage.complete}/${s.tokenCoverage.merged} merged PRs (linked sessions only)`, `Bugs caught and fixed before merge: ${s.bugsCaughtAndFixed} (${s.cacheSupportedFixes} supported by cached knowledge)`, `Findings: ${s.findingOutcomes.confirmed} confirmed; ${s.findingOutcomes.dismissed} dismissed; ${s.findingOutcomes.duplicate} duplicate; ${s.findingOutcomes.pending} pending`, `Median opened-to-merged time: ${s.medianOpenToMergeHours == null ? 'unknown' : s.medianOpenToMergeHours.toFixed(1) + 'h'}`, `Median ready-to-merge time: ${s.medianReadyToMergeHours == null ? 'unknown' : s.medianReadyToMergeHours.toFixed(1) + 'h'}`, `Repository overhead: ${n(r.overhead.tokens)} known tokens; ${r.overhead.unknownCalls} calls unmeasured`, `Open/abandoned PRs: ${n(s.openOrAbandonedKnownTokens)} known tokens`, `Unassigned: ${r.unassignedSessions.length} sessions; ${r.unassignedReviews.length} reviews`, 'Improvement vs baseline: not established'];
  if (detail) for (const p of r.prs) {
    lines.push('', `#${p.number} ${p.title || ''} · ${p.state}`, p.url || '', `Recorded tokens: ${n(p.tokens.known)} (${n(p.tokens.agent)} agent; ${n(p.tokens.review)} review)${p.tokens.complete ? '' : ' · incomplete counters'}`, `Cache: ${p.cacheNotes.length} notes served; ${p.actedOnNotes.length} assessed as acted on`);
    for (const s of p.sessions) lines.push(`  session ${s.id}: ${n(s.tokens)} tokens; ${Math.round(s.share * 100)}% allocated (${s.allocation})`);
    for (const f of p.findings) lines.push(`  ${f.id} ${f.validity}/${f.resolution}: ${f.message || f.title || f.category || 'finding'}${f.caughtAndFixed ? ' [caught and fixed before merge]' : ''}${f.fixCommit ? `; fix ${f.fixCommit}` : ''}${f.decisionEvidence ? `; ${f.decisionEvidence}` : ''}`);
  }
  for (const w of r.warnings) lines.push(`Warning: ${w}`);
  if (!r.prs.length) lines.push('', 'Run thinker impact sync, then link sessions with thinker impact link --session <id> --pr <number>.');
  return lines.filter(l => l !== undefined).join('\n');
}
