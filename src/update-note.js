// What changed in thinker: a release's note, shown once, right after the update that brought it.
//
// The rule (the owner's, 2026-11-23): a note shows up only right after an update to a release that carries
// one, and it is never revealed more than once. So the note is not something a copy of thinker compares
// against a record at every turn. It is a token:
//
//   the update   the new copy's `rewire` (what every updater runs last, update.js) sees the machine's
//                release rise and that the release carries a note this machine has not been shown, and
//                writes the note itself to `state/update-note-armed.json` (armNote);
//   the reveal   the first watched turn that ends takes that file by renaming it, which one process can
//                do and no second one, records the note as shown, and only then shows it (takeNote).
//
// After that nothing on the machine holds the note, so nothing can show it again: not a second session, not
// another agent, not a session that was already open, not one reopened later. A reveal that fails after the
// take is a note not shown at all; never two.
//
// From 2026-11-10 to 2026-11-23 it was the other way round, and the owner saw the same note for a day: each
// copy carried its own note and showed it wherever a record did not hold its id. A Claude Code session keeps
// the card mod it loaded at its start, so two sessions open across an update carried two notes and each
// found the other's id where its own should be; and a card kept in the mod's store was drawn again under its
// answer in every session that reopened the transcript. Hence the three things that hold here: no door
// carries a note or decides to show one (it can only take the token), the take is this copy's and atomic
// (the mod asks for it through `thinker hook note`), and the card is kept nowhere but the session it was
// drawn in. The note was removed outright on 2026-11-23 (#936) and came back as this.
//
// No release carries a note unless UPDATE_NOTE is set. Four lines at most. A person who has switched the
// notices off is told nothing, and the note is still taken: it does not wait for them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isTestMode } from './test-mode.js';
import { appVersion } from './proxy-service.js';
import { compareVersions } from './clients.js';
import { ensureUi } from './context-suggest.js';

// The note of this release, or null: `{ id, title, lines, more }`. A new note takes a new id; a release that
// keeps the last one's note shows nothing, since the machine's last release carried it too.
// A line may name a place on the local page as `{chat}` or `{factory}` (noteParts).
export const UPDATE_NOTE = null;

// All of it is the machine's, under thinker's home. The suite must not write under the developer's home, so
// in test mode with no THINKER_HOME there is no home, and nothing is armed or taken.
const noteHome = () => process.env.THINKER_HOME || (isTestMode() ? null : path.join(os.homedir(), '.thinker'));
const SHOWN = 'update-notes.json';            // { shown: { <note id>: <when> } }, only ever added to
const SHOWN_BEFORE = 'update-note.json';      // the one id the Stop hook kept until 2026-11-22; read, never written
export const ARMED = 'update-note-armed.json';       // the token: the note itself, from the update until the reveal
const RELEASE = 'update-note-release.json';   // { version, note }: the release this machine was last moved to
const at = (home, name) => path.join(home, 'state', name);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const own = () => `${process.pid}.${randomBytes(4).toString('hex')}`;
// whole or not at all: a half-written record reads as nothing recorded
function writeWhole(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${own()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); } finally { fs.rmSync(tmp, { force: true }); }
}

// Every note this machine has been shown, by id. The copies of 0.5.2 still open in a session read the same
// file, so it keeps its shape and no id is ever taken out of it.
export function notesShown(home = noteHome()) {
  if (!home) return {};
  const before = readJson(at(home, SHOWN_BEFORE)), shown = readJson(at(home, SHOWN))?.shown;
  return { ...(before?.id ? { [before.id]: before.at || '' } : {}), ...(shown && typeof shown === 'object' ? shown : {}) };
}

