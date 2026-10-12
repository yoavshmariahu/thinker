import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activityAreas, areaOf, areasConfig, saveAreas, notesByArea } from '../src/areas.js';
import { Store } from '../src/store.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

// A repository with commits by two people: the user's commits touch src/api and src/db (and a
// data directory, which is not an area); a teammate's commits touch web/ui.
function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-areas-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'me@example.com');
  git(dir, 'config', 'user.name', 'Me');
  const write = (f, body) => { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); };
  const commit = (email, files, msg) => { for (const [f, b] of files) write(f, b); git(dir, 'add', '-A'); execFileSync('git', ['-c', `user.email=${email}`, '-c', 'user.name=x', 'commit', '-q', '-m', msg], { cwd: dir, stdio: 'ignore' }); };
  commit('me@example.com', [['src/api/handlers.py', 'a'], ['src/api/routes.py', 'b'], ['fixtures/big.json', '{}']], 'api 1');
  commit('me@example.com', [['src/api/handlers.py', 'a2'], ['src/db/store.py', 'c']], 'api 2');
  commit('me@example.com', [['src/db/store.py', 'c2'], ['src/db/migrations/001.sql', 'd']], 'db 1');
  commit('me@example.com', [['src/api/auth.py', 'e'], ['README.md', 'docs']], 'api 3');
  commit('other@example.com', [['web/ui/app.tsx', 'f']], 'ui 1');
  commit('other@example.com', [['web/ui/app.tsx', 'f2'], ['web/ui/nav.tsx', 'g']], 'ui 2');
  commit('other@example.com', [['web/ui/app.tsx', 'f3']], 'ui 3');
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

test('activityAreas: the directories the user\'s own commits touch, ranked by commits, the teammate\'s left out', () => {
  const dir = fixtureRepo();
  const a = activityAreas(dir, { noGitHub: true });
  assert.deepEqual(a.directories, ['src/api', 'src/db']);
  assert.equal(a.source, 'activity');
  assert.equal(a.changes, 4);
  assert.equal(a.counts['src/api'], 3);
  assert.equal(a.counts['src/db'], 2);
  assert.equal(a.counts['fixtures'], undefined);
  // another identity sees the other areas; nobody at all sees none
  assert.deepEqual(activityAreas(dir, { noGitHub: true, email: 'other@example.com' }).directories, ['web/ui']);
  const none = activityAreas(dir, { noGitHub: true, email: 'nobody@example.com' });
  assert.deepEqual(none.directories, []); assert.equal(none.source, null);
  // top caps the list; since excludes old history
  assert.deepEqual(activityAreas(dir, { noGitHub: true, top: 1 }).directories, ['src/api']);
  assert.deepEqual(activityAreas(dir, { noGitHub: true, now: new Date(Date.now() + 400 * 86_400_000) }).directories, []);
});

test('areasConfig and saveAreas: the generic build by default; a saved list sticks and merges', () => {
  const dir = fixtureRepo();
  const store = new Store(dir).init();
  assert.deepEqual(areasConfig(store), { directories: [], source: 'all', walk: 100, walked: 0 });
  saveAreas(store, { directories: ['src/api', 'src/db'], source: 'activity' });
  assert.deepEqual(areasConfig(store).directories, ['src/api', 'src/db']);
  assert.equal(areasConfig(store).source, 'activity');
  saveAreas(store, { walked: 40 });
  assert.equal(areasConfig(store).walked, 40);
  assert.deepEqual(areasConfig(store).directories, ['src/api', 'src/db']);
  // the rest of the config is untouched
  assert.equal(store.config().distillModel, 'haiku');
});

test('notesByArea counts the notes whose pointers fall inside each area, once per note', () => {
  const notes = [
    { id: 'a', deps: [{ path: 'src/api/handlers.py' }, { path: 'src/api/routes.py' }] },
    { id: 'b', deps: [{ path: 'src/db/store.py' }, { path: 'src/api/auth.py' }] },
    { id: 'c', deps: [{ path: 'web/ui/app.tsx' }] },
  ];
  assert.deepEqual(notesByArea(notes, ['src/api', 'src/db']), { 'src/api': 2, 'src/db': 1 });
});
