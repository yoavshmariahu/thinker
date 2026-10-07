import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('performance gates, live logs, cancellation and process-tree cleanup', {timeout: 30000}, () => {
  const script = fileURLToPath(new URL('../research/performance-canary/test_guardrails.py', import.meta.url));
  const result = spawnSync(process.env.THINKER_BENCH_PYTHON || 'python3', [script, '-v'], {
    env: {...process.env, THINKER_TEST: '1', PYTHONDONTWRITEBYTECODE: '1'}, encoding: 'utf8', timeout: 25000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stdout + result.stderr);
});
