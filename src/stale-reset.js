// Compatibility for the old one-time staleness reset. Ordinary edits now become pending
// through refresh, without rebaselining. Keep old reset markers and undo support readable.
import fs from 'node:fs';
import path from 'node:path';
import { refresh } from './ops.js';

// Bump to run a fresh reset on every repository; a repository already at this version is skipped.
export const RESET_VERSION = 1;
export const markerFile = store => path.join(store.dir, 'state', 'stale-reset.json');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// Rewire still calls this entry point. It refreshes statuses once but never erases the last
// verified hashes. Earlier marker files are retained, including their undo snapshots.
export function resetStaleMarks(store, { dry = false, now = () => new Date().toISOString() } = {}) {
  if (!store.exists()) return null;
  const file = markerFile(store);
  const done = readJson(file);
  if (done && Number(done.version) >= RESET_VERSION) return null;
  const live = store.list().filter(n => !['invalid', 'violated', 'broken'].includes(n.status));
  refresh(store, live, { persist: !dry });
  if (!dry) writeMarker(file, { at: now(), cleared: [], before: [] });
  return null;
}

function writeMarker(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: RESET_VERSION, ...body }));
}

// Put back what the reset waved through, from the marker file it wrote. A note a session has since
// corrected, rewritten or retired is left as it is: the reset is not worth undoing over a note the
// cache has already moved past.
export function undoStaleReset(store, { dry = false } = {}) {
  const done = readJson(markerFile(store));
  if (!done?.before?.length) return null;
  const restored = [], left = [];
  for (const p of done.before) {
    const n = store.get(p.id);
    if (!n || n.status !== 'fresh' || !n.rebaselined) { left.push(p.id); continue; }
    if (dry) { restored.push(p.id); continue; }
    const next = { ...n, status: p.status, deps: p.deps, verifiedCommit: p.verifiedCommit };
    if (p.stale) next.stale = p.stale; else delete next.stale;
    delete next.rebaselined;
    store.put(next);
    restored.push(p.id);
  }
  if (!dry && restored.length) store.log({ op: 'stale-reset-undo', restored: restored.length, left: left.length });
  return { restored, left };
}
