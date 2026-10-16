import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { setup } from '../src/commands/setup.js';

test('warmup completion follows the build result, including implicit choices and partial failures', async t => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-setup-outcome-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const store = new Store(repo).init(), events = [];
  t.mock.method(store, 'log', e => events.push(e));
  const ctx = { repo, store, HERE: path.resolve('src'), flags: { clients: [], yes: true }, out: () => {}, learnOn: () => false,
    mcpEntry: () => ({}), userMcpEntry: () => ({}) };
  const originalExitCode = process.exitCode;
  try {
    for (const result of [
      { built: false, error: 'unauthenticated', warnings: 0 },
      { built: true, error: null, warnings: 1 },
      { built: true, error: null, warnings: 0 },
    ]) {
      events.length = 0; process.exitCode = undefined;
      await setup(ctx, { runSetupFn: async options => { options.onBuildStart(); return result; } });
      const ok = result.built && !result.error && !result.warnings;
      assert.deepEqual(events.map(e => e.op), ok ? ['warmup-start', 'warmup-done'] : ['warmup-start', 'warmup-done', 'warmup-issue']);
      assert.equal(events[1].ok, Boolean(ok));
      if (!ok) assert.deepEqual([events[2].stage, events[2].reason], ['build', result.error || 'incomplete'], 'a failed build is recorded as a warm-up issue');
      assert.equal(process.exitCode, ok ? undefined : 1, 'background jobs must also see a failed build');
    }
    events.length = 0; process.exitCode = undefined;
    await setup(ctx, { runSetupFn: async () => ({ built: false, warnings: 0, error: null }) });
    assert.deepEqual(events, [], 'declining a build is not an attempted warmup');
    // asked to build, no agent signed in: the build never began, and that is an issue too
    await setup(ctx, { runSetupFn: async () => ({ built: false, warnings: 0, error: 'unauthenticated' }) });
    assert.deepEqual(events.map(e => [e.op, e.stage, e.reason]), [['warmup-issue', 'start', 'unauthenticated']]);
    events.length = 0;
    assert.equal(process.exitCode, undefined);
    await assert.rejects(setup(ctx, { runSetupFn: async options => { options.onBuildStart(); throw new Error('interrupted'); } }), /interrupted/);
    assert.deepEqual([events.at(-2).ok, events.at(-1).stage, events.at(-1).detail], [false, 'build', 'interrupted'], 'the error\'s words kept locally');
  } finally { process.exitCode = originalExitCode; }
});
