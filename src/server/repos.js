// The central cache, one directory per repository under the server's data directory:
//
//   repos/<key>/checkout/            a clone of the repository (its default branch), so notes
//                                    distilled here are anchored to real files and symbols;
//                                    the notes live in its .thinker/ through the ordinary Store
//   repos/<key>/journal.jsonl        every change to a note, numbered: what clients pull by cursor
//   repos/<key>/sessions/<id>.jsonl  events streamed by clients' hooks, distilled when idle
//   repos/<key>/prs/<n>.json         merged pull requests sent by CI, distilled in turn
//   repos/<key>/repo.json            id, clone url, sequence number, head
//
// <key> is the repository id (github.com/owner/repo, see store.js:repoId) with '/' as '__'.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { Store, sharedContent, LOCAL_FIELDS } from '../store.js';

export const REPO_ID = /^[a-z0-9][a-z0-9.-]*(\/[a-z0-9._-]+)+$/i;
export const NOTE_ID = /^[a-z0-9][a-z0-9-]*$/;
export const SESSION_ID = /^[\w.-]{1,120}$/;
export const digest = content => crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);

// What is synchronized of a note: its content (store.js:sharedContent) and what sessions anywhere
// said about it. Not a checkout's own state (uses, servedIn, staleness against its working tree).
// `status` travels beside it: a retired note is retired everywhere, a stale one only where it is stale.
export const SYNC_FIELDS = ['attest', 'history'];
export function syncContent(note) {
  const out = sharedContent(note);
  for (const k of SYNC_FIELDS) if (note[k] !== undefined && note[k] !== null) out[k] = note[k];
  return out;
}
export function wire(note) {
  const out = syncContent(note);
  if (note.status === 'invalid') { out.status = 'invalid'; if (note.invalidReason) out.invalidReason = note.invalidReason; }
  else out.status = 'fresh';
  return out;
}

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
const jsonLines = text => text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

