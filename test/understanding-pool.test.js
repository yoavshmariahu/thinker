// Understanding notes as their own serving pool at the prompt hook (dense.js:UNDERSTANDING_POOL, ops.js:orient):
// off by default until an experiment shows it helps; on, the cross-encoder's best understanding note is served
// beside the other notes, below the floor when it scores at least the fallback floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ceConfig, UNDERSTANDING_POOL, rankerStatus } from '../src/dense.js';
import { Store } from '../src/store.js';
import { createNote, orient } from '../src/ops.js';

test('the understanding pool is off by default; config and environment turn it on', () => {
  const env = process.env.THINKER_CE_UNDERSTANDING;
  try {
    delete process.env.THINKER_CE_UNDERSTANDING;
    assert.equal(ceConfig({ config: () => ({}) }).understanding.enabled, false);
    assert.deepEqual(ceConfig({ config: () => ({}) }).understanding, UNDERSTANDING_POOL);
    const on = ceConfig({ config: () => ({ ce: { understanding: { enabled: true, budget: 800 } } }) }).understanding;
    assert.deepEqual([on.enabled, on.budget, on.views, on.maxNotes, on.fallbackFloor], [true, 800, 'multi', 1, -4]);
    process.env.THINKER_CE_UNDERSTANDING = 'on';
    assert.equal(ceConfig({ config: () => ({}) }).understanding.enabled, true);
    process.env.THINKER_CE_UNDERSTANDING = 'off';
    assert.equal(ceConfig({ config: () => ({ ce: { understanding: { enabled: true } } }) }).understanding.enabled, false, 'the environment wins (an experiment arm)');
  } finally { if (env === undefined) delete process.env.THINKER_CE_UNDERSTANDING; else process.env.THINKER_CE_UNDERSTANDING = env; }
});

const model = (await rankerStatus().catch(() => ({}))).model;
test('on, the best understanding note is served beside the others, even below the floor', { skip: !model && 'the cross-encoder model is not installed here' }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-upool-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'gateway'));
  fs.writeFileSync(path.join(dir, 'gateway', 'gemini.py'), 'def stream_chunks(resp):\n    return resp\n\ndef tool_calls(chunk):\n    return chunk\n');
  const store = new Store(dir).init();
  createNote(store, { title: 'Gemini streaming numbers tool calls per chunk', kind: 'rule', answers: ['how are streamed gemini tool calls indexed'], body: 'gateway/gemini.py:tool_calls numbers each streamed tool call by its place in the chunk', deps: [{ path: 'gateway/gemini.py', symbol: 'tool_calls' }] }, { source: { type: 'pr', ref: '1' } });
  createNote(store, { title: 'How Gemini streaming builds tool calls for each chunk', kind: 'map', answers: ['how does the gateway stream gemini tool calls', 'where is a streamed tool call index set'], body: 'gateway/gemini.py:stream_chunks reads the Gemini stream and hands each chunk to gateway/gemini.py:tool_calls, which builds the tool calls of that chunk and sets each call index; clients merge streamed tool calls by index', deps: [{ path: 'gateway/gemini.py', symbol: 'stream_chunks' }, { path: 'gateway/gemini.py', symbol: 'tool_calls' }] }, { source: { type: 'understanding', ref: 'gateway/gemini.py' } });
  const task = 'When the gateway streams a Gemini response with several tool calls, every call gets index 0 and clients merge them. Number tool calls consecutively across the whole stream.';
  const env = { ...process.env };
  try {
    process.env.THINKER_HOLDOUT = '0';
    process.env.THINKER_CE_UNDERSTANDING = 'off';
    const off = await orient(store, { task, recordUsage: false });
    process.env.THINKER_CE_UNDERSTANDING = 'on';
    const on = await orient(store, { task, recordUsage: false });
    const kinds = r => r.included.map(n => n.source?.type).sort();
    assert.ok(kinds(on).includes('understanding'), `served on: ${kinds(on)}`);
    assert.ok(kinds(on).includes('pr'), 'the other notes keep their own rule');
    assert.ok(on.included.length >= off.included.length);
  } finally { for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); }
});
