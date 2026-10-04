import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceConfig, CE_DEFAULTS, ceText } from '../src/dense.js';

const withEnv = (vars, fn) => { const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } try { return fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
const store = cfg => ({ config: () => ({ ce: cfg }) });
const clean = { THINKER_CE: undefined, THINKER_CE_FLOOR: undefined, THINKER_CE_MAX: undefined, THINKER_CE_K: undefined, THINKER_CE_QUERY_TOKENS: undefined };

test('the cross-encoder is on by default at floor 0 with one note, and config and environment adjust it', () => {
  withEnv(clean, () => {
    assert.deepEqual(ceConfig(store(undefined)), { ...CE_DEFAULTS });
    assert.equal(ceConfig(store(false)).enabled, false);
    assert.deepEqual(ceConfig(store({ floor: -2, maxNotes: 2 })), { ...CE_DEFAULTS, floor: -2, maxNotes: 2 });
  });
  withEnv({ ...clean, THINKER_CE: 'off' }, () => assert.equal(ceConfig(store({ enabled: true })).enabled, false));
  withEnv({ ...clean, THINKER_CE: 'on', THINKER_CE_FLOOR: '-1', THINKER_CE_MAX: '2', THINKER_CE_QUERY_TOKENS: '0' }, () => {
    const c = ceConfig(store(false));
    assert.equal(c.enabled, true); assert.equal(c.floor, -1); assert.equal(c.maxNotes, 2); assert.equal(c.queryTokens, 0);
  });
});

test('the cross-encoder reads the search text when a note has one, else title, answers and the head of the body', () => {
  const n = { title: 'T', answers: ['a1', 'a2', 'a3', 'a4'], body: 'body text' };
  assert.equal(ceText(n), 'T. a1 a2 a3 body text');
  assert.equal(ceText({ ...n, search: 'S.' }), 'T. S.');
});
