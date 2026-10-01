// Explicit promotion and commit-based validation of the repository note cache.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { KINDS, LOCAL_FIELDS, sharedContent } from './store.js';
import { checkNote, validDepPath } from './deps.js';
import { tokenize } from './rank.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_BODY_BYTES = 12000;
const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
export const resolveCommit = (repo, ref) => git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function nearDuplicate(a, b) {
  if (a.kind !== b.kind) return false;
  const words = n => new Set(tokenize(`${n.title || ''} ${Array.isArray(n.answers) ? n.answers.join(' ') : ''}`));
  const x = words(a), y = words(b), union = new Set([...x, ...y]);
  return union.size > 0 && [...x].filter(w => y.has(w)).length / union.size >= 0.5;
}

// No source transcript paths or per-checkout state are included in a promoted note.
export function prepareContent(note, sharedIds) {
  const content = sharedContent(note);
  if (content.source?.type === 'agent') {
    content.source = { ...content.source };
    delete content.source.ref;
  }
  if (Array.isArray(content.related)) content.related = content.related.filter(id => id !== note.id && sharedIds.has(id));
  if (typeof content.confidence === 'number') content.confidence = Math.round(content.confidence * 100) / 100;
  return content;
}

export function contentErrors(note, id = note?.id) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return ['note must be an object'];
  const errors = [];
  if (typeof note.id !== 'string' || !ID.test(note.id) || note.id !== id) errors.push('invalid id (must match the filename)');
  if (typeof note.title !== 'string' || !note.title.trim()) errors.push('missing title');
  if (typeof note.body !== 'string' || !note.body.trim()) errors.push('missing body');
  else if (Buffer.byteLength(note.body) > MAX_BODY_BYTES) errors.push(`body exceeds ${MAX_BODY_BYTES} bytes`);
  if (!KINDS.includes(note.kind)) errors.push('unknown kind');
  if (!Array.isArray(note.deps) || !note.deps.length) errors.push('missing deps');
  else for (const d of note.deps) {
    if (!d || !validDepPath(d.path) || typeof d.hash !== 'string' || !/^sha256:[a-f0-9]{24}$/.test(d.hash) || (d.symbol !== undefined && (typeof d.symbol !== 'string' || !d.symbol))) errors.push('invalid dependency path, symbol or hash');
  }
  for (const field of ['answers', 'tags', 'related', 'says']) if (note[field] !== undefined && (!Array.isArray(note[field]) || note[field].some(v => typeof v !== 'string'))) errors.push(`invalid ${field}`);
  const text = JSON.stringify(note);
  if (/(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\\\Users\\\\|~\/)[^\s"/]+/i.test(text)) errors.push('contains a machine-specific home path');
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b|(?:api[_ -]?key|(?:access[_ -]?)?token|secret[_ -]?key|password)\s*["']?\s*[:=]\s*["']?[A-Za-z0-9_\/+.-]{16,}/i.test(text)) errors.push('contains a possible secret');
  return [...new Set(errors)];
}

function dependencyErrors(repo, note, opts) {
  if (contentErrors(note).some(e => /deps|dependency/.test(e))) return [];
  const result = checkNote(repo, note, opts);
  const errors = result.changed.map(d => `${d.path}${d.symbol ? ':' + d.symbol : ''}: ${d.reason}`);
  for (const d of result.deps) if (d.symbolMissing && !errors.some(e => e.startsWith(`${d.path}:`))) errors.push(`${d.path}:${d.symbol}: symbol not found`);
  return errors;
}

export function planShare(store, { ids = [], all = false } = {}) {
  if (!store.tiered) throw new Error('sharing is unavailable with THINKER_NOTES_DIR');
  const notes = store.list(), shared = notes.filter(n => store.isShared(n.id));
  const sharedIds = new Set(shared.map(n => n.id));
  const selected = new Set(ids), ready = [], skipped = [];
  for (const id of ids) if (!notes.some(n => n.id === id)) skipped.push({ id, reasons: ['no such note'] });
  for (const note of notes) {
    if (selected.size && !selected.has(note.id)) continue;
    const isShared = sharedIds.has(note.id);
    if (isShared && note.status === 'invalid') { ready.push({ id: note.id, action: 'remove', note }); continue; }
    const legacy = isShared && LOCAL_FIELDS.some(k => k in store.sharedFile(note.id));
    if (isShared && !legacy && !Object.keys(store.pending(note.id)).length) continue;
    const content = prepareContent(note, sharedIds);
    const reasons = contentErrors(content);
    if (note.status !== 'fresh') reasons.push(`status is ${note.status || 'unknown'}`);
    reasons.push(...dependencyErrors(store.repo, content));
    if (!isShared && !all && !selected.has(note.id) && !['human', 'pr', 'doc'].includes(note.source?.type) && !(note.attest?.confirmed > 0)) reasons.push('not confirmed by a session yet');
    const dup = shared.find(n => n.id !== note.id && n.status !== 'invalid' && nearDuplicate(content, n)) || ready.find(r => r.action !== 'remove' && nearDuplicate(content, r.note))?.note;
    if (dup) reasons.push(`near-duplicate of ${dup.id}`);
    if (reasons.length) skipped.push({ id: note.id, reasons });
    else ready.push({ id: note.id, action: isShared ? 'update' : 'add', note });
  }
  return { ready, skipped };
}

export function share(store, opts = {}) {
  const plan = planShare(store, opts);
  const sharedIds = new Set(store.list().filter(n => store.isShared(n.id)).map(n => n.id));
  for (const item of plan.ready) item.action === 'remove' ? sharedIds.delete(item.id) : sharedIds.add(item.id);
  for (const item of plan.ready) {
    item.content = item.action === 'remove' ? null : prepareContent(item.note, sharedIds);
    if (!opts.dry) item.action === 'remove' ? store.remove(item.id) : store.promote(item.note, item.content);
  }
  return plan;
}

function committedNotes(repo, ref) {
  const notes = new Map();
  if (!ref) return notes;
  for (const entry of git(repo, ['ls-tree', '-rz', ref, '--', '.thinker/notes']).split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t');
    if (!file.endsWith('.json')) continue;
    const id = path.posix.basename(file, '.json');
    const regular = /^100(?:644|755) blob /.test(meta) && file === `.thinker/notes/${id}.json`;
    let note = null, error = regular ? null : 'note must be a regular JSON file directly in .thinker/notes';
    try { note = JSON.parse(git(repo, ['show', `${ref}:${file}`])); } catch { error = 'invalid JSON'; }
    notes.set(file, { id, note, error });
  }
  return notes;
}

// Resolve the remote's cached default branch; no network requests in a push hook.
export function defaultBase(repo, ref, remote = 'origin') {
  let target;
  try { target = git(repo, ['symbolic-ref', `refs/remotes/${remote}/HEAD`]); } catch {
    // Clones normally have remote/HEAD. For repos initialized locally, use the conventional
    // default only when it actually exists. Otherwise ask for an explicit base.
    for (const name of ['main', 'master']) {
      try { target = resolveCommit(repo, `refs/remotes/${remote}/${name}`); break; } catch {}
    }
  }
  if (!target) throw new Error(`cannot find ${remote}'s default branch; fetch it or pass --base`);
  return git(repo, ['merge-base', ref, target]);
}

export function validateShare(repo, { ref = 'HEAD', base, strict = false } = {}) {
  ref = resolveCommit(repo, ref);
  if (base === undefined) base = defaultBase(repo, ref);
  if (base) base = resolveCommit(repo, base);
  const current = committedNotes(repo, ref), before = committedNotes(repo, base);
  const errors = [], warnings = [];
  const report = (list, id, message) => list.push({ id, message });
  for (const [file, entry] of current) {
    const { id, note, error } = entry;
    const old = before.get(file);
    const changed = !old || !equal(note && sharedContent(note), old.note && sharedContent(old.note)) || error !== old.error;
    const issues = error ? [error] : contentErrors(note, id);
    for (const issue of issues) report(changed || strict ? errors : warnings, id, issue);
    if (note && typeof note === 'object') {
      if (LOCAL_FIELDS.some(k => k in note)) report(warnings, id, 'legacy local fields in committed note; run thinker share to clean up');
      if (!issues.length) {
        for (const issue of dependencyErrors(repo, note, { ref })) report(changed || strict ? errors : warnings, id, issue);
        if (changed) for (const [otherFile, other] of current) {
          if (file !== otherFile && other.note && nearDuplicate(note, other.note)) report(errors, id, `near-duplicate of ${other.id}`);
        }
      }
    }
  }
  return { ref, base, errors, warnings, checked: current.size };
}

export function validatePush(repo, input, { base, strict = false, remote = 'origin' } = {}) {
  const results = [];
  for (const line of input.split('\n').filter(l => l.trim())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40,64}$/.test(fields[1]) || !/^[a-f0-9]{40,64}$/.test(fields[3])) throw new Error('invalid pre-push input');
    const [, localSha, , remoteSha] = fields;
    if (/^0+$/.test(localSha)) continue; // deleting a ref
    const ref = resolveCommit(repo, localSha);
    const comparison = base !== undefined ? base : /^0+$/.test(remoteSha) ? defaultBase(repo, ref, remote) : remoteSha;
    results.push(validateShare(repo, { ref, base: comparison, strict }));
  }
  return results;
}

