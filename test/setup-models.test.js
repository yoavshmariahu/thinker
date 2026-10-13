import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildModels, selectBuildModel } from '../src/setup/models.js';
import { DEFAULT_DISTILL_MODEL, resolveModel } from '../src/llm.js';
import { warmupCommand } from '../src/commands/warmup.js';

class TtyIn extends EventEmitter {
  constructor() { super(); this.isTTY = true; this.isRaw = false; }
  setRawMode(v) { this.isRaw = v; }
  resume() {}
  pause() {}
}
const ttyOut = () => ({ isTTY: true, writes: [], write(s) { this.writes.push(String(s)); return true; } });

test('the model picker recommends each harness’s inexpensive model and uses arrow keys', async () => {
  for (const [agent, name] of [['claude', 'Haiku'], ['codex', 'Luna'], ['gemini', 'Gemini Flash']]) {
    const stdin = new TtyIn(), stdout = ttyOut(), lines = [];
    const promise = selectBuildModel({ agent, stdin, stdout, out: s => lines.push(s) });
    stdin.emit('keypress', null, { name: 'return' });
    assert.equal(await promise, DEFAULT_DISTILL_MODEL);
    assert.match(stdout.writes.join(''), new RegExp(`${name} · recommended`));
    assert.match(lines.join('\n'), /Other models are a bit more expensive/);
    assert.equal(buildModels(agent)[0].model, resolveModel(agent, DEFAULT_DISTILL_MODEL));
    assert.equal(stdin.isRaw, false);
  }
  const stdin = new TtyIn(), stdout = ttyOut();
  const choice = selectBuildModel({ agent: 'codex', stdin, stdout, out: () => {} });
  stdin.emit('keypress', null, { name: 'down' });
  stdin.emit('keypress', null, { name: 'return' });
  assert.equal(await choice, 'gpt-6-sol');
  assert.match(stdout.writes.join(''), /Sol · more expensive/);
  const cancel = selectBuildModel({ agent: 'claude', stdin, stdout, out: () => {} });
  stdin.emit('keypress', null, { name: 'escape' });
  assert.equal(await cancel, null, 'Escape cancels rather than beginning a build');
});

test('explicit models, --yes, and pipes do not prompt; a configured model is preserved', async () => {
  const selectMenuFn = () => { throw new Error('must not prompt'); };
  const common = { agent: 'claude', out: () => {}, stdin: new TtyIn(), selectMenuFn };
  assert.equal(await selectBuildModel({ ...common, model: 'opus' }), 'opus');
  assert.equal(await selectBuildModel({ ...common, yes: true }), DEFAULT_DISTILL_MODEL);
  assert.equal(await selectBuildModel({ ...common, yes: true, configModel: 'custom-model' }), 'custom-model');
  assert.equal(await selectBuildModel({ ...common, stdin: { isTTY: false } }), DEFAULT_DISTILL_MODEL);
});

test('an environment model override is shown accurately and never changed by the picker', async () => {
  const previous = process.env.THINKER_LLM_MODEL;
  process.env.THINKER_LLM_MODEL = 'pinned-model';
  try {
    const lines = [];
    await selectBuildModel({ agent: 'codex', stdin: new TtyIn(), out: s => lines.push(s),
      selectMenuFn: () => { throw new Error('explicit environment override must not prompt'); } });
    assert.match(lines.join('\n'), /pinned-model \(set by THINKER_LLM_MODEL\)/);
    assert.equal(buildModels('codex')[0].model, 'pinned-model');
    assert.equal(process.env.THINKER_LLM_MODEL, 'pinned-model');
  } finally {
    if (previous === undefined) delete process.env.THINKER_LLM_MODEL;
    else process.env.THINKER_LLM_MODEL = previous;
  }
});

test('terminal warm-up chooses harness and model once before spawning --yes builds', async () => {
  const rows = ['one', 'two'].map(name => ({ name, checkout: `/repos/${name}`, canMine: true,
    estimates: { full: { seconds: 1, prs: 1 } } }));
  const calls = [], spawned = [];
  await warmupCommand({ flags: { terminal: true, repos: 'one,two' }, store: {}, out: () => {}, HERE: '/app' }, {
    candidatesFn: () => rows,
    selectAgentFn: async opts => { calls.push('agent'); assert.equal(opts.yes, false); return { ok: true, agent: 'codex' }; },
    selectModelFn: async opts => { calls.push('model'); assert.equal(opts.agent, 'codex'); assert.equal(opts.yes, false); return 'gpt-6-sol'; },
    spawnFn: (cmd, args) => { calls.push('build'); spawned.push(args); return { status: 0 }; },
  });
  assert.deepEqual(calls, ['agent', 'model', 'build', 'build']);
  for (const args of spawned) {
    assert.ok(args.includes('--yes'));
    assert.equal(args[args.indexOf('--agent') + 1], 'codex');
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-sol');
  }
  await warmupCommand({ flags: { terminal: true, repos: 'one' }, store: {}, out: () => {}, HERE: '/app' }, {
    candidatesFn: () => rows,
    selectAgentFn: async () => ({ ok: true, agent: 'claude' }),
    selectModelFn: async () => null,
    spawnFn: () => { throw new Error('cancelled picker must not build'); },
  });
});
