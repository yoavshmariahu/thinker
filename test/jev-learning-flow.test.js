import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { distillFile } from '../src/commands/learn.js';
import { resetFallback } from '../src/llm.js';

test('session integration retains retries and queues contradictions without modifying the old note', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-jev-flow-'));
  const keys = ['THINKER_LLM', 'THINKER_LLM_CMD'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  try {
    const old = { id: 'charge-rule', title: 'Charge retries', kind: 'rule', body: 'Never charge twice for the same key.', deps: [], status: 'fresh', servedIn: ['s'], confidence: .8 };
    const proposed = { kind: 'rule', title: old.title, body: 'Always charge twice for the same key.', deps: [] };
    const script = path.join(dir, 'writer.cjs');
    const marker = path.join(dir, 'writer-called');
    const reply = { notes: [proposed], assessments: [{ id: old.id, verdict: 'contradicted', evidence: 'charge-rule changed', correction: proposed.body }] };
    fs.writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'yes');console.log(${JSON.stringify(JSON.stringify(reply))});});`);
    process.env.THINKER_LLM = 'command'; process.env.THINKER_LLM_CMD = `node "${script}"`;
    const store = new Store(dir).init(); store.put(old);
    let mode = 'catalog-failure';
    store.config = () => ({ learn: { auditRate: 0, quietExplore: 0 }, maintain: { dailyTokens: 0 }, jev: {
      enabled: true, key: 'test', fetchImpl: async (_url, options) => {
        const { questions } = JSON.parse(options.body);
        const ids = Object.keys(questions);
        if ((mode === 'catalog-failure' && ids.some(id => /^n\d/.test(id))) || (mode === 'relation-failure' && questions.relation)) return { ok: false, status: 503 };
        const answers = Object.fromEntries(ids.map(id => [id, questions[id].type === 'choice'
          ? { type: 'choice', choice: 'contradicts', confidence: .98, probabilities: { covered: .01, extends: 0, contradicts: .99, unrelated: 0 } }
          : { type: 'noul', noul: .99 }]));
        return { ok: true, json: async () => ({ model: 'mock-jev', answers, usage: { input_tokens: 10, output_tokens: 5 } }) };
      },
    } });
    const trace = path.join(dir, 'session.jsonl');
    const events = [{ t: 'prompt', text: 'Fix charge-rule retry behavior.' }, { t: 'say', text: 'charge-rule is contradicted: the payment source now charges twice.' }];
    fs.writeFileSync(trace, events.map(e => JSON.stringify(e)).join('\n') + '\n');
    const ctx = { repo: dir, store, out() {} }, opts = { minExplore: 0, incremental: true, session: 's' };
    const checkpoint = path.join(store.dir, 'state', 'session.json');
    await assert.rejects(distillFile(ctx, trace, opts), /catalog unavailable/);
    assert.equal(fs.existsSync(marker), false, 'catalog failure must stop before the writing model');
    assert.equal(fs.existsSync(checkpoint), false);
    mode = 'relation-failure';
    await distillFile(ctx, trace, opts);
    assert.equal(JSON.parse(fs.readFileSync(checkpoint)).line, 0, 'transient reconciliation failure remains retryable');
    mode = 'contradiction';
    await distillFile(ctx, trace, opts);
    assert.equal(JSON.parse(fs.readFileSync(checkpoint)).line, events.length, 'persisted semantic conflict need not spend again');
    assert.equal(store.get(old.id).body, old.body);
    assert.equal(store.get(old.id).confidence, old.confidence);
    const pending = fs.readdirSync(path.join(store.dir, 'state', 'learning-pending'));
    assert.ok(pending.length >= 2);
    assert.equal(store.list().length, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    resetFallback(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
