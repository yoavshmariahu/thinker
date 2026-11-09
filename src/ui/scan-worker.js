// Keep transcript parsing off the HTTP thread. Partial views use the CLI's readers;
// only the complete view is persisted as a snapshot.
import fs from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { Store, logFile } from '../store.js';
import { findRepoSessions } from '../instruction-value.js';
import { contextView } from '../context-view.js';
import { reportView, weekColumns } from '../report.js';
import { writeSnapshot } from '../context-snapshot.js';
import { writeReport } from '../report-snapshot.js';
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
  const { id, kind, store, window, now, days, sessions, completed, from = 0, changed = null } = job;
  try {
    const total = changed ? changed.size : sessions.length, done = completed === sessions.length, subset = sessions.slice(0, completed);
    const onSession = changed ? progressOf(id, changed, 0, total - 1, total) : progressOf(id, new Set(sessions.slice(from, completed).map(s => s.session)), from, completed - 1, total);
    const view = kind === 'context' ? contextView(store, { days, sessions: subset, onSession })
      : reportView(store, { weeks: window, now, sessions: subset, includePrs: done, onSession });
    const at = Date.now();
    if (done) {
      if (kind === 'context') writeSnapshot(store, window, view, { now: at });
      else writeReport(store, window, view, { now: at });
    }
    parentPort.postMessage({ id, completed: changed ? total : completed, total, view, at, done, ...(changed ? { delta: true } : {}) });
    // Geometric checkpoints bound repeated aggregation to less than three times
    // the session count. Rotate jobs so every repository contributes early.
    if (!done) queue.push({ ...job, from: completed, completed: Math.min(sessions.length, completed * 2) });
  } catch (e) { fail(id, e); }
  // Accept discovery requests and tab switches between checkpoints.
  setImmediate(next);
}

// whether a file moved since `since` (a log appended to, a transcript written)
const movedSince = (f, since) => { try { return fs.statSync(f).mtimeMs > since; } catch { return false; } };

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
      if (!changed.size && !logs) { parentPort.postMessage({ id, completed: 0, total: 0, done: true, unchanged: true, at: now }); return; }
      parentPort.postMessage({ id, completed: 0, total: changed.size, delta: true });
      queue.push({ id, kind, store, window, now, days, sessions, completed: sessions.length, changed });
    } else {
      parentPort.postMessage({ id, completed: 0, total: sessions.length });
      queue.push({ id, kind, store, window, now, days, sessions, completed: Math.min(1, sessions.length) });
    }
    if (!running) { running = true; setImmediate(next); }
  } catch (e) { fail(id, e); }
});
