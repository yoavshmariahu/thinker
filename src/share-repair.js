// Pre-commit repair of the shared cache. Read and write Git's index so partially
// staged files are judged against exactly the code the commit will contain.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkNote, hashDepAtIndex, locateSymbol, validDepPath } from './deps.js';
import { sharedContent } from './store.js';
import { contentErrors, nearDuplicate, prepareContent } from './share.js';
import { extractDeps } from './ops.js';
import { complete } from './llm.js';

const run = (repo, args, input) => execFileSync('git', args, { cwd: repo, input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
const notePath = p => p.startsWith('.thinker/notes/') && p.endsWith('.json');
const idOf = p => path.posix.basename(p, '.json');
const readIndex = (repo, file) => run(repo, ['show', `:${file}`]);
const stagedNames = repo => run(repo, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);

function indexNotes(repo) {
  const out = new Map();
  const files = run(repo, ['ls-files', '-z', '--', '.thinker/notes']).split('\0').filter(notePath);
  for (const file of files) {
    const raw = readIndex(repo, file);
    let note;
    try { note = JSON.parse(raw); } catch {}
    const mode = run(repo, ['ls-files', '--stage', '--', file]).match(/^(\d+) /)?.[1];
    out.set(file, { file, id: idOf(file), raw, note, mode });
  }
  return out;
}

function backup(store, entry) {
  store.init();
  const dir = path.join(store.localDir, 'quarantine');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safeId = /^[a-z0-9][a-z0-9-]*$/.test(entry.id) ? entry.id : 'invalid-note';
  const file = path.join(dir, `${safeId}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, entry.raw, { mode: 0o600, flag: 'wx' });
  return file;
}

function syncWorking(store, entry, after) {
  const file = path.join(store.repo, entry.file);
  let current;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) { if (after === null) fs.unlinkSync(file); return; }
    current = fs.readFileSync(file, 'utf8');
  } catch { return; }
  // Never overwrite unstaged changes. The index is still repaired for this commit.
  if (current !== entry.raw) return;
  if (after === null) fs.unlinkSync(file);
  else fs.writeFileSync(file, after, { mode: 0o600 });
}

function writeIndex(repo, file, text) {
  const hash = run(repo, ['hash-object', '-w', '--stdin'], text).trim();
  const mode = run(repo, ['ls-files', '--stage', '--', file]).match(/^(100644|100755) /)?.[1] || '100644';
  run(repo, ['update-index', '--cacheinfo', mode, hash, file]);
}
function removeIndex(repo, file) { run(repo, ['update-index', '--force-remove', '--', file]); }

// An answer that says the note was not there is a misreading of the request, not a verdict on the note.
const MISREAD = /\b(?:no|not|without)\b[^.]{0,40}\b(?:note|content|claims?)\b[^.]{0,30}\b(?:provided|given|included|supplied|present|shown)\b|\b(?:note|content)\b[^.]{0,30}\b(?:(?:was|is|were) )?(?:not|never) (?:provided|given|included|supplied)\b|\bmissing (?:the )?(?:cache )?note\b/i;
export const misread = reason => MISREAD.test(String(reason || ''));

async function modelDecision(store, note, changed, { model } = {}) {
  const deps = (note.deps || []).slice(0, 8).map(d => {
    let source = '(missing from staged code)';
    if (validDepPath(d.path)) try {
      const text = run(store.repo, ['show', `:${d.path}`]);
      const loc = d.symbol ? locateSymbol(text, d.symbol, d.path) : null;
      source = loc ? text.split('\n').slice(loc.start, Math.min(loc.end, loc.start + 120)).join('\n').slice(0, 5000) : text.slice(0, 5000);
    } catch {}
    return `${d.path}${d.symbol ? ':' + d.symbol : ''}\n${source}`;
  }).join('\n\n');
  const diff = run(store.repo, ['diff', '--cached', '--no-color', '--', ...(note.deps || []).map(d => d.path).filter(validDepPath)]).slice(0, 12000);
  const res = await complete({
    model: model || store.config().verifyModel || 'haiku',
    accounting: { store, purpose: 'repair', phase: 'maintenance' },
    maxTokens: 2000,
    schema: {
      type: 'object', properties: {
        verdict: { type: 'string', enum: ['still_valid', 'update', 'invalid'] },
        reason: { type: 'string' },
        body: { type: 'string' },
        deps: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, symbol: { type: 'string' } }, required: ['path'] } },
      }, required: ['verdict', 'reason', 'body', 'deps'],
    },
    system: 'Repair a codebase cache note against the staged source code. Keep a note only when its concrete claims still hold. Return still_valid if every claim remains true; update with a complete corrected body and dependencies when it can be repaired; invalid if it is unnecessary or no longer accurate. Never invent paths or symbols.',
    prompt: `NOTE ${note.id} (${note.kind}): ${note.title}\n${String(note.body).slice(0, 14000)}\n\nISSUES: ${changed.join('; ')}\n\nSTAGED DIFF:\n${diff || '(none)'}\n\nSTAGED CODE:\n${deps.slice(0, 40000)}`,
  });
  return res.json;
}

// Every changed index note is backed up locally before replacement or removal. Failures
// on one note are reported and never prevent Git from making the commit.
// A commit that touches a central file can change the deps of dozens of shared notes, and each
// model check is a call through the agent's CLI (seconds to minutes). At most `cap` notes are asked
// about per commit, the staged note files first and then the most served; the rest are left as
// they are (`deferred`) for maintenance, which re-verifies stale notes anyway.
export const REPAIR_CAP = 25;
export async function repairStaged(store, { dry = false, decide = modelDecision, model, cap = REPAIR_CAP } = {}) {
  const repo = store.repo;
  const staged = new Set(stagedNames(repo));
  const notes = indexNotes(repo), sharedIds = new Set([...notes.values()].map(n => n.id));
  const actions = [];
  const uses = id => { try { return store.get(id)?.uses || 0; } catch { return 0; } }; // served how often here: shared content carries no per-checkout state
  const relevant = [...notes.values()].filter(e => staged.has(e.file) || (e.note?.deps || []).some(d => staged.has(d.path)))
    .sort((a, b) => (Number(staged.has(b.file)) - Number(staged.has(a.file))) || (uses(b.id) - uses(a.id)));
  let asked = 0;
  for (const entry of relevant) {
    const { file, id } = entry;
    // A note file the commit adds or changes is the commit's own: it may be taken out of it. A note
    // reached only through the code it rests on is never removed by a commit: a small model at commit
    // time is the only judge there, and it misread notes it was shown ("No cache note was provided",
    // four times out of four on one note), so a note that does not check out is left as it is, goes
    // stale, and maintenance verifies it with its history kept.
    const own = staged.has(file);
    try {
      let note = entry.note;
      let reason = '', settled = true; // settled: a reason that is a fact about the note, not a missing or unusable answer
      if (entry.mode !== '100644' && entry.mode !== '100755') reason = 'not a regular note file';
      if (file !== `.thinker/notes/${id}.json`) reason = 'note is outside the shared notes directory';
      if (!reason && (!note || typeof note !== 'object' || Array.isArray(note))) reason = 'invalid JSON or note object';
      if (!reason && note.status === 'invalid') reason = 'already retired';
      if (!reason) {
        note = { ...note, id };
        if ((!note.title || !String(note.title).trim()) && Array.isArray(note.answers) && typeof note.answers[0] === 'string') note.title = note.answers[0].trim();
        if ((!Array.isArray(note.deps) || !note.deps.length) && typeof note.body === 'string') {
          const found = extractDeps(repo, note.body, []).map(d => hashDepAtIndex(repo, d)).filter(d => !d.missing && !d.symbolMissing);
          if (found.length) note.deps = found;
        }
        const errors = contentErrors(note, id);
        const hashOnly = errors.includes('invalid dependency path, symbol or hash') && Array.isArray(note.deps) && note.deps.every(d => d && validDepPath(d.path) && (d.symbol === undefined || (typeof d.symbol === 'string' && d.symbol)));
        const unsafe = errors.filter(e => !e.startsWith('body exceeds') && !(hashOnly && e === 'invalid dependency path, symbol or hash'));
        if (unsafe.length) reason = unsafe.join('; ');
        if (!reason) {
          const duplicates = [...notes.values()].filter(other => other.file !== file && other.note && nearDuplicate(note, other.note));
          // Keep the existing note when a newly staged note duplicates it. When both
          // are staged, keep the stronger one, with ID as a stable tie break.
          const winner = [entry, ...duplicates].sort((a, b) =>
            (Number(staged.has(a.file)) - Number(staged.has(b.file))) ||
            ((b.note?.confidence || 0) - (a.note?.confidence || 0)) || a.id.localeCompare(b.id))[0];
          if (winner.file !== file) reason = `duplicate of ${winner.id}`;
        }
        if (!reason) {
          const check = checkNote(repo, note, { index: true });
          const issues = check.changed.map(d => `${d.path}${d.symbol ? ':' + d.symbol : ''}: ${d.reason}`);
          if (errors.length || issues.length) {
            if (dry) { actions.push({ id, action: 'verify', reason: [...errors, ...issues].join('; ') }); continue; }
            if (cap && asked >= cap) { actions.push({ id, action: 'deferred', reason: `over the cap of ${cap} model checks a commit; left as it is for maintenance` }); continue; }
            asked++;
            let answer;
            try { answer = await decide(store, note, [...errors, ...issues], { model }); }
            catch (e) { reason = `verification unavailable: ${e.message}`; settled = false; }
            if (!reason && answer?.verdict === 'invalid' && misread(answer.reason)) { reason = `verification misread the request: ${String(answer.reason).slice(0, 120)}`; settled = false; }
            if (!reason && answer?.verdict === 'invalid') reason = answer.reason || 'no longer useful';
            if (!reason && !['still_valid', 'update'].includes(answer?.verdict)) { reason = 'verification gave no usable answer'; settled = false; }
            if (!reason) {
              if (answer.verdict === 'update') {
                if (!answer.body?.trim()) { reason = 'verification returned no corrected body'; settled = false; }
                else { note.body = answer.body.trim(); if (answer.deps?.length) note.deps = answer.deps; }
              }
              if (!reason) {
                note.deps = note.deps.map(d => hashDepAtIndex(repo, d));
                if (note.deps.some(d => d.missing || d.symbolMissing) || contentErrors(note, id).length) { reason = 'corrected note still fails validation'; settled = false; }
                else { note.verified = new Date().toISOString(); note.confidence = Math.min(1, (note.confidence ?? 0.7) + 0.05); }
              }
            }
          }
        }
      }
      if (reason && !(own && settled)) {
        // left as it is in the commit: nothing written, so nothing to back up
        actions.push({ id, action: 'left', reason: `${reason}; left as it is${own ? '' : ' (the commit does not change the note)'} for maintenance to verify` });
        continue;
      }
      if (reason) {
        actions.push({ id, action: 'remove', reason });
        if (!dry) { backup(store, entry); removeIndex(repo, file); syncWorking(store, entry, null); }
        continue;
      }
      const next = JSON.stringify(prepareContent(note, sharedIds), null, 2) + '\n';
      if (next === entry.raw) continue;
      actions.push({ id, action: 'update', reason: 'corrected shared content' });
      if (!dry) { backup(store, entry); writeIndex(repo, file, next); syncWorking(store, entry, next); }
    } catch (e) { actions.push({ id, action: 'skipped', reason: e.message }); }
  }
  return actions;
}
