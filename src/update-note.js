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
// The Claude Code mod draws it as a card under an answer (src/integrations/claude-card) and carries
// its own copy of these words, which test/claude-card.test.js holds to this file; every other agent
// gets it at the top of the next end-of-turn summary (commands/hooks.js).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestMode } from './test-mode.js';
import { appVersion } from './proxy-service.js';

export const UPDATE_NOTE = {
  id: '2026-11-profile-factory',
  title: 'What changed',
  lines: [
    'Thinker builds a memory profile — what you are working on and how you like to work, distilled from your sessions and loaded at the top of each new one.',
    'Knowledge notes are removed: hit rates were low across many users.',
    'New Factory tab: the breakdown of your software factory, and which parts spend the most tokens or rework.',
    'Find Savings is now one more compact table. Skill and tool suggestions from your session history are coming soon.',
  ],
  more: 'See both: thinker ui',
};

// The state is the machine's, beside the notice cadence, because a person sees one stream of messages
// however many checkouts they work in. The suite must not write under the developer's home, so a run
// with no THINKER_HOME of its own keeps it in the cache it is working in (notice-cadence.js does the same).
const noteHome = () => (isTestMode() && !process.env.THINKER_HOME ? null : process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'));
const noteFile = store => path.join(noteHome() || store.dir, 'state', 'update-note.json');

export function updateNoteDue(store, { note = UPDATE_NOTE } = {}) {
  try { return JSON.parse(fs.readFileSync(noteFile(store), 'utf8'))?.id !== note.id; } catch { return true; }
}

export function updateNoteShown(store, { note = UPDATE_NOTE, now = Date.now() } = {}) {
  const f = noteFile(store);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ id: note.id, at: new Date(now).toISOString() }));
  } catch {}   // a note must never fail a turn
}

// The note as the end-of-turn lines of an agent that draws no card. The version is named here as the
// status row names it (savings-ledger.js:savingsStatus): a note about what changed is the one moment a
// person wants to know which thinker they are running.
export const updateNoteText = (note = UPDATE_NOTE, { version = appVersion() } = {}) =>
  [`🧠 thinker${version ? ` v${version}` : ''} · ${note.title}`, ...note.lines.map(l => `  • ${l}`), note.more ? `  ${note.more}` : ''].filter(Boolean).join('\n');
