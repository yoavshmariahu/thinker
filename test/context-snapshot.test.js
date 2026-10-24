import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { snapshotView, readSnapshot, refreshSnapshots, dropSnapshots, refreshing, REFRESH_MS, SNAPSHOT_DAYS } from '../src/context-snapshot.js';

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ctxsnap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# R\n\n## Tests\n\nRun `npm test`.\n');
  const st = new Store(dir); st.init();
  return st;
}

test('the Context report is made once and read back until it is old', t => {
  const st = repo(t), now = Date.now();
  const a = snapshotView(st, 30, { now });
  assert.equal(a.stale, false);
  assert.deepEqual(a.view.instructions.sections.map(s => s.title), ['Tests']);
  // read back, not made again: same time, and older than REFRESH_MS it says so
  assert.equal(snapshotView(st, 30, { now: now + 1000 }).at, now);
  assert.equal(snapshotView(st, 30, { now: now + REFRESH_MS + 1 }).stale, true);
  // another window is its own report
  assert.equal(readSnapshot(st, 7), null);
});

test('a change to the instruction file or the config is shown at once', t => {
  const st = repo(t);
  snapshotView(st, 30);
  assert.ok(readSnapshot(st, 30));
  fs.writeFileSync(path.join(st.repo, 'AGENTS.md'), '# R\n\n## Tests\n\nRun `npm test`.\n\n## Style\n\nShort lines.\n');
  assert.equal(readSnapshot(st, 30), null);
  assert.deepEqual(snapshotView(st, 30).view.instructions.sections.map(s => s.title), ['Tests', 'Style']);
  fs.writeFileSync(path.join(st.dir, 'config.json'), JSON.stringify({ instructions: { core: { enabled: true, keep: ['Tests'] } } }));
  assert.equal(readSnapshot(st, 30), null);
});

test('a refresh writes every window the tab offers, one run at a time, and an action drops them', t => {
  const st = repo(t);
  assert.deepEqual(refreshSnapshots(st).written, SNAPSHOT_DAYS);
  for (const d of SNAPSHOT_DAYS) assert.ok(readSnapshot(st, d));
  assert.equal(refreshing(st), false);
  fs.writeFileSync(path.join(st.dir, 'state', 'context-view.lock'), '1');
  assert.equal(refreshing(st), true);
  assert.equal(refreshSnapshots(st).skipped, 'locked');
  dropSnapshots(st);
  for (const d of SNAPSHOT_DAYS) assert.equal(readSnapshot(st, d), null);
});

test('a linked worktree reads and refreshes the main checkout\'s report: one file per repository', t => {
  const st = repo(t), wt = path.join(st.repo, '.worktrees', 'wt');
  // a worktree shares the main checkout's cache once that has local notes (store.js:cacheCheckout)
  fs.mkdirSync(path.join(st.dir, 'local', 'notes'), { recursive: true }); fs.writeFileSync(path.join(st.dir, 'local', 'notes', 'n1.json'), '{}');
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'init', '--allow-empty'], { cwd: st.repo });
  execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'wt'], { cwd: st.repo });
  fs.copyFileSync(path.join(st.repo, 'AGENTS.md'), path.join(wt, 'AGENTS.md'));
  const ws = new Store(wt);
  assert.equal(ws.dir, st.dir);
  snapshotView(st, 30);
  assert.equal(fs.readdirSync(path.join(st.dir, 'state')).filter(f => f.startsWith('context-view')).length, 1);
  assert.ok(readSnapshot(ws, 30), 'the worktree reads the same report');
  assert.deepEqual(refreshSnapshots(ws).written, SNAPSHOT_DAYS);
  assert.equal(fs.readdirSync(path.join(st.dir, 'state')).filter(f => f.startsWith('context-view')).length, SNAPSHOT_DAYS.length, 'no file of its own');
  // an instruction file of its own on its branch: the report is made again for it
  fs.appendFileSync(path.join(wt, 'AGENTS.md'), '\n## Branch\n\nx\n');
  assert.equal(readSnapshot(ws, 30), null);
  assert.ok(readSnapshot(st, 30));
});
