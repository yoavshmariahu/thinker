// What changed in thinker, said once to the people running it.
//
// thinker ships every few days and has never said a word about it: the agents it wires itself into
// never name a version, so a person whose knowledge notes turned into a profile overnight had no way
// to learn that from the product. This file is the one place that copy lives. Three lines at most: it
// rides the same budget as every other thinker message (notice-cadence.js, "One summary, not a line a
// turn"), and a person who has switched the notices off is told nothing.
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
    'thinker keeps a short profile of how you work now — what you are building, how you like answers, which skills you run — read from your own prompts and put at the top of every session. It replaces the knowledge notes.',
    'The report has a Factory tab: where a session\'s tokens actually go, from prompt to merge, and how much went on work redone after something failed.',
    'Find Savings is one table — a row per part of your prompt, what it wastes in dollars, and the one action that fixes it.',
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
