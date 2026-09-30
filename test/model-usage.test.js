import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeModelUsage, streamModelUsage, logModelUsage } from '../src/model-usage.js';
import { Store } from '../src/store.js';
import { summarize, renderUsage } from '../src/usage.js';
import { complete } from '../src/llm.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cost-')));

function isolatedEnv(dir) {
  const env = { ...process.env, HOME: dir, THINKER_HOME: dir, THINKER_LOG: 'local', THINKER_IN_LLM: '1', THINKER_NO_TELEMETRY: '1', THINKER_NO_LIMIT_WAIT: '1', THINKER_QUIET: '1' };
  for (const k of ['THINKER_NOTES_DIR', 'THINKER_LLM_CMD', 'THINKER_LLM_MODEL', 'ANTHROPIC_API_KEY', 'THINKER_NO_LEARN']) delete env[k];
  return env;
}

test('provider counters include cache writes once, cached input once, and Gemini reasoning', () => {
  assert.deepEqual(normalizeModelUsage('claude', { input_tokens: 20, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 30 }),
    { inputTokens: 150, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 30, totalTokens: 200 });
  assert.equal(normalizeModelUsage('codex', { input_tokens: 150, cached_input_tokens: 100, output_tokens: 50 }).totalTokens, 200);
  const gemini = normalizeModelUsage('gemini', { models: {
    fast: { tokens: { input: 20, prompt: 150, cached: 130, candidates: 40, thoughts: 10, total: 200 } },
    other: { tokens: { prompt: 10, candidates: 5, thoughts: 5, cached: 0 } },
  } });
  assert.equal(gemini.inputTokens, 160);
  assert.equal(gemini.outputTokens, 60);
  assert.equal(gemini.totalTokens, 220);
  assert.equal(normalizeModelUsage('command', null).totalTokens, null);
  assert.equal(normalizeModelUsage('cursor', {}).totalTokens, null);
  assert.equal(normalizeModelUsage('cursor', { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 100 }).totalTokens, 125);
  assert.equal(normalizeModelUsage('codex', { input_tokens: -1, output_tokens: 2 }).totalTokens, null);
  assert.equal(normalizeModelUsage('codex', { input_tokens: 0, output_tokens: 0 }).totalTokens, 0);
});

test('exploration sums completed Codex turns but uses the final cumulative result for other agents', () => {
  const codex = streamModelUsage('codex', [
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 } },
    { type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 180, output_tokens: 40 } },
  ].map(JSON.stringify).join('\n'));
  assert.equal(normalizeModelUsage('codex', codex.usage).totalTokens, 360);
  const cursor = streamModelUsage('cursor', [
    { type: 'assistant', usage: { input_tokens: 99, output_tokens: 99 } },
    { type: 'result', usage: { input_tokens: 200, output_tokens: 40 }, total_cost_usd: 0.03 },
  ].map(JSON.stringify).join('\n'));
  assert.equal(normalizeModelUsage('cursor', cursor.usage).totalTokens, 240);
  assert.equal(cursor.cost, 0.03);
  assert.equal(streamModelUsage('gemini', '').usage, null);
});

test('spending separates init, learning and legacy costs without double counting', () => {
  const store = new Store(tmp()).init();
  logModelUsage(store, { purpose: 'explore', phase: 'init' }, { provider: 'claude', model: 'test', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 200 }, cost: 0.1 });
  logModelUsage(store, { purpose: 'distill', phase: 'learning' }, { provider: 'codex', model: 'test', usage: { input_tokens: 300, output_tokens: 50 }, cost: null });
  store.log({ op: 'distill', saved: [], merged: [], cost: 0.1, metered: true });
  store.log({ op: 'mine-prs', cost: 0.2 }); // legacy batch, cost known but no tokens
  store.log({ op: 'orient', session: 'a', served: ['n'], tokens: 50, est: [[1, 1000]] });
  store.log({ op: 'attest', session: 'a', applied: [{ id: 'n', verdict: 'confirmed' }] });
  const u = summarize(store);
  assert.equal(u.spent, 0.3);
  assert.equal(u.spending.totalTokens, 670);
  assert.equal(u.spending.calls, 3);
  assert.equal(u.spending.unknownTokenCalls, 1);
  assert.equal(u.spending.unknownCostCalls, 1);
  assert.equal(u.spending.byPhase.init.totalTokens, 320);
  assert.equal(u.spending.byPurpose.distill.totalTokens, 350);
  assert.equal(u.spending.byModel['codex/test'].totalTokens, 350);
  assert.equal(u.repos[0].spending.totalTokens, 670);
  assert.equal(u.saved.netAfterSpend, 280);
  assert.equal(u.saved.spendComplete, false);
  assert.equal(u.distillation.noChanges, 1);
  assert.match(renderUsage(u), /Partial accounting/);
});

