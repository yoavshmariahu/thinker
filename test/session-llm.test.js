// The session provider: a build's model call waits in the queue until the session's subagent answers it
// through warmup_next and warmup_answer (session-llm.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { viaSession, nextRequest, answerRequest, requestText, markBuild, buildRunning, requestBuild, buildRequested } from '../src/session-llm.js';
import { complete } from '../src/llm.js';

const queue = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-session-'));
const SCHEMA = { type: 'object', properties: { notes: { type: 'array' } }, required: ['notes'] };

test('a model call round-trips through the queue, and a malformed answer is refused for another try', async () => {
  const dir = queue();
  markBuild(dir, process.pid);
  const call = viaSession({ system: 'Turn the PR into notes.', prompt: 'PR #1: fix', schema: SCHEMA }, { dir, pollMs: 10 });
  const { request } = await nextRequest(dir, { waitMs: 2000, pollMs: 10 });
  assert.equal(request.prompt, 'PR #1: fix');
  assert.match(requestText(request), /warmup_answer: id ".+" and answer, one JSON object/);
  // taken: a second taker finds nothing
  assert.deepEqual(await nextRequest(dir, { waitMs: 50, pollMs: 10 }), { waiting: true });
  assert.match(answerRequest(dir, request.id, 'no idea').error, /not JSON/);
  assert.match(answerRequest(dir, request.id, '{"other": 1}').error, /notes/);
  assert.deepEqual(answerRequest(dir, request.id, '```json\n{"notes": [{"title": "t"}]}\n```'), { ok: true });
  const r = await call;
  assert.deepEqual(r.json, { notes: [{ title: 't' }] });
  assert.match(answerRequest(dir, request.id, '{"notes": []}').error, /no request/);
});

test('nobody working the queue fails the call; an ended build tells the subagent to stop', async () => {
  const dir = queue();
  await assert.rejects(viaSession({ prompt: 'p' }, { dir, pollMs: 10, unclaimedMs: 50 }), /no agent session answered/);
  assert.deepEqual(fs.readdirSync(dir), []);
  markBuild(dir, 2 ** 22 + 12345); // no such process
  assert.equal(buildRunning(dir), false);
  assert.deepEqual(await nextRequest(dir, { waitMs: 50 }), { done: true });
});

test('THINKER_LLM=session routes complete() to the queue and labels the model session', async () => {
  const dir = queue();
  const saved = { llm: process.env.THINKER_LLM, q: process.env.THINKER_SESSION_QUEUE };
  process.env.THINKER_LLM = 'session'; process.env.THINKER_SESSION_QUEUE = dir;
  try {
    markBuild(dir, process.pid);
    const call = complete({ prompt: 'say ok', maxTokens: 10 });
    const { request } = await nextRequest(dir, { waitMs: 3000, pollMs: 10 });
    answerRequest(dir, request.id, 'ok');
    const r = await call;
    assert.equal(r.text, 'ok'); assert.equal(r.model, 'session');
  } finally {
    for (const [k, v] of [['THINKER_LLM', saved.llm], ['THINKER_SESSION_QUEUE', saved.q]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('a build asked for by the session is started by the taker; a queue that never had a build waits before it is done', async () => {
  const dir = queue();
  // the subagent came first: nothing asked for yet, so it waits out its wait instead of being told to stop
  const t0 = Date.now();
  assert.deepEqual(await nextRequest(dir, { waitMs: 150, pollMs: 10, start: () => assert.fail('nothing was asked for') }), { done: true });
  assert.ok(Date.now() - t0 >= 140);
  requestBuild(dir);
  assert.ok(buildRequested(dir)); assert.ok(!buildRequested(dir, { maxAgeMs: -1 }), 'an old request is not one');
  let started = 0;
  const call = nextRequest(dir, { waitMs: 2000, pollMs: 10, start: () => { started++; fs.rmSync(path.join(dir, 'build-request.json')); markBuild(dir, process.pid); } });
  const answer = viaSession({ prompt: 'PR #2' }, { dir, pollMs: 10 });
  const { request } = await call;
  assert.equal(started, 1); assert.equal(request.prompt, 'PR #2');
  answerRequest(dir, request.id, 'ok'); await answer;
  // a start that fails is the subagent's answer
  const other = queue(); requestBuild(other);
  assert.deepEqual(await nextRequest(other, { waitMs: 50, pollMs: 10, start: () => ({ error: 'spawn EPERM' }) }), { error: 'spawn EPERM' });
});
