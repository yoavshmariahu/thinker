import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { complete, resetFallback } from '../src/llm.js';

// A THINKER_LLM_CMD that answers with what it was told in its environment and on stdin.
function shim(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'shim.mjs');
  fs.writeFileSync(f, `import fs from 'node:fs';
const input = fs.readFileSync(0, 'utf8');
process.stdout.write(JSON.stringify({ tier: process.env.THINKER_TIER ?? null, model: process.env.THINKER_MODEL ?? null,
  schema: process.env.THINKER_SCHEMA ? JSON.parse(process.env.THINKER_SCHEMA) : null, promptHasSchema: input.includes('JSON Schema'), inLlm: process.env.THINKER_IN_LLM }));
`);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(f)}`;
}
const KEYS = ['THINKER_LLM', 'THINKER_LLM_CMD', 'THINKER_LLM_MODEL'];
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars); resetFallback();
  try { return await fn(); } finally { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } resetFallback(); }
}

test('the command provider is told the tier, the model and the schema, apart from the prompt', async t => {
  const cmd = shim(t);
  await withEnv({ THINKER_LLM: 'command', THINKER_LLM_CMD: cmd }, async () => {
    const schema = { type: 'object', properties: { tier: { type: 'string' } } };
    const cheap = await complete({ prompt: 'verify this', model: 'haiku', schema, timeoutMs: 20_000 });
    assert.equal(cheap.json.tier, 'haiku');
    assert.equal(cheap.json.model, 'haiku');
    assert.deepEqual(cheap.json.schema, schema);
    assert.equal(cheap.json.promptHasSchema, true, 'the prompt still carries the schema for shims that only read stdin');
    assert.equal(cheap.json.inLlm, '1');

    const costly = await complete({ prompt: 'distill this', model: 'opus', schema, timeoutMs: 20_000 });
    assert.equal(costly.json.tier, 'opus');

    const named = await complete({ prompt: 'x', model: 'corp-gpt-large', schema, timeoutMs: 20_000 });
    assert.equal(named.json.tier, null, 'a model name is not a tier');
    assert.equal(named.json.model, 'corp-gpt-large');

    const plain = await complete({ prompt: 'x', timeoutMs: 20_000 });
    assert.match(plain.text, /"tier":"sonnet"/);
    assert.match(plain.text, /"schema":null/);
  });
  await withEnv({ THINKER_LLM: 'command', THINKER_LLM_CMD: cmd, THINKER_LLM_MODEL: 'corp-gpt' }, async () => {
    const r = await complete({ prompt: 'x', model: 'haiku', schema: { type: 'object' }, timeoutMs: 20_000 });
    assert.equal(r.json.model, 'corp-gpt', 'THINKER_LLM_MODEL overrides the name');
    assert.equal(r.json.tier, 'haiku', 'but the tier is still told');
  });
});
