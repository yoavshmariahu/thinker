// Keep transcript parsing off the HTTP thread. Partial views use the CLI's readers;
// only the complete view is persisted as a snapshot.
import { parentPort } from 'node:worker_threads';
import { Store } from '../store.js';
import { findRepoSessions } from '../instruction-value.js';
import { contextView } from '../context-view.js';
import { reportView, weekColumns } from '../report.js';
import { writeSnapshot } from '../context-snapshot.js';
import { writeReport } from '../report-snapshot.js';
import { refreshCheckouts, machineRepos } from './server.js';

const queue = [];
let running = false;
const fail = (id, e) => parentPort.postMessage({ id, error: String(e.message || e), done: true });
function next() {
  const job = queue.shift();
  if (!job) { running = false; return; }
  const { id, kind, store, window, now, days, sessions, completed } = job;
  try {
    const total = sessions.length, done = completed === total, subset = sessions.slice(0, completed);
    const view = kind === 'context' ? contextView(store, { days, sessions: subset })
      : reportView(store, { weeks: window, now, sessions: subset, includePrs: done });
    const at = Date.now();
    if (done) {
      if (kind === 'context') writeSnapshot(store, window, view, { now: at });
      else writeReport(store, window, view, { now: at });
    }
    parentPort.postMessage({ id, completed, total, view, at, done });
    // Geometric checkpoints bound repeated aggregation to less than three times
    // the session count. Rotate jobs so every repository contributes early.
    if (!done) queue.push({ ...job, completed: Math.min(total, completed * 2) });
  } catch (e) { fail(id, e); }
  // Accept discovery requests and tab switches between checkpoints.
  setImmediate(next);
}

parentPort.on('message', ({ id, kind, repo, window, home, transcriptsHome }) => {
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
    parentPort.postMessage({ id, completed: 0, total: sessions.length });
    queue.push({ id, kind, store, window, now, days, sessions, completed: Math.min(1, sessions.length) });
    if (!running) { running = true; setImmediate(next); }
  } catch (e) { fail(id, e); }
});
