// Keep transcript parsing off the HTTP thread. Partial views use the CLI's readers;
// only the complete view is persisted as a snapshot.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { Store, logFile } from '../store.js';
import { findRepoSessions } from '../instruction-value.js';
import { contextView } from '../context-view.js';
import { reportView, weekColumns, refreshLogParts } from '../report.js';
import { writeSnapshot, lastSnapshot } from '../context-snapshot.js';
import { writeReport, readReport } from '../report-snapshot.js';
import { sourceStamp, sessionsStamp, canKeep, contextWindow, reportWindow } from '../view-sources.js';
import { proxyLogFile } from '../proxy-service.js';
import { refreshCheckouts, machineRepos } from './server.js';

const queue = [];
let running = false;
// The page's count moves inside a batch, not only at its end (2026-11-07). A checkpoint aggregates the sessions read so
// far, and the batches double, so the last one is half of every session with the bar standing still at the previous
// power of two for half the wait. Each of the view's three readers (instruction-value.js, harness.js, tool-outputs.js)
// calls `onSession` with every session it passes, so a session of the batch not yet aggregated counts as read once all
// READERS have passed it; the count is capped one under the checkpoint, which then says the exact figure. Posted at most
// every PROGRESS_MS, and without a view, so the page's stamp moves and its table does not (scans.js bumps no revision).
// `fresh`: the sessions the count is over (a cold batch's, or the ones changed since the kept view); `base`: the count
// already reported before them.
const READERS = 3, PROGRESS_MS = 200;
function progressOf(id, fresh, base, cap, total) {
  let hits = 0, reported = base, lastAt = 0;
  return s => {
    if (!fresh.has(s.session)) return;
    const completed = Math.min(cap, base + Math.floor(++hits / READERS)), now = Date.now();
    if (completed <= reported || now - lastAt < PROGRESS_MS) return;
    reported = completed; lastAt = now;
    parentPort.postMessage({ id, completed, total });
  };
}
const fail = (id, e) => parentPort.postMessage({ id, error: String(e.message || e), done: true });
function next() {
  const job = queue.shift();
  if (!job) { running = false; return; }
  const { id, kind, store, window, now, days, sessions, completed, from = 0, changed = null, stamp = null } = job;
  try {
    const total = changed ? changed.size : sessions.length, done = completed === sessions.length, subset = sessions.slice(0, completed);
    const onSession = changed ? progressOf(id, changed, 0, total - 1, total) : progressOf(id, new Set(sessions.slice(from, completed).map(s => s.session)), from, completed - 1, total);
    const view = kind === 'context' ? contextView(store, { days, sessions: subset, onSession })
      : reportView(store, { weeks: window, now, sessions: subset, includePrs: done, onSession });
    const at = Date.now();
    if (done) {
      // with the stamp of what it was read from (view-sources.js), so a refresh that finds nothing moved keeps it
      if (kind === 'context') writeSnapshot(store, window, view, { now: at, stamp });
      else writeReport(store, window, view, { now: at, stamp, sessions: sessionsStamp(sessions) });
    }
    parentPort.postMessage({ id, completed: changed ? total : completed, total, view, at, done, ...(changed ? { delta: true } : {}) });
    // Geometric checkpoints bound repeated aggregation to less than three times
    // the session count. Rotate jobs so every repository contributes early.
    if (!done) queue.push({ ...job, from: completed, completed: Math.min(sessions.length, completed * 2) });
  } catch (e) { fail(id, e); }
  // Accept discovery requests and tab switches between checkpoints.
  setImmediate(next);
}

// The kept view written back under a new `at`, when the stamp of what it rests on is the one it was made at: the
// page's own answer to "nothing has moved", the same one the commands give (context-snapshot.js, report-snapshot.js).
// A stamp that does not match (a session dropped out of the window, a record rewritten in place) leaves the view
// alone: the next visit reads it as old and has it made again, which is what happened to every such view before.
// `from` is the first week of a Report's window, which is part of its stamp; a Context view's window is its days
const stampOf = (store, kind, window, { sessions, from }) => {
  try {
    return kind === 'context' ? sourceStamp(store, { sessions, window: contextWindow(window) })
      : sourceStamp(store, { sessions, window: reportWindow(window, from), proxy: true });
  } catch { return null; }
};
function restamp(store, kind, window, { now, sessions, from }) {
  try {
    const stamp = stampOf(store, kind, window, { sessions, from });
    const kept = kind === 'context' ? lastSnapshot(store, window) : readReport(store, window, { now });
    if (!canKeep(kept, stamp, { now })) return;
    if (kind === 'context') writeSnapshot(store, window, kept.view, { now, stamp });
    else writeReport(store, window, kept.view, { now, stamp, sessions: sessionsStamp(sessions) });
  } catch {}
}

