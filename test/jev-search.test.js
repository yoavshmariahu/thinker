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

test('Jev searches past the lexical gate for lookup and both hook and agent orientation', async t => {
  const n = note('hidden-rule', { search: 'A customer cannot receive another invitation after joining.' });
  n.saysFor = phraseKey(n);
  assert.equal(rank([n], { query: 'avoid duplicate membership', mode: 'lookup' }).length, 0);
  const seen = [];
  const store = fixture(t, [n], transport(() => 0.95, seen));
  const l = await lookup(store, { query: 'avoid duplicate membership' });
  const hook = await orient(store, { task: 'avoid duplicate membership', maxNotes: 2 });
  const agent = await orient(store, { task: 'avoid duplicate membership', maxNotes: 5 });
  for (const r of [l, hook, agent]) assert.deepEqual(r.included.map(n => n.id), ['hidden-rule']);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(r => r.state.candidate_notes[0].claim === n.search));
});

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

test('eligibility, kind filters, exact IDs and behavior listings retain their semantics', async t => {
  const notes = [note('fresh'), note('archived', { archived: { reason: 'test' } }), note('invalid', { status: 'invalid' }), note('stale', { status: 'stale' })];
  const seen = [];
  const rows = await jevSearch(notes, 'query', { freshOnly: true, key: 'test', fetchImpl: transport(() => 0.9, seen) });
  assert.deepEqual(rows.map(r => r.note.id), ['fresh']);
  assert.deepEqual(seen[0].state.candidate_notes.map(n => n.title), ['fresh']);
  const store = fixture(t, [...notes, note('human-rule', { kind: 'behavior' })], transport(() => 0.9, seen));
  assert.equal((await lookup(store, { query: 'archived' })).included[0].id, 'archived');
  assert.equal((await lookup(store, { kind: 'behavior' })).included[0].id, 'human-rule');
  assert.equal(seen.length, 1, 'IDs and kind-only listing never call Jev');
  await lookup(store, { query: 'some question', kind: 'behavior' });
  assert.deepEqual(seen[1].state.candidate_notes.map(n => n.kind), ['behavior']);
});

test('a successful no-match decision is final, while a failed request falls back to lexical search', async t => {
  const n = note('retry-rule', { title: 'Retry worker requests', body: 'Retry worker requests after a timeout.', answers: ['retry worker requests'] });
  const store = fixture(t, [n], transport(() => 0.1));
  const query = 'retry worker requests';
  assert.ok(rank([n], { query, mode: 'lookup' }).length);
  assert.equal((await lookup(store, { query })).included.length, 0);
  const empty = await orient(store, { task: query });
  assert.equal(empty.included.length, 0);
  assert.equal(empty.more.length, 0, 'rejected lexical candidates must not reappear as recommended titles');
  store.config = () => ({ jev: { enabled: true, key: 'test', fetchImpl: async () => ({ ok: false, status: 503 }) }, ce: false, snippets: false });
  assert.equal((await lookup(store, { query })).included[0].id, n.id);
  assert.equal((await orient(store, { task: query })).included[0].id, n.id);
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

test('once-per-session, holdouts, budgets and explicit result limits still apply with Jev', async t => {
  const notes = Array.from({ length: 5 }, (_, i) => note(`n-${i}`, { body: `Concrete guidance ${i}.`, servedIn: i ? [] : ['session'] }));
  const store = fixture(t, notes, transport(() => 0.9));
  const once = await orient(store, { task: 'specific mechanism', session: 'session', once: true, maxNotes: 5, budget: 3000 });
  assert.deepEqual(once.included.map(n => n.id), ['n-1', 'n-2', 'n-3', 'n-4']);
  const held = await orient(store, { task: 'specific mechanism', session: 'control', holdout: true });
  assert.equal(held.included.length, 0); assert.ok(held.withheld.length);
  assert.ok(store.list().every(n => !n.servedIn?.includes('control')));
  assert.equal((await lookup(store, { query: 'some query', maxNotes: 1 })).included.length, 1);
  assert.equal((await lookup(store, { query: 'some query', budget: 1 })).included.length, 0);
});

test('subjectless orientation does not search the catalog, while a short explicit lookup can', async t => {
  const seen = [];
  const store = fixture(t, [note('retry-rule')], transport(() => 0.9, seen));
  assert.equal((await orient(store, { task: 'status?' })).included.length, 0);
  assert.equal(seen.length, 0);
  await lookup(store, { query: 'retry' });
  assert.equal(seen.length, 1);
});
