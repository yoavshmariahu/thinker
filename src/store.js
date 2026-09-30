// Note store: one JSON file per note under <repo>/.thinker/notes/.
// Notes are plain files so a team can commit them and share via git.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const KINDS = ['location', 'callpath', 'cochange', 'howto', 'convention', 'rationale', 'gotcha', 'overview', 'invariant', 'fix'];

export function findRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
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
// a path, `local` (the repository's own .thinker/log.jsonl) or `off`. Runs that serve
// notes from elsewhere (THINKER_NOTES_DIR: benchmark arms) log locally unless told
// otherwise, so experiments stay out of the machine's history.
export function logFile(store) {
  const v = process.env.THINKER_LOG;
  if (v === 'off') return null;
  if (v === 'local' || (!v && process.env.THINKER_NOTES_DIR)) return path.join(store.dir, 'log.jsonl');
  if (v) return path.resolve(v);
  return path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'log.jsonl');
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

export class Store {
  constructor(repo) {
    this.repo = repo;
    this.dir = path.join(repo, '.thinker');
    // THINKER_NOTES_DIR serves notes from elsewhere (benchmark control arms).
    this.notesDir = process.env.THINKER_NOTES_DIR || path.join(this.dir, 'notes');
  }
  assertSafeNotesPath() {
    try { if (fs.lstatSync(this.dir).isSymbolicLink()) throw new Error('refusing to use a symlinked .thinker directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!process.env.THINKER_NOTES_DIR) {
      try {
        if (fs.lstatSync(this.notesDir).isSymbolicLink()) throw new Error('refusing to use a symlinked notes directory');
        const root = fs.realpathSync(this.repo), real = fs.realpathSync(this.notesDir);
        const rel = path.relative(root, real);
        if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('notes directory must be inside the repository');
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  init() {
    // Notes may live outside the repo (THINKER_NOTES_DIR). config.json still belongs in <repo>/.thinker.
    this.assertSafeNotesPath();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.notesDir, { recursive: true });
    this.assertSafeNotesPath();
    const cfg = path.join(this.dir, 'config.json');
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ version: 1, verifyModel: 'haiku', distillModel: 'sonnet' }, null, 2) + '\n');
    return this;
  }
  config() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'config.json'), 'utf8')); } catch { return {}; }
  }
  exists() { return fs.existsSync(this.notesDir); }
  list() {
    this.assertSafeNotesPath();
    if (!this.exists()) return [];
    return fs.readdirSync(this.notesDir).filter(f => /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(f)).flatMap(f => {
      const file = path.join(this.notesDir, f);
      try {
        if (fs.lstatSync(file).isSymbolicLink()) return [];
        const note = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof note?.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(note.id) ? [note] : [];
      } catch { return []; }
    });
  }
  get(id) {
    this.assertSafeNotesPath();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(id))) return null;
    try {
      const n = JSON.parse(fs.readFileSync(path.join(this.notesDir, id + '.json'), 'utf8'));
      return n?.id === id ? n : null;
    } catch { return null; }
  }
  put(note) {
    this.assertSafeNotesPath();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(note?.id))) throw new Error('invalid note id');
    fs.mkdirSync(this.notesDir, { recursive: true });
    const file = path.join(this.notesDir, note.id + '.json');
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing to write through a note symlink'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    fs.writeFileSync(file, JSON.stringify(note, null, 2) + '\n', { mode: 0o600 });
    return note;
  }
  remove(id) {
    this.assertSafeNotesPath();
    if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return false;
    try { fs.unlinkSync(path.join(this.notesDir, id + '.json')); return true; } catch { return false; }
  }
  // Append-only usage/feedback log for the machine (see logFile); one line per event, so
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

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'note';
}

export function uniqueId(store, base) {
  let id = base, n = 2;
  while (store.get(id)) id = `${base}-${n++}`;
  return id;
}
