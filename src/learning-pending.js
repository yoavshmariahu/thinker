import fs from 'node:fs';
import { verificationChanges } from './freshness.js';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Contradictions and uncertain discoveries remain inspectable without changing a note.
// One content-addressed record per source/finding makes retries idempotent. Evidence
// stays in its original transcript/PR; this queue stores the proposed change and reference.
export function deferLearning(store, entries, { source, evidenceRef } = {}) {
  if (!entries.length) return [];
  const dir = path.join(store.dir, 'state', 'learning-pending');
  fs.mkdirSync(dir, { recursive: true });
  return entries.map(entry => {
    const record = { source, evidenceRef, ...entry };
    const id = createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 24);
    const file = path.join(dir, `${id}.json`);
    try { fs.writeFileSync(file, JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return file;
  });
}

export function safeLearningAssessments(store, assessments, shown) {
  const accepted = [], deferred = [];
  for (const a of assessments || []) {
    const note = store.get(a.id);
    if (!note) continue;
    if (shown) {
      const snapshot = n => JSON.stringify([n?.title, n?.body, n?.applies || '', n?.kind]);
      const original = shown.find(n => n.id === a.id);
      if (!original || snapshot(original) !== snapshot(note)) continue;
    }
    // a contradicted skill is recorded on its card and taken out of serving at once (ops.js:attest); other
    // contradictions wait for investigation
    if (a.verdict === 'contradicted' && note.kind !== 'skill') deferred.push({ reason: 'contradiction requires investigation', assessment: a, existing: { id: note.id, body: note.body } });
    else if (note.kind !== 'behavior') accepted.push(a);
  }
  return { accepted, deferred };
}

// The queue's consumer. Until 2026-10-17 nothing read it: 164 contradictions had piled up on this
// repository since 2026-10-06 while the notes they contradicted went on being served. Each one now
// marks its note `contradicted` (the evidence and where it came from) and stale: the prompt hooks hold a
// stale note back, maintenance verifies contradicted notes first and shows the verifier the evidence
// (ops.js:verifyNote), and refresh keeps the note stale until then (ops.js:refresh). A record whose note
// is gone or was rewritten since the finding is moot. Every record read leaves the queue.
export function takeContradictions(store, { now = new Date().toISOString() } = {}) {
  const dir = path.join(store.dir, 'state', 'learning-pending');
  let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return { marked: [], moot: 0 }; }
  const marked = []; let moot = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    let rec; try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fs.rmSync(file, { force: true }); continue; }
    const a = rec.assessment || {}, note = a.id && store.get(a.id);
    if (rec.reason === 'contradiction requires investigation' && note && note.status !== 'invalid' && !note.archived && note.kind !== 'behavior' && note.body === rec.existing?.body) {
      const next = { ...note, status: 'stale', stale: { since: note.stale?.since || note.recheck?.since || now, changed: verificationChanges(note) }, contradicted: { evidence: String(a.evidence || '').slice(0, 2000), source: rec.source, at: rec.at || now } };
      delete next.recheck;
      store.put(next);
      marked.push(note.id);
    } else moot++;
    fs.rmSync(file, { force: true });
  }
  if (marked.length || moot) store.log({ op: 'contradictions', marked, moot });
  return { marked, moot };
}
