// What changed in thinker, said once. The note's whole job is to be said to a person exactly once and
// never again, so that is what is tested: the id is the key, not the version, and a note already told
// is not told after an update that did not change it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UPDATE_NOTE, updateNoteDue, updateNoteShown, updateNoteText, noteLinks, notePage } from '../src/update-note.js';
import { ensureUi, uiFile } from '../src/context-suggest.js';

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

// The note of 2026-11-22 sends a person to two places on the local page, and the page is only up while
// somebody runs it. So the note's links are the address of a page that is running when the note is said,
// and where none could be started the same line names the command instead of a link that opens nothing.
test('a place on the page is a link while a page runs, and the command where none does', () => {
  const note = { id: 'x', title: 'What changed', lines: ['Chat in {chat} now.', 'See {factory} too.', 'No link here.'] };
  assert.equal(updateNoteText(note, { version: null, page: 'http://127.0.0.1:4848/' }),
    ['🧠 thinker · What changed', '  • Chat in http://127.0.0.1:4848/#tab=chat now.', '  • See http://127.0.0.1:4848/#tab=factory too.', '  • No link here.'].join('\n'));
  assert.equal(updateNoteText(note, { version: null }),
    ['🧠 thinker · What changed', '  • Chat in the dashboard (run: thinker ui) now.', '  • See (run: thinker ui --tab factory) too.', '  • No link here.'].join('\n'));
  // the tabs are the page's own (ui/page.html:hashTab reads `tab=`), so the link lands where the line says
  const page = fs.readFileSync(new URL('../src/ui/page.html', import.meta.url), 'utf8');
  for (const to of Object.values(noteLinks('/'))) assert.ok(page.includes(`id="tab-${to.split('tab=')[1]}"`), to);
  // the shipped note names both places, and no slot is left unfilled whichever way it is said
  const said = [updateNoteText(UPDATE_NOTE, { page: 'http://127.0.0.1:4848/' }), updateNoteText(UPDATE_NOTE)];
  assert.match(said[0], /#tab=chat/); assert.match(said[0], /#tab=factory/);
  for (const text of said) assert.doesNotMatch(text, /[{}]/);
});

test('the page is started for a note that links to it, and for no other', t => {
  const s = store(t);
  let asked = 0;
  const ensureFn = () => { asked++; return 'http://127.0.0.1:4848/'; };
  assert.equal(notePage(s, { ensureFn }), 'http://127.0.0.1:4848/');
  assert.equal(notePage(s, { note: { lines: ['nothing to open'] }, ensureFn }), null);
  assert.equal(asked, 1);
  // a page that cannot be started costs the note its links, never the turn
  assert.equal(notePage(s, { ensureFn: () => { throw new Error('no node'); } }), null);
  assert.equal(notePage(s, { ensureFn: () => null }), null);
});

test('one page per machine: a running one is reused, a dead one replaced, and a suite starts none', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-note-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const s = { repo: home }, spawned = [];
  const write = pid => { fs.mkdirSync(path.dirname(uiFile(home)), { recursive: true }); fs.writeFileSync(uiFile(home), JSON.stringify({ pid, port: 4848, url: 'http://127.0.0.1:4848/' })); };
  // what `thinker ui --background` does once it listens: its address in the machine's state (cache.js:uiCommand)
  const spawnFn = (cmd, args, opts) => { spawned.push({ args, opts }); write(process.pid); return { on() {}, unref() {} }; };
  // nothing running, and under THINKER_TEST nothing is started unless the test hands in a spawn (set here, so a
  // run of this file outside the suite starts no page either)
  const was = process.env.THINKER_TEST;
  process.env.THINKER_TEST = '1';
  try { assert.equal(ensureUi(s, { home }), null); } finally { if (was === undefined) delete process.env.THINKER_TEST; else process.env.THINKER_TEST = was; }
  assert.equal(ensureUi(s, { home, spawnFn, cliPath: '/thinker/cli.js' }), 'http://127.0.0.1:4848/');
  assert.deepEqual(spawned[0].args, ['/thinker/cli.js', 'ui', '--background']);
  assert.equal(spawned[0].opts.detached, true);
  // the page is up: asked again, nothing is started
  assert.equal(ensureUi(s, { home, spawnFn }), 'http://127.0.0.1:4848/');
  assert.equal(spawned.length, 1);
  // its process gone and its file left behind: a link there would open nothing, so another is started
  write(2 ** 30);
  assert.equal(ensureUi(s, { home, spawnFn }), 'http://127.0.0.1:4848/');
  assert.equal(spawned.length, 2);
  // one that never says where it is: no address, after the wait and no longer
  fs.rmSync(uiFile(home));
  assert.equal(ensureUi(s, { home, spawnFn: () => ({ on() {}, unref() {} }), waitMs: 200 }), null);
});
