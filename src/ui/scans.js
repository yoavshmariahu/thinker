import { Worker } from 'node:worker_threads';
import { lastSnapshot, REFRESH_MS } from '../context-snapshot.js';
import { readReport } from '../report-snapshot.js';

// One worker and queue per server: tab switches and repeated polls share work,
// and All repositories never launches a process per checkout.
export function uiScans({ workerFactory = () => new Worker(new URL('./scan-worker.js', import.meta.url)) } = {}) {
  const jobs = new Map();
  let worker, serial = 0, closed = false;
  const start = data => {
    if (closed) throw new Error('UI closed');
    if (!worker) {
      worker = workerFactory();
      const own = worker;
      worker.on('message', message => {
        const job = jobs.get(message.id);
        if (!job) return;
        Object.assign(job, message); job.revision++;
        if (job.resolve && message.done) {
          if (message.error) job.reject(new Error(message.error)); else job.resolve(message.repos);
          jobs.delete(message.id);
        }
      });
      const fail = error => {
        if (worker !== own) return;
        worker = null;
        for (const job of jobs.values()) if (!job.done) {
          Object.assign(job, { done: true, error: error.message }); job.revision++;
          job.reject?.(error);
        }
      };
      worker.on('error', fail);
      worker.on('exit', code => { if (worker === own && !closed) fail(new Error(`Session reader stopped (${code})`)); });
    }
    const job = { id: ++serial, ...data, completed: 0, total: null, revision: 0, done: false };
    jobs.set(job.id, job);
    worker.postMessage({ ...data, id: job.id });
    return job;
  };
  return {
    discover(data) {
      const job = start({ ...data, kind: 'repos' });
      return new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    },
    read(kind, store, window, { retry = false } = {}) {
      let job = [...jobs.values()].find(j => j.kind === kind && j.repo === store.repo && j.window === window);
      const saved = job && !job.done ? job.saved : kind === 'context' ? lastSnapshot(store, window) : readReport(store, window);
      const current = saved?.current && Date.now() - saved.at < REFRESH_MS;
      const invalid = Date.now() - (job?.at || 0) >= REFRESH_MS || (saved && saved.at >= job?.at && !current);
      if (job?.done && ((!job.error && invalid) || (job.error && retry))) { jobs.delete(job.id); job = null; }
      if (!job && !current) { job = start({ kind, repo: store.repo, window }); job.saved = saved; }
      // Keep a completed view in memory if writing its snapshot was not possible.
      const latest = job?.done && !job.error && saved?.at >= job.at ? saved : job?.view ? job : saved;
      return {
        view: latest?.view, at: latest?.at || 0,
        refreshing: Boolean(job && !job.done),
        progress: job ? { completed: job.completed, total: job.total, done: job.done, error: job.error || null } : null,
        revision: job ? `${job.id}:${job.revision}:${saved?.at || 0}` : `saved:${saved?.at || 0}`,
      };
    },
    async cancel() { const previous = worker; worker = null; for (const job of jobs.values()) job.reject?.(new Error('Session read cancelled')); jobs.clear(); await previous?.terminate(); },
    close() { closed = true; for (const job of jobs.values()) job.reject?.(new Error('UI closed')); jobs.clear(); return worker?.terminate(); },
  };
}

export function scanStatus(readings) {
  const active = readings.filter(s => s.progress);
  return {
    refreshing: readings.some(s => s.refreshing),
    partial: active.some(s => !s.progress.done || s.progress.error),
    revision: readings.map(s => s.revision).join('|'),
    progress: active.some(s => !s.progress.done || s.progress.error) ? {
      completed: active.reduce((n, s) => n + s.progress.completed, 0),
      total: active.some(s => s.progress.total === null) ? null : active.reduce((n, s) => n + s.progress.total, 0),
      error: active.map(s => s.progress.error).filter(Boolean).join('; ') || null,
    } : null,
  };
}
