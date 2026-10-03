// Note store: one JSON file per note. A repository's shared notes are under <repo>/.thinker/notes/
// (committed; a team shares them through pull requests), a checkout's own under .thinker/local/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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

// --- two caches -------------------------------------------------------------------------------------
// .thinker/notes/        the repository's cache: committed, shared through pull requests, and written
//                        only by `thinker share` (store.promote) or by hand. Content only.
// .thinker/local/notes/  this checkout's cache: what sessions here learned. Never committed.
// .thinker/local/shared/ what this checkout holds about a shared note: how often it was served here,
//                        whether this working tree makes it stale, what sessions here said about it,
//                        and content it changed and has not shared yet (`pending`). So serving,
//                        assessing and re-verifying a shared note never touches the committed file.
// With THINKER_NOTES_DIR (benchmark arms) there is one directory of whole notes, as before.
export const LOCAL_FIELDS = ['status', 'stale', 'verifying', 'invalidReason', 'uses', 'lastUsed', 'servedIn', 'attest', 'outcomes', 'history', 'sync'];
// Shared fields a checkout holds its own value of, without that being a change worth sharing.
const OVERRIDE_FIELDS = ['confidence', 'verified', 'related'];
const CONTENT_ORDER = ['id', 'title', 'kind', 'answers', 'body', 'applies', 'tags', 'deps', 'source', 'created', 'verified', 'verifiedCommit', 'confidence', 'says', 'saysFor', 'related'];
const NOTE_ID = /^[a-z0-9][a-z0-9-]*$/;
const NOTE_FILE = /^[a-z0-9][a-z0-9-]*\.json$/;

// What of a note is shared: everything that is not this checkout's, in one key order so that
// rewriting a note does not reorder its file.
export function sharedContent(note) {
  const out = {};
  for (const k of CONTENT_ORDER) if (note[k] !== undefined && note[k] !== null) out[k] = note[k];
  for (const k of Object.keys(note).sort()) if (!(k in out) && !LOCAL_FIELDS.includes(k) && !CONTENT_ORDER.includes(k) && note[k] !== undefined && note[k] !== null) out[k] = note[k];
  return out;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const digest = content => crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);
