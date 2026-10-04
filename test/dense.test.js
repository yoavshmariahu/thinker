import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceConfig, CE_DEFAULTS, ceText, rankerStatus, modelsDir, selectByScore } from '../src/dense.js';

const withEnv = (vars, fn) => { const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } try { return fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
const store = cfg => ({ config: () => ({ ce: cfg }) });
const clean = { THINKER_CE: undefined, THINKER_CE_FLOOR: undefined, THINKER_CE_MAX: undefined, THINKER_CE_K: undefined, THINKER_CE_QUERY_TOKENS: undefined, THINKER_CE_FALLBACK: undefined };

test('the cross-encoder is on by default at floor 0 with one note, and config and environment adjust it', () => {
  withEnv(clean, () => {
    assert.deepEqual(ceConfig(store(undefined)), { ...CE_DEFAULTS });
    assert.equal(ceConfig(store(false)).enabled, false);
    assert.deepEqual(ceConfig(store({ floor: -2, maxNotes: 2 })), { ...CE_DEFAULTS, floor: -2, maxNotes: 2 });
  });
  withEnv({ ...clean, THINKER_CE: 'off' }, () => assert.equal(ceConfig(store({ enabled: true })).enabled, false));
  withEnv({ ...clean, THINKER_CE: 'on', THINKER_CE_FLOOR: '-1', THINKER_CE_MAX: '2', THINKER_CE_QUERY_TOKENS: '0', THINKER_CE_FALLBACK: 'off' }, () => {
    const c = ceConfig(store(false));
    assert.equal(c.enabled, true); assert.equal(c.floor, -1); assert.equal(c.maxNotes, 2); assert.equal(c.queryTokens, 0); assert.equal(c.fallbackFloor, null);
  });
  withEnv({ ...clean, THINKER_CE_FALLBACK: '-2' }, () => assert.equal(ceConfig(store(undefined)).fallbackFloor, -2));
  withEnv(clean, () => assert.equal(ceConfig(store({ fallbackFloor: false })).fallbackFloor, null));
});

test('the cross-encoder reads the search text when a note has one, else title, answers and the head of the body', () => {
  const n = { title: 'T', answers: ['a1', 'a2', 'a3', 'a4'], body: 'body text' };
  assert.equal(ceText(n), 'T. a1 a2 a3 body text');
  assert.equal(ceText({ ...n, search: 'S.' }), 'T. S.');
});

test('rankerStatus reports the runtime, the model files and the models directory', async () => {
  const st = await rankerStatus();
  assert.equal(typeof st.runtime, 'boolean'); assert.equal(typeof st.model, 'boolean');
  assert.equal(st.dir, modelsDir()); assert.match(st.modelName, /ms-marco/);
  const saved = process.env.THINKER_MODELS_DIR; process.env.THINKER_MODELS_DIR = '/nonexistent/models';
  try { const off = await rankerStatus(); assert.equal(off.model, false); assert.equal(off.dir, '/nonexistent/models'); }
  finally { if (saved === undefined) delete process.env.THINKER_MODELS_DIR; else process.env.THINKER_MODELS_DIR = saved; }
});

test('selection: the floor decides, the best candidate falls back when nothing clears it, none below the fallback floor', () => {
  const rows = [{ id: 'a', ce: -0.93 }, { id: 'b', ce: -2.4 }, { id: 'c', ce: -7 }];
  assert.deepEqual(selectByScore(rows, { floor: 0, maxNotes: 1, fallbackFloor: -1 }).map(r => [r.id, r.fallback]), [['a', true]]);
  assert.deepEqual(selectByScore(rows, { floor: 0, maxNotes: 1, fallbackFloor: null }), []);
  assert.deepEqual(selectByScore(rows, { floor: -3, maxNotes: 2, fallbackFloor: -1 }).map(r => r.id), ['a', 'b']);
  assert.deepEqual(selectByScore([{ id: 'x', ce: -1.5 }], { floor: 0, maxNotes: 1, fallbackFloor: -1 }), []);
  assert.deepEqual(selectByScore([{ id: 'y', ce: 1.2 }, { id: 'z', ce: 0.4 }], { floor: 0, maxNotes: 1, fallbackFloor: -1 }).map(r => [r.id, r.fallback]), [['y', undefined]]);
});
