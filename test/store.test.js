import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, logFile } from '../src/store.js';

test('init creates .thinker when notes live outside the repo', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-store-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const notes = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-notes-'));
  const prev = process.env.THINKER_NOTES_DIR;
  process.env.THINKER_NOTES_DIR = notes;
  try {
    const store = new Store(repo).init();
    assert.equal(fs.existsSync(path.join(repo, '.thinker', 'config.json')), true);
    assert.equal(store.notesDir, notes);
    assert.equal(store.list().length, 0);
  } finally {
    if (prev === undefined) delete process.env.THINKER_NOTES_DIR;
    else process.env.THINKER_NOTES_DIR = prev;
  }
});

test('note ids cannot escape the notes directory and symlinked note roots are refused', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-store-safe-')));
  const store = new Store(repo).init();
  assert.throws(() => store.put({ id: '../../../outside', title: 'x' }), /invalid note id/);
  fs.renameSync(path.join(repo, '.thinker', 'notes'), path.join(repo, '.thinker', 'notes-original'));
  fs.symlinkSync(os.tmpdir(), path.join(repo, '.thinker', 'notes'));
  assert.throws(() => store.list(), /symlinked notes directory/);
  assert.throws(() => store.put({ id: 'safe', title: 'x' }), /symlinked notes directory/);
});

// The test suite makes hundreds of checkouts under the system temp directory. Without
// THINKER_HOME they used to append to the real machine log, where their fixture costs
// showed up in `thinker usage` as money spent.
test('a scratch checkout logs locally unless THINKER_HOME says where the machine log is', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-scratch-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')));
  const prevHome = process.env.THINKER_HOME, prevLog = process.env.THINKER_LOG, prevTest = process.env.THINKER_TEST;
  delete process.env.THINKER_LOG;
  try {
    const store = new Store(repo);
    delete process.env.THINKER_HOME;
    assert.equal(logFile(store), path.join(repo, '.thinker', 'log.jsonl'));
    process.env.THINKER_HOME = home;
    assert.equal(logFile(store), path.join(home, 'log.jsonl'));
    // Test mode keeps even non-temporary benchmark worktrees out of the machine log.
    delete process.env.THINKER_HOME;
    process.env.THINKER_TEST = '1';
    assert.equal(logFile(new Store('/non-temporary/benchmark')), path.join('/non-temporary/benchmark', '.thinker', 'log.jsonl'));
    process.env.THINKER_TEST = '0';
    assert.equal(logFile(new Store('/non-temporary/benchmark')), path.join(os.homedir(), '.thinker', 'log.jsonl'));
  } finally {
    if (prevTest === undefined) delete process.env.THINKER_TEST; else process.env.THINKER_TEST = prevTest;
    if (prevHome === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = prevHome;
    if (prevLog === undefined) delete process.env.THINKER_LOG; else process.env.THINKER_LOG = prevLog;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a linked worktree uses the main checkout\'s cache unless isolation is explicit or already there', async () => {
  const { createNote } = await import('../src/ops.js');
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'ignore' });
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-wt-')));
  const main = path.join(tmp, 'main'); fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  git(main, 'init', '-q'); fs.writeFileSync(path.join(main, 'src/a.js'), 'export function fetchRows() { return 1; }\n'); git(main, 'add', '.'); git(main, 'commit', '-qm', 'i');
  const prevLog = process.env.THINKER_LOG; process.env.THINKER_LOG = 'local';
  try {
    // the main checkout has no notes yet: a worktree keeps its own (a benchmark's base clone)
    const early = path.join(tmp, 'early'); git(main, 'worktree', 'add', '-q', early);
    assert.equal(new Store(early).dir, path.join(early, '.thinker'));
    const store = new Store(main).init();
    createNote(store, { title: 'fetchRows reads the rows table', kind: 'map', answers: ['where are rows read'], body: 'src/a.js:fetchRows reads rows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
    // a worktree inside the checkout (Claude Desktop's .claude/worktrees) and one beside it
    const nested = path.join(main, '.claude', 'worktrees', 'w1'), beside = path.join(tmp, 'beside');
    git(main, 'worktree', 'add', '-q', '-b', 'w1', nested); git(main, 'worktree', 'add', '-q', '-b', 'w2', beside);
    for (const wt of [nested, beside]) {
      const s = new Store(wt);
      assert.equal(s.repo, wt, 'code is read from the worktree');
      assert.equal(s.dir, path.join(main, '.thinker'), 'the cache is the main checkout\'s');
      assert.deepEqual(s.list().map(n => n.title), ['fetchRows reads the rows table']);
      assert.doesNotThrow(() => s.assertSafeNotesPath());
    }
    // notes a worktree's cache gathered on its own are no reason to stay apart; an isolated file is
    const own = path.join(tmp, 'own'); git(main, 'worktree', 'add', '-q', '-b', 'w3', own);
    fs.mkdirSync(path.join(own, '.thinker', 'local', 'notes'), { recursive: true }); fs.writeFileSync(path.join(own, '.thinker', 'local', 'notes', 'x.json'), '{}');
    assert.equal(new Store(own).dir, path.join(main, '.thinker'));
    const kept = path.join(tmp, 'kept'); git(main, 'worktree', 'add', '-q', '-b', 'w5', kept);
    fs.mkdirSync(path.join(kept, '.thinker', 'local'), { recursive: true }); fs.writeFileSync(path.join(kept, '.thinker', 'local', 'isolated'), '');
    assert.equal(new Store(kept).dir, path.join(kept, '.thinker'));
    // THINKER_NOTES_DIR (benchmark arms) isolates outright
    const prev = process.env.THINKER_NOTES_DIR; process.env.THINKER_NOTES_DIR = path.join(tmp, 'arm-notes');
    try { const wt = path.join(tmp, 'arm'); git(main, 'worktree', 'add', '-q', '-b', 'w4', wt); assert.equal(new Store(wt).dir, path.join(wt, '.thinker')); }
    finally { if (prev === undefined) delete process.env.THINKER_NOTES_DIR; else process.env.THINKER_NOTES_DIR = prev; }
    assert.equal(new Store(main).dir, path.join(main, '.thinker'));
  } finally {
    if (prevLog === undefined) delete process.env.THINKER_LOG; else process.env.THINKER_LOG = prevLog;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