test('seed and distill persist provider usage, including empty yields and dry runs', () => {
  const dir = tmp(), bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
process.stdin.resume(); process.stdin.on('end', () => {
 const distill = !process.argv.includes('--cd');
 const events = distill ? [
  {type:'item.completed',item:{type:'agent_message',text:'{"notes":[]}'}},
  {type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:20}}
 ] : [
  {type:'item.completed',item:{type:'command_execution',command:'cat a.js',aggregated_output:'function a() {}',exit_code:0}},
  {type:'item.completed',item:{type:'agent_message',text:'The a function lives in a.js.'}},
  {type:'turn.completed',usage:{input_tokens:500,cached_input_tokens:200,output_tokens:50}}
 ];
 for (const e of events) console.log(JSON.stringify(e));
});`);
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const prompts = path.join(dir, 'prompts.json'); fs.writeFileSync(prompts, '["Explore a.js"]');
  const env = { ...isolatedEnv(dir), PATH: bin + path.delimiter + process.env.PATH, THINKER_LLM: 'codex' };
  const run = (...args) => execFileSync(process.execPath, [CLI, ...args, '--repo', dir], { env, stdio: 'pipe' });
  run('seed', '--prompts', prompts, '--agent', 'codex');
  let u = JSON.parse(run('usage', '--here', '--json'));
  assert.equal(u.spending.byPhase.init.totalTokens, 670);
  assert.equal(u.spending.byPurpose.explore.totalTokens, 550);
  assert.equal(u.spending.byPurpose.distill.totalTokens, 120);
  assert.equal(u.spending.unknownCostCalls, 2);
  assert.equal(u.distillation.noChanges, 1);
  const trace = path.join(dir, 'session.jsonl');
  fs.writeFileSync(trace, [ { t: 'tool', name: 'Read', input: { file_path: 'a.js' }, result: 'a' }, { t: 'say', text: 'a lives here' } ].map(JSON.stringify).join('\n'));
  run('distill', trace, '--dry');
  u = JSON.parse(run('usage', '--here', '--json'));
  assert.equal(u.spending.byPhase.learning.totalTokens, 120);
  assert.equal(u.spending.calls, 3);
  assert.equal(u.distillation.runs, 1); // dry run costs count, but it saved nothing
  assert.equal(u.distillationPerformance.attempts, 1);
  assert.equal(u.distillationPerformance.succeeded, 1);
  assert.equal(u.distillationPerformance.failed, 0);
  assert.equal(u.distillationPerformance.durationSamples, 1);
  assert.ok(u.distillationPerformance.durationMs >= 0);
  assert.equal(u.distillationPerformance.spending.calls, 1); // dry-run calls excluded
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'turn.failed',error:{message:'synthetic failure'}}));process.exitCode=1;});`);
  assert.throws(() => run('distill', trace));
  u = JSON.parse(run('usage', '--here', '--json'));
  assert.equal(u.distillationPerformance.attempts, 2);
  assert.equal(u.distillationPerformance.failed, 1);
  assert.equal(u.distillationPerformance.durationSamples, 2);
});

test('invalid model answers still retain reported tokens and cost', async () => {
  const dir = tmp(), store = new Store(dir).init();
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({result:'not JSON',usage:{input_tokens:50,output_tokens:10},total_cost_usd:0.02})));`);
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  const previous = { ...process.env };
  Object.assign(process.env, { ...isolatedEnv(dir), PATH: dir + path.delimiter + process.env.PATH, THINKER_LLM: 'claude' });
  try {
    await assert.rejects(complete({ prompt: 'test', schema: { type: 'object' }, accounting: { store, purpose: 'distill', phase: 'learning' } }), /no structured output/);
    const u = summarize(store);
    assert.equal(u.spending.totalTokens, 60);
    assert.equal(u.spent, 0.02);
    assert.equal(u.spending.failed, 1);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in previous)) delete process.env[k];
    Object.assign(process.env, previous);
  }
});
