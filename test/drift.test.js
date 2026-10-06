// The surface a note could break on, and the one verdict it licenses. Every call uses an injected
// fetch: no test contacts the API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DRIFT_BATCH, DRIFT_SURFACES, derivedVerdict, driftKey, driftStale, externalSurface, typeDrift } from '../src/drift.js';

const note = (over = {}) => ({ id: 'n1', kind: 'rule', title: 'A rule', body: 'It says a thing about src/a.js:f', deps: [{ path: 'src/a.js', symbol: 'f' }], ...over });
const typed = (surface, confidence = 0.9, n = note()) => ({ ...n, drift: { surface, confidence, key: driftKey(n) } });
const changed = (reason = 'symbol body changed') => ({ stale: { changed: [{ path: 'src/a.js', symbol: 'f', reason }] } });
// a valid Choice answer: probabilities over exactly the offered options, summing to 1, the choice highest
const choiceReply = surface => {
  const names = Object.keys(DRIFT_SURFACES);
  const probabilities = Object.fromEntries(names.map(k => [k, k === surface ? 0.8 : 0.2 / (names.length - 1)]));
  return { type: 'choice', choice: surface, probabilities, confidence: 0.75 };
};

test('the key follows the note text, so an edited note is retyped', () => {
  const a = note();
  assert.equal(driftKey(a), driftKey({ ...a }));
  assert.notEqual(driftKey(a), driftKey({ ...a, body: 'something else' }));
  assert.notEqual(driftKey(a), driftKey({ ...a, title: 'Another rule' }));
  assert.equal(driftStale(a), true, 'never typed');
  assert.equal(driftStale(typed('a_symbol_moving')), false);
  assert.equal(driftStale({ ...typed('a_symbol_moving'), body: 'edited since' }), true);
});

test('typeDrift asks one Choice per note and batches under the request limits', async () => {
  const notes = Array.from({ length: DRIFT_BATCH + 3 }, (_, i) => note({ id: `n${i}` }));
  const bodies = [];
  const fetchImpl = async (_u, o) => {
    const body = JSON.parse(o.body); bodies.push(body);
    return { ok: true, status: 200, json: async () => ({ model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 0 },
      answers: Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, choiceReply(i % 2 ? 'a_number_changing' : 'an_external_tool_changing')])) }) };
  };
  const out = await typeDrift({ config: () => ({ jev: { key: 'k', fetchImpl, enabled: true } }) }, notes);
  assert.equal(out.length, notes.length, 'every note is typed');
  assert.equal(bodies.length, 2, 'two calls for 15 notes at a batch of 12');
  assert.ok(Object.keys(bodies[0].questions).length <= DRIFT_BATCH);
  assert.ok(Object.values(bodies[0].questions).every(q => q.type === 'choice'), 'a Choice, not five Nouls');
  assert.deepEqual(Object.keys(bodies[0].questions[Object.keys(bodies[0].questions)[0]].criteria), Object.keys(DRIFT_SURFACES));
  assert.equal(out[0].key, driftKey(notes[0]), 'the key of the text it was typed from');
  assert.ok(out[0].confidence > 0 && out[0].confidence <= 1);
});

test('a note resting on an external tool is re-baselined in code, without raising its confidence', () => {
  const n = { ...typed('an_external_tool_changing'), ...changed() };
  const v = derivedVerdict('/repo', n);
  assert.equal(v.verdict, 'still_valid');
  assert.equal(v.noBump, true, 'nothing confirmed the note; it was only not refuted');
  assert.match(v.reason, /outside this repository/);
  assert.equal(externalSurface(n), true);
});

test('no other surface licenses a verdict: they go to the model', () => {
  for (const surface of Object.keys(DRIFT_SURFACES).filter(s => s !== 'an_external_tool_changing')) {
    assert.equal(derivedVerdict('/repo', { ...typed(surface), ...changed() }), null, `${surface} is not derivable`);
  }
});

test('nothing is derived from a low-confidence type, a stale key, or a vanished symbol', () => {
  assert.equal(derivedVerdict('/repo', { ...typed('an_external_tool_changing', 0.4), ...changed() }), null, 'low confidence');
  const t = typed('an_external_tool_changing');
  assert.equal(derivedVerdict('/repo', { ...t, body: 'edited since typing', ...changed() }), null, 'the note changed since');
  assert.equal(derivedVerdict('/repo', { ...t, ...changed('symbol not found') }), null, 'a vanished symbol needs the model');
  assert.equal(derivedVerdict('/repo', { ...t, ...changed('file removed') }), null, 'a removed file needs the model');
  assert.equal(derivedVerdict('/repo', t), null, 'nothing changed, nothing to verify');
  assert.equal(derivedVerdict('/repo', { ...note(), ...changed() }), null, 'never typed');
});

test('a behavior is never typed or derived: its verification is the other way round', async () => {
  const notes = [note({ id: 'b1', kind: 'behavior' })];
  let called = false;
  await typeDrift({ config: () => ({ jev: { key: 'k', enabled: true, fetchImpl: async (_u, o) => { called = true;
    const body = JSON.parse(o.body);
    return { ok: true, status: 200, json: async () => ({ model: 'm', usage: {},
      answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, choiceReply('a_symbol_moving')])) }) }; } } }) }, notes);
  assert.equal(called, true, 'typeDrift itself does not filter; maintenance does');
  // the guard that matters: verifyNote hands a behavior to verifyBehavior before any derived check
  const src = fs.readFileSync(new URL('../src/ops.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function verifyNote'));
  assert.ok(fn.indexOf("kind === 'behavior'") < fn.indexOf('derivedVerdict'), 'behaviors return before the derived path');
});
