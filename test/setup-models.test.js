import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, useBuildModel } from '../src/setup/models.js';
import { DEFAULT_DISTILL_MODEL, resolveModel } from '../src/llm.js';
import { warmupCommand } from '../src/commands/warmup.js';

test('each harness gets its inexpensive model automatically, with no model menu', () => {
  for (const [agent, name] of [['claude', 'Haiku'], ['cursor', 'Haiku'], ['codex', 'Luna'], ['gemini', 'Gemini Flash']]) {
    const lines = [];
    assert.equal(useBuildModel({ agent, out: s => lines.push(s) }), DEFAULT_DISTILL_MODEL);
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

test('terminal warm-up asks only for the harness and passes its automatic model to all builds', async () => {
  const rows = ['one', 'two'].map(name => ({ name, checkout: `/repos/${name}`, canMine: true,
    estimates: { full: { seconds: 1, prs: 1 } } }));
  for (const agent of ['claude', 'codex', 'gemini']) {
    const calls = [], spawned = [], lines = [];
    await warmupCommand({ flags: { terminal: true, repos: 'one,two' }, store: {}, out: s => lines.push(s), HERE: '/app' }, {
      candidatesFn: () => rows,
      selectAgentFn: async opts => { calls.push('harness'); assert.equal(opts.yes, false); return { ok: true, agent }; },
      spawnFn: (cmd, args) => { calls.push('build'); spawned.push(args); return { status: 0 }; },
    });
    assert.deepEqual(calls, ['harness', 'build', 'build']);
    assert.match(lines.join('\n'), /Model: .*automatic/);
    for (const args of spawned) {
      assert.ok(args.includes('--yes'));
      assert.equal(args[args.indexOf('--agent') + 1], agent);
      assert.equal(args[args.indexOf('--model') + 1], DEFAULT_DISTILL_MODEL);
    }
  }
  await warmupCommand({ flags: { terminal: true, repos: 'one' }, store: {}, out: () => {}, HERE: '/app' }, {
    candidatesFn: () => rows,
    selectAgentFn: async () => ({ ok: false, error: 'cancelled' }),
    spawnFn: () => { throw new Error('cancelled harness selection must not build'); },
  });
  await warmupCommand({ flags: { terminal: true, repos: 'one', model: 'gpt-6-sol' }, store: {}, out: () => {}, HERE: '/app' }, {
    candidatesFn: () => rows,
    selectAgentFn: async () => ({ ok: true, agent: 'codex' }),
    spawnFn: (cmd, args) => { assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-sol'); return { status: 0 }; },
  });
});

// `--repos` takes the path of any git checkout, listed or not (machine.js:warmupCandidate): the offer an
// agent makes on the first session in a fresh clone names the checkout this way, and the clone is on no
// list until a session there is recorded. A name the list lacks, or a path that is no checkout, is refused.
test('--repos warms a checkout by path when the list lacks it, and refuses what is no repository', async () => {
  const rows = [{ name: 'one', checkout: '/repos/one', canMine: true, estimates: { full: { seconds: 1, prs: 1 } } }];
  const fresh = { name: 'clone', checkout: '/home/me/src/clone', canMine: true, estimates: { full: { seconds: 2, prs: 1 } } };
  const asked = [], spawned = [], lines = [];
  await warmupCommand({ flags: { terminal: true, yes: true, repos: 'one,/home/me/src/clone' }, store: {}, out: s => lines.push(s), HERE: '/app' }, {
    candidatesFn: () => rows,
    candidateFn: (store, p) => { asked.push(p); return p === '/home/me/src/clone' ? fresh : null; },
    selectAgentFn: async () => ({ ok: true, agent: 'claude' }),
    spawnFn: (cmd, args) => { spawned.push(args[args.indexOf('--repo') + 1]); return { status: 0 }; },
  });
  assert.deepEqual(asked, ['/home/me/src/clone'], 'only the entry the list lacks is looked up, and only as a path');
  assert.deepEqual(spawned, ['/repos/one', '/home/me/src/clone']);
  process.exitCode = 0;
  const refused = [];
  await warmupCommand({ flags: { terminal: true, yes: true, repos: 'two,/nowhere' }, store: {}, out: s => refused.push(s), HERE: '/app' }, {
    candidatesFn: () => rows, candidateFn: () => null,
    selectAgentFn: async () => ({ ok: true, agent: 'claude' }),
    spawnFn: () => { throw new Error('nothing to build'); },
  });
  assert.match(refused.join('\n'), /Not a git repository on this machine: two, \/nowhere/);
  assert.equal(process.exitCode, 1); process.exitCode = 0;
});
