// Focus areas through setup and maintenance (areas.js): the chooser defaults to the person's own
// areas, the generic build is a choice, and maintenance mines inside the areas and walks their
// older history up to the depth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chooseProject } from '../src/setup/project.js';
import { maintain, MAINTENANCE_INTERVAL_MS, DEFAULTS } from '../src/maintain.js';
import { areasConfig, saveAreas, AREAS_DEFAULTS } from '../src/areas.js';
import { Store } from '../src/store.js';

function repoWith(dirs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-areas-setup-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  for (const d of dirs) { fs.mkdirSync(path.join(dir, d), { recursive: true }); fs.writeFileSync(path.join(dir, d, 'index.js'), '1'); }
  return dir;
}
const found = dirs => () => ({ directories: dirs, source: 'activity', changes: dirs.length * 3, counts: {} });
const none = () => ({ directories: [], source: null, changes: 0, counts: {} });

test('chooseProject: with --yes the areas are the build; the generic build is --full-repo; the choice lands in the config', async () => {
  const repo = repoWith(['src/api', 'src/db']);
  const store = new Store(repo).init();
  const lines = [];
  const p = await chooseProject({ repo, store, flags: { yes: true }, interactive: true, out: s => lines.push(s), areasFn: found(['src/api', 'src/db']), selectFn: () => { throw new Error('must not prompt'); } });
  assert.deepEqual(p.directories, ['src/api', 'src/db']);
  assert.equal(areasConfig(store).source, 'activity');
  assert.deepEqual(areasConfig(store).directories, ['src/api', 'src/db']);
  assert.match(lines.join('\n'), /your areas \(src\/api, src\/db\)/);
  assert.equal(fs.existsSync(path.join(repo, 'thinker.project.json')), false, 'the areas do not write a project file into the repository');
  // the generic build
  const full = await chooseProject({ repo, store, flags: { yes: true, 'full-repo': true }, interactive: true, out: () => {}, areasFn: () => { throw new Error('not consulted'); } });
  assert.equal(full, null);
  assert.equal(areasConfig(store).source, 'all');
  assert.deepEqual(areasConfig(store).directories, []);
  // named directories
  const named = await chooseProject({ repo, store, flags: { yes: true, directories: 'src/db' }, interactive: true, out: () => {}, areasFn: () => { throw new Error('not consulted'); } });
  assert.deepEqual(named.directories, ['src/db']);
  assert.equal(areasConfig(store).source, 'manual');
  // no activity at all: the whole repository, as before
  fs.rmSync(path.join(repo, 'thinker.project.json'), { force: true });
  assert.equal(await chooseProject({ repo, store, flags: { yes: true }, interactive: false, out: () => {}, areasFn: none }), null);
  assert.equal(areasConfig(store).source, 'all');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('chooseProject: the menu leads with the areas and offers the generic build', async () => {
  const repo = repoWith(['src/api']);
  const store = new Store(repo).init();
  let items;
  const p = await chooseProject({ repo, store, interactive: true, out: () => {}, areasFn: found(['src/api']), selectFn: async o => { items = o.items.map(x => x.label); assert.equal(o.defaultIndex, 0); return o.items[0]; } });
  assert.deepEqual(items, ['Your areas: src/api (from your commits)', 'Whole repository (generic build)', 'Specify project directories']);
  assert.deepEqual(p.directories, ['src/api']);
  const full = await chooseProject({ repo, store, interactive: true, out: () => {}, areasFn: found(['src/api']), selectFn: async o => o.items[1] });
  assert.equal(full, null);
  assert.equal(areasConfig(store).source, 'all');
  fs.rmSync(repo, { recursive: true, force: true });
});

function staleRepo() {
  const dir = repoWith(['src/api']);
  const store = new Store(dir).init();
  fs.mkdirSync(path.join(dir, '.thinker', 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), maintain: { prs: true } }));  // mining is off by default since 2026-10-21
  return { dir, store };
}

