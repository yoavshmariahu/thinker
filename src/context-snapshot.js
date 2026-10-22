// The Context tab's report, worked out ahead of time. contextView reads every transcript of the window: a second
// or four a repository on this machine, about fifteen for All repositories, on every visit to the tab. So the
// report is kept in the checkout's state (`.thinker/state/context-view-<days>.json`) and the page reads that:
// `thinker context --refresh` writes it (for the windows the tab offers), so does `thinker context` itself and the
// maintenance run, and the page starts that command in the background when what it read is older than REFRESH_MS.
// A snapshot is not read when the code that made it or the files its switches live in changed since: the
// config, Claude's settings, the instruction files (a change made from the tab or by hand shows at once).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contextView } from './context-view.js';

export const SNAPSHOT_DAYS = [7, 30];
export const REFRESH_MS = 10 * 60_000;
const LOCK_MS = 5 * 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// the readers behind the report: a snapshot made by other code is not this code's report
let codeKey;
const code = () => codeKey ||= crypto.createHash('sha256').update(['context-view.js', 'instruction-value.js', 'instruction-sections.js', 'harness.js', 'harness-codex.js', 'tool-outputs.js', 'diet.js', 'instructions-core.js']
  .map(f => { try { return fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { return f; } }).join('\0')).digest('hex').slice(0, 16);
// where the report's switches and sections come from, by size and mtime
const INPUTS = ['.thinker/config.json', '.claude/settings.json', '.claude/settings.local.json', 'AGENTS.md', 'CLAUDE.md', 'AGENTS.override.md', 'CLAUDE.local.md', '.cursor/rules'];
const inputs = store => INPUTS.map(f => { try { const s = fs.statSync(path.join(store.repo, f)); return `${f}\t${s.size}\t${Math.round(s.mtimeMs)}`; } catch { return `${f}\t-`; } }).join('\n');

// a linked worktree keeps its cache in the main checkout's .thinker but has sessions of its own: named apart
const tag = store => store.repo === store.home ? '' : `-${crypto.createHash('sha256').update(store.repo).digest('hex').slice(0, 8)}`;
const file = (store, days) => path.join(store.dir, 'state', `context-view-${days}${tag(store)}.json`);
const lockFile = store => path.join(store.dir, 'state', `context-view${tag(store)}.lock`);

// { at, view } when a snapshot of this window holds for the code and files as they are; else null
export function readSnapshot(store, days) {
  try {
    const s = JSON.parse(fs.readFileSync(file(store, days), 'utf8'));
    return s.code === code() && s.inputs === inputs(store) && s.view ? { at: s.at, view: s.view } : null;
  } catch { return null; }
}

export function writeSnapshot(store, days, view, { now = Date.now() } = {}) {
  const f = file(store, days), tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ at: now, days, code: code(), inputs: inputs(store), view }));
    fs.renameSync(tmp, f);
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
  return { at: now, view };
}

// The report of one window: the snapshot when there is one, else made now and kept. `stale` says it is older
// than REFRESH_MS, for the caller to have it made again in the background.
export function snapshotView(store, days, { now = Date.now() } = {}) {
  const s = readSnapshot(store, days);
  if (s) return { ...s, stale: now - s.at > REFRESH_MS };
  return { ...writeSnapshot(store, days, contextView(store, { days }), { now }), stale: false };
}

// `thinker context --refresh`: every window the tab offers, made again; one run at a time per checkout
export function refreshSnapshots(store, { days = SNAPSHOT_DAYS, now = Date.now() } = {}) {
  const lock = lockFile(store);
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch {}
  try { if (now - fs.statSync(lock).mtimeMs < LOCK_MS) return { skipped: 'locked' }; fs.rmSync(lock, { force: true }); } catch {}
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch { return { skipped: 'locked' }; }
  try { return { written: days.map(d => { writeSnapshot(store, d, contextView(store, { days: d }), { now }); return d; }) }; }
  finally { fs.rmSync(lock, { force: true }); }
}

// whether a refresh is running in this checkout (the page says so and checks back)
export function refreshing(store, { now = Date.now() } = {}) {
  try { return now - fs.statSync(lockFile(store)).mtimeMs < LOCK_MS; } catch { return false; }
}

// after an action from the tab: the next read makes the report again
export function dropSnapshots(store) {
  for (const d of SNAPSHOT_DAYS) { try { fs.rmSync(file(store, d), { force: true }); } catch {} }
}
