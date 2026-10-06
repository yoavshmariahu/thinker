// Jev serving reranker. Every call here uses a fake fetch: no test ever contacts the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JEV_DEFAULTS, buildRequest, forgetKey, jevConfig, jevKey, jevRerank, jevScores, jevStatus, keyFile, noteRecord, saveKey, selectByJev } from '../src/jev.js';

const note = (id, over = {}) => ({ id, kind: 'rule', title: `t ${id}`, answers: [`q ${id}`], body: `line one about ${id}\nline two`, deps: [{ path: 'src/a.js', symbol: 'f' }], status: 'fresh', ...over });
const withHome = fn => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-')); const prev = process.env.THINKER_HOME; process.env.THINKER_HOME = dir;
  const keep = { k: process.env.THINKER_JEV_KEY, j: process.env.JEV_API_KEY, t: process.env.TYPESAFE_API_KEY };
  delete process.env.THINKER_JEV_KEY; delete process.env.JEV_API_KEY; delete process.env.TYPESAFE_API_KEY;
  try { return fn(dir); } finally { prev === undefined ? delete process.env.THINKER_HOME : (process.env.THINKER_HOME = prev);
    for (const [k, v] of [['THINKER_JEV_KEY', keep.k], ['JEV_API_KEY', keep.j], ['TYPESAFE_API_KEY', keep.t]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
    fs.rmSync(dir, { recursive: true, force: true }); } };
const okFetch = scores => async () => ({ ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', answers: Object.fromEntries(scores.map((s, i) => [`rel${i}`, { type: 'noul', noul: s }])), usage: { input_tokens: 10, output_tokens: 0 } }) });

test('selectByJev keeps those at or above the floor, best first, at most maxNotes', () => {
  const rows = [{ id: 'a', jev: 0.9 }, { id: 'b', jev: 0.4 }, { id: 'c', jev: 0.7 }];
  assert.deepEqual(selectByJev(rows, { floor: 0.5, maxNotes: 2 }).map(r => r.id), ['a', 'c']);
  assert.deepEqual(selectByJev(rows, { floor: 0.5, maxNotes: 1 }).map(r => r.id), ['a']);
});

test('selectByJev serves nothing when nothing clears the floor (no fallback, unlike the cross-encoder)', () => {
  assert.deepEqual(selectByJev([{ id: 'a', jev: 0.2 }, { id: 'b', jev: 0.1 }], { floor: 0.5 }), []);
});

test('noteRecord gives Jev named fields, not a prose blob', () => {
  const r = noteRecord(note('n1', { status: 'stale' }), 3);
  assert.equal(r.index, 3);
  assert.equal(r.kind, 'rule');
  assert.equal(r.freshness, 'stale');
  assert.deepEqual(r.code_it_points_at, ['src/a.js:f']);
  assert.deepEqual(r.answers_the_questions, ['q n1']);
  assert.ok(r.claim.includes('line one'));
});

test('buildRequest asks one noul per candidate, keyed by index', () => {
  const b = buildRequest('do a thing', [note('a'), note('b')]);
  assert.equal(b.model, JEV_DEFAULTS.model);
  assert.deepEqual(Object.keys(b.questions), ['rel0', 'rel1']);
  assert.equal(b.questions.rel0.type, 'noul');
  assert.equal(b.questions.rel0.instructions.request, 'do a thing');
  assert.equal(b.state.developer_request, 'do a thing');
  assert.equal(b.state.candidate_notes.length, 2);
});

test('jevScores returns one probability per note, in order', async () => {
  const s = await jevScores('q', [note('a'), note('b')], { key: 'k', fetchImpl: okFetch([0.8, 0.2]) });
  assert.deepEqual(s, [0.8, 0.2]);
});

test('jevScores throws on a failed call, an empty body, or a missing answer, so serving falls back', async () => {
  await assert.rejects(jevScores('q', [note('a')], { key: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) }), /jev 429/);
  await assert.rejects(jevScores('q', [note('a')], { key: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), /no answers/);
  await assert.rejects(jevScores('q', [note('a'), note('b')], { key: 'k', fetchImpl: okFetch([0.8]) }), /missing rel1/);
  await assert.rejects(jevScores('q', [note('a')], { key: null }), /no jev key/);
});

test('jevRerank scores only the first k and returns the selection', async () => {
  let seen = 0;
  const fetchImpl = async (_u, o) => { seen = JSON.parse(o.body).state.candidate_notes.length; return (await okFetch([0.9, 0.6, 0.1])()); };
  const ranked = [note('a'), note('b'), note('c'), note('d')].map(n => ({ note: n }));
  const out = await jevRerank(ranked, 'q', { key: 'k', k: 3, floor: 0.5, maxNotes: 2, fetchImpl });
  assert.equal(seen, 3);
  assert.deepEqual(out.map(r => r.note.id), ['a', 'b']);
  assert.equal(out[0].jev, 0.9);
});

test('a key round-trips through the thinker home and is owner-readable only', () => withHome(() => {
  assert.equal(jevKey(), null);
  const where = saveKey('  secret-key  ');
  assert.equal(jevKey(), 'secret-key');
  assert.equal(where, keyFile());
  if (process.platform !== 'win32') assert.equal(fs.statSync(where).mode & 0o777, 0o600);
  assert.equal(forgetKey(), true);
  assert.equal(jevKey(), null);
}));

test('the key is never written into the repository', () => withHome(dir => {
  assert.ok(saveKey('k').startsWith(dir), 'key must live under THINKER_HOME');
}));

test('enabled defaults to auto: on with a key, off without', () => withHome(() => {
  const store = { config: () => ({}) };
  assert.equal(jevConfig(store).enabled, false);
  saveKey('k');
  assert.equal(jevConfig(store).enabled, true);
  assert.equal(jevStatus(store).key, true);
}));

test('config and environment override the defaults', () => withHome(() => {
  assert.equal(jevConfig({ config: () => ({ jev: false }) }).enabled, false);
  saveKey('k');
  assert.equal(jevConfig({ config: () => ({ jev: { floor: 0.9, maxNotes: 1 } }) }).floor, 0.9);
  process.env.THINKER_JEV = 'off';
  assert.equal(jevConfig({ config: () => ({}) }).enabled, false);
  process.env.THINKER_JEV = 'on';
  process.env.THINKER_JEV_FLOOR = '0.25';
  process.env.THINKER_JEV_MAX = '3';
  const c = jevConfig({ config: () => ({}) });
  assert.equal(c.enabled, true); assert.equal(c.floor, 0.25); assert.equal(c.maxNotes, 3);
  delete process.env.THINKER_JEV; delete process.env.THINKER_JEV_FLOOR; delete process.env.THINKER_JEV_MAX;
}));

test('an environment key is preferred over the file and reported as such', () => withHome(() => {
  saveKey('from-file');
  process.env.THINKER_JEV_KEY = 'from-env';
  assert.equal(jevKey(), 'from-env');
  assert.equal(jevStatus({ config: () => ({}) }).source, 'environment');
  delete process.env.THINKER_JEV_KEY;
}));

test('jevRerank reports every candidate score through onScores, not just the selected ones', async () => {
  const seen = [];
  const ranked = [note('a'), note('b'), note('c')].map(n => ({ note: n }));
  const out = await jevRerank(ranked, 'q', { key: 'k', floor: 0.5, maxNotes: 2, fetchImpl: okFetch([0.9, 0.1, 0.6]), onScores: rows => seen.push(...rows.map(r => r.jev)) });
  assert.deepEqual(seen, [0.9, 0.1, 0.6], 'every candidate is reported');
  assert.deepEqual(out.map(r => r.note.id), ['a', 'c'], 'only those above the floor are served');
});
