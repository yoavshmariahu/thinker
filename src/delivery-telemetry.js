// What leaves the machine about pull requests: counts and token totals, nothing else.
//
// Never the pull request's number, title, URL, branch, author or repository, and never a session id. A
// person's work in progress stays on their machine; what is counted is how many pull requests thinker was
// used on and how much it saved on them, which is the claim the project wants to be able to make.
import fs from 'node:fs';
import { Store, repoId } from './store.js';
import { readLog } from './usage.js';
import { deliveryReport, WINDOW_DAYS, SAVED_BUCKETS } from './delivery.js';
import { deliveryCheckouts } from './delivery-journal.js';

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
    schemaVersion: 2, windowDays: WINDOW_DAYS,
    repositories: 0, repositoriesWithPrs: 0, unreadableRepositories: 0,
    merged: 0, mergedSeen: 0, mergedAssisted: 0, open: 0, worked: 0,
    clearedTokens: 0, readingTokens: 0, savedTokens: 0,
    agentTokens: 0, completeTokenPrs: 0,
    linkedSessions: 0, unlinkedSessions: 0,
    hoursToMerge: 0, hoursToMergeSamples: 0,
    savedBuckets: SAVED_BUCKETS.map(upper => ({ upper, count: 0 })),
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
      out.clearedTokens += s.saved.cleared; out.readingTokens += s.saved.reading; out.savedTokens += s.saved.total;
      out.agentTokens += s.tokens.agent; out.completeTokenPrs += s.tokens.complete;
      out.linkedSessions += s.sessions.linked; out.unlinkedSessions += s.sessions.unlinked;
      for (const p of report.prs.filter(p => p.sessions.length && p.mergedAt && p.mergedAt >= report.since)) {
        out.savedBuckets.find(b => b.upper === null || p.saved.total <= b.upper).count++;
        if (typeof p.hoursToMerge === 'number' && Number.isFinite(p.hoursToMerge)) { out.hoursToMerge += p.hoursToMerge; out.hoursToMergeSamples++; }
      }
    } catch { out.unreadableRepositories++; }
  }
  for (const k of ['clearedTokens', 'readingTokens', 'savedTokens', 'agentTokens']) out[k] = Math.round(out[k]);
  out.hoursToMerge = Math.round(out.hoursToMerge * 100) / 100;
  return out;
}
