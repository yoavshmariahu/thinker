import { isTestMode } from './test-mode.js';
// A repository's cache directory: .thinker/ (config, state, this checkout's local data under .thinker/local/,
// which is where the session profile lives) and the machine's log. The note store that lived here went with the
// knowledge notes on 2026-11-08; what a checkout holds now is the profile's ledger and state files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';


export function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export const isGitCheckout = repo => fs.existsSync(path.join(repo, '.git'));

// The machine-local pieces of a fresh cache in the checkout's own exclude file (.git/info/exclude,
// which is not committed), unless git ignores .thinker already: the config, the state and the log.
// A repository may still commit `.thinker/notes/` from the days of the shared note cache, and an excluded path
// cannot be added. The local directory ignores itself. Nothing when this is not a git checkout.
export const EXCLUDED = ['.thinker/config.json', '.thinker/.gitignore', '.thinker/state/', '.thinker/log.jsonl', '.thinker/benchmarks/'];
export function excludeFromGit(repo, excluded = EXCLUDED) {
  if (!isGitCheckout(repo)) return false;
  try {
    const r = spawnSync('git', ['check-ignore', '-q', excluded === EXCLUDED ? '.thinker' : excluded[0]], { cwd: repo, stdio: 'ignore' });
    if (r.status === 0) return false;
    const file = path.resolve(repo, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
    const had = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const lines = new Set(had.split('\n').map(l => l.trim()));
    const missing = excluded.filter(l => !lines.has(l) && (excluded !== EXCLUDED || (!lines.has('.thinker/') && !lines.has('.thinker'))));
    if (!missing.length) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, had + (had && !had.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
    return true;
  } catch { return false; }
}

// The path of a git hook for this checkout; null when this is not a git checkout.
// Worktrees keep hooks with the main repository, where `.git` is a file, not a directory.
export function gitHookPath(repo, name) {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return path.resolve(repo, dir, name);
  } catch { return null; }
}

export function gitHead(repo) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

// Which repository a checkout is: its origin as .git/config names it, so that worktrees and
// further clones of a repository count as that repository. Without an origin, the path.
//   git@github.com:Owner/Repo.git, https://github.com/Owner/Repo → github.com/owner/repo
export function normalizeOrigin(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  const scp = u.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);        // user@host:path
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+\//, '$1/');
  return u.replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}
function gitConfigFile(repo) {
  const dot = path.join(repo, '.git');
  const st = fs.statSync(dot);
  if (st.isDirectory()) return path.join(dot, 'config');
  // a linked worktree or submodule: .git is a file naming the git directory, whose commondir holds the config
  const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m); if (!m) return null;
  const gitDir = path.resolve(repo, m[1].trim());
  let common = gitDir; try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch {}
  return path.join(common, 'config');
}
const ids = new Map();
export function repoId(repo) {
  if (ids.has(repo)) return ids.get(repo);
  let id = '';
  try {
    let section = '';
    for (const line of fs.readFileSync(gitConfigFile(repo), 'utf8').split('\n')) {
      const h = line.match(/^\s*\[\s*([^\]]+?)\s*\]/);
      if (h) { section = h[1].replace(/\s+/g, ' '); continue; }
      const kv = section === 'remote "origin"' && line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (kv) { id = normalizeOrigin(kv[1].replace(/^"(.*)"$/, '$1')); break; }
    }
  } catch {}
  id = id || repo;
  ids.set(repo, id);
  return id;
}

// Usage history is kept in one file for the machine, THINKER_HOME/log.jsonl (default
// ~/.thinker), each line naming the repository it is about (`origin`, see repoId)
// and the checkout it came from (`repo`). THINKER_LOG changes that:
// a path, `local` (the repository's own .thinker/log.jsonl) or `off`. Checkouts made under the system temporary directory while THINKER_HOME
// is unset: the test suite makes hundreds of them, and they are not usage — counting their
// fixture costs as money spent made `thinker usage` lie by several dollars. A test that
// means to exercise the machine's log points THINKER_HOME at a directory of its own, and
// then logs there as before.
export function logFile(store) {
  const v = process.env.THINKER_LOG;
  if (v === 'off') return null;
  const scratch = !process.env.THINKER_HOME && (isTestMode() || isScratchCheckout(store.repo));
  if (v === 'local' || (!v && scratch)) return path.join(store.dir, 'log.jsonl');
  if (v) return path.resolve(v);
  return path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'log.jsonl');
}