test('maintain: focused on areas, the merged-PR step is scoped and each area\'s older history is walked in turn up to the depth', async () => {
  const { dir, store } = staleRepo();
  saveAreas(store, { directories: ['src/api', 'src/db'], source: 'manual', walkedBy: {}, walkVersion: 2 });
  const prs = [], walks = [];
  const fns = { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid', cost: 0 }), phrase: async (s, n) => ({ done: n, cost: 0 }),
    minePrs: async o => { prs.push(o); return { saved: 1, tokens: 10 }; }, mineAreaHistory: async o => { walks.push(o); return { saved: 2, tokens: 20, processed: 3 }; } };
  await maintain(store, dir, { fns });  // the first run only records where "since" starts
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  const r = await maintain(store, dir, { fns, now: Date.now() + MAINTENANCE_INTERVAL_MS });
  assert.equal(prs.length, 1);
  assert.deepEqual(prs[0].directories, ['src/api', 'src/db']);
  assert.equal(walks.length, 2, 'one walk per run, including the first');
  assert.deepEqual(walks[1], { paths: ['src/api'], limit: DEFAULTS.prsPerRun, scan: DEFAULTS.prsPerRun * 6 });
  assert.equal(r.prs, 3, 'merged PRs plus the walk');
  assert.deepEqual(areasConfig(store).walkedBy, { 'src/api': 6 });
  // the first area warm, the walk moves to the next; an area with nothing left is warm
  saveAreas(store, { walkedBy: { 'src/api': AREAS_DEFAULTS.walk } });
  const empty = { ...fns, mineAreaHistory: async o => { walks.push(o); return { saved: 0, tokens: 0, processed: 0, exhausted: true }; } };
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  await maintain(store, dir, { fns: empty, now: Date.now() + 2 * MAINTENANCE_INTERVAL_MS });
  assert.deepEqual(walks[2].paths, ['src/db']);
  assert.equal(areasConfig(store).walkedBy['src/db'], AREAS_DEFAULTS.walk);
  // warm: past the depth the walk stops, the merged-PR step goes on
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  await maintain(store, dir, { fns, now: Date.now() + 3 * MAINTENANCE_INTERVAL_MS });
  assert.equal(walks.length, 3);
  assert.equal(prs.length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('maintain: the generic build mines repository-wide and walks nothing', async () => {
  const { dir, store } = staleRepo();
  saveAreas(store, { directories: [], source: 'all' });
  const prs = [], walks = [];
  const fns = { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid', cost: 0 }), phrase: async (s, n) => ({ done: n, cost: 0 }),
    minePrs: async o => { prs.push(o); return { saved: 0, tokens: 0 }; }, mineAreaHistory: async o => { walks.push(o); return { saved: 0, tokens: 0 }; } };
  await maintain(store, dir, { fns });
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  await maintain(store, dir, { fns, now: Date.now() + MAINTENANCE_INTERVAL_MS });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].directories, null);
  assert.equal(walks.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('maintain: a cache nobody warmed finds its areas offline, then mines and walks them; no activity, no areas yet', async () => {
  const { dir, store } = staleRepo();
  const prs = [], walks = [];
  let found = { directories: [], source: null };
  const fns = { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid', cost: 0 }), phrase: async (s, n) => ({ done: n, cost: 0 }),
    activityAreas: () => found,
    minePrs: async o => { prs.push(o); return { saved: 0, tokens: 0 }; }, mineAreaHistory: async o => { walks.push(o); return { saved: 0, tokens: 0, processed: 3 }; } };
  await maintain(store, dir, { fns });
  assert.equal(store.config().areas, undefined, 'nothing found, nothing saved');
  assert.equal(walks.length, 0);
  found = { directories: ['src/api'], source: 'activity' };
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  await maintain(store, dir, { fns, now: Date.now() + MAINTENANCE_INTERVAL_MS });
  assert.deepEqual(store.config().areas.directories, ['src/api']);
  assert.equal(store.config().areas.source, 'activity');
  assert.deepEqual(prs.at(-1).directories, ['src/api']);
  assert.deepEqual(walks[0].paths, ['src/api']);
  // a saved choice, the generic build among them, is never replaced
  saveAreas(store, { directories: [], source: 'all' });
  found = { directories: ['web/ui'], source: 'activity' };
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  await maintain(store, dir, { fns, now: Date.now() + 2 * MAINTENANCE_INTERVAL_MS });
  assert.equal(store.config().areas.source, 'all');
  assert.equal(prs.at(-1).directories, null);
  fs.rmSync(dir, { recursive: true, force: true });
});
