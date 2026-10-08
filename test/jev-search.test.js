import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jevSearch, searchRecord } from '../src/jev.js';
import { phraseKey } from '../src/note-search.js';
import { lookup, orient } from '../src/ops.js';
import { rank } from '../src/rank.js';
import { Store } from '../src/store.js';

const note = (id, extra = {}) => ({ id, kind: 'rule', title: id, answers: [], body: 'Opaque mechanism.', deps: [], status: 'fresh', confidence: 0.9, ...extra });
function transport(score, seen = []) {
  return async (_url, options) => {
    const request = JSON.parse(options.body); seen.push(request);
    assert.ok(Buffer.byteLength(options.body) <= 30000, 'whole UTF-8 payload fits hosted proxy, including questions');
    assert.ok(Object.keys(request.questions).length <= 32);
    return { ok: true, json: async () => ({ answers: Object.fromEntries(request.state.candidate_notes.map((n, i) => [`rel${i}`, { noul: score(n) }])) }) };
  };
}
function fixture(t, notes, fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-jev-search-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir).init();
  for (const n of notes) store.put(n);
  store.config = () => ({ jev: { enabled: true, key: 'test-key', fetchImpl }, ce: false, snippets: false });
  return store;
}

test('search scans every batch and globally ranks the last note, without an eight-note cutoff', async () => {
  const notes = Array.from({ length: 75 }, (_, i) => note(`n-${i}`, { body: '界'.repeat(1100) }));
  const seen = [];
  const rows = await jevSearch(notes, 'specific request', { key: 'test', fetchImpl: transport(n => n.title === 'n-74' ? 0.99 : 0.1, seen) });
  assert.deepEqual(rows.map(r => r.note.id), ['n-74']);
  assert.equal(seen.flatMap(r => r.state.candidate_notes).length, 75);
  assert.ok(seen.length > 2);
});

test('changed content and scope invalidate summaries even when the character count stays the same', () => {
  const n = note('rule', { body: 'Allow retries.', applies: 'Admins only.', search: 'Retry guidance.' });
  n.saysFor = phraseKey(n);
  assert.equal(searchRecord(n, 0).claim, 'Retry guidance.');
  const changed = { ...n, body: 'Block retries.' };
  assert.equal(n.body.length, changed.body.length);
  assert.equal(searchRecord(changed, 0).claim, changed.body);
  assert.notEqual(phraseKey({ ...n, applies: 'Guests only.' }), n.saysFor);
  assert.equal(searchRecord({ ...n, saysFor: 'old-length-key:s1' }, 0).claim, n.body);
});

test('eligibility and the freshOnly filter hold inside the search', async t => {
  const notes = [note('fresh'), note('archived', { archived: { reason: 'test' } }), note('invalid', { status: 'invalid' }), note('stale', { status: 'stale' })];
  const seen = [];
  const rows = await jevSearch(notes, 'query', { freshOnly: true, key: 'test', fetchImpl: transport(() => 0.9, seen) });
  assert.deepEqual(rows.map(r => r.note.id), ['fresh']);
  assert.deepEqual(seen[0].state.candidate_notes.map(n => n.title), ['fresh']);
});

test('one failed batch rejects the whole search, and all batches share one deadline', async () => {
  const notes = Array.from({ length: 70 }, (_, i) => note(`n-${i}`));
  let calls = 0;
  await assert.rejects(jevSearch(notes, 'query', { key: 'test', fetchImpl: async (url, options) => {
    if (++calls === 2) return { ok: false, status: 503 };
    return transport(() => 0.9)(url, options);
  } }), /jev 503/);
  let aborted = 0;
  await assert.rejects(jevSearch(notes, 'query', { key: 'test', timeoutMs: 20, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted')); }, { once: true });
  }) }), /aborted/);
  assert.equal(aborted, 2, 'both in-flight batches are stopped by the search deadline');
});

// Jev served the hooks from 2026-10-06 to 2026-10-08 and was taken out of serving (ops.js:orient):
// its servings on the Click rerun were true, nearby and costly, and it was an outage away from
// serving nothing. Learning decisions and review still call it; serving never does.
test('serving never calls Jev, whatever the config says', async t => {
  const seen = [];
  const notes = [note('member', { answers: ['avoid duplicate membership'], body: 'src/a.py:invite checks membership first', deps: [{ path: 'src/a.py' }] })];
  const store = fixture(t, notes, transport(() => 0.99, seen));
  const hook = await orient(store, { task: 'avoid duplicate membership', maxNotes: 2, backgroundVerify: false });
  const agent = await orient(store, { task: 'avoid duplicate membership', maxNotes: 5, backgroundVerify: false });
  const l = await lookup(store, { query: 'avoid duplicate membership' });
  assert.ok(hook.included.length && agent.included.length && l.included.length, 'the lexical ranking serves the note');
  assert.equal(seen.length, 0, 'no request reached Jev');
});
