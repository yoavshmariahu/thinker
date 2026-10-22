// What is running against a cache right now, read from the batch detail files progress.js writes
// (state/pr-mining-<started>-<pid>.jsonl, state/distilling-sessions-<started>-<pid>.jsonl): the
// local page shows it as a progress bar, and can stop it. A batch is live while its file has no
// finish record and the process that writes it is still alive.
import fs from 'node:fs';
import path from 'node:path';

const KINDS = { 'pr-mining': 'mining', 'distilling-sessions': 'distilling' };
const FILE = /^(pr-mining|distilling-sessions)-(\d+)-(\d+)\.jsonl$/;

export const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function readBatch(file) {
  let lines = []; try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return null; }
  const recs = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const head = recs.find(r => r.event === 'batch'); if (!head) return null;
  const b = { name: head.name, total: head.total || 0, completed: 0, saved: 0, failed: 0, current: '', done: false, cancelled: false };
  for (const r of recs) {
    if (r.event === 'start') b.current = r.item || '';
    else if (r.event === 'complete') { b.completed++; b.saved += (r.notes || []).length; if (r.error) b.failed++; if (r.item === b.current) b.current = ''; }
    else if (r.event === 'finish') { b.done = true; b.ended = r.time || null; }
    else if (r.event === 'cancelled') { b.done = true; b.cancelled = true; b.ended = r.time || null; }
  }
  return b;
}

// Seconds a batch has left at its pace so far (the time per item, times the items left), or null
// before its first item is done.
export function batchEta(b, startedMs, now = Date.now()) {
  if (!b.total || !b.completed || b.completed >= b.total) return b.total && b.completed >= b.total ? 0 : null;
  return Math.round((now - startedMs) / 1000 / b.completed * (b.total - b.completed));
}

// The newest batch of one kind started at or after `sinceMs`, finished or not, with when it started
// and ended: a build's stage is read from its mining batch (ui/server.js:jobProgress).
export function latestBatch(storeDir, kind, sinceMs = 0) {
  const dir = path.join(storeDir, 'state');
  let names = []; try { names = fs.readdirSync(dir); } catch { return null; }
  const files = names.map(n => ({ n, m: FILE.exec(n) })).filter(x => x.m && x.m[1] === kind && Number(x.m[2]) >= sinceMs).sort((a, b) => Number(b.m[2]) - Number(a.m[2]));
  for (const { n, m } of files) { const b = readBatch(path.join(dir, n)); if (b) return { ...b, pid: Number(m[3]), startedMs: Number(m[2]) }; }
  return null;
}

// The live batch of a cache, newest first, or null. `storeDir` is the cache's .thinker directory.
export function activity(storeDir) {
  const dir = path.join(storeDir, 'state');
  let names = []; try { names = fs.readdirSync(dir); } catch { return null; }
  const files = names.map(n => ({ n, m: FILE.exec(n) })).filter(x => x.m).sort((a, b) => Number(b.m[2]) - Number(a.m[2]));
  for (const { n, m } of files) {
    const pid = Number(m[3]);
    const b = readBatch(path.join(dir, n));
    if (!b || b.done) continue;
    if (!alive(pid)) continue;
    return {
      kind: KINDS[m[1]], pid, started: new Date(Number(m[2])).toISOString(), file: path.join(dir, n),
      total: b.total, completed: b.completed, saved: b.saved, failed: b.failed, current: b.current,
      etaSeconds: batchEta(b, Number(m[2])),
      // "mining 3/20 PRs", "distilling 1/4 sessions"
      status: `${KINDS[m[1]]} ${b.completed}/${b.total} ${m[1] === 'pr-mining' ? 'PRs' : 'sessions'}`,
    };
  }
  return null;
}

// Stop a live batch: the process group it leads (a detached build or catch-up run) or, failing that,
// the process itself. Its file is closed with a `cancelled` record so the page stops showing it at
// once. Only a pid the cache's own live batch names is ever signalled.
export function cancelActivity(storeDir, pid) {
  const a = activity(storeDir);
  if (!a || a.pid !== Number(pid)) return { error: 'nothing is running with that pid' };
  let signalled = false;
  try { process.kill(-a.pid, 'SIGTERM'); signalled = true; } catch {}
  if (!signalled) { try { process.kill(a.pid, 'SIGTERM'); signalled = true; } catch (e) { return { error: `could not stop it: ${e.message}` }; } }
  try { fs.appendFileSync(a.file, JSON.stringify({ time: new Date().toISOString(), event: 'cancelled' }) + '\n'); } catch {}
  return { ok: true, kind: a.kind, completed: a.completed, total: a.total };
}
