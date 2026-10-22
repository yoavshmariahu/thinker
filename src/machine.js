// The git repositories on this machine, for the local page: the ones the coding agents have
// worked in lately (their transcripts name the working directory) and the ones thinker's log
// names. Nothing is read from the repositories but their git metadata and their caches, so the cache
// page can show what each cache holds.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, findRepoRoot, repoId, isScratchCheckout, isGitCheckout } from './store.js';
import { readLog } from './usage.js';
import { isBehavior } from './behavior.js';
import { activity } from './activity.js';
import { isTestMode } from './test-mode.js';
import { isDisabledRepo } from './repo-switch.js';

const ls = d => { try { return fs.readdirSync(d); } catch { return []; } };
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
// the working directory a transcript records, from its first bytes
function cwdOf(file) {
  try {
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(16384); const n = fs.readSync(fd, buf, 0, 16384, 0); fs.closeSync(fd);
    return (buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/) || [])[1]?.replace(/\\(.)/g, '$1') || null;
  } catch { return null; }
}

// Where the agents worked these 30 days: a path per transcript, with the transcript's time.
export function agentWorkDirs({ home = os.homedir(), sinceMs = 30 * 86400_000, now = Date.now() } = {}) {
  const out = [], cutoff = now - sinceMs;
  const add = (dir, t) => { if (dir && t >= cutoff) out.push({ dir, t }); };
  const claude = path.join(home, '.claude', 'projects');
  for (const d of ls(claude)) {
    const files = ls(path.join(claude, d)).filter(f => f.endsWith('.jsonl')).map(f => path.join(claude, d, f)).map(f => ({ f, t: mtime(f) })).sort((a, b) => b.t - a.t);
    for (const { f, t } of files.slice(0, 12)) add(cwdOf(f), t);
  }
  const cursor = path.join(home, '.cursor', 'projects');
  for (const d of ls(cursor)) {
    let ws = null; try { ws = JSON.parse(fs.readFileSync(path.join(cursor, d, '.workspace-trusted'), 'utf8')).workspacePath; } catch {}
    if (!ws) continue;
    for (const id of ls(path.join(cursor, d, 'agent-transcripts'))) add(ws, mtime(path.join(cursor, d, 'agent-transcripts', id, id + '.jsonl')));
  }
  const codex = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
  for (let d = 0; d * 86400_000 <= sinceMs; d++) {
    const t = new Date(now - d * 86400_000);
    const dir = path.join(codex, String(t.getFullYear()), String(t.getMonth() + 1).padStart(2, '0'), String(t.getDate()).padStart(2, '0'));
    for (const f of ls(dir)) if (f.endsWith('.jsonl')) add(cwdOf(path.join(dir, f)), mtime(path.join(dir, f)));
  }
  return out;
}

// Which checkouts to show: a git checkout that is not scratch (under a temporary directory: a test's
// fixture or an agent's scratchpad, unless the test suite itself is asking) and not the home directory.
const TMP = [os.tmpdir(), '/tmp', '/private/tmp'].map(d => { try { return fs.realpathSync(d); } catch { return d; } });
function checkoutOf(p) {
  try {
    const real = fs.realpathSync(p);
    const root = findRepoRoot(real);
    const scratch = isScratchCheckout(root) || TMP.some(t => root.startsWith(t + path.sep));
    if (!isGitCheckout(root) || (scratch && !isTestMode()) || root === fs.realpathSync(os.homedir())) return null;
    return root;
  } catch { return null; }
}

