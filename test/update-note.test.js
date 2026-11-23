// The release note is shown once, right after the update that brought it (src/update-note.js; the owner's rule of
// 2026-11-23, after one note was shown for a day). Held here: what arms a note, that one take is all there is
// however many turns end together, and that each door says only what it took.
import { tmp, repo } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { armNote, takeNote, notesShown, updateNoteText, noteCard, UPDATE_NOTE, ARMED } from '../src/update-note.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const MODULE = new URL('../src/update-note.js', import.meta.url).href;
const NOTE = { id: '2026-12-next', title: 'What changed', lines: ['Thinker does a new thing.', 'Talk to it in {chat}.'], more: 'Open the dashboard any time: thinker ui' };
const OTHER = { ...NOTE, id: '2027-01-later', lines: ['And another.'] };
const armed = home => { try { return JSON.parse(fs.readFileSync(path.join(home, 'state', ARMED), 'utf8')); } catch { return null; } };

test('the note of this release, where it has one, is short and has an id', () => {
  if (UPDATE_NOTE === null) return;   // most releases say nothing
  assert.match(UPDATE_NOTE.id, /^\d{4}-\d{2}-[a-z0-9-]+$/);
  assert.ok(UPDATE_NOTE.title && UPDATE_NOTE.lines.length >= 1 && UPDATE_NOTE.lines.length <= 4 && UPDATE_NOTE.lines.every(l => typeof l === 'string'));
});

test('a note is armed only by an update to a release that brings it', () => {
  const home = tmp('home');
  const arm = (version, note) => armNote({ home, version, note });
  assert.equal(arm('1.0.0', NOTE), null, 'a new install is shown nothing: nothing changed for it');
  assert.equal(arm('1.0.0', NOTE), null, 'the same release run again is not an update');
  assert.equal(arm('1.0.1', NOTE), null, 'an update that keeps the note the last release carried brings nothing new');
  assert.equal(arm('1.0.2', null), null, 'a release with no note says nothing');
  assert.equal(armed(home), null);

  assert.equal(arm('1.1.0', OTHER), OTHER.id, 'the update that brings a note arms it');
  assert.deepEqual({ id: armed(home).id, version: armed(home).version, lines: armed(home).lines }, { id: OTHER.id, version: '1.1.0', lines: OTHER.lines });
  assert.equal(arm('1.0.5', NOTE), null, 'an older copy run on this machine (a worktree, a downgrade) is not an update');
  assert.equal(armed(home).id, OTHER.id, 'and takes nothing away');
  assert.equal(arm('1.2.0', null), null);
  assert.equal(armed(home), null, 'a note still waiting when its release is replaced by one without it is dropped');

  // a machine that an updater has moved before, arriving from a release that kept no record: this is its update
  const old = tmp('home');
  fs.writeFileSync(path.join(old, 'install.json'), JSON.stringify({ version: '1.3.0', updatedAt: '2026-11-23T06:26:08.079Z' }));
  assert.equal(armNote({ home: old, version: '1.3.0', note: NOTE }), NOTE.id);
  // ... unless it was shown this note already, by the record of today or the one before it
  for (const [file, record] of [['update-notes.json', { shown: { [NOTE.id]: '2026-11-23T06:01:40.329Z' } }], ['update-note.json', { id: NOTE.id, at: '2026-11-22T23:34:49.201Z' }]]) {
    const seen = tmp('home');
    fs.mkdirSync(path.join(seen, 'state'));
    fs.writeFileSync(path.join(seen, 'install.json'), JSON.stringify({ updatedAt: '2026-11-23T06:26:08.079Z' }));
    fs.writeFileSync(path.join(seen, 'state', file), JSON.stringify(record));
    assert.equal(armNote({ home: seen, version: '1.3.0', note: NOTE }), null, `${file} says it was shown`);
  }
});

test('of every turn that ends at once, one is shown the note, and nothing can show it again', async () => {
  const home = tmp('home');
  armNote({ home, version: '1.0.0', note: null });
  assert.equal(armNote({ home, version: '1.1.0', note: NOTE }), NOTE.id);
  // twelve processes, as twelve sessions and agents ending a turn together: each waits for the same instant and
  // asks for the note (without the wait they would ask one after another, and any take at all would pass)
  const go = Date.now() + 1500;
  const ask = () => new Promise(resolve => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `import { takeNote } from ${JSON.stringify(MODULE)}; while (Date.now() < ${go}) {} process.stdout.write(takeNote({ home: ${JSON.stringify(home)} })?.id || '');`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; p.stdout.on('data', d => { out += d; }); p.on('close', () => resolve(out));
  });
  const got = await Promise.all(Array.from({ length: 12 }, ask));
  assert.deepEqual(got.filter(Boolean), [NOTE.id], 'exactly one');

  assert.equal(takeNote({ home }), null, 'a turn that ends later');
  assert.ok(NOTE.id in notesShown(home));
  assert.deepEqual(fs.readdirSync(path.join(home, 'state')).filter(f => f.startsWith(ARMED)), [], 'nothing of the note is left on the machine');
  // and no update brings it back: the same release again, a downgrade and the update after it, a later release
  assert.equal(armNote({ home, version: '1.1.0', note: NOTE }), null);
  assert.equal(armNote({ home, version: '1.0.0', note: null }), null);
  assert.equal(armNote({ home, version: '1.1.1', note: NOTE }), null);
  fs.rmSync(path.join(home, 'state', 'update-note-release.json'));   // even with the record of releases lost
  assert.equal(armNote({ home, version: '1.2.0', note: NOTE }), null);
  assert.equal(armNote({ home, version: '1.3.0', note: NOTE }), null);
  assert.equal(armed(home), null);

  // a note written to the file by something else, already shown here, is not shown either
  fs.writeFileSync(path.join(home, 'state', ARMED), JSON.stringify({ ...NOTE, version: '1.1.0' }));
  assert.equal(takeNote({ home }), null);
  assert.equal(armed(home), null);
});