export class Repo {
  constructor(root, id) {
    if (!REPO_ID.test(id)) throw new Error('invalid repository id');
    this.id = id.toLowerCase();
    this.dir = path.join(root, 'repos', this.id.replace(/\//g, '__'));
    this.checkout = path.join(this.dir, 'checkout');
    this.sessionsDir = path.join(this.dir, 'sessions');
    this.prsDir = path.join(this.dir, 'prs');
    this.reviewsDir = path.join(this.dir, 'reviews');
    this.journalFile = path.join(this.dir, 'journal.jsonl');
    this.metaFile = path.join(this.dir, 'repo.json');
    this.queue = Promise.resolve();
  }
  exists() { return fs.existsSync(this.metaFile); }
  meta() { return readJson(this.metaFile, { id: this.id, seq: 0 }); }
  saveMeta(patch) { const m = { ...this.meta(), ...patch }; fs.mkdirSync(this.dir, { recursive: true }); writeJson(this.metaFile, m); return m; }
  create({ clone } = {}) {
    fs.mkdirSync(this.checkout, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.prsDir, { recursive: true });
    fs.mkdirSync(this.reviewsDir, { recursive: true });
    if (!this.exists()) this.saveMeta({ id: this.id, seq: 0, clone: clone || defaultClone(this.id), created: new Date().toISOString() });
    else if (clone) this.saveMeta({ clone });
    this.store().init();
    return this;
  }
  store() { return this._store || (this._store = new Store(this.checkout)); }

  // Changes to one repository run one at a time: the server is one process, so a promise chain is the lock.
  locked(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  // --- the journal --------------------------------------------------------------------------------
  journal() { try { return jsonLines(fs.readFileSync(this.journalFile, 'utf8')); } catch { return []; } }
  #append(entries) {
    if (!entries.length) return this.meta().seq || 0;
    let { seq = 0 } = this.meta();
    const lines = entries.map(e => JSON.stringify({ seq: ++seq, at: new Date().toISOString(), ...e }));
    fs.appendFileSync(this.journalFile, lines.join('\n') + '\n');
    this.saveMeta({ seq });
    return seq;
  }
  // Run `fn` against the store and journal every note it changed, added, retired or removed.
  #snapshot() { return new Map(this.store().list().map(n => [n.id, digest(wire(n))])); }
  #journalDiff(before, by) {
    const after = this.#snapshot();
    const entries = [];
    for (const [id, d] of after) if (before.get(id) !== d) entries.push({ op: 'put', id, digest: d, by });
    for (const id of before.keys()) if (!after.has(id)) entries.push({ op: 'del', id, by });
    return { changed: entries.map(e => e.id), seq: this.#append(entries) };
  }
  withJournal(fn, by = 'server') {
    const before = this.#snapshot();
    const result = fn(this.store());
    return { result, ...this.#journalDiff(before, by) };
  }
  async withJournalAsync(fn, by = 'server') {
    const before = this.#snapshot();
    const result = await fn(this.store());
    return { result, ...this.#journalDiff(before, by) };
  }

  // What changed since a cursor: the present content of every note touched, and tombstones.
  changes(since = 0, { limit = 5000 } = {}) {
    const store = this.store();
    const seq = this.meta().seq || 0;
    since = Math.max(0, Number(since) || 0);
    let notes = [], deleted = [];
    if (since === 0) notes = store.list().map(wire);
    else {
      const touched = new Map();
      for (const e of this.journal()) if (e.seq > since) touched.set(e.id, e.op);
      for (const [id, op] of touched) { const n = store.get(id); if (n) notes.push(wire(n)); else if (op === 'del') deleted.push(id); }
    }
    return { seq, since, notes: notes.slice(0, limit), deleted, truncated: notes.length > limit };
  }
  note(id) { const n = NOTE_ID.test(String(id)) && this.store().get(id); return n ? wire(n) : null; }

  // --- notes pushed by clients -------------------------------------------------------------------------
  // A new note is kept unless it repeats one the server has. An update holds only against the
  // content it was made from (`base`): when the server moved on, the server's version stands and
  // the client takes it on its next pull. Server-side state (uses, servedIn) is never overwritten.
  upsert(items, { by = 'client', nearDuplicate } = {}) {
    return this.withJournal(store => {
      const results = [];
      for (const item of items || []) {
        const note = item?.note, id = note?.id;
        if (!id || !NOTE_ID.test(id)) { results.push({ id: id || null, result: 'invalid', error: 'invalid note id' }); continue; }
        const existing = store.get(id);
        const current = existing ? digest(wire(existing)) : null;
        if (item.op === 'del') {
          if (!existing) { results.push({ id, result: 'absent' }); continue; }
          if (item.base && item.base !== current) { results.push({ id, result: 'conflict', digest: current }); continue; }
          store.put({ ...existing, status: 'invalid', invalidReason: String(note.invalidReason || `retired by ${by}`).slice(0, 300) });
          results.push({ id, result: 'retired', digest: digest(wire(store.get(id))) }); continue;
        }
        const content = syncContent(note);
        if (!content.title || !content.body || !Array.isArray(content.deps) || !content.deps.length) { results.push({ id, result: 'invalid', error: 'a note needs a title, a body and deps' }); continue; }
        if (existing) {
          if (item.base !== current) { results.push({ id, result: item.base ? 'conflict' : 'exists', digest: current }); continue; }
          const next = { ...existing, ...content };
          for (const k of Object.keys(syncContent(existing))) if (!(k in content)) delete next[k];
          if (note.status === 'invalid') { next.status = 'invalid'; next.invalidReason = note.invalidReason; } else if (existing.status === 'invalid') { next.status = 'fresh'; delete next.invalidReason; }
          store.put(next);
          results.push({ id, result: 'updated', digest: digest(wire(next)) });
          continue;
        }
        const dup = nearDuplicate && store.list().find(n => n.status !== 'invalid' && nearDuplicate(content, n));
        if (dup) { results.push({ id, result: 'duplicate', of: dup.id }); continue; }
        const fresh = { ...content, status: note.status === 'invalid' ? 'invalid' : 'fresh', uses: 0 };
        if (fresh.status === 'invalid') fresh.invalidReason = note.invalidReason;
        store.put(fresh);
        results.push({ id, result: 'added', digest: digest(wire(fresh)) });
      }
      return results;
    }, by);
  }

  // --- sessions -------------------------------------------------------------------------------------
  sessionFile(session) {
    if (!SESSION_ID.test(String(session))) throw new Error('invalid session id');
    return path.join(this.sessionsDir, `${session}.jsonl`);
  }
  sessionMeta(session) { return readJson(this.sessionFile(session).replace(/\.jsonl$/, '.json'), {}); }
  saveSessionMeta(session, patch) { const f = this.sessionFile(session).replace(/\.jsonl$/, '.json'); const m = { ...this.sessionMeta(session), ...patch }; writeJson(f, m); return m; }
  appendSession(session, events, { by, client } = {}) {
    const f = this.sessionFile(session);
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    const kept = (events || []).filter(e => e && typeof e === 'object' && ['prompt', 'say', 'tool', 'served', 'end'].includes(e.t));
    if (kept.length) fs.appendFileSync(f, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
    const meta = this.sessionMeta(session);
    const count = (meta.events || 0) + kept.length;
    const ended = !!(meta.ended || kept.some(e => e.t === 'end'));
    this.saveSessionMeta(session, { events: count, by: by || meta.by, client: client || meta.client, lastAt: new Date().toISOString(), ended });
    return { events: count, ended };
  }
  sessionEvents(session) { try { return jsonLines(fs.readFileSync(this.sessionFile(session), 'utf8')); } catch { return []; } }
  sessions() {
    let files = []; try { files = fs.readdirSync(this.sessionsDir); } catch {}
    return files.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6));
  }

  // --- pull requests from CI --------------------------------------------------------------------------
  prFile(n) { if (!/^\d{1,9}$/.test(String(n))) throw new Error('invalid pull request number'); return path.join(this.prsDir, `${n}.json`); }
  queuePr(pr) {
    fs.mkdirSync(this.prsDir, { recursive: true });
    const f = this.prFile(pr.number);
    const prev = readJson(f, {});
    if (prev.done) return { queued: false, done: true };
    writeJson(f, { ...pr, queuedAt: new Date().toISOString() });
    return { queued: true };
  }
  pendingPrs() {
    let files = []; try { files = fs.readdirSync(this.prsDir); } catch {}
    return files.filter(f => /^\d+\.json$/.test(f)).map(f => readJson(path.join(this.prsDir, f), null)).filter(p => p && !p.done).sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
  }
  finishPr(n, patch) { const f = this.prFile(n); const pr = readJson(f, { number: n }); delete pr.diff; delete pr.body; delete pr.comments; writeJson(f, { ...pr, ...patch, done: true, doneAt: new Date().toISOString() }); }

  // --- pull requests to review ----------------------------------------------------------------------
  // One record per pull request number, the latest request winning: a push replaces the pending
  // request for the same number. {status: queued | running | done | failed, ...}; the record of a
  // finished review keeps the counts, the behaviors and the review body, so the action can wait for
  // it and fail the check.
  reviewFile(n) { if (!/^\d{1,9}$/.test(String(n))) throw new Error('invalid pull request number'); return path.join(this.reviewsDir, `${n}.json`); }
  review(n) { return readJson(this.reviewFile(n), null); }
  queueReview(rv) {
    fs.mkdirSync(this.reviewsDir, { recursive: true });
    const prev = this.review(rv.number);
    if (prev && prev.headSha && rv.headSha && prev.headSha === rv.headSha && prev.status !== 'failed') return { queued: false, ...prev };
    const rec = { ...rv, status: 'queued', queuedAt: new Date().toISOString() };
    writeJson(this.reviewFile(rv.number), rec);
    return { queued: true, ...rec };
  }
  saveReview(n, patch) { const rec = { ...(this.review(n) || { number: n }), ...patch }; writeJson(this.reviewFile(n), rec); return rec; }
  finishReview(n, patch) { return this.saveReview(n, { ...patch, doneAt: new Date().toISOString() }); }
  pendingReviews() {
    let files = []; try { files = fs.readdirSync(this.reviewsDir); } catch {}
    return files.filter(f => /^\d+\.json$/.test(f)).map(f => readJson(path.join(this.reviewsDir, f), null)).filter(r => r && r.status === 'queued').sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
  }
  // The pull request's head commit into the clone: GitHub's refs/pull/N/head first, then the branch
  // named, then the commit itself (GitHub serves a reachable commit by id). Returns the commit to
  // review: the one asked for when it arrived, else the tip that was fetched.
  async fetchPrHead({ number, headSha, headRef }, token) {
    const has = sha => { try { this.git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } };
    const tries = [['+refs/pull/' + number + '/head:refs/thinker/pr/' + number], headRef ? ['+refs/heads/' + headRef + ':refs/thinker/pr/' + number] : null, headSha ? [headSha] : null].filter(Boolean);
    let fetched = null, err = null;
    for (const spec of tries) {
      try { await this.gitAsync(['fetch', '--quiet', 'origin', ...spec], token); } catch (e) { err = e; continue; }
      if (headSha && has(headSha)) return headSha;
      if (spec[0] !== headSha) { try { fetched = this.git(['rev-parse', '--verify', `refs/thinker/pr/${number}^{commit}`]); } catch {} }
      if (fetched && !headSha) return fetched;
    }
    if (headSha && has(headSha)) return headSha;
    if (fetched) return fetched;
    throw new Error(`could not fetch the pull request's head (${headSha || headRef || 'refs/pull/' + number + '/head'}): ${String(err?.stderr || err?.message || 'not found').split('\n')[0].slice(0, 160)}`);
  }
  hasCommit(sha) { try { this.git(['cat-file', '-e', `${sha}^{commit}`]); return true; } catch { return false; } }

  // --- the checkout ---------------------------------------------------------------------------------
  // The repository's default branch, cloned once and fetched before a distillation, so notes rest on
  // files that exist and symbols that resolve. Without access (a private repository and no token)
  // the checkout stays empty: notes are stored as clients send them, sessions wait.
  isCloned() { return fs.existsSync(path.join(this.checkout, '.git')); }
  gitEnv(token) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (token) Object.assign(env, { THINKER_GIT_TOKEN: token, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo "password=$THINKER_GIT_TOKEN"; }; f' });
    return env;
  }
  git(args, token) { return execFileSync('git', args, { cwd: this.checkout, encoding: 'utf8', env: this.gitEnv(token), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, timeout: 10 * 60_000 }).trim(); }
  // clone and fetch talk to the network for a while: they must not hold up the server's other requests
  gitAsync(args, token, cwd = this.checkout) {
    return new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8', env: this.gitEnv(token), maxBuffer: 64 << 20, timeout: 20 * 60_000 }, (e, stdout, stderr) => e ? reject(Object.assign(e, { stderr })) : resolve(stdout.trim())));
  }
  async sync({ token, ref } = {}) {
    const { clone } = this.meta();
    if (!clone) return { ok: false, error: 'no clone url' };
    try {
      if (!this.isCloned()) {
        const tmp = this.checkout + '.clone';
        fs.rmSync(tmp, { recursive: true, force: true });
        await this.gitAsync(['clone', '--quiet', '--filter=blob:none', clone, tmp], token, this.dir);
        // notes and state received before the clone existed move into it; a note the repository
        // commits itself keeps its committed file
        const had = path.join(this.checkout, '.thinker');
        if (fs.existsSync(had)) {
          const into = path.join(tmp, '.thinker');
          for (const f of fs.readdirSync(had)) if (f !== 'notes') fs.cpSync(path.join(had, f), path.join(into, f), { recursive: true, force: false, errorOnExist: false });
          const notes = path.join(had, 'notes');
          if (fs.existsSync(notes)) { fs.mkdirSync(path.join(into, 'local', 'notes'), { recursive: true }); for (const f of fs.readdirSync(notes)) if (!fs.existsSync(path.join(into, 'notes', f))) fs.copyFileSync(path.join(notes, f), path.join(into, 'local', 'notes', f)); }
        }
        fs.rmSync(this.checkout, { recursive: true, force: true });
        fs.renameSync(tmp, this.checkout);
        this._store = null;
        this.store().init();
      } else await this.gitAsync(['fetch', '--quiet', '--prune', 'origin'], token);
      let target = ref;
      if (!target) {
        let branch = ''; try { branch = this.git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']); } catch {}
        if (!branch) { try { const m = (await this.gitAsync(['remote', 'show', 'origin'], token)).match(/HEAD branch:\s*(\S+)/); if (m) branch = 'origin/' + m[1]; } catch {} }
        target = branch || 'origin/HEAD';
      }
      this.git(['checkout', '--quiet', '--force', '--detach', target]);
      const head = this.git(['rev-parse', 'HEAD']);
      this.saveMeta({ head, fetchedAt: new Date().toISOString(), cloneError: null });
      return { ok: true, head };
    } catch (e) {
      const error = String(e.stderr || e.message || e).split('\n').find(l => l.trim()) ?.slice(0, 200) || 'git failed';
      this.saveMeta({ cloneError: error, cloneErrorAt: new Date().toISOString() });
      return { ok: false, error };
    }
  }

  status() {
    const m = this.meta();
    const store = this.store();
    const notes = store.exists() ? store.list() : [];
    return { id: this.id, seq: m.seq || 0, clone: m.clone, head: m.head || null, fetchedAt: m.fetchedAt || null, cloned: this.isCloned(), cloneError: m.cloneError || null, notes: notes.length, invalid: notes.filter(n => n.status === 'invalid').length, sessions: this.sessions().length, pendingPrs: this.pendingPrs().length, pendingReviews: this.pendingReviews().length, created: m.created };
  }
}

export function defaultClone(id) { return `https://${id}.git`; }

export class Repos {
  constructor(root) { this.root = root; this.cache = new Map(); fs.mkdirSync(path.join(root, 'repos'), { recursive: true }); }
  get(id, { create = false, clone } = {}) {
    id = String(id || '').toLowerCase();
    if (!REPO_ID.test(id)) return null;
    let r = this.cache.get(id);
    if (!r) { r = new Repo(this.root, id); this.cache.set(id, r); }
    if (!r.exists()) { if (!create) return null; r.create({ clone }); }
    else if (clone) r.saveMeta({ clone });
    return r;
  }
  list() {
    let dirs = []; try { dirs = fs.readdirSync(path.join(this.root, 'repos')); } catch {}
    return dirs.filter(d => fs.existsSync(path.join(this.root, 'repos', d, 'repo.json'))).map(d => this.get(d.replace(/__/g, '/'))).filter(Boolean);
  }
}
