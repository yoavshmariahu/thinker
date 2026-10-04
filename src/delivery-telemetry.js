// Only aggregate numeric outcomes leave the machine. The event journal, PR identities,
// source snippets and human confirmation evidence remain local.
import fs from 'node:fs';
import path from 'node:path';
import { Store, repoId } from './store.js';
import { readLog } from './usage.js';
import { impactReport } from './impact.js';
import { impactFile } from './impact-journal.js';

export const TOKEN_BUCKETS = [100000, 250000, 500000, 1000000, 2000000, null];
export function deliveryMetrics(store, { all = true, now = Date.now() } = {}) {
  const candidates = new Map(), visited = new Set(), excluded = new Set();
  const add = checkout => {
    if (typeof checkout !== 'string' || visited.has(checkout) || !fs.existsSync(checkout)) return;
    visited.add(checkout);
    const s = checkout === store.repo ? store : new Store(checkout, { readonly: true });
    // Honor repository opt-outs even when a different repository triggered the upload.
    const key = repoId(checkout);
    if (s.config().telemetry === false) { excluded.add(key); return; }
    const list = candidates.get(key) || [];
    if (!list.some(x => x.repo === checkout)) list.push(s);
    candidates.set(key, list);
  };
  add(store.repo);
  if (all) {
    for (const e of readLog(store, { all: true })) add(e.repo);
    // A checkout synced before it served any notes may exist only in the outcome journal.
    const file = impactFile(store);
    if (file && fs.existsSync(path.dirname(file))) for (const name of fs.readdirSync(path.dirname(file))) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const lines = fs.readFileSync(path.join(path.dirname(file), name), 'utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const e = JSON.parse(lines[i]);
          if (e.checkout) { add(e.checkout); break; }
        }
      } catch { /* unreadable journals are counted when their known checkout is visited */ }
    }
  }
  const out = {
    schemaVersion: 1, windowDays: 30, repositories: 0, repositoriesWithPrData: 0, unreadableRepositories: 0,
    mergedPrs: 0, cacheAssistedPrs: 0, reviewedPrs: 0, completeTokenPrs: 0,
    completePrTokens: 0, knownMergedPrTokens: 0, agentTokens: 0, reviewTokens: 0,
    bugsCaughtAndFixed: 0, cacheSupportedFixes: 0,
    confirmedFindings: 0, dismissedFindings: 0, duplicateFindings: 0, pendingFindings: 0,
    openToMergeHours: 0, openToMergeSamples: 0, readyToMergeHours: 0, readyToMergeSamples: 0,
    overheadTokens: 0, overheadUnknownCalls: 0, openOrAbandonedTokens: 0,
    unassignedSessions: 0, unassignedReviews: 0,
    tokenBuckets: TOKEN_BUCKETS.map(upper => ({ upper, count: 0 })),
  };
  for (const [origin, stores] of candidates) {
    if (excluded.has(origin)) continue;
    // Worktrees with the default machine log share one journal. Prefer the checkout with
    // the most linked evidence when local logging creates separate journals; never add
    // duplicate PRs from several checkouts. Such partial coverage remains explicit.
    try {
      const reports = stores.map(s => impactReport(s, { days: 30, now }));
      const report = reports.sort((a, b) => b.prs.reduce((n, p) => n + p.sessions.length + p.reviews.length, 0) - a.prs.reduce((n, p) => n + p.sessions.length + p.reviews.length, 0))[0];
      out.repositories++;
      if (report.warnings.length) out.unreadableRepositories++;
      if (report.prs.length) out.repositoriesWithPrData++;
      const s = report.summary;
      for (const [key, from] of Object.entries({ mergedPrs: 'merged', cacheAssistedPrs: 'cacheAssisted', reviewedPrs: 'reviewed', knownMergedPrTokens: 'knownTokensOnMergedPrs', bugsCaughtAndFixed: 'bugsCaughtAndFixed', cacheSupportedFixes: 'cacheSupportedFixes', openOrAbandonedTokens: 'openOrAbandonedKnownTokens' })) out[key] += s[from];
      for (const status of ['confirmed', 'dismissed', 'duplicate', 'pending']) out[`${status}Findings`] += s.findingOutcomes[status];
      out.overheadTokens += report.overhead.tokens;
      out.overheadUnknownCalls += report.overhead.unknownCalls;
      out.unassignedSessions += report.unassignedSessions.length;
      out.unassignedReviews += report.unassignedReviews.length;
      for (const p of report.prs.filter(p => p.mergedAt && p.mergedAt >= report.since)) {
        out.agentTokens += p.tokens.agent; out.reviewTokens += p.tokens.review;
        if (p.tokens.complete) {
          out.completeTokenPrs++; out.completePrTokens += p.tokens.known;
          out.tokenBuckets.find(b => b.upper === null || p.tokens.known <= b.upper).count++;
        }
        for (const [metric, value] of [['openToMerge', p.openToMergeHours], ['readyToMerge', p.readyToMergeHours]]) {
          if (typeof value === 'number' && Number.isFinite(value)) { out[`${metric}Hours`] += value; out[`${metric}Samples`]++; }
        }
      }
    } catch { out.unreadableRepositories++; }
  }
  return out;
}
