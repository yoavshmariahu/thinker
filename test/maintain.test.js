import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { maintain, maintenanceNotice, renderMaintain, spentToday, withinDailyCap, reportCapped, reportPruned, postCommitHook, DEFAULTS, MAINTENANCE_INTERVAL_MS } from '../src/maintain.js';

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-maintain-')));
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(['add', '.']); git(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one']);
  return { dir, store: new Store(dir).init() };
}
const env = { THINKER_LOG: 'local', THINKER_TELEMETRY: 'off' };
function withEnv(fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('a run prunes state, reads the pull requests once a day, and runs at most every four hours', () => withEnv(async () => {
  const { store } = repo();
  let synced = 0;
  const syncPrs = async () => { synced++; return { synced: 3 }; };
  const r = await maintain(store, store.repo, { fns: { syncPrs, containers: () => null, contextSuggest: async () => null } });
  assert.equal(r.prSynced, 3); assert.equal(r.errors, 0);
  assert.match(renderMaintain(r), /3 pull requests read/);
  const again = await maintain(store, store.repo, { fns: { syncPrs } });
  assert.equal(again.skipped, 'not-due', 'a second run inside the interval does nothing');
  const later = await maintain(store, store.repo, { now: Date.now() + MAINTENANCE_INTERVAL_MS + 1000, fns: { syncPrs, containers: () => null, contextSuggest: async () => null } });
  assert.equal(later.prSynced, 0, 'the pull requests are read once a day, not every run'); assert.equal(synced, 1);
  assert.equal(renderMaintain({ skipped: 'locked' }), 'maintenance skipped (locked)');
  assert.equal(renderMaintain({ errors: 0, errorList: [] }), 'maintained: nothing to do');
}));

test('a failing step is counted and named, never thrown', () => withEnv(async () => {
  const { store } = repo();
  const r = await maintain(store, store.repo, { fns: { syncPrs: async () => { throw new Error('Reading pull requests needs a github.com origin'); }, containers: () => null, contextSuggest: async () => null } });
  assert.equal(r.errors, 1);
  assert.deepEqual(r.errorList, [{ step: 'pr-sync', message: 'Reading pull requests needs a github.com origin' }]);
  assert.match(renderMaintain(r), /1 failed \(pr-sync: Reading pull requests needs a github.com origin\)/);
}));

test('the daily token cap counts the model calls of learning, and is said once a day', () => withEnv(async () => {
  const { store } = repo();
  assert.equal(withinDailyCap(store).cap, DEFAULTS.dailyTokens);
  store.log({ op: 'model', phase: 'learning', purpose: 'profile-extract', tokens: { totalTokens: 1_500_000 } });
  store.log({ op: 'model', phase: 'maintenance', purpose: 'x', tokens: { totalTokens: 600_000 } });
  store.log({ op: 'model', phase: 'init', purpose: 'x', tokens: { totalTokens: 999_999_999 } });
  assert.equal(spentToday(store), 2_100_000, 'learning and maintenance count; a build does not');
  assert.equal(withinDailyCap(store).ok, false);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyTokens: 0 } }));
  assert.equal(withinDailyCap(store).ok, true, '0 is no cap');
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyCap: 0 } }));
  assert.equal(withinDailyCap(store).ok, true, 'the legacy dollar cap of 0 still means no cap');
  fs.writeFileSync(path.join(store.dir, 'config.json'), '{}');
  reportCapped(store, { spent: 2_100_000, cap: 2_000_000 });
  assert.match(maintenanceNotice(store), /learning paused at the daily token limit/);
  assert.equal(maintenanceNotice(store), '', 'said once');
  reportCapped(store, { spent: 2_100_000, cap: 2_000_000 });
  assert.equal(maintenanceNotice(store), '', 'and not again the same day');
}));

test('what the hooks pruned is said once, and the post-commit hook runs maintenance alone', () => withEnv(async () => {
  const { store } = repo();
  reportPruned(store, ['moved hooks out of .claude/settings.json']);
  assert.equal(maintenanceNotice(store), '🧠 thinker: Thinker setup updated');
  assert.equal(maintenanceNotice(store), '');
  const hook = postCommitHook('/opt/thinker/src/cli.js', '/r/repo', true);
  assert.match(hook, /maintain --quiet --repo "\$repo"/);
  assert.ok(!hook.includes('check'), 'no re-hash: the notes went');
  assert.match(hook, /THINKER_TEST/);
}));
