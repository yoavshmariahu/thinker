// Review step gates. Every call uses an injected fetch: no test contacts the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GATES, changeRecord, reviewGates } from '../src/gates.js';
import { saveKey } from '../src/jev.js';

const change = {
  files: [{ path: 'src/a.js', hunks: [{ lines: ['+export function widgetTotal(items) {', '+  return items.length;', '-  return 0;'] }] }],
};
const symbols = [{ path: 'src/a.js', changed: ['widgetTotal'], removed: [] }];
const NAMES = Object.keys(GATES);
const reply = scores => async () => ({ ok: true, status: 200, json: async () => ({
  answers: Object.fromEntries(scores.map((s, i) => [`rel${i}`, { type: 'noul', noul: s }])), usage: { input_tokens: 1, output_tokens: 0 } }) });
// run inside a throwaway home with THINKER_TEST cleared, so `auto` resolves on
const withJev = async fn => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-'));
  const prevHome = process.env.THINKER_HOME, prevTest = process.env.THINKER_TEST;
  process.env.THINKER_HOME = home; delete process.env.THINKER_TEST;
  try { saveKey('k'); return await fn(); } finally {
    prevHome === undefined ? delete process.env.THINKER_HOME : (process.env.THINKER_HOME = prevHome);
    prevTest === undefined ? delete process.env.THINKER_TEST : (process.env.THINKER_TEST = prevTest);
    fs.rmSync(home, { recursive: true, force: true });
  }
};
const store = extra => ({ config: () => ({ jev: { ...extra } }), log: () => {} });

test('changeRecord describes the change as named fields', () => {
  const r = changeRecord(change, symbols);
  assert.deepEqual(r.files_changed, ['src/a.js']);
  assert.equal(r.file_count, 1);
  assert.equal(r.lines_added, 2);
  assert.equal(r.lines_removed, 1);
  assert.deepEqual(r.definitions_touched, ['widgetTotal']);
  assert.ok(r.identifiers_added.includes('widgetTotal'));
});

test('every gate is decided in one call', async () => await withJev(async () => {
  let calls = 0, body = null;
  const fetchImpl = async (_u, o) => { calls++; body = JSON.parse(o.body); return (await reply(NAMES.map(() => 0.9))())(); };
  const r = await reviewGates(store({ fetchImpl: async (u, o) => { calls++; body = JSON.parse(o.body); return (await reply(NAMES.map(() => 0.9))()); } }), change, symbols);
  assert.equal(calls, 1, 'one request for all of them');
  assert.equal(Object.keys(body.questions).length, NAMES.length, 'one question per gate');
  assert.equal(Object.keys(body.state)[0], 'the_change');
  // each gate carries its own criteria, not a shared one
  assert.notDeepEqual(body.questions.rel0.criteria, body.questions.rel1.criteria);
  assert.equal(r.source, 'jev');
}));

test('a gate runs its step at or above its threshold', async () => await withJev(async () => {
  const at = Object.fromEntries(NAMES.map((n, i) => [n, i]));
  const scores = NAMES.map(n => GATES[n].act);            // exactly on the threshold
  const r = await reviewGates(store({ fetchImpl: reply(scores) }), change, symbols);
  for (const n of NAMES) assert.equal(r.gates[n].run, true, `${n} runs at exactly its threshold`);
  const below = NAMES.map(n => GATES[n].act - 0.01);
  const r2 = await reviewGates(store({ fetchImpl: reply(below) }), change, symbols);
  for (const n of NAMES) assert.equal(r2.gates[n].run, false, `${n} does not run just below it`);
  assert.ok(at);
}));

test('skipping the review needs near-certainty; doing it does not', async () => await withJev(async () => {
  // worth_reviewing is the only gate whose `false` silences work, so its bar to skip is high
  assert.ok(GATES.worth_reviewing.act <= 0.2, 'the bar to skip must stay low enough that doubt reviews');
  assert.equal(GATES.worth_reviewing.fallback, true, 'no answer still reviews');
  const i = NAMES.indexOf('worth_reviewing');
  const mid = NAMES.map(() => 0); mid[i] = 0.2;
  const r = await reviewGates(store({ fetchImpl: reply(mid) }), change, symbols);
  assert.equal(r.gates.worth_reviewing.run, true, 'a merely uncertain change is still reviewed');
  const sure = NAMES.map(() => 0); sure[i] = 0.05;
  const r2 = await reviewGates(store({ fetchImpl: reply(sure) }), change, symbols);
  assert.equal(r2.gates.worth_reviewing.run, false, 'only a confident no skips it');
}));

test('a failed call leaves every step at the behaviour review has without gates', async () => await withJev(async () => {
  const logged = [];
  const s = { config: () => ({ jev: { fetchImpl: async () => ({ ok: false, status: 503 }) } }), log: r => logged.push(r) };
  const r = await reviewGates(s, change, symbols);
  assert.equal(r.source, 'error');
  for (const n of NAMES) assert.equal(r.gates[n].run, GATES[n].fallback, `${n} falls back`);
  assert.equal(r.gates.worth_reviewing.run, true, 'and the review still happens');
  assert.equal(logged.filter(x => x.op === 'jev-error' && x.where === 'review-gates').length, 1);
}));

test('with Jev off the gates decide nothing and review behaves as before', async () => {
  const r = await reviewGates({ config: () => ({ jev: false }), log: () => {} }, change, symbols);
  assert.equal(r.source, 'default');
  for (const n of NAMES) assert.equal(r.gates[n].run, GATES[n].fallback);
  assert.equal(r.gates[NAMES[0]].p, null);
});

test('an empty change is never gated', async () => await withJev(async () => {
  const r = await reviewGates(store({ fetchImpl: reply([1, 1, 1, 1, 1]) }), { files: [] }, []);
  assert.equal(r.source, 'default');
}));
