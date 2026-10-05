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
