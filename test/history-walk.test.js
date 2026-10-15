import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { listMergedCommits, recordMinedPrs, minedPrs } from '../src/prs.js';
import { minePrs } from '../src/commands/learn.js';
import { maintain, MAINTENANCE_INTERVAL_MS } from '../src/maintain.js';
import { saveAreas, areasConfig } from '../src/areas.js';

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-walk-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true });
  for (let i = 0; i < 16; i++) {
    fs.writeFileSync(path.join(repo, 'src/api/a.js'), `export const n = ${i};\n`);
    git('add', 'src'); git('commit', '-qm', `fix: API value ${i}`);
  }
  const store = new Store(repo).init();
  saveAreas(store, { directories: ['src/api'], source: 'manual', walkedBy: {}, walkVersion: 2 });
  const ctx = { store, flags: {}, out: () => {} };
  const scan = (options, distillPrFn) => minePrs(ctx, null, { repo, from: 'HEAD', pathsOnly: true, pathsLimit: options.limit,
    pathsScan: options.scan, ...options, distillPrFn });
  return { repo, store, scan };
}
const free = { spentToday: () => 0, refresh: () => [], archive: () => [] };

test('an empty bounded walk widens past mined changes and only finishes at the end of history', async t => {
  const { repo, store, scan } = fixture(t);
  const all = listMergedCommits(repo, { from: 'HEAD', limit: 100, paths: ['src/api'] });
  recordMinedPrs(store, 'local', all.slice(0, 9));
  const calls = [], results = [];
  const distill = async (_, pr) => { calls.push(pr.hash); return { notes: [], tokens: 0 }; };
  const fns = { ...free, mineAreaHistory: async o => { const r = await scan(o, distill); results.push(r); return r; } };
  const now = Date.now();
  await maintain(store, repo, { fns, now });
  assert.equal(results[0].processed, 0);
  assert.equal(results[0].exhausted, false);
  assert.equal(areasConfig(store).walkedBy['src/api'], 0);
  for (let i = 1; i <= 3; i++) await maintain(store, repo, { fns, now: now + i * MAINTENANCE_INTERVAL_MS });
  assert.equal(calls.length, 7);
  assert.equal(new Set(calls).size, 7);
  assert.equal(results.at(-1).exhausted, true);
  assert.equal(minedPrs(store, 'local').mined.size, 16);
  assert.equal(areasConfig(store).walkedBy['src/api'], 100);
});

test('failed mining leaves the walk unfinished and retries; the last batch respects its remaining allowance', async t => {
  const { repo, store, scan } = fixture(t);
  saveAreas(store, { walkedBy: { 'src/api': 99 } });
  const now = Date.now(), calls = [];
  let failing = true;
  const fns = { ...free, mineAreaHistory: async o => {
    calls.push(o);
    return scan(o, async () => { if (failing) throw new Error('temporary failure'); return { notes: [], tokens: 0 }; });
  } };
  await maintain(store, repo, { fns, now });
  assert.equal(calls[0].limit, 1);
  assert.equal(areasConfig(store).walkedBy['src/api'], 99);
  assert.equal(minedPrs(store, 'local').mined.size, 0);
  failing = false;
  await maintain(store, repo, { fns, now: now + MAINTENANCE_INTERVAL_MS });
  assert.equal(areasConfig(store).walkedBy['src/api'], 100);
  assert.equal(minedPrs(store, 'local').mined.size, 1);
});

test('legacy finished counters are rechecked and a git error cannot finish a walk', async t => {
  const { repo, store } = fixture(t);
  saveAreas(store, { walkVersion: 1, walkedBy: { 'src/api': 100 } });
  let called = false;
  await maintain(store, repo, { fns: { ...free, mineAreaHistory: async () => {
    called = true;
    listMergedCommits(path.join(repo, 'missing'), { strict: true });
  } } });
  assert.equal(called, true);
  assert.equal(areasConfig(store).walkVersion, 2);
  assert.equal(areasConfig(store).walkedBy['src/api'] || 0, 0);
});