// whether a file moved since `since` (a log appended to, a transcript written)
const movedSince = (f, since) => { try { return fs.statSync(f).mtimeMs > since; } catch { return false; } };

// A Report whose sessions have not moved and whose logs have: the kept view with its log half read again
// (report.js:refreshLogParts), written back under the stamp of what it now rests on. Answers whether it was done:
// false leaves the caller to read every session, which is what happens when there is no kept view to build on.
function logsOnly(store, kind, window, { id, now, sessions, from }) {
  if (kind !== 'report') return false;
  try {
    const kept = readReport(store, window, { now });
    const mine = sessionsStamp(sessions);
    // not the sessions it was made from (one dropped out of the window, or it predates this): read every one
    if (!kept?.view || kept.sessions !== mine) return false;
    const view = refreshLogParts(store, kept.view, { now, sessions });
    writeReport(store, window, view, { now, stamp: stampOf(store, kind, window, { sessions, from }), sessions: mine });
    parentPort.postMessage({ id, completed: 0, total: 0, view, at: now, done: true, delta: true });
    return true;
  } catch { return false; }
}

parentPort.on('message', ({ id, kind, repo, window, home, transcriptsHome, since = null }) => {
  try {
    const store = new Store(repo), now = Date.now();
    if (kind === 'repos') {
      const checkouts = refreshCheckouts(store, { home, transcriptsHome });
      parentPort.postMessage({ id, done: true, repos: machineRepos(store, { home: transcriptsHome, checkouts }) });
      return;
    }
    const from = kind === 'report' ? weekColumns(now, window)[0].t : null;
    const days = kind === 'report' ? Math.ceil((now - from) / 86400_000) + 1 : window;
    const sessions = findRepoSessions(repo, days).filter(s => from === null || s.mtime >= from);
    if (since) {
      // Bringing a kept view up to date (scans.js): the sessions written since it, and for the Report the machine's log
      // and the proxy's (the savings and the pull requests are read from them). Nothing moved: nothing to read, and the
      // kept view stands as it is. Something moved: every session in one pass (the unchanged ones are the readers' cache
      // hits), the page's count over the changed ones, no doubling batches, since the kept view is on the screen meanwhile.
      const changed = new Set(sessions.filter(s => s.mtime > since).map(s => s.session));
      const logs = kind === 'report' && [logFile(store), proxyLogFile()].some(f => f && movedSince(f, since));
      if (!changed.size && !logs) {
        // Nothing moved: the kept view is written back with when it was looked at (view-sources.js), so the server
        // stops reading it as old and starts no `--refresh` behind it. Until 2026-11-10 the view's `at` stood where
        // it was, the page asked again on the next visit, and the command it started worked the whole view out anew.
        restamp(store, kind, window, { now, sessions, from });
        parentPort.postMessage({ id, completed: 0, total: 0, done: true, unchanged: true, at: now });
        return;
      }
      // Only a log moved: the sessions' half of the Report cannot have changed, so it is kept and the logs' half read
      // again (report.js:refreshLogParts). The logs move every few seconds of a live session, so before this a
      // repository with no session of its own still re-read every session it has on every visit, and All repositories
      // paid that for each of them: ~2.7 s of the ~3 s a visit cost on this machine, for figures that could not move.
      if (!changed.size && logsOnly(store, kind, window, { id, now, sessions, from })) return;
      parentPort.postMessage({ id, completed: 0, total: changed.size, delta: true });
      queue.push({ id, kind, store, window, now, days, sessions, completed: sessions.length, changed, stamp: stampOf(store, kind, window, { sessions, from }) });
    } else {
      parentPort.postMessage({ id, completed: 0, total: sessions.length });
      queue.push({ id, kind, store, window, now, days, sessions, completed: Math.min(1, sessions.length), stamp: stampOf(store, kind, window, { sessions, from }) });
    }
    if (!running) { running = true; setImmediate(next); }
  } catch (e) { fail(id, e); }
});
