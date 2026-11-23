// What changed in thinker, said once to the people running it.
//
// thinker ships every few days and has never said a word about it: the agents it wires itself into
// never name a version, so a person whose knowledge notes turned into a memory profile overnight had no
// way to learn that from the product. This file is the one place that copy lives. Four lines at most:
// it rides the same budget as every other thinker message (notice-cadence.js, "One summary, not a line
// a turn"), and a person who has switched the notices off is told nothing.
//
// Shown once per machine per note, keyed on the note's own id and not on a version, so a note can be
// written without cutting a release and a release that changes nothing a person can see says nothing.
// There is one note, the latest: a copy of thinker says its own and no other, and a note already said
// is never said again, whichever copy or door said it (the record below).
// The Claude Code mod draws it as a card under an answer (src/integrations/claude-card) and carries
// its own copy of these words (no test holds the two together: change both); every other agent
// gets it at the top of the next end-of-turn summary (commands/hooks.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestMode } from './test-mode.js';
import { appVersion } from './proxy-service.js';
import { ensureUi } from './context-suggest.js';

export const UPDATE_NOTE = {
  id: '2026-11-agent',
  title: 'What changed',
  lines: [
    'Thinker is now an agent that constantly improves your harness and instruction files!',
    'Chat with thinker in {chat} to learn about how it works and steer it as you like.',
    'Look at your factory page {factory} and click on a stage to tell thinker to improve it based on your recent history.',
    'More coming soon.',
  ],
  more: 'Open the dashboard any time: thinker ui',
};

// A line may name a place on the local page: `{chat}` and `{factory}` are filled where the note is said, with
// the address of the page running for this machine (`page`, context-suggest.js:ensureUi) or, where none could
// be started, with the command that opens the same place. The page is put up first because a link in the one
// message a person reads about a release has to open; it stops by itself once nobody has used it for half an
// hour, which is what the note's last line is for. The card mod fills its copy the same way (noteLinks there).
const SLOT = /\{(chat|factory)\}/g;
export const noteLinks = page => (page
  ? { chat: `${page}#tab=chat`, factory: `${page}#tab=factory` }
  : { chat: 'the dashboard (run: thinker ui)', factory: '(run: thinker ui --tab factory)' });
// the page for a note that links to it, and nothing started for one that does not
export function notePage(store, { note = UPDATE_NOTE, ensureFn = ensureUi } = {}) {
  if (!note.lines.some(l => l.search(SLOT) >= 0)) return null;
  try { return ensureFn(store) || null; } catch { return null; }   // a note must never fail a turn
}

// The state is the machine's, beside the notice cadence, because a person sees one stream of messages
// however many checkouts they work in. The suite must not write under the developer's home, so a run
// with no THINKER_HOME of its own keeps it in the cache it is working in (notice-cadence.js does the same).
//
// The record is every note this machine has been shown, `{ shown: { <note id>: <when> } }`, and it is only
// ever added to. Until 2026-11-22 it was the one id of the last note said, here and in the card mod's own
// store, each door with its own: a note said by the card was said again by the Stop hook of another agent,
// and -- the fault the owner saw -- two copies of thinker carrying different notes each found the other's id
// where its own should be, said its note again and put its id back, at every turn. An open Claude Code
// session keeps the mod it loaded at its start (claude-card.js), so every update that changed the note left
// such a pair running. One file, both doors (the mod reads and adds to it through its own file door, the
// same path), and no writer takes an id out. `update-note.json` is the old record: its id still counts as
// said, and it is not written any more, since a copy from before this one would read it as its own.
const noteHome = () => (isTestMode() && !process.env.THINKER_HOME ? null : process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'));
const stateFile = (store, name) => path.join(noteHome() || store.dir, 'state', name);
const noteFile = store => stateFile(store, 'update-notes.json');
export const NOTES_KEEP = 20;
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// every note said on this machine, by id: the shared record, and the last id the old one held
export function notesShown(store) {
  const old = readJson(stateFile(store, 'update-note.json'));
  const shown = readJson(noteFile(store))?.shown;
  return { ...(old?.id ? { [old.id]: old.at || '' } : {}), ...(shown && typeof shown === 'object' ? shown : {}) };
}

export function updateNoteDue(store, { note = UPDATE_NOTE } = {}) {
  return !(note.id in notesShown(store));
}

export function updateNoteShown(store, { note = UPDATE_NOTE, now = Date.now() } = {}) {
  const f = noteFile(store);
  try {
    const all = { ...notesShown(store), [note.id]: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    // whole or not at all: a half-written record reads as nothing said, which is the note said again
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ shown: Object.fromEntries(Object.entries(all).slice(-NOTES_KEEP)) }));
    fs.renameSync(tmp, f);
  } catch {}   // a note must never fail a turn
}

// The note as the end-of-turn lines of an agent that draws no card. The version is named here as the
// status row names it (accountant.js:savingsStatus): a note about what changed is the one moment a
// person wants to know which thinker they are running.
export const updateNoteText = (note = UPDATE_NOTE, { version = appVersion(), page = null } = {}) => {
  const links = noteLinks(page);
  return [`🧠 thinker${version ? ` v${version}` : ''} · ${note.title}`, ...note.lines.map(l => `  • ${l.replace(SLOT, (_, k) => links[k])}`), note.more ? `  ${note.more}` : ''].filter(Boolean).join('\n');
};
