import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveModel,
  TIER_MODELS,
  getFallbackOrder,
  provider,
  complete,
  resetFallback,
  FALLBACK_ORDER
} from '../src/llm.js';

test('resolveModel maps Sonnet tier across providers (Sonnet, Gemini 3.8 Flash, GPT-6 Luna)', () => {
  const prev = process.env.THINKER_LLM_MODEL;
  delete process.env.THINKER_LLM_MODEL;
  try {
    assert.equal(resolveModel('claude', 'sonnet'), 'sonnet');
    assert.equal(resolveModel('gemini', 'sonnet'), 'gemini-3.8-flash-high');
    assert.equal(resolveModel('codex', 'sonnet'), 'gpt-6-luna');
    assert.equal(resolveModel('cursor', 'sonnet'), 'sonnet');

    // Default when no model is provided is Sonnet tier
    assert.equal(resolveModel('claude', undefined), 'sonnet');
    assert.equal(resolveModel('gemini', undefined), 'gemini-3.8-flash-high');
    assert.equal(resolveModel('codex', undefined), 'gpt-6-luna');
  } finally {
    if (prev !== undefined) process.env.THINKER_LLM_MODEL = prev;
  }
});

test('resolveModel handles Haiku, Opus, custom models and THINKER_LLM_MODEL override', () => {
  const prev = process.env.THINKER_LLM_MODEL;
  delete process.env.THINKER_LLM_MODEL;
  try {
    // Haiku
    assert.equal(resolveModel('claude', 'haiku'), 'haiku');
    assert.equal(resolveModel('gemini', 'haiku'), 'gemini-3.8-flash-high');
    assert.equal(resolveModel('codex', 'haiku'), 'gpt-6-luna');

    // Opus (for future cache-building research experiments)
    assert.equal(resolveModel('claude', 'opus'), 'opus');
    assert.equal(resolveModel('gemini', 'opus'), 'gemini-3.8-flash-high');
    assert.equal(resolveModel('codex', 'opus'), 'gpt-6-luna');

    // Custom model
    assert.equal(resolveModel('codex', 'gpt-5-mini'), 'gpt-5-mini');
    assert.equal(resolveModel('gemini', 'gemini-2.5-pro'), 'gemini-2.5-pro');

    // Environment override
    process.env.THINKER_LLM_MODEL = 'custom-env-model';
    assert.equal(resolveModel('claude', 'sonnet'), 'custom-env-model');
    assert.equal(resolveModel('codex', 'sonnet'), 'custom-env-model');
  } finally {
    if (prev !== undefined) process.env.THINKER_LLM_MODEL = prev;
    else delete process.env.THINKER_LLM_MODEL;
  }
});

test('getFallbackOrder enforces claude -> gemini -> codex fallback priority', () => {
  resetFallback();
  const prevLlm = process.env.THINKER_LLM;
  const prevPrefer = process.env.THINKER_LLM_PREFER;
  delete process.env.THINKER_LLM;
  delete process.env.THINKER_LLM_PREFER;

  try {
    assert.deepEqual(FALLBACK_ORDER.slice(0, 3), ['claude', 'gemini', 'codex']);
    const order = getFallbackOrder();
    // Verify that among installed CLIs, claude precedes gemini, which precedes codex
    const indices = ['claude', 'gemini', 'codex'].map(p => order.indexOf(p)).filter(idx => idx !== -1);
    for (let i = 0; i < indices.length - 1; i++) {
      assert.ok(indices[i] < indices[i + 1], `expected ${order[indices[i]]} to precede ${order[indices[i + 1]]}`);
    }

    // Pinning via THINKER_LLM overrides fallback list
    process.env.THINKER_LLM = 'codex';
    assert.deepEqual(getFallbackOrder(), ['codex']);
  } finally {
    if (prevLlm !== undefined) process.env.THINKER_LLM = prevLlm;
    else delete process.env.THINKER_LLM;
    if (prevPrefer !== undefined) process.env.THINKER_LLM_PREFER = prevPrefer;
    else delete process.env.THINKER_LLM_PREFER;
    resetFallback();
  }
});

test('complete falls back when primary command provider fails', async () => {
  resetFallback();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-fallback-test-')));
  const prevLlm = process.env.THINKER_LLM;
  const prevCmd = process.env.THINKER_LLM_CMD;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevQuiet = process.env.THINKER_QUIET;

  process.env.THINKER_QUIET = '1';
  delete process.env.THINKER_LLM;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    // Model command that returns valid JSON
    const script = path.join(home, 'mock-model.js');
    fs.writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ notes: [{ id: 'test-note', kind: 'howto' }] })));`);
    process.env.THINKER_LLM_CMD = `node "${script}"`;

    const res = await complete({ schema: { type: 'object' } });
    assert.equal(res.provider, 'command');
    assert.deepEqual(res.json.notes[0].id, 'test-note');
  } finally {
    if (prevLlm !== undefined) process.env.THINKER_LLM = prevLlm;
    else delete process.env.THINKER_LLM;
    if (prevCmd !== undefined) process.env.THINKER_LLM_CMD = prevCmd;
    else delete process.env.THINKER_LLM_CMD;
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (prevQuiet !== undefined) process.env.THINKER_QUIET = prevQuiet;
    else delete process.env.THINKER_QUIET;
    resetFallback();
  }
});

test('provider() returns the primary candidate or promoted active fallback', () => {
  resetFallback();
  const p1 = provider();
  // Provider is the top of getFallbackOrder
  assert.equal(p1, getFallbackOrder()[0] ?? null);

  // If a provider was explicitly pinned
  const prev = process.env.THINKER_LLM;
  try {
    process.env.THINKER_LLM = 'gemini';
    assert.equal(provider(), 'gemini');
    process.env.THINKER_LLM = 'codex';
    assert.equal(provider(), 'codex');
  } finally {
    if (prev !== undefined) process.env.THINKER_LLM = prev;
    else delete process.env.THINKER_LLM;
    resetFallback();
  }
});

test('complete() throws descriptive error when provider fails', async () => {
  resetFallback();
  const prevCmd = process.env.THINKER_LLM_CMD;
  const prevLlm = process.env.THINKER_LLM;
  const prevQuiet = process.env.THINKER_QUIET;
  process.env.THINKER_QUIET = '1';
  process.env.THINKER_LLM_CMD = 'exit 1';
  process.env.THINKER_LLM = 'command';

  try {
    await assert.rejects(
      async () => await complete({ prompt: 'test' }),
      /exited 1/
    );
  } finally {
    if (prevCmd !== undefined) process.env.THINKER_LLM_CMD = prevCmd;
    else delete process.env.THINKER_LLM_CMD;
    if (prevLlm !== undefined) process.env.THINKER_LLM = prevLlm;
    else delete process.env.THINKER_LLM;
    if (prevQuiet !== undefined) process.env.THINKER_QUIET = prevQuiet;
    else delete process.env.THINKER_QUIET;
    resetFallback();
  }
});


