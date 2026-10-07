import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
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

test('learning judgments distinguish disabled and validated responses, and meter failures', async () => {
  const events = [];
  const store = { config: () => ({ jev: false, maintain: { dailyTokens: 0, dailyJevTokens: 0 } }), log: e => events.push(e) };
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

test('the next judgment stops after reported Jev usage reaches the Jev cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-jev-cap-'));
  try {
    const store = new Store(dir).init();
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyJevTokens: 25 } }));
    let calls = 0;
    const cfg = { enabled: true, key: 'test', fetchImpl: async (...args) => { calls++; return transport(valid)(...args); } };
    const request = { state: {}, questions, purpose: 'jev-grounding' };
    assert.equal((await judgeWithJev(store, request, cfg)).status, 'ok');
    const result = await judgeWithJev(store, request, cfg);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'dailyJevTokens');
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A typed decision is what licenses writing a note at all, so a day of distillation must not stop it:
// the two budgets are counted apart (maintain.js:spentToday / jevSpentToday).
test('a spent generative budget does not stop a typed decision', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-jev-split-cap-'));
  try {
    const store = new Store(dir).init();
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyTokens: 1, dailyJevTokens: 10_000 } }));
    store.log({ op: 'model', phase: 'learning', purpose: 'distill', provider: 'claude', model: 'sonnet', tokens: { totalTokens: 500_000 } });
    let calls = 0;
    const cfg = { enabled: true, key: 'test', fetchImpl: async (...args) => { calls++; return transport(valid)(...args); } };
    const result = await judgeWithJev(store, { state: {}, questions, purpose: 'jev-grounding' }, cfg);
    assert.equal(result.status, 'ok');
    assert.equal(calls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('test mode prohibits automatic production transport even when explicitly enabled', async () => {
  const events = [];
  const store = { config: () => ({ maintain: { dailyTokens: 0, dailyJevTokens: 0 } }), log: e => events.push(e) };
  const result = await judgeWithJev(store, { state: {}, questions, purpose: 'test' }, { enabled: true, key: 'test' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /network disabled in tests/);
});

test('malformed responses retry once with identical input and retain each metered attempt', async () => {
  const events = [], requests = [];
  const store = { config: () => ({}), log: e => events.push(e) };
  const result = await judgeWithJev(store, { state: { pr: 3158 }, questions, purpose: 'jev-grounding', phase: 'init' }, {
    enabled: true, key: 'test', model: 'jev-pinned', fetchImpl: async (_url, options) => {
      requests.push(options.body);
      return transport(requests.length === 1 ? undefined : valid)();
    },
  });
  assert.equal(result.status, 'ok'); assert.equal(result.attempts, 2);
  assert.equal(requests[0], requests[1]);
  assert.deepEqual(events.map(e => [e.attempt, !!e.failed]), [[1, true], [2, false]]);
  assert.equal(events[0].errorCode, 'JEV_INVALID_RESPONSE');
  assert.equal(events[0].errorQuestion, 'relation');
  assert.match(events[0].errorReason, /missing answer/);
  assert.equal(events.reduce((sum, e) => sum + e.tokens.totalTokens, 0), 50);
});

test('persistent schema failure is bounded; valid negatives and authentication failures never retry', async () => {
  for (const mode of ['malformed', 'negative', 'forbidden', 'transient']) {
    let calls = 0;
    const s = { config: () => ({}), log() {} };
    const r = await judgeWithJev(s, { state: {}, questions, purpose: 'test', phase: 'init' }, {
      enabled: true, key: 'test', fetchImpl: async () => {
        calls++;
        if (mode === 'forbidden' || mode === 'transient') return { ok: false, status: mode === 'forbidden' ? 403 : 503 };
        return transport(mode === 'malformed' ? undefined : { ...valid, choice: 'new', probabilities: { covered: .05, new: .95 } })();
      },
    });
    assert.equal(calls, ['malformed', 'transient'].includes(mode) ? 2 : 1, mode);
    assert.equal(r.status, mode === 'negative' ? 'ok' : 'unavailable', mode);
  }
});

test('external cancellation and daily budget prevent retries', async t => {
  const controller = new AbortController();
  let calls = 0;
  const s = { config: () => ({}), log() {} };
  const aborted = await judgeWithJev(s, { state: {}, questions, purpose: 'test', phase: 'init' }, {
    enabled: true, key: 'test', signal: controller.signal, fetchImpl: async () => {
      calls++; controller.abort(); throw new DOMException('Aborted', 'AbortError');
    },
  });
  assert.equal(aborted.status, 'unavailable'); assert.equal(calls, 1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-retry-cap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir).init();
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyJevTokens: 25 } }));
  calls = 0;
  const capped = await judgeWithJev(store, { state: {}, questions, purpose: 'test' }, {
    enabled: true, key: 'test', fetchImpl: async () => { calls++; return transport(undefined)(); },
  });
  assert.equal(capped.reason, 'dailyJevTokens'); assert.equal(calls, 1);
});

test('invalid JSON retries but errors retain their type and no source payload reaches logs', async () => {
  const events=[];let calls=0;
  const result=await judgeWithJev({config:()=>({}),log:e=>events.push(e)}, {state:{privateSource:'source text'},questions,purpose:'test',phase:'init'}, {
    enabled:true,key:'test',fetchImpl:async()=>{calls++;return calls===1 ? {ok:true,json:async()=>{throw new SyntaxError('bad JSON')}} : transport(valid)();},
  });
  assert.equal(result.status,'ok');assert.equal(calls,2);
  assert.equal(events[0].errorReason,'invalid JSON');
  assert.equal(events[0].errorQuestion,'response');
  assert.ok(!JSON.stringify(events).includes('privateSource'));
});
