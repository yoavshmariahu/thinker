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
