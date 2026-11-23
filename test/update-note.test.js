// The update note is said once per machine. What is held here is the record behind that: it is every note
// said, never the one id of the last, because two copies of thinker carrying different notes run side by side
// after every update (an open Claude Code session keeps the mod it started with).
import './helpers.js';
import { tmp } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UPDATE_NOTE, updateNoteDue, updateNoteShown, notesShown } from '../src/update-note.js';

const storeAt = () => ({ dir: tmp('cache') });
const OLDER = { ...UPDATE_NOTE, id: 'an-older-note' };

test('a note is due until it is said, and never again after', () => {
  const store = storeAt();
  assert.equal(updateNoteDue(store), true);
  updateNoteShown(store);
  assert.equal(updateNoteDue(store), false);
});

test('a copy that says an older note afterwards does not make the latest one due again', () => {
  const store = storeAt();
  updateNoteShown(store);                               // the new copy says the latest note
  assert.equal(updateNoteDue(store, { note: OLDER }), true);
  updateNoteShown(store, { note: OLDER });              // an older copy says its own
  assert.equal(updateNoteDue(store), false, 'the latest note was said again');
  assert.equal(updateNoteDue(store, { note: OLDER }), false);
  assert.deepEqual(Object.keys(notesShown(store)).sort(), [OLDER.id, UPDATE_NOTE.id].sort());
});

test('a note the old one-id record holds counts as said, and that record is left as it was', () => {
  const store = storeAt();
  const old = path.join(store.dir, 'state', 'update-note.json');
  fs.mkdirSync(path.dirname(old), { recursive: true });
  const was = JSON.stringify({ id: UPDATE_NOTE.id, at: '2026-11-22T23:34:49.201Z' });
  fs.writeFileSync(old, was);
  assert.equal(updateNoteDue(store), false);
  updateNoteShown(store, { note: OLDER });
  assert.equal(fs.readFileSync(old, 'utf8'), was);
  assert.equal(updateNoteDue(store), false);
});