// A checkout under the system temporary directory is scratch: a test fixture or a throwaway.
export function isScratchCheckout(repo) {
  try {
    const tmp = fs.realpathSync(os.tmpdir());
    const real = fs.realpathSync(repo);
    const rel = path.relative(tmp, real);
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

// What a repository logged locally before the log was shared is moved into the machine's
// log, once: the local file is renamed first, so two processes cannot both move it. It is
// kept under state/, which every checkout already keeps out of commits.
export function adoptLocalLog(store) {
  const main = logFile(store), local = path.join(store.dir, 'log.jsonl');
  // only into the machine's own log, not one that THINKER_LOG names
  if (process.env.THINKER_LOG || !main || main === local || !fs.existsSync(local)) return;
  const moved = path.join(store.dir, 'state', 'log-before-shared.jsonl');
  try { fs.mkdirSync(path.dirname(moved), { recursive: true }); fs.renameSync(local, moved); } catch { return; }
  try {
    const lines = fs.readFileSync(moved, 'utf8').split('\n').filter(Boolean).map(l => { try { const e = JSON.parse(l); return JSON.stringify(e.repo ? e : { t: e.t, repo: store.repo, origin: repoId(store.repo), ...e }); } catch { return null; } }).filter(Boolean);
    fs.mkdirSync(path.dirname(main), { recursive: true });
    if (lines.length) fs.appendFileSync(main, lines.join('\n') + '\n');
  } catch { try { fs.renameSync(moved, local); } catch {} }
}

// The checkout whose cache a linked worktree uses: the main checkout of the same repository, so a session in a
// worktree (Claude Desktop starts many) reads the profile the repository has, and its sessions feed it. Until
// 2026-10-18 each worktree had a cache of its own. Code is still read from the worktree (Store.repo); only the
// cache moves. A worktree keeps a cache of its own when the main checkout has none to share (a benchmark's base
// clone, whose worktrees must see nothing) or when a `.thinker/local/isolated` file says so (an experiment build
// kept apart). A submodule (no commondir) is its own repository.
const homes = new Map();
export function cacheCheckout(repo) {
  if (homes.has(repo)) return homes.get(repo);
  let home = repo;
  try {
    const dot = path.join(repo, '.git');
    if (fs.statSync(dot).isFile()) {
      const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m);
      const gitDir = m && path.resolve(repo, m[1].trim());
      const common = gitDir && path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
      const main = common && path.basename(common) === '.git' ? path.dirname(common) : null;
      if (main && path.resolve(main) !== path.resolve(repo) && !fs.existsSync(path.join(repo, '.thinker', 'local', 'isolated')) && fs.existsSync(path.join(main, '.thinker', 'local'))) home = main;
    }
  } catch {}
  homes.set(repo, home);
  return home;
}

export class Store {
  // readonly: for looking at another checkout (usage, telemetry); it is never initialized from here.
  constructor(repo, { readonly = false } = {}) {
    this.repo = repo;
    // the checkout that holds the cache: this one, or the main checkout of a linked worktree (cacheCheckout)
    this.home = cacheCheckout(repo);
    this.dir = path.join(this.home, '.thinker');
    this.readonly = readonly;
    this.localDir = path.join(this.dir, 'local');
  }
  // A symlinked .thinker directory is refused: the hooks write into it on every prompt.
  assertSafeNotesPath() {
    try { if (fs.lstatSync(this.dir).isSymbolicLink()) throw new Error('refusing to use a symlinked .thinker directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    try { if (fs.lstatSync(this.localDir).isSymbolicLink()) throw new Error('refusing to use a symlinked .thinker/local directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  init() {
    if (this.readonly) throw new Error('readonly store');
    this.assertSafeNotesPath();
    const fresh = !fs.existsSync(this.dir);
    fs.mkdirSync(this.localDir, { recursive: true });
    // the local directory ignores itself, so nothing in the repository's own .gitignore has to change
    const ignore = path.join(this.localDir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    const cfg = path.join(this.dir, 'config.json');
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ version: 1 }, null, 2) + '\n');
    // a cache made in a checkout that had none stays out of `git status`: thinker starts one in
    // every git repository it runs in, and that must not dirty the repository
    if (fresh) excludeFromGit(this.home);
    return this;
  }
  config() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'config.json'), 'utf8')); } catch { return {}; }
  }
  exists() { return fs.existsSync(this.dir); }
  // Append-only usage log for the machine (see logFile); one line per event, so
  // sessions in different repositories can append at the same time.
  log(event) {
    try {
      const f = logFile(this); if (!f) return;
      adoptLocalLog(this);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), repo: this.repo, origin: repoId(this.repo), ...event }) + '\n');
    } catch { /* ignore */ }
  }
}
