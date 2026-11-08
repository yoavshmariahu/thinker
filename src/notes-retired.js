// The knowledge notes went on 2026-11-08 (the owner's call: the session profile, profile.js, replaces them). What a
// checkout kept of them under .thinker/ is deleted here, once per checkout, when `thinker rewire` (an update) or
// the prompt hook's wiring check first runs the new version there: this checkout's own notes and their state,
// never a committed `.thinker/notes/` directory, which is the repository's file to remove. Logged as counts.
import fs from 'node:fs';
import path from 'node:path';

export const RETIRED_VERSION = 1;
const LOCAL = ['notes', 'shared', 'quarantine', 'layout', 'behavior-docs.json', 'share-notice.json', 'migration-backup', 'migrating', 'dedupe.json'];
const TOP = ['SYSTEM.md', 'verification.json'];
const STATE = ['symbols', 'dedupe.json', 'learning-pending', 'stale-reset.json'];

export function retireNotes(store, { dry = false } = {}) {
  const marker = path.join(store.dir, 'state', 'notes-retired.json');
  try { if (JSON.parse(fs.readFileSync(marker, 'utf8')).version >= RETIRED_VERSION) return null; } catch {}
  const removed = [];
  let files = 0;
  const count = p => { try { const st = fs.statSync(p); if (!st.isDirectory()) return 1; let n = 0; for (const f of fs.readdirSync(p)) n += count(path.join(p, f)); return n; } catch { return 0; } };
  const rm = p => { if (!fs.existsSync(p)) return; files += count(p); removed.push(path.relative(store.dir, p)); if (!dry) fs.rmSync(p, { recursive: true, force: true }); };
  for (const f of LOCAL) rm(path.join(store.localDir, f));
  for (const f of TOP) rm(path.join(store.dir, f));
  for (const f of STATE) rm(path.join(store.dir, 'state', f));
  if (dry) return { removed, files };
  try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ version: RETIRED_VERSION, at: new Date().toISOString(), removed, files })); } catch {}
  if (removed.length) store.log({ op: 'notes-retired', removed: removed.length, files });
  return { removed, files };
}
