import os from 'node:os';
import { thinkerHome } from './update.js';
import { claudePaths } from './harness.js';
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
import { findRepoSessions } from './instruction-value.js';
import { sourceStamp, canKeep, contextWindow } from './view-sources.js';

export const SNAPSHOT_DAYS = [7, 30];
export const REFRESH_MS = 10 * 60_000;
const LOCK_MS = 5 * 60_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// the readers behind the report: a snapshot made by other code is not this code's report
let codeKey;
const code = () => codeKey ||= crypto.createHash('sha256').update(['context-view.js', 'instruction-value.js', 'instruction-sections.js', 'harness.js', 'harness-codex.js', 'tool-outputs.js', 'diet.js', 'context-suggest.js', 'scoped-state.js']
  .map(f => { try { return fs.readFileSync(path.join(HERE, f), 'utf8'); } catch { return f; } }).join('\0')).digest('hex').slice(0, 16);
// where the report's switches and sections come from, by content (a directory by its size and mtime): the config is
// the repository's (store.dir, shared by its worktrees), the rest the checkout's, so a worktree with the same files
// reads the repository's report and one whose instruction file differs has it made again
const INPUTS = ['.thinker/config.json', '.claude/settings.json', '.claude/settings.local.json', 'AGENTS.md', 'CLAUDE.md'];
// Of a Claude Code settings file only the fields the report reads count (harness.js:claudeHarness: the denied tools and
// servers, the plugins switched, the skill overrides). The whole file was hashed until 2026-11-08, and Claude Code and
// thinker's own rewire write other fields of `~/.claude/settings.json` (hooks, env), so every release dropped every
// repository's kept report and the page read every session again on its next visit.
const SETTINGS = new Set(['.claude/settings.json', '.claude/settings.local.json', claudePaths().settings]);
const settingsKey = p => { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return JSON.stringify({ deny: j.permissions?.deny ?? null, servers: j.disabledMcpjsonServers ?? null, plugins: j.enabledPlugins ?? null, skills: j.skillOverrides ?? null }); };
const digest = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const inputs = store => [...INPUTS, claudePaths().settings, path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), path.join(thinkerHome(), 'state', 'machine-actions', 'harness.json')].map(f => {
  const p = path.isAbsolute(f) ? f : f.startsWith('.thinker/') ? path.join(store.dir, f.slice('.thinker/'.length)) : path.join(store.repo, f);
  try { const s = fs.statSync(p); return s.isDirectory() ? `${f}\t${s.size}\t${Math.round(s.mtimeMs)}` : `${f}\t${digest(SETTINGS.has(f) ? settingsKey(p) : fs.readFileSync(p))}`; } catch { return `${f}\t-`; }
}).join('\n');

// One report per repository: a linked worktree keeps its cache in the main checkout's .thinker (store.dir), and the
// sessions behind the report are gathered over every checkout of the repository (instruction-value.js:
// findRepoSessions), so every checkout reads and refreshes the same file. Until 2026-10-24 each worktree kept a
// file of its own, the same figures worked out again (the owner's decision: worktrees are not a dimension).
const file = (store, days) => path.join(store.dir, 'state', `context-view-${days}.json`);
const lockFile = store => path.join(store.dir, 'state', 'context-view.lock');

// { at, view } when a snapshot of this window holds for the code and files as they are; else null
export function readSnapshot(store, days) {
  try {
    const s = JSON.parse(fs.readFileSync(file(store, days), 'utf8'));
    return s.code === code() && s.inputs === inputs(store) && s.view ? { at: s.at, view: s.view } : null;
  } catch { return null; }
}

// The window's sessions and the stamp of what the report rests on besides the switches `inputs` already watches
// (view-sources.js): the sessions themselves and the machine's log, which the skills' outcome checks are read from.
export function contextSources(store, days) {
  const sessions = findRepoSessions(store.repo, days);
  return { sessions, stamp: sourceStamp(store, { sessions, window: contextWindow(days) }) };
}

// { at, view, current } of the last snapshot kept, whether or not it still holds: what the Context tab's rows and History read, so a
// click there does not wait for every transcript to be read again (the person's decisions take the changes they
// settled out of it: context-suggest.js:currentChanges)
export function lastSnapshot(store, days) {
  // `mine`: this code made it and its inputs hold, so ui/scans.js reads only the sessions changed since it
  try { const s = JSON.parse(fs.readFileSync(file(store, days), 'utf8')); const current = Boolean(readSnapshot(store, days)); return s.view ? { at: s.at, view: s.view, stamp: s.stamp || null, current, mine: current } : null; } catch { return null; }
}

export function writeSnapshot(store, days, view, { now = Date.now(), stamp = null } = {}) {
  const f = file(store, days), tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ at: now, days, code: code(), inputs: inputs(store), ...(stamp ? { stamp } : {}), view }));
    fs.renameSync(tmp, f);
    pruneSnapshots(path.dirname(f));
  } catch { try { fs.rmSync(tmp, { force: true }); } catch {} }
  return { at: now, view };
}

// The reports of windows the tab no longer offers, and the per-worktree files of before 2026-10-24
// (`context-view-<days>-<hash>.json`): half a megabyte each, never read, kept for a month on this machine (eleven of them).
const LIVE = new Set(SNAPSHOT_DAYS.map(d => `context-view-${d}.json`));
export function pruneSnapshots(dir) {
  let removed = 0;
  try { for (const n of fs.readdirSync(dir)) if (/^context-view-\d+(-[0-9a-f]+)?\.json$/.test(n) && !LIVE.has(n)) { try { fs.rmSync(path.join(dir, n), { force: true }); removed++; } catch {} } } catch {}
  return removed;
}

// The report of one window: the snapshot when there is one, else made now and kept. `stale` says it is older
// than REFRESH_MS, for the caller to have it made again in the background.
export function snapshotView(store, days, { now = Date.now() } = {}) {
  const s = readSnapshot(store, days);
  if (s) return { ...s, stale: now - s.at > REFRESH_MS };
  const { sessions, stamp } = contextSources(store, days);
  return { ...writeSnapshot(store, days, contextView(store, { days, sessions }), { now, stamp }), stale: false };
}

// `thinker context --refresh`: every window the tab offers, made again; one run at a time per checkout.
// A window whose sessions and records have not moved since the snapshot kept here (view-sources.js) keeps it as it
// is, with only when it was looked at written again: no transcript's record is read and nothing is added up. Until
// 2026-11-10 every refresh worked every window out again from every session's records, every ten minutes, in every
// repository the page lists.
export function refreshSnapshots(store, { days = SNAPSHOT_DAYS, now = Date.now() } = {}) {
  const lock = lockFile(store);
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch {}
  try { if (now - fs.statSync(lock).mtimeMs < LOCK_MS) return { skipped: 'locked' }; fs.rmSync(lock, { force: true }); } catch {}
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); } catch { return { skipped: 'locked' }; }
  try {
    const written = [], kept = [];
    for (const d of days) {
      const last = lastSnapshot(store, d), { sessions, stamp } = contextSources(store, d);
      if (canKeep(last, stamp, { now })) { writeSnapshot(store, d, last.view, { now, stamp }); kept.push(d); continue; }
      writeSnapshot(store, d, contextView(store, { days: d, sessions }), { now, stamp }); written.push(d);
    }
    return { written, kept };
  }
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
