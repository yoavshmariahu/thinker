// Note store: one JSON file per note under <repo>/.thinker/notes/.
// Notes are plain files so a team can commit them and share via git.
import fs from 'node:fs';
import path from 'node:path';
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

export function gitHead(repo) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}

export class Store {
  constructor(repo) {
    this.repo = repo;
    this.dir = path.join(repo, '.thinker');
    // THINKER_NOTES_DIR serves notes from elsewhere (benchmark control arms).
    this.notesDir = process.env.THINKER_NOTES_DIR || path.join(this.dir, 'notes');
  }
  init() {
    fs.mkdirSync(this.notesDir, { recursive: true });
    const cfg = path.join(this.dir, 'config.json');
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ version: 1, verifyModel: 'haiku', distillModel: 'sonnet' }, null, 2) + '\n');
    return this;
  }
  config() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'config.json'), 'utf8')); } catch { return {}; }
  }
  exists() { return fs.existsSync(this.notesDir); }
  list() {
    if (!this.exists()) return [];
    return fs.readdirSync(this.notesDir).filter(f => f.endsWith('.json')).map(f => this.get(f.slice(0, -5))).filter(Boolean);
  }
  get(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.notesDir, id + '.json'), 'utf8')); } catch { return null; }
  }
  put(note) {
    fs.mkdirSync(this.notesDir, { recursive: true });
    fs.writeFileSync(path.join(this.notesDir, note.id + '.json'), JSON.stringify(note, null, 2) + '\n');
    return note;
  }
  remove(id) {
    try { fs.unlinkSync(path.join(this.notesDir, id + '.json')); return true; } catch { return false; }
  }
  // Append-only usage/feedback log (not committed; useful for pruning and eval).
  log(event) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, 'log.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...event }) + '\n');
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