test('a note names its release and fills its links, for the agents with a card and without one', () => {
  const note = { ...NOTE, version: '1.1.0' };
  assert.equal(updateNoteText(note, { page: 'http://127.0.0.1:4100/' }), [
    '🧠 thinker v1.1.0 · What changed', '  • Thinker does a new thing.', '  • Talk to it in http://127.0.0.1:4100/#tab=chat.', '  Open the dashboard any time: thinker ui',
  ].join('\n'));
  assert.match(updateNoteText(note), /Talk to it in the dashboard \(run: thinker ui\)\./, 'no page running: the command that opens the place');
  assert.deepEqual(noteCard(note, { page: 'http://127.0.0.1:4100/' }).lines[1], [
    { text: 'Talk to it in ' }, { text: 'http://127.0.0.1:4100/#tab=chat', href: 'http://127.0.0.1:4100/#tab=chat' }, { text: '.' },
  ]);
});

test('each door says the note to the first turn that ends, and to no turn after it', () => {
  const checkout = repo();
  const hook = (home, args, { input = {}, env = {} } = {}) => execFileSync('node', [CLI, 'hook', ...args], {
    cwd: checkout, input: JSON.stringify({ cwd: checkout, ...input }), encoding: 'utf8', env: { ...process.env, THINKER_HOME: home, ...env },
  });
  const arm = () => { const home = tmp('home'); armNote({ home, version: '1.0.0', note: null }); armNote({ home, version: '1.1.0', note: NOTE }); return home; };

  // the Stop hook, in an agent that shows a message at the end of a turn
  let home = arm();
  const first = hook(home, ['stop', '--client', 'codex'], { input: { session_id: 's1' } });
  assert.match(JSON.parse(first).systemMessage, /thinker v1\.1\.0 · What changed\n {2}• Thinker does a new thing\./);
  assert.doesNotMatch(hook(home, ['stop', '--client', 'codex'], { input: { session_id: 's1' } }), /What changed/, 'the next turn of that session');
  assert.doesNotMatch(hook(home, ['stop', '--client', 'gemini'], { input: { session_id: 's2' } }), /What changed/, 'and another agent\'s');

  // a run nobody watches leaves it for a turn somebody will see
  home = arm();
  assert.doesNotMatch(hook(home, ['stop', '--client', 'claude'], { input: { session_id: 's3' }, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } }), /What changed/);
  assert.equal(armed(home).id, NOTE.id);
  // so does a session that is closing (Claude Code runs this hook for SessionEnd too)
  assert.doesNotMatch(hook(home, ['stop', '--client', 'claude'], { input: { session_id: 's3', hook_event_name: 'SessionEnd' } }), /What changed/);
  assert.equal(armed(home).id, NOTE.id);
  // and so does an agent with no message at the end of a turn
  assert.doesNotMatch(hook(home, ['stop', '--client', 'cursor'], { input: { session_id: 's4' } }), /What changed/);
  assert.equal(armed(home).id, NOTE.id);

  // the card mod's door: the note, cut into words and links, to the one call that takes it
  const card = JSON.parse(hook(home, ['note', '--client', 'claude']));
  assert.deepEqual({ title: card.title, version: card.version, first: card.lines[0] }, { title: 'What changed', version: '1.1.0', first: [{ text: 'Thinker does a new thing.' }] });
  assert.equal(hook(home, ['note', '--client', 'claude']), '');
  assert.doesNotMatch(hook(home, ['stop', '--client', 'codex'], { input: { session_id: 's5' } }), /What changed/, 'the Stop hook has nothing left to say');

  // the notices switched off: taken, and not said -- it does not wait for them to come back on
  home = arm();
  assert.doesNotMatch(hook(home, ['stop', '--client', 'codex'], { input: { session_id: 's6' }, env: { THINKER_NOTICE: 'off' } }), /What changed/);
  assert.equal(armed(home), null);
});
