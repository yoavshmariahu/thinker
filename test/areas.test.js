import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { activityAreas, areaOf, areasConfig, saveAreas, notesByArea, refreshAreas, REFRESH_MS } from '../src/areas.js';
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
  assert.deepEqual(areasConfig(store), { directories: [], source: 'all', walk: 100, walked: 0, walkedBy: {} });
  saveAreas(store, { directories: ['src/api', 'src/db'], source: 'activity' });
  assert.deepEqual(areasConfig(store).directories, ['src/api', 'src/db']);
  assert.equal(areasConfig(store).source, 'activity');
  saveAreas(store, { walked: 40 }); // a cache from before walkedBy: spread over the areas
  assert.equal(areasConfig(store).walked, 40);
  assert.deepEqual(areasConfig(store).walkedBy, { 'src/api': 20, 'src/db': 20 });
  saveAreas(store, { walkedBy: { 'src/api': 100, 'src/db': 7, 'web/ui': 50 } });
  assert.equal(areasConfig(store).walked, 107, 'only the present areas count');
  assert.deepEqual(areasConfig(store).directories, ['src/api', 'src/db']);
  // the rest of the config is untouched
  assert.equal(store.config().distillModel, 'sonnet');
});

test('notesByArea counts the notes whose pointers fall inside each area, once per note', () => {
  const notes = [
    { id: 'a', deps: [{ path: 'src/api/handlers.py' }, { path: 'src/api/routes.py' }] },
    { id: 'b', deps: [{ path: 'src/db/store.py' }, { path: 'src/api/auth.py' }] },
    { id: 'c', deps: [{ path: 'web/ui/app.tsx' }] },
  ];
  assert.deepEqual(notesByArea(notes, ['src/api', 'src/db']), { 'src/api': 2, 'src/db': 1 });
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

test('activityAreas: recent work outranks more but older work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-areas-'));
  git(dir, 'init', '-q');
  const at = days => { const d = new Date(Date.now() - days * 86_400_000).toISOString(); return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d }; };
  const commit = (f, days) => { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.appendFileSync(path.join(dir, f), 'x'); git(dir, 'add', '-A'); execFileSync('git', ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-q', '-m', f], { cwd: dir, stdio: 'ignore', env: { ...process.env, ...at(days) } }); };
  for (const d of [150, 140, 130, 120]) commit('old/area/a.py', d);
  commit('new/area/b.py', 3); commit('new/area/b.py', 1);
  const a = activityAreas(dir, { noGitHub: true, email: 'me@example.com' });
  assert.deepEqual(a.directories, ['new/area', 'old/area'], 'two this week beat four in the spring; the spring still counts');
  assert.equal(a.counts['old/area'], 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refreshAreas: follows activity once a day, keeps the walk per area, leaves chosen and hand-edited lists', () => {
  const dir = fixtureRepo();
  const store = new Store(dir).init();
  let found = { directories: ['src/api'], source: 'activity' };
  const find = () => found;
  const t0 = Date.parse('2026-10-15T08:00:00Z');
  assert.deepEqual(refreshAreas(store, dir, { now: t0, find }).directories, ['src/api'], 'no areas yet: found');
  saveAreas(store, { walkedBy: { 'src/api': 30 } });
  found = { directories: ['web/ui', 'src/api'], source: 'activity' };
  assert.equal(refreshAreas(store, dir, { now: t0 + 3_600_000, find }), null, 'within the day: not looked at');
  refreshAreas(store, dir, { now: t0 + REFRESH_MS + 1, find });
  const a = areasConfig(store);
  assert.deepEqual(a.directories, ['web/ui', 'src/api']);
  assert.deepEqual(a.walkedBy, { 'src/api': 30 }, 'the walk so far is kept');
  // nothing found keeps the areas
  found = { directories: [], source: null };
  assert.equal(refreshAreas(store, dir, { now: t0 + 3 * REFRESH_MS, find }), null);
  assert.deepEqual(areasConfig(store).directories, ['web/ui', 'src/api']);
  // a hand edit sticks; so does a chosen list
  found = { directories: ['src/db'], source: 'activity' };
  saveAreas(store, { directories: ['lib'] });
  assert.equal(refreshAreas(store, dir, { now: t0 + 5 * REFRESH_MS, find }), null);
  saveAreas(store, { directories: ['lib'], found: ['lib'], source: 'manual' });
  assert.equal(refreshAreas(store, dir, { now: t0 + 6 * REFRESH_MS, find }), null);
  assert.deepEqual(areasConfig(store).directories, ['lib']);
  fs.rmSync(dir, { recursive: true, force: true });
});