// The update's half. Run by `rewire` and `connect`, the steps every update and install ends with, so it is
// this copy -- the one just installed -- that says what it carries. It arms the note only when all three hold:
// the machine's release rose (the same release run again, an older copy in a worktree and a downgrade are not
// updates), the release it rose from did not carry this note, and the note was never shown here. A machine
// with no record of a release is a new install and is shown nothing -- except one that an updater has already
// moved (its receipt says so), which is a machine arriving from before this record was kept.
// Returns the id it armed, or null.
export function armNote({ home = noteHome(), version = appVersion(), note = UPDATE_NOTE, now = Date.now() } = {}) {
  if (!home || !version) return null;
  try {
    const was = readJson(at(home, RELEASE)) || (readJson(path.join(home, 'install.json'))?.updatedAt ? { version: '0', note: null } : null);
    if (was && compareVersions(version, was.version) <= 0) return null;
    let armed = null;
    if (was && note?.id && note.id !== was.note && !(note.id in notesShown(home))) {
      writeWhole(at(home, ARMED), { id: note.id, title: note.title, lines: note.lines, more: note.more || '', version, at: new Date(now).toISOString() });
      armed = note.id;
    // a note still waiting that this release does not carry is not this release's to show
    } else if (readJson(at(home, ARMED))?.id !== note?.id) fs.rmSync(at(home, ARMED), { force: true });
    writeWhole(at(home, RELEASE), { version, note: note?.id || null, at: new Date(now).toISOString() });
    return armed;
  } catch { return null; }   // an update must never fail on a note
}

// The reveal's half: the armed note, to the one caller that takes it, and null to everyone else and ever after.
// The rename is the take -- of two turns ending together one finds the file and the other does not -- and the
// note is recorded as shown before it is handed over, so a caller that then fails to show it has shown nothing.
export function takeNote({ home = noteHome(), now = Date.now() } = {}) {
  if (!home) return null;
  const mine = `${at(home, ARMED)}.${own()}.taken`;
  try { fs.renameSync(at(home, ARMED), mine); } catch { return null; }   // nothing armed, or already taken
  try {
    const note = readJson(mine);
    if (!note?.id || typeof note.title !== 'string' || !Array.isArray(note.lines) || note.id in notesShown(home)) return null;
    writeWhole(at(home, SHOWN), { shown: { ...notesShown(home), [note.id]: new Date(now).toISOString() } });
    return note;
  } catch { return null; }   // not recorded is not shown
  finally { fs.rmSync(mine, { force: true }); }
}

// A line as the pieces a door draws: its words, and each place on the local page as a link while a page runs
// for this machine (`page`, context-suggest.js:ensureUi) or, where none could be started, the command that
// opens the same place.
const SLOT = /(\{(?:chat|factory)\})/;
export const noteLinks = page => (page
  ? { chat: `${page}#tab=chat`, factory: `${page}#tab=factory` }
  : { chat: 'the dashboard (run: thinker ui)', factory: '(run: thinker ui --tab factory)' });
export function noteParts(line, page) {
  const links = noteLinks(page);
  return String(line).split(SLOT).filter(Boolean).map(t => {
    const to = /^\{(chat|factory)\}$/.exec(t);
    return to ? { text: links[to[1]], ...(page ? { href: links[to[1]] } : {}) } : { text: t };
  });
}
// The page a note's links open, put up first because a link in the one message a person reads about a release
// has to open (it stops by itself once nobody has used it for half an hour); nothing started for a note
// without links.
export function notePage(store, note, { ensureFn = ensureUi } = {}) {
  if (!store?.repo || !note.lines.some(l => SLOT.test(l))) return null;
  try { return ensureFn(store) || null; } catch { return null; }   // a note must never fail a turn
}

// The note as the card mod draws it (integrations/claude-card): the pieces, so the mod holds no words of its own.
export const noteCard = (note, { page = null } = {}) => ({
  id: note.id, title: note.title, version: note.version || '', more: note.more || '', lines: note.lines.map(l => noteParts(l, page)),
});
// The note as the end-of-turn lines of an agent that draws no card. It names the version, as the status row
// does: a note about what changed is the one moment a person wants to know which thinker they are running.
export const updateNoteText = (note, { page = null } = {}) => [
  `🧠 thinker${note.version ? ` v${note.version}` : ''} · ${note.title}`,
  ...note.lines.map(l => `  • ${noteParts(l, page).map(p => p.text).join('')}`),
  note.more ? `  ${note.more}` : '',
].filter(Boolean).join('\n');
