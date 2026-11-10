// What changed in thinker, said once. The note's whole job is to be said to a person exactly once and
// never again, so that is what is tested: the id is the key, not the version, and a note already told
// is not told after an update that did not change it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UPDATE_NOTE, updateNoteDue, updateNoteShown, updateNoteText } from '../src/update-note.js';

const store = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-note-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir };
};

test('a note is said once per machine, and a new note is said again', t => {
  const s = store(t);
  assert.equal(updateNoteDue(s), true);
  updateNoteShown(s);
  assert.equal(updateNoteDue(s), false);
  // the same words under a new id are a new note; the same id under a new version is not
  assert.equal(updateNoteDue(s, { note: { ...UPDATE_NOTE, id: 'next' } }), true);
});

test('the note is the title, the lines, and where to look', () => {
  const text = updateNoteText({ id: 'x', title: 'What changed', lines: ['one', 'two'], more: 'See both: thinker ui' }, { version: '0.3.0' });
  assert.equal(text, ['🧠 thinker v0.3.0 · What changed', '  • one', '  • two', '  See both: thinker ui'].join('\n'));
  // no version to hand (a checkout with no package.json read): the note still reads as a sentence
  assert.match(updateNoteText({ id: 'x', title: 'What changed', lines: ['one'] }, { version: null }), /^🧠 thinker · What changed\n {2}• one$/);
  // the shipped note: short lines, plain words, nothing a person must look up
  assert.ok(UPDATE_NOTE.lines.every(l => l.length <= 240), 'a line fits an end-of-turn message');
});
