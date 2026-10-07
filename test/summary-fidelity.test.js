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
// One writer whose answers differ per call, so a retry is visible: each call describes the notes it
// was given, taking the next entry of `passes` for each.
const writer = passes => { let call = 0; return async ({ prompt }) => {
  const count = (prompt.match(/^\[\d+\] kind=/gm) || []).length;
  const texts = passes[Math.min(call++, passes.length - 1)];
  return { json: { notes: Array.from({ length: count }, (_, i) => ({ n: i + 1, says: ['Please retry failed worker jobs'], search: texts[i] ?? texts[texts.length - 1] })) }, tokens: { totalTokens: 100 } };
}; };

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

test('a refused description is written again once, and the second refusal is final', async t => {
  // The judge refuses whatever claims billing jobs retry, whichever attempt wrote it.
  const store = fixture(t, transport((key, request) => {
    const i = key.replace(/\D/g, '');
    return /billing jobs may retry/.test(request.state.summaries[i].search) ? .2 : .95;
  }));
  const good = note('good'), bad = note('bad', { search: 'Obsolete description.', saysFor: 'old-key' });
  for (const n of [good, bad]) store.put(n);
  const result = await phraseNotes(store, [good, bad], {
    completeFn: writer([[faithful, 'All worker and billing jobs may retry after delivery.'],
                        ['All worker and billing jobs may retry after delivery, every time.']]) });
  assert.deepEqual(result.done, ['good'], 'only the faithful description is stored');
  assert.equal(searchText(store.get('good')), faithful);
  assert.equal(store.get('bad').saysFor, 'old-key', 'a refused description never stamps the key current');
  assert.equal(searchText(store.get('bad')), bad.body, 'the note falls back to its body');
  assert.equal(result.deferred[0].status, 'rejected');
  const refused = store.get('bad').phraseRefused;
  assert.equal(refused.key, phraseKey(store.get('bad')), 'the refusal records the key it was for');
  assert.ok(refused.support <= 0.7 || refused.scope <= 0.7, 'and the scores that refused it');
});

test('a check that could not run leaves the note for a later run, not refused for good', async t => {
  // The daily token cap, a quota or a transport failure all arrive as `unavailable`. Recording that
  // as a refusal would stop maintenance describing the note ever again.
  const store = fixture(t, async () => ({ ok: false, status: 429, json: async () => ({ error: 'dailyTokens' }) }));
  const n = note('capped');
  store.put(n);
  const result = await phraseNotes(store, [n], { completeFn: generated([faithful]) });
  assert.deepEqual(result.done, [], 'nothing is stored when the check could not run');
  assert.equal(result.deferred[0].status, 'unavailable');
  assert.equal(store.get('capped').phraseRefused, undefined, 'and the note is not refused for good');
  assert.equal(searchText(store.get('capped')), n.body);
});

test('a rewritten description that satisfies the check is kept', async t => {
  const store = fixture(t, transport((key, request) => {
    const i = key.replace(/\D/g, '');
    return /billing jobs may retry/.test(request.state.summaries[i].search) ? .2 : .95;
  }));
  const n = note('fixable');
  store.put(n);
  const result = await phraseNotes(store, [n], {
    completeFn: writer([['All worker and billing jobs may retry after delivery.'], [faithful]]) });
  assert.deepEqual(result.done, ['fixable'], 'the retry is what gets stored');
  assert.equal(searchText(store.get('fixable')), faithful);
  assert.equal(store.get('fixable').phraseRefused, undefined, 'nothing is recorded as refused');
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
