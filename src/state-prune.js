// The per-session files a cache's state directory gathers, removed once nobody will read them again. Nothing
// removed them: on this repository 775 files by 2026-10-17, 209 of them finished distill batches. Maintenance
// runs this (maintain.js). What goes, by file name:
// - batch detail files (activity.js: pr-mining-*, distilling-sessions-*): finished or their writer gone, after
//   a day; the newest of each kind always stays (a warm-up's stage is read from it: ui/server.js:jobProgress)
// - a session's own state (session-<id>.json and .lock: holdout turns, late notes; trace-<id>.jsonl: its
//   recorded trace; oriented-<turn>; <id>.json and rollout-*.json: how far its transcript was distilled),
//   untouched for a month: catch-up learning looks two days back, and a session resumed after a month is
//   distilled from its start again, which costs one distill and loses nothing
import fs from 'node:fs';
import path from 'node:path';
import { alive } from './activity.js';

const DAY = 86400_000;
const BATCH = /^(pr-mining|distilling-sessions)-\d+-(\d+)\.jsonl$/;
const SESSION = /^(session-.+\.(json|lock)|trace-.+\.jsonl|oriented-.+|rollout-.+\.json|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$/;
export const PRUNE_DAYS = { batch: 1, session: 30 };

const finished = file => { try { return /"event":"(finish|cancelled)"/.test(fs.readFileSync(file, 'utf8')); } catch { return true; } };

export function pruneState(storeDir, { now = Date.now(), days = PRUNE_DAYS, dry = false } = {}) {
  const dir = path.join(storeDir, 'state');
  let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
  // the newest batch of each kind stays, whatever its age: a warm-up's stage is read from it
  const newest = {};
  for (const n of names) { const m = /^(pr-mining|distilling-sessions)-(\d+)-/.exec(n); if (m && !(Number(newest[m[1]]?.[1]) >= Number(m[2]))) newest[m[1]] = [n, m[2]]; }
  const keep = new Set(Object.values(newest).map(x => x[0]));
  const gone = [];
  for (const n of names) {
    if (keep.has(n)) continue;
    const f = path.join(dir, n);
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    const age = now - st.mtimeMs, b = BATCH.exec(n);
    const old = b ? age > days.batch * DAY && (finished(f) || !alive(Number(b[2]))) : SESSION.test(n) && age > days.session * DAY;
    if (!old) continue;
    if (!dry) fs.rmSync(f, { force: true });
    gone.push(n);
  }
  return gone;
}
