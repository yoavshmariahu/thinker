import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSearchSummaries, summaryFidelityRequest } from '../src/summary-fidelity.js';
import { phraseNotes } from '../src/ops.js';
import { phraseKey, searchText } from '../src/note-search.js';
import { Store } from '../src/store.js';

const note = (id, extra = {}) => ({ id, kind: 'rule', title: 'Retry policy',
  body: 'src/jobs.js:retry retries failed jobs only before delivery. Never retry a delivered job.',
  applies: 'Worker jobs only; excludes billing jobs.', deps: [{ path: 'src/jobs.js', symbol: 'retry' }], ...extra });
const faithful = 'Worker jobs can retry before delivery. Delivered jobs must never retry. Billing jobs are excluded; src/jobs.js:retry owns this rule.';
function fixture(t, fetchImpl, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir).init();
  store.config = () => ({ jev: { enabled, key: 'test', fetchImpl }, maintenance: { dailyTokens: 0 } });
  return store;
}
function transport(decide, seen = []) {
  return async (_url, { body }) => {
    const request = JSON.parse(body); seen.push(request);
    assert.ok(Buffer.byteLength(body, 'utf8') <= 30000);
    assert.ok(Object.keys(request.questions).length <= 32);
    return { ok: true, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 20, output_tokens: 4 },
      answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: decide(key, request) }])) }) };
  };
}
const generated = entries => async () => ({ json: { notes: entries.map((search, i) => ({ n: i + 1, says: ['Please retry failed worker jobs'], search })) }, tokens: { totalTokens: 100 } });

test('fidelity state retains full source, applicability and symbol pointers with separate support and scope checks', () => {
  const n = note('a', { body: 'Detail.\n'.repeat(200) + 'Never retry after delivery.' });
  const request = summaryFidelityRequest([{ note: n, search: faithful }]);
  assert.equal(request.state.summaries[0].source.body, n.body);
  assert.equal(request.state.summaries[0].source.applies, n.applies);
  assert.deepEqual(request.state.summaries[0].source.pointers, n.deps);
  assert.deepEqual(Object.keys(request.questions), ['support0', 'scope0']);
});

test('summary judgment accepts faithful descriptions and rejects invented or broadened and uncertain ones independently', async t => {
  const seen = [];
  const store = fixture(t, transport(key => ({ support0: .98, scope0: .96, support1: .2, scope1: .99, support2: .98, scope2: .1, support3: .95, scope3: .6 })[key], seen));
  const candidates = [faithful, 'Retries use exponential backoff.', 'All jobs retry failures.', 'Maybe the rule permits retries.'].map((search, i) => ({ note: note(String(i)), search }));
  const result = await checkSearchSummaries(store, candidates);
  assert.deepEqual(result.results.map(r => r.accepted), [true, false, false, false]);
  assert.equal(result.tokens, 24);
  assert.equal(seen.length, 1);
});

test('phrase writes only accepted summaries and does not stamp rejected summaries current', async t => {
  const store = fixture(t, transport(key => key === 'scope1' ? .1 : .98));
  const good = note('good'), bad = note('bad', { search: 'Obsolete description.', saysFor: 'old-key' });
  for (const n of [good, bad]) store.put(n);
  const result = await phraseNotes(store, [good, bad], { completeFn: generated([faithful, 'All worker and billing jobs may retry after delivery.']) });
  assert.deepEqual(result.done, ['good']);
  assert.equal(store.get('good').saysFor, phraseKey(good));
  assert.equal(searchText(store.get('good')), faithful);
  assert.equal(store.get('bad').saysFor, 'old-key');
  assert.equal(searchText(store.get('bad')), bad.body);
  assert.equal(result.deferred[0].status, 'rejected');
  assert.equal(result.tokens, 124);
});

test('a failed check preserves an existing valid summary; disabled Jev retains legacy phrasing', async t => {
  const store = fixture(t, async () => ({ ok: false, status: 503 }));
  const n = note('known', { search: faithful }); n.saysFor = phraseKey(n); store.put(n);
  const next = 'Worker retries are allowed before delivery, except for billing jobs. Delivered jobs cannot retry.';
  const result = await phraseNotes(store, [n], { completeFn: generated([next]) });
  assert.deepEqual(result.done, []);
  assert.equal(result.deferred[0].status, 'unavailable');
  assert.equal(searchText(store.get(n.id)), faithful);
  store.config = () => ({ jev: { enabled: false } });
  const disabled = await phraseNotes(store, [n], { completeFn: generated([next]) });
  assert.deepEqual(disabled.done, [n.id]);
  assert.equal(searchText(store.get(n.id)), next);
});

test('edits or deletion during the check cannot install stale summaries or resurrect notes', async t => {
  let store;
  store = fixture(t, transport(() => { store.put(note('edited', { body: 'New rule.' })); store.remove('deleted'); return .99; }));
  const notes = [note('edited'), note('deleted')]; notes.forEach(n => store.put(n));
  const result = await phraseNotes(store, notes, { completeFn: generated([faithful, faithful]) });
  assert.deepEqual(result.done, []);
  assert.equal(store.get('edited').search, undefined);
  assert.equal(store.get('deleted'), null);
});

test('batching respects the full UTF-8 envelope and oversized source defers without truncating evidence', async t => {
  const seen = [], store = fixture(t, transport(() => .99, seen));
  const candidates = Array.from({ length: 25 }, (_, i) => ({ note: note(String(i), { body: '界'.repeat(900) }), search: faithful }));
  candidates.splice(1, 0, { note: note('huge', { body: '界'.repeat(15000) }), search: faithful });
  const result = await checkSearchSummaries(store, candidates);
  assert.equal(result.results.filter(r => r.accepted).length, 25);
  assert.equal(result.results[1].status, 'unavailable');
  assert.ok(seen.length > 1);
  assert.equal(seen.flatMap(r => r.state.summaries).length, 25);
});