// Maintenance only deletes local duplicates. No committed file is touched.
export function reconcileLocal(store) {
  if (!store.tiered) return [];
  const shared = store.list().filter(n => store.isShared(n.id));
  const removed = [];
  for (const local of store.localNotes()) {
    const match = shared.find(n => n.id === local.id) || shared.find(n => nearDuplicate(local, n));
    if (!match) continue;
    if (match.id === local.id) {
      // The pulled shared content wins; retain this checkout's usage evidence.
      const merged = { ...match };
      for (const key of LOCAL_FIELDS) if (local[key] !== undefined && !['status', 'stale', 'verifying', 'invalidReason'].includes(key)) merged[key] = local[key];
      store.put(merged);
    }
    store.removeLocal(local.id);
    removed.push({ id: local.id, shared: match.id });
  }
  if (removed.length) store.log({ op: 'share-reconcile', removed });
  return removed;
}

export function readyToShareNotice(store) {
  if (!store.tiered || (!store.config().share && !store.list().some(n => store.isShared(n.id)))) return '';
  const file = path.join(store.localDir, 'share-notice.json');
  let seen = []; try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const ready = planShare(store).ready;
  const keys = ready.map(r => {
    const content = sharedContent(r.note);
    for (const k of ['confidence', 'verified', 'related']) delete content[k];
    return `${r.id}:${r.action}:${crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex')}`;
  });
  fs.mkdirSync(store.localDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys));
  if (!keys.some(k => !seen.includes(k))) return '';
  return `${ready.length} ${ready.length === 1 ? 'note is' : 'notes are'} ready to share; run thinker share --dry`;
}
