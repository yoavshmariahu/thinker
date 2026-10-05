import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isTestMode } from '../src/test-mode.js';
import { postCommitHook } from '../src/maintain.js';
import { preCommitHook } from '../src/git-hooks.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('one inherited test flag blocks automatic work before touching state or spawning workers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-mode-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('THINKER_') && k !== 'NODE_TEST_CONTEXT'));
  // No old per-feature flags and no node:test context: this is also a benchmark subprocess.
  env.THINKER_TEST = '1';
  try {
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { maybeCheckDailyUpdateInBackground } from './src/update.js';
      import { maybeSendTelemetryInBackground, sendTelemetry } from './src/telemetry.js';
      import { scheduleVerify } from './src/ops.js';
      import { learnInBackground, commands } from './src/commands/hooks.js';
      import { Store, logFile } from './src/store.js';
      const home = process.argv[1];
      const untouched = new Proxy({}, { get() { throw Error('background work accessed state'); } });
      maybeCheckDailyUpdateInBackground({ home, force: true });
      maybeSendTelemetryInBackground({ home, store: untouched, force: true });
      scheduleVerify(untouched, [{ id: 'stale' }]);
      learnInBackground({ NO_LEARN: false, sessionLearning() { throw Error('background learning'); } });
      await commands.hook({ HERE: '/unused', flags: { user: true }, pos: ['prompt'], readStdin: () => '{}', out() { throw Error('machine hook served'); } });
      const result = await sendTelemetry({ home, store: { config: () => ({}) }, force: true });
      assert.equal(result.reason, 'test_environment');
      assert.deepEqual(fs.readdirSync(home), []);
      const store = new Store('/non-temporary/benchmark');
      assert.equal(logFile(store), '/non-temporary/benchmark/.thinker/log.jsonl');
      process.env.THINKER_LOG = 'off';
      assert.equal(logFile(store), null);
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', script, home], { cwd: ROOT, env, stdio: 'pipe' });
    // Real generated git hook must also inherit the one flag, before any shell work.
    const hook = path.join(home, 'post-commit');
    for (const script of [postCommitHook('/missing/cli.js', '/missing/repo', true), preCommitHook('/missing/cli.js')]) {
      fs.writeFileSync(hook, script);
      assert.equal(execFileSync('sh', [hook], { env, encoding: 'utf8', stdio: 'pipe' }), '');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('test mode is explicit and does not change normal production defaults', () => {
  assert.equal(isTestMode({}), false);
  assert.equal(isTestMode({ THINKER_TEST: '0' }), false);
  assert.equal(isTestMode({ THINKER_TEST: '1' }), true);
});
