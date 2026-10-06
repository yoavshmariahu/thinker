import fs from 'node:fs';
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
    if (a.verdict === 'contradicted') deferred.push({ reason: 'contradiction requires investigation', assessment: a, existing: { id: note.id, body: note.body } });
    else if (note.kind !== 'behavior') accepted.push(a);
  }
  return { accepted, deferred };
}