const readJson = file => { try { if (fs.lstatSync(file).isSymbolicLink()) return null; return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// Replace atomically so another hook process never reads a half-written note.
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}

export class Store {
  // readonly: for looking at another checkout (usage, telemetry). Its layout is read as it is and
  // never migrated from here.
  constructor(repo, { readonly = false } = {}) {
    this.repo = repo;
    this.dir = path.join(repo, '.thinker');
    // THINKER_NOTES_DIR serves notes from elsewhere (benchmark control arms).
    this.notesDir = process.env.THINKER_NOTES_DIR || path.join(this.dir, 'notes');
    this.tiered = !process.env.THINKER_NOTES_DIR;
    this.readonly = readonly;
    this.localDir = path.join(this.dir, 'local');
    this.localNotesDir = path.join(this.localDir, 'notes');
    this.overlayDir = path.join(this.localDir, 'shared');
  }
  assertSafeNotesPath() {
    try { if (fs.lstatSync(this.dir).isSymbolicLink()) throw new Error('refusing to use a symlinked .thinker directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!process.env.THINKER_NOTES_DIR) {
      for (const dir of [this.notesDir, this.localDir, this.localNotesDir, this.overlayDir]) {
        try {
          if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('refusing to use a symlinked notes directory');
          const root = fs.realpathSync(this.repo), real = fs.realpathSync(dir);
          const rel = path.relative(root, real);
          if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('notes directory must be inside the repository');
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
  }
  init() {
    if (this.readonly) throw new Error('readonly store');
    // Notes may live outside the repo (THINKER_NOTES_DIR). config.json still belongs in <repo>/.thinker.
    this.assertSafeNotesPath();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.notesDir, { recursive: true });
    this.assertSafeNotesPath();
    if (this.tiered) this.#layout(true);
    const cfg = path.join(this.dir, 'config.json');
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ version: 1, verifyModel: 'haiku', distillModel: 'sonnet' }, null, 2) + '\n');
    return this;
  }
  config() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'config.json'), 'utf8')); } catch { return {}; }
  }
  exists() { return fs.existsSync(this.notesDir) || (this.tiered && fs.existsSync(this.localNotesDir)); }

  // The local directory, made on first use. It ignores itself, so nothing in the repository's
  // own .gitignore has to change. Returns false when this checkout still has the one-directory
  // layout and may not be migrated from here (readonly), or has no cache at all.
  #layout(create = false) {
    if (this.migrated) return true;
    const marker = path.join(this.localDir, 'layout');
    if (fs.existsSync(marker)) return (this.migrated = true);
    this.assertSafeNotesPath();
    const legacy = fs.existsSync(this.notesDir);
    if (this.readonly || (!legacy && !create)) return false;
    fs.mkdirSync(this.localNotesDir, { recursive: true });
    fs.mkdirSync(this.overlayDir, { recursive: true });
    fs.writeFileSync(path.join(this.localDir, '.gitignore'), '*\n');
    if (legacy) this.adoptUntracked({ seed: true });
    fs.writeFileSync(marker, '2\n');
    return (this.migrated = true);
  }
  // Notes in .thinker/notes that git does not track were written by sessions on this machine:
  // they move to the local cache. Tracked ones stay as the shared cache; with `seed`, what such a
  // file still carries of this checkout's state (from before the split) starts its local record.
  // Run once when a checkout first meets this layout. Imports write through put directly.
  adoptUntracked({ seed = false } = {}) {
    if (this.readonly) throw new Error('readonly store');
    this.assertSafeNotesPath();
    fs.mkdirSync(this.localNotesDir, { recursive: true });
    fs.mkdirSync(this.overlayDir, { recursive: true });
    const lock = path.join(this.localDir, 'migrating');
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (const until = Date.now() + 3000; ;) {
      try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== 'EEXIST' || Date.now() > until) throw new Error('cache migration is locked; retry later'); }
      Atomics.wait(wait, 0, 0, 25);
    }
    let moved = 0;
    try {
      const tracked = new Set();
      try {
        for (const f of execFileSync('git', ['ls-files', '-z', '--', '.thinker/notes'], { cwd: this.repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0')) if (f) tracked.add(path.basename(f));
      } catch { /* not a git checkout: nothing is shared yet */ }
      let files = []; try { files = fs.readdirSync(this.notesDir).filter(f => NOTE_FILE.test(f)); } catch {}
      for (const f of files) {
        const file = path.join(this.notesDir, f);
        if (!tracked.has(f)) {
          // Never overwrite a newer local note left by an interrupted migration.
          let target = path.join(this.localNotesDir, f);
          if (fs.existsSync(target)) {
            const backup = path.join(this.localDir, 'migration-backup');
            fs.mkdirSync(backup, { recursive: true });
            target = path.join(backup, `${Date.now()}-${crypto.randomUUID()}-${f}`);
          }
          fs.renameSync(file, target); moved++; continue;
        }
        if (!seed) continue;
        const raw = readJson(file); const id = f.slice(0, -5);
        if (!raw || raw.id !== id || fs.existsSync(path.join(this.overlayDir, f))) continue;
        const state = {}; for (const k of LOCAL_FIELDS) if (raw[k] !== undefined) state[k] = raw[k];
        if (Object.keys(state).length) this.#writeOverlay(id, { base: digest(sharedContent(raw)), state, pending: {} });
      }
    } finally { try { fs.rmdirSync(lock); } catch {} }
    return moved;
  }

  #writeOverlay(id, { base, state, pending, superseded }) {
    fs.mkdirSync(this.overlayDir, { recursive: true });
    const out = { id, base, state, pending };
    if (superseded) out.superseded = superseded;
    writeJson(path.join(this.overlayDir, id + '.json'), out);
  }
  // Content this checkout changed and had not shared when a pull replaced the note: it no
  // longer applies to the committed content, so it is not served or offered for sharing, but
  // it is kept beside the overlay (`superseded`) so a correction made on evidence is not lost
  // without a trace. Null when there is none.
  superseded(id) {
    if (!this.isShared(id)) return null;
    const raw = readJson(path.join(this.notesDir, id + '.json')), ov = readJson(path.join(this.overlayDir, id + '.json'));
    if (!raw || !ov) return null;
    if (ov.base !== digest(sharedContent(raw)) && Object.keys(ov.pending || {}).length) return { base: ov.base, pending: ov.pending, at: ov.supersededAt || null };
    return ov.superseded || null;
  }
  // Forget a superseded correction, once it has been looked at (or shared again).
  clearSuperseded(id) {
    if (this.readonly) throw new Error('readonly store');
    const file = path.join(this.overlayDir, id + '.json'), ov = readJson(file);
    if (!ov) return false;
    const raw = readJson(path.join(this.notesDir, id + '.json'));
    const live = raw && ov.base !== digest(sharedContent(raw)) && Object.keys(ov.pending || {}).length;
    if (!live && !ov.superseded) return false;
    const next = { id: ov.id, base: live ? digest(sharedContent(raw)) : ov.base, state: ov.state || {}, pending: live ? {} : ov.pending || {} };
    if (live) for (const k of ['status', 'stale', 'verifying', 'invalidReason', ...OVERRIDE_FIELDS]) delete next.state[k];
    writeJson(file, next);
    return true;
  }
  // Note files that cannot be read: invalid JSON (a merge conflict, a half-written file) or an
  // id that does not match the file name. The store skips them, so a caller that lists notes
  // should name them, or a conflicted note just disappears from the cache.
  unreadable() {
    const out = [];
    const dirs = this.tiered && this.#layout() ? [['shared', this.notesDir], ['local', this.localNotesDir]] : [['shared', this.notesDir]];
    for (const [tier, dir] of dirs) {
      let files = []; try { files = fs.readdirSync(dir).filter(f => NOTE_FILE.test(f)); } catch {}
      for (const f of files) {
        const file = path.join(dir, f);
        let text; try { if (fs.lstatSync(file).isSymbolicLink()) { out.push({ file, tier, reason: 'symbolic link' }); continue; } text = fs.readFileSync(file, 'utf8'); } catch { continue; }
        let n = null; try { n = JSON.parse(text); } catch {}
        if (n === null) out.push({ file, tier, reason: /^<{7} |^={7}$|^>{7} /m.test(text) ? 'unresolved merge conflict' : 'invalid JSON' });
        else if (typeof n?.id !== 'string' || n.id !== f.slice(0, -5)) out.push({ file, tier, reason: 'id does not match the file name' });
      }
    }
    return out;
  }
  // A shared note as this checkout sees it: the committed content, then what was changed here and
  // not shared yet, then this checkout's state. What was changed here holds only against the
  // content it was made from: when a pull brings a newer version of the note, that version wins and
  // the staleness, confidence and pending changes recorded against the old one are dropped.
  #shared(id) {
    const raw = readJson(path.join(this.notesDir, id + '.json'));
    if (!raw || raw.id !== id) return null;
    const content = sharedContent(raw);
    const ov = readJson(path.join(this.overlayDir, id + '.json'));
    if (!ov) return { ...content, status: 'fresh' };
    const state = { ...(ov.state || {}) };
    let pending = ov.pending || {};
    if (ov.base !== digest(content)) {
      pending = {};
      for (const k of ['status', 'stale', 'verifying', 'invalidReason', ...OVERRIDE_FIELDS]) delete state[k];
    }
    const note = { ...content, ...pending, status: 'fresh', ...state };
    for (const k of Object.keys(note)) if (note[k] === null) delete note[k];
    return note;
  }
  #sharedIds() {
    try { return fs.readdirSync(this.notesDir).filter(f => NOTE_FILE.test(f)).map(f => f.slice(0, -5)); } catch { return []; }
  }
  // Whole notes in one directory: THINKER_NOTES_DIR, or a checkout that is only being looked at.
  #flat(dir) {
    let files = []; try { files = fs.readdirSync(dir).filter(f => NOTE_FILE.test(f)); } catch {}
    return files.flatMap(f => { const n = readJson(path.join(dir, f)); return typeof n?.id === 'string' && NOTE_ID.test(n.id) ? [n] : []; });
  }

  isShared(id) { return this.tiered && NOTE_ID.test(String(id)) && this.#layout() && fs.existsSync(path.join(this.notesDir, id + '.json')); }
  // Content of a shared note that was changed in this checkout and is not in the committed file yet
  // (a re-verification, a correction, phrasings); {} when there is none.
  pending(id) {
    if (!this.isShared(id)) return {};
    const raw = readJson(path.join(this.notesDir, id + '.json')), ov = readJson(path.join(this.overlayDir, id + '.json'));
    return raw && ov && ov.base === digest(sharedContent(raw)) ? (ov.pending || {}) : {};
  }
  // The committed file of a shared note, as it is (local state from before the split included).
  sharedFile(id) { return this.isShared(id) ? readJson(path.join(this.notesDir, id + '.json')) : null; }

  list() {
    this.assertSafeNotesPath();
    if (!this.tiered || !this.#layout()) return this.#flat(this.notesDir);
    const byId = new Map();
    for (const n of this.#flat(this.localNotesDir)) byId.set(n.id, n);
    for (const id of this.#sharedIds()) { const n = this.#shared(id); if (n) byId.set(id, n); } // the shared note wins
    return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  get(id) {
    this.assertSafeNotesPath();
    if (!NOTE_ID.test(String(id))) return null;
    if (!this.tiered || !this.#layout()) { const n = readJson(path.join(this.notesDir, id + '.json')); return n?.id === id ? n : null; }
    const s = this.#shared(id); if (s) return s;
    const n = readJson(path.join(this.localNotesDir, id + '.json'));
    return n?.id === id ? n : null;
  }
  put(note) {
    if (this.readonly) throw new Error('readonly store');
    this.assertSafeNotesPath();
    if (!NOTE_ID.test(String(note?.id))) throw new Error('invalid note id');
    if (this.tiered && this.#layout(true) && this.isShared(note.id)) {
      // a shared note: the committed file stays as it is; this checkout's state and changes go beside it
      const content = sharedContent(readJson(path.join(this.notesDir, note.id + '.json')) || { id: note.id });
      const state = {}, pending = {};
      for (const k of LOCAL_FIELDS) if (note[k] !== undefined) state[k] = note[k];
      for (const k of new Set([...Object.keys(note), ...Object.keys(content)])) {
        if (k === 'id' || LOCAL_FIELDS.includes(k) || same(note[k], content[k])) continue;
        (OVERRIDE_FIELDS.includes(k) ? state : pending)[k] = note[k] ?? null;
      }
      const base = digest(content);
      // what was pending against the content a pull replaced is kept as superseded, not dropped
      const prev = readJson(path.join(this.overlayDir, note.id + '.json'));
      let superseded = prev?.superseded || null;
      if (prev && prev.base !== base && Object.keys(prev.pending || {}).length) superseded = { base: prev.base, pending: prev.pending, at: new Date().toISOString() };
      this.#writeOverlay(note.id, { base, state, pending, superseded });
      return note;
    }
    const dir = this.tiered ? this.localNotesDir : this.notesDir;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, note.id + '.json');
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing to write through a note symlink'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    writeJson(file, note);
    return note;
  }
  // Write a note into the repository's cache, for the next commit: its content goes to
  // .thinker/notes, what this checkout knows about it stays local. `content` is what to write
  // (share.js prepares it); the note may be local (it moves) or shared already (it is updated).
  promote(note, content = sharedContent(note)) {
    if (this.readonly) throw new Error('readonly store');
    this.assertSafeNotesPath();
    if (!this.tiered) throw new Error('no shared cache with THINKER_NOTES_DIR');
    if (!NOTE_ID.test(String(note?.id)) || content.id !== note.id) throw new Error('invalid note id');
    this.#layout(true);
    fs.mkdirSync(this.notesDir, { recursive: true });
    const file = path.join(this.notesDir, note.id + '.json');
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('refusing to write through a note symlink'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    writeJson(file, content);
    try { fs.unlinkSync(path.join(this.localNotesDir, note.id + '.json')); } catch {}
    this.put({ ...note, ...content }); // now a shared note: the rest becomes its local record
    this.clearSuperseded(note.id);     // what is shared now is this checkout's word on the note
    return content;
  }
  remove(id) {
    if (this.readonly) throw new Error('readonly store');
    this.assertSafeNotesPath();
    if (typeof id !== 'string' || !NOTE_ID.test(id)) return false;
    let removed = false;
    const dirs = this.tiered && this.#layout() ? [this.notesDir, this.localNotesDir, this.overlayDir] : [this.notesDir];
    for (const dir of dirs) { try { fs.unlinkSync(path.join(dir, id + '.json')); if (dir !== this.overlayDir) removed = true; } catch {} }
    return removed;
  }
  localNotes() {
    this.assertSafeNotesPath();
    if (!this.tiered || !this.#layout()) return [];
    return this.#flat(this.localNotesDir);
  }
  // Overlays of shared notes that no longer exist (retired by a teammate, say). One that still
  // holds unshared content is kept, so the correction can be read; the rest are removed.
  sweepOverlays() {
    if (this.readonly) throw new Error('readonly store');
    if (!this.tiered || !this.#layout()) return [];
    const removed = [];
    let files = []; try { files = fs.readdirSync(this.overlayDir).filter(f => NOTE_FILE.test(f)); } catch {}
    for (const f of files) {
      const id = f.slice(0, -5);
      if (fs.existsSync(path.join(this.notesDir, f))) continue;
      const ov = readJson(path.join(this.overlayDir, f));
      if (ov && (Object.keys(ov.pending || {}).length || ov.superseded)) continue;
      try { fs.unlinkSync(path.join(this.overlayDir, f)); removed.push(id); } catch {}
    }
    return removed;
  }
  removeLocal(id) {
    if (this.readonly) throw new Error('readonly store');
    this.assertSafeNotesPath();
    if (!this.tiered || !NOTE_ID.test(String(id))) return false;
    try { fs.unlinkSync(path.join(this.localNotesDir, id + '.json')); return true; } catch { return false; }
  }
  // Bytes of every note file of this checkout, both caches.
  size() {
    let n = 0;
    for (const dir of this.tiered ? [this.notesDir, this.localNotesDir] : [this.notesDir]) {
      try { for (const f of fs.readdirSync(dir)) if (NOTE_FILE.test(f)) n += fs.statSync(path.join(dir, f)).size; } catch {}
    }
    return n;
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
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') || 'note';
}

export function uniqueId(store, base) {
  let id = base, n = 2;
  while (store.get(id)) id = `${base}-${n++}`;
  return id;
}
