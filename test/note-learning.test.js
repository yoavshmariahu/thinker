import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { saveNotes } from '../src/distill.js';
import { prepareNotes, selectLearningNotes, NOTE_RELATIONS } from '../src/note-learning.js';

const note = (id = 'lease', extra = {}) => ({ id, title: 'Release leases after committing', kind: 'rule', body: 'src/a.js:commit releases the lease after commit.\nNever release an unowned lease.', applies: 'Owned leases only.', answers: ['When should the lease be released?'], deps: [{ path: 'src/a.js', symbol: 'commit' }], confidence: .8, ...extra });
const store = notes => ({ list: () => notes });
const choice = (key, keys, p = .97) => ({ type: 'choice', choice: key, confidence: .9, probabilities: Object.fromEntries(keys.map(k => [k, k === key ? p : (1 - p) / (keys.length - 1)])) });
function judge({ relation = 'unrelated', supports = true, preserve = .98, catalog = .95, capture = () => {} } = {}) {
  return async (_store, r) => {
    capture(r);
    const answers = Object.fromEntries(Object.entries(r.questions).map(([id]) => [id,
      r.purpose === 'jev-reconcile-search' ? { noul: catalog } :
      r.purpose === 'jev-reconcile' ? id === 'preserves' ? { noul: preserve } : choice(relation, Object.keys(NOTE_RELATIONS)) :
      choice(supports ? 'supported' : 'insufficient', ['supported', 'contradicted', 'insufficient'])]));
    return { status: 'ok', answers };
  };
}
const evidence = 'READ src/a.js: commit first commits, then releases the owned lease. Tests prove unowned leases remain held.';

test('catalog scans every live note in bounded batches without a lexical gate', async () => {
  const notes = Array.from({ length: 90 }, (_, i) => note(`n${i}`, { title: `Rule ${i}` }));
  const requests = [];
  const r = await selectLearningNotes(store(notes), 'Transaction token disposal', { max: 2, judge: judge({ capture: r => requests.push(r) }) });
  assert.equal(r.notes.length, 2);
  assert.deepEqual(requests.flatMap(r => r.state.notes.map(n => n.id)), notes.map(n => n.id));
  assert.ok(requests.length >= 3);
  for (const request of requests) { assert.ok(Object.keys(request.questions).length <= 32); assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 28000); }
});

test('catalog failure discards partial results and oversized Unicode is never silently clipped', async () => {
  let calls = 0;
  const r = await selectLearningNotes(store(Array.from({ length: 40 }, (_, i) => note(`n${i}`))), 'leases', { judge: async (s, q) => ++calls === 2 ? { status: 'unavailable', reason: 'timeout' } : judge()(s, q) });
  assert.equal(r.status, 'unavailable'); assert.deepEqual(r.notes, []);
  const huge = await selectLearningNotes(store([note('huge', { body: '語'.repeat(10000) })]), 'leases', { judge: () => assert.fail('oversized evidence must not be transmitted') });
  assert.equal(huge.status, 'unavailable');
});

test('grounded novel notes are accepted and every source chunk is checked', async () => {
  const seen = [];
  const r = await prepareNotes(store([]), [note()], { evidence: evidence + '\n'.repeat(21000), judge: judge({ capture: q => seen.push(q) }) });
  assert.equal(r.notes.length, 1); assert.equal(r.reconciled, true);
  assert.ok(seen.filter(q => q.purpose === 'jev-grounding').length >= 2);
});

test('covered notes skip while contradictions and uncertain relationships defer without writes', async () => {
  const s = store([note()]);
  const covered = await prepareNotes(s, [note('new')], { evidence, judge: judge({ relation: 'covered' }) });
  assert.equal(covered.notes.length, 0); assert.equal(covered.skipped.length, 1);
  const conflict = await prepareNotes(s, [note('new')], { evidence, judge: judge({ relation: 'contradicts' }) });
  assert.equal(conflict.notes.length, 0); assert.equal(conflict.deferred[0].status, 'contradiction');
  const uncertain = await prepareNotes(s, [note('new')], { evidence, judge: async (s, r) => {
    const response = await judge()(s, r);
    if (r.purpose === 'jev-reconcile') response.answers.relation = choice('extends', Object.keys(NOTE_RELATIONS), .6);
    return response;
  } });
  assert.equal(uncertain.deferred[0].status, 'uncertain');
});

test('extension preserves full old text and refuses lossy merging or human behavior rewrites', async () => {
  const old = note();
  const seen = [];
  const next = note('new', { body: old.body + '\nThe release token must match the commit token.', extends: old.id });
  const good = await prepareNotes(store([old]), [next], { evidence, judge: judge({ relation: 'extends', capture: r => seen.push(r) }) });
  assert.equal(good.notes[0].extends, old.id);
  assert.match(good.notes[0].learningTarget, /Never release/);
  assert.equal(seen.find(r => r.purpose === 'jev-reconcile').state.existing_note.body, old.body);
  const lossy = await prepareNotes(store([old]), [next], { evidence, judge: judge({ relation: 'extends', preserve: .5 }) });
  assert.equal(lossy.notes.length, 0); assert.match(lossy.deferred[0].reason, /complete merged body/);
  const behavior = await prepareNotes(store([note('lease', { kind: 'behavior' })]), [next], { evidence, judge: judge({ relation: 'extends' }) });
  assert.equal(behavior.notes.length, 0); assert.match(behavior.deferred[0].reason, /human behavior/);
});

test('unsupported claims and unavailable judgments never pass, while explicit disabled mode stays local', async () => {
  const bad = await prepareNotes(store([]), [note()], { evidence, judge: judge({ supports: false }) });
  assert.equal(bad.notes.length, 0); assert.match(bad.deferred[0].reason, /every proposed claim/);
  const unavailable = await prepareNotes(store([]), [note()], { evidence, judge: async () => ({ status: 'unavailable', reason: 'timeout' }) });
  assert.equal(unavailable.deferred[0].status, 'unavailable');
  const disabled = await prepareNotes(store([]), [note()], { evidence, judge: async () => ({ status: 'disabled' }) });
  assert.equal(disabled.notes.length, 1); assert.equal(disabled.reconciled, false);
});

test('save cannot bypass reconciliation through lexical merging, a changed target, or behavior extends', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-note-learning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function commit() { return true; }\n');
  const s = new Store(dir).init();
  const old = saveNotes(s, [note('lease')], { source: { type: 'agent' } }).saved[0];
  const independent = saveNotes(s, [note('different')], { source: { type: 'agent' }, reconciled: true });
  assert.equal(independent.saved.length, 1); assert.equal(independent.merged.length, 0);
  const changed = saveNotes(s, [{ ...note('new'), extends: old.id, learningTarget: 'old snapshot' }], { source: { type: 'agent' }, reconciled: true });
  assert.equal(changed.merged.length, 0); assert.match(changed.skipped[0].reason, /changed after/);
  s.put({ ...old, kind: 'behavior' });
  for (const reconciled of [false, true]) {
    const r = saveNotes(s, [{ ...note('new'), extends: old.id }], { source: { type: 'agent' }, reconciled });
    assert.equal(r.merged.length, 0); assert.match(r.skipped[0].reason, /human behaviors/);
  }
  assert.equal(s.get(old.id).kind, 'behavior');
});
