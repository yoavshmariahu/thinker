import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { areaOf, areasConfig } from '../src/areas.js';
import { Store } from '../src/store.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

// A git repository to hold a cache.
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-areas-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'me@example.com');
  git(dir, 'config', 'user.name', 'Me');
  fs.writeFileSync(path.join(dir, 'README.md'), 'r');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

test('areaOf: code files under a directory, two components deep; data, dotfiles and root files are no area', () => {
  assert.equal(areaOf('src/api/handlers.py'), 'src/api');
  assert.equal(areaOf('src/db/migrations/001.sql'), 'src/db');
  assert.equal(areaOf('src/index.js'), 'src');
  assert.equal(areaOf('README.md'), null);
  assert.equal(areaOf('fixtures/big.json'), null);
  assert.equal(areaOf('.github/workflows/ci.yml'), null);
  assert.equal(areaOf('node_modules/x/index.js'), null);
  assert.equal(areaOf('mlflow/gateway/providers/gemini.py', 3), 'mlflow/gateway/providers');
});

test('areasConfig: the whole repository by default; a list set by hand scopes the mining commands', () => {
  const dir = fixtureRepo();
  const store = new Store(dir).init();
  assert.deepEqual(areasConfig(store), { directories: [], source: 'all' });
  const file = path.join(store.dir, 'config.json');
  // what an old setup wrote, and what `thinker rewire` now drops (retire-background.js)
  fs.writeFileSync(file, JSON.stringify({ ...store.config(), areas: { directories: ['src/api', 'src/db'], source: 'activity', walk: 100, walked: 40 } }));
  store.init();
  assert.deepEqual(areasConfig(store).directories, ['src/api', 'src/db']);
  assert.equal(areasConfig(store).source, 'activity');
  fs.writeFileSync(file, JSON.stringify({ ...store.config(), areas: { directories: [] } }));
  store.init();
  assert.equal(areasConfig(store).source, 'all', 'an empty list is the whole repository');
});

test('a cache with the old haiku default moves to sonnet once; haiku chosen after that stays', () => {
  const dir = fixtureRepo();
  const store = new Store(dir).init();
  const file = path.join(store.dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, verifyModel: 'haiku', distillModel: 'haiku', maintain: { prsPerRun: 1 } }));
  store.init();
  assert.equal(store.config().distillModel, 'sonnet');
  assert.equal(store.config().verifyModel, 'haiku');
  assert.deepEqual(store.config().maintain, { prsPerRun: 1 });
  fs.writeFileSync(file, JSON.stringify({ ...store.config(), distillModel: 'haiku' }));
  store.init();
  assert.equal(store.config().distillModel, 'haiku');
  fs.writeFileSync(file, JSON.stringify({ version: 1, distillModel: 'haiku', learnTrial: { model: 'haiku' } }));
  store.init();
  assert.equal(store.config().distillModel, 'haiku', 'a trial keeps its model');
  assert.equal(store.config().distillDefault, undefined, 'and moves once the trial is gone');
  fs.writeFileSync(file, JSON.stringify({ version: 1, distillModel: 'opus' }));
  store.init();
  assert.equal(store.config().distillModel, 'opus');
});

