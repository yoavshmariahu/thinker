import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jevEvaluate } from '../src/jev.js';
import { judgeWithJev } from '../src/jev-decisions.js';

const questions = { relation: { type: 'choice', instructions: 'Choose relation', criteria: { covered: 'Already known', new: 'New fact' } } };
const valid = { type: 'choice', choice: 'covered', probabilities: { covered: .95, new: .05 }, confidence: .9 };
const transport = answer => async () => ({ ok: true, json: async () => ({ model: 'jev-test', answers: { relation: answer }, usage: { input_tokens: 20, output_tokens: 5 } }) });

test('typed transport rejects missing options, invented choices and inconsistent distributions', async () => {
  for (const answer of [undefined, { ...valid, choice: 'delete' }, { ...valid, probabilities: { covered: .95 } },
    { ...valid, probabilities: { covered: .05, new: .95 } }, { ...valid, probabilities: { covered: .95, new: .95 } }]) {
    await assert.rejects(jevEvaluate({}, questions, { key: 'test', fetchImpl: transport(answer) }), /missing or invalid/);
  }
  assert.deepEqual((await jevEvaluate({}, questions, { key: 'test', fetchImpl: transport(valid) })).answers.relation, valid);
});

test('oversized UTF-8 payloads and too many questions never reach the transport', async () => {
  let calls = 0;
  const cfg = { key: 'test', fetchImpl: async () => { calls++; } };
  await assert.rejects(jevEvaluate('界'.repeat(12000), questions, cfg), /request exceeds/);
  await assert.rejects(jevEvaluate({}, Object.fromEntries(Array.from({ length: 33 }, (_, i) => [i, questions.relation])), cfg), /too many/);
  assert.equal(calls, 0);
});

test('learning judgments distinguish disabled, cap exhaustion and validated responses, and meter failures', async () => {
  const events = [];
  const store = { config: () => ({ jev: false, maintain: { dailyTokens: 0 } }), log: e => events.push(e) };
  const request = { state: {}, questions, purpose: 'jev-reconcile' };
  assert.equal((await judgeWithJev(store, request)).status, 'disabled');
  const cfg = { enabled: true, key: 'test', fetchImpl: transport(valid) };
  const result = await judgeWithJev(store, request, cfg);
  assert.equal(result.status, 'ok');
  assert.equal(events[0].tokens.totalTokens, 25);
  assert.equal(events[0].purpose, 'jev-reconcile');
  assert.equal(events[0].phase, 'learning');
  const failed = await judgeWithJev(store, request, { ...cfg, fetchImpl: transport({ ...valid, choice: 'invented' }) });
  assert.equal(failed.status, 'unavailable');
  assert.equal(events[1].failed, true);
  assert.equal(events[1].tokens.totalTokens, 25);
  assert.equal(events[1].state, undefined);
});

test('test mode prohibits automatic production transport even when explicitly enabled', async () => {
  const events = [];
  const store = { config: () => ({ maintain: { dailyTokens: 0 } }), log: e => events.push(e) };
  const result = await judgeWithJev(store, { state: {}, questions, purpose: 'test' }, { enabled: true, key: 'test' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /network disabled in tests/);
});