// The directories a build can be narrowed to: every tracked directory up to three levels deep, hidden
// ones and dependency folders left out, for the page's search box.
const DIR_SKIP = /(^|\/)(node_modules|vendor|dist|build|target|__pycache__|\.[^/]+)(\/|$)/;
export function topDirs(checkout, { depth = 3, limit = 4000 } = {}) {
  try {
    return execFileSync('git', ['ls-tree', '-r', '-d', '--name-only', 'HEAD'], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(d => d && d.split('/').length <= depth && !DIR_SKIP.test(d)).slice(0, limit);
  } catch { return []; }
}

// The repository as people name it: owner/name from its origin, else the checkout's folder.
export const displayName = (id, checkout) => /^[^/]+\.[a-z]+\/[^/]/.test(id) ? String(id).replace(/^[^/]+\.[a-z]+\//, '') : path.basename(checkout);

// Every repository the machine knows: from the agents' transcripts and thinker's log, one entry per
// repository (its clones and worktrees share one history, so they are one line: `checkout` is the
// main checkout, or the latest used, and `checkouts` all of them), newest use first. `store` is any
// store, for reading the machine's log. `hasCache` says the repository's cache holds notes (`notes`
// how many, over its checkouts); a .thinker folder alone says nothing, since every checkout an agent
// has worked in gets one.
export function discoverRepos(store, { home, sinceMs, now = Date.now() } = {}) {
  const by = new Map();
  const touch = (checkout, t, sessions) => {
    if (!by.has(checkout)) by.set(checkout, { checkout, lastUsed: 0, sessions: 0 });
    const r = by.get(checkout);
    r.lastUsed = Math.max(r.lastUsed, t || 0); r.sessions += sessions;
  };
  // the log names a few hundred paths over tens of thousands of lines: each is resolved once
  const seen = new Map(), checkout = p => { if (!seen.has(p)) seen.set(p, checkoutOf(p)); return seen.get(p); };
  for (const { dir, t } of agentWorkDirs({ home, sinceMs, now })) { const c = checkout(dir); if (c) touch(c, t, 1); }
  let events = []; try { events = readLog(store, { all: true }); } catch {}
  for (const e of events) { if (!e.repo || !path.isAbsolute(e.repo)) continue; const c = checkout(e.repo); if (c) touch(c, Date.parse(e.t) || 0, 0); }
  const here = checkoutOf(store.repo); if (here) touch(here, 0, 0);
  const groups = new Map();
  for (const r of by.values()) { const id = repoId(r.checkout); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(r); }
  return [...groups].map(([id, cs]) => repoRecord(id, cs, here)).sort((a, b) => (Date.parse(b.lastUsed) || 0) - (Date.parse(a.lastUsed) || 0));
}

// One repository's line from its checkouts ({ checkout, lastUsed, sessions } each).
function repoRecord(id, cs, here) {
  // a worktree's .git is a file: the main checkout comes first, then the latest used
  const main = c => { try { return fs.statSync(path.join(c.checkout, '.git')).isDirectory() ? 1 : 0; } catch { return 0; } };
  cs.sort((a, b) => main(b) - main(a) || b.lastUsed - a.lastUsed);
  const lastUsed = Math.max(...cs.map(c => c.lastUsed));
  // a cache exists when it holds notes: every checkout an agent worked in has a .thinker folder, most of them empty
  const notes = cs.reduce((a, c) => a + (cacheStats(c.checkout)?.notes || 0), 0);
  return {
    id, checkout: cs[0].checkout, checkouts: cs.map(c => c.checkout), name: displayName(id, cs[0].checkout),
    lastUsed: lastUsed ? new Date(lastUsed).toISOString() : null, sessions: cs.reduce((a, c) => a + c.sessions, 0),
    current: cs.some(c => c.checkout === here), notes, hasCache: notes > 0,
    // switched off machine-wide (repo-switch.js)
    disabled: isDisabledRepo(cs[0].checkout),
  };
}

// What a cache holds, for the cache page's repository cards.
export function cacheStats(checkout) {
  if (!fs.existsSync(path.join(checkout, '.thinker'))) return null;
  let notes = []; try { notes = new Store(checkout, { readonly: true }).list(); } catch { return null; }
  const live = notes.filter(n => n.status !== 'invalid' && !n.archived);
  const plain = live.filter(n => !isBehavior(n));
  const lastUsed = notes.map(n => n.lastUsed).filter(Boolean).sort().pop() || null;
  return {
    notes: plain.length, fresh: plain.filter(n => n.status !== 'stale').length, stale: plain.filter(n => n.status === 'stale').length,
    archived: notes.filter(n => n.archived && !isBehavior(n)).length, behaviors: live.filter(isBehavior).length,
    hits: notes.reduce((a, n) => a + (n.uses || 0), 0), lastUsed,
    activity: activity(path.join(checkout, '.thinker')),
  };
}
