import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { snapshotView, readSnapshot, lastSnapshot, refreshSnapshots, dropSnapshots, refreshing, pruneSnapshots, REFRESH_MS, SNAPSHOT_DAYS } from '../src/context-snapshot.js';
import { MAX_KEEP_MS } from '../src/view-sources.js';

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

// The point of the stamp (view-sources.js): a refresh over a repository where nothing has moved keeps the report it
// has and reads no session's record again. Before 2026-11-10 every refresh worked every window out from scratch, and
// the page starts one every ten minutes in every repository it lists.
test('a refresh where nothing has moved keeps the report it has', t => {
  const st = repo(t), now = Date.now();
  assert.deepEqual(refreshSnapshots(st, { now }).written, SNAPSHOT_DAYS);
  const first = readSnapshot(st, 30);
  const again = refreshSnapshots(st, { now: now + REFRESH_MS + 1 });
  assert.deepEqual(again, { written: [], kept: SNAPSHOT_DAYS }, 'nothing moved: nothing made again');
  const second = readSnapshot(st, 30);
  assert.deepEqual(second.view, first.view, 'the same report');
  assert.equal(second.at, now + REFRESH_MS + 1, 'with when it was looked at, so the page stops asking');
  // a report older than MAX_KEEP_MS is made again whatever the stamp says: nothing the stamp watches is trusted for ever
  assert.deepEqual(refreshSnapshots(st, { now: now + MAX_KEEP_MS + REFRESH_MS + 2 }).written, SNAPSHOT_DAYS);
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
  // the 30-day report snapshotView just made stands (nothing has moved since); the other window is made now
  const r = refreshSnapshots(ws);
  assert.deepEqual([...r.written, ...r.kept].sort((a, b) => a - b), SNAPSHOT_DAYS);
  assert.equal(fs.readdirSync(path.join(st.dir, 'state')).filter(f => f.startsWith('context-view')).length, SNAPSHOT_DAYS.length, 'no file of its own');
  // an instruction file of its own on its branch: the report is made again for it
  fs.appendFileSync(path.join(wt, 'AGENTS.md'), '\n## Branch\n\nx\n');
  assert.equal(readSnapshot(ws, 30), null);
  assert.ok(readSnapshot(st, 30));
});

// The kept report is keyed on the settings fields it reads, not the files' bytes (2026-11-08): Claude Code and thinker's
// rewire write other fields of ~/.claude/settings.json, and every such write dropped every repository's report.
test('a settings change the report does not read keeps the snapshot; one it reads drops it', t => {
  const st = repo(t), claude = path.join(st.repo, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Workflow'] }, env: { A: '1' } }));
  snapshotView(st, 30);
  assert.ok(readSnapshot(st, 30));
  fs.writeFileSync(path.join(claude, 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Workflow'] }, env: { A: '2' }, hooks: { Stop: [] } }));
  assert.ok(readSnapshot(st, 30), 'env and hooks are not read by the report');
  fs.writeFileSync(path.join(claude, 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Workflow', 'Artifact'] }, env: { A: '2' } }));
  assert.equal(readSnapshot(st, 30), null, 'a denied tool is a row of the report');
  snapshotView(st, 30);
  fs.writeFileSync(path.join(claude, 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Workflow', 'Artifact'] }, enabledPlugins: { 'x@y': false } }));
  assert.equal(readSnapshot(st, 30), null, 'a plugin switched off is too');
  // `mine` is what ui/scans.js reads the changed sessions against: this code's, inputs holding
  assert.equal(lastSnapshot(st, 30).mine, false);
  snapshotView(st, 30);
  assert.equal(lastSnapshot(st, 30).mine, true);
});

test('a write prunes the reports of windows the tab no longer offers and the per-worktree files of before', t => {
  const st = repo(t), state = path.join(st.dir, 'state');
  fs.mkdirSync(state, { recursive: true });
  for (const n of ['context-view-14.json', 'context-view-30-315df62f.json', 'context-view-7-a8dc827a.json', 'context-view.lock', 'report.json']) fs.writeFileSync(path.join(state, n), '{}');
  snapshotView(st, 30);
  const left = fs.readdirSync(state).sort();
  assert.deepEqual(left.filter(n => n.startsWith('context-view')), ['context-view-30.json', 'context-view.lock']);
  assert.ok(left.includes('report.json'), 'only its own files');
  assert.equal(pruneSnapshots(state), 0);
});
