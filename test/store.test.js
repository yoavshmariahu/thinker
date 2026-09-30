import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';

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
