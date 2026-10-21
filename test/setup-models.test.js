import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, useBuildModel } from '../src/setup/models.js';
import { DEFAULT_DISTILL_MODEL, resolveModel } from '../src/llm.js';
import { stripAnsi } from '../src/setup/ui.js';

test('each harness gets its inexpensive model automatically, with no model menu', () => {
  for (const [agent, name] of [['claude', 'Sonnet'], ['cursor', 'Sonnet'], ['codex', 'Luna'], ['gemini', 'Gemini Flash']]) {
    const lines = [];
    // colors are on when the suite runs on a terminal (the release script does): the words are what is checked
    assert.equal(useBuildModel({ agent, out: s => lines.push(stripAnsi(s)) }), DEFAULT_DISTILL_MODEL);
    assert.match(lines.join('\n'), new RegExp(`Model: ${name}.*automatic`));
    assert.equal(buildModel(agent).model, resolveModel(agent, DEFAULT_DISTILL_MODEL));
  }
});

test('explicit and configured model overrides remain available without a menu', () => {
  const common = { agent: 'claude', out: () => {} };
  assert.equal(useBuildModel({ ...common, model: 'opus' }), 'opus');
  assert.equal(useBuildModel({ ...common, configModel: 'custom-model' }), 'custom-model');
  assert.equal(useBuildModel({ ...common, model: 'sonnet', configModel: 'opus' }), 'sonnet');
  const previous = process.env.THINKER_LLM_MODEL;
  process.env.THINKER_LLM_MODEL = 'pinned-model';
  try {
    const lines = [];
    useBuildModel({ agent: 'codex', out: s => lines.push(s) });
    assert.match(lines.join('\n'), /pinned-model.*configured/);
    assert.equal(buildModel('codex').model, 'pinned-model');
    assert.equal(process.env.THINKER_LLM_MODEL, 'pinned-model');
  } finally {
    if (previous === undefined) delete process.env.THINKER_LLM_MODEL;
    else process.env.THINKER_LLM_MODEL = previous;
  }
});
