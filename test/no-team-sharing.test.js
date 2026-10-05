import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installGitHooks, preCommitHook } from '../src/git-hooks.js';
import { commands } from '../src/commands/cache.js';
import { Store } from '../src/store.js';
import { maintain, maintenanceNotice } from '../src/maintain.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-local-only-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  return repo;
}

test('removed collaboration commands fail before creating a cache; legacy Git hooks remain harmless', t => {
  const repo = fixture(t);
  assert.equal(commands.share, undefined);
  assert.equal(commands.sync, undefined);
  for (const args of [['share'], ['sync', 'login', 'https://invalid.example'], ['setup', '--shared']]) {
    const r = spawnSync(process.execPath, [cli, ...args, '--repo', repo], {
      encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off' },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /team sharing is no longer supported/);
    assert.equal(fs.existsSync(path.join(repo, '.thinker')), false);
  }
  for (const flag of ['--pre-push', '--repair-staged']) {
    const r = spawnSync(process.execPath, [cli, 'share', flag, '--repo', repo], {
      env: { ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off' },
    });
    assert.equal(r.status, 0);
  }
});

test('rewiring removes obsolete note checks and preserves custom pre-push hooks', t => {
  const repo = fixture(t), hook = path.join(repo, '.git/hooks/pre-push');
  fs.writeFileSync(hook, '#!/bin/sh\n# thinker: report shared-note issues without blocking a push\nnode old.js share --check --pre-push\n');
  installGitHooks(repo, cli, true);
  assert.equal(fs.existsSync(hook), false);
  assert.doesNotMatch(preCommitHook(cli), /share|repair/);
  const custom = '#!/bin/sh\n# repository policy\nexit 1\n';
  fs.writeFileSync(hook, custom);
  installGitHooks(repo, cli, true);
  assert.equal(fs.readFileSync(hook, 'utf8'), custom);
});

test('maintenance ignores old sharing settings and never invokes sync', async t => {
  const store = new Store(fixture(t)).init();
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ share: true, sync: { url: 'https://invalid.example' } }));
  let synced = false;
  await maintain(store, store.repo, { fns: {
    sync: () => { synced = true; throw new Error('must not sync'); },
    spentToday: () => 0,
  } });
  assert.equal(synced, false);
  assert.doesNotMatch(maintenanceNotice(store), /share|team cache|pushed|pulled/);
});
