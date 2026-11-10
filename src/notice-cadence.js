// How often thinker says anything at the end of a turn.
//
// Until 2026-11-01 every turn could carry a line of its own: the notes served in it, what the
// context proxy's clearing saved, what maintenance did, the weekly figure. The clearing line had no
// guard at all, so once a session was TURNS_AFTER turns past a clear it printed under every answer
// with the same figure. A line under every answer is not information, it is noise, and the figures
// it carried are all on the Report page and in `thinker usage` anyway.
//
// The owner's call: one summary instead, when `prompts` prompts have passed since the last one *and*
// a day has gone by. Both floors, so a day of heavy work carries one summary and a quiet week still
// gets one once 20 prompts have added up. Nothing is dropped by waiting: the notes served in between
// are summed into the next summary (`holdNotice`), and maintenance keeps its own `unreported`
// state until a notice actually renders (`maintain.js:maintenanceNotice` is not called while held).
// The first turn of a fresh cache says its piece at once -- there is nothing to be quiet about yet,
// and that is how a person learns the cache is there.
//
// The cards are not this: where the Claude Code card mod or the Codex desktop card draws
// (`claude-card.js`, `notice-card.js`), the turn's notes are a card under the answer, which is its
// own quiet surface and keeps drawing every turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestMode } from './test-mode.js';

export const NOTICE_PROMPTS = 20;
export const NOTICE_HOURS = 24;

// The cadence is the person's, not a repository's: they see one stream of messages however many
// checkouts they work in, so the count and the stamp sit beside the weekly notice's marker under
// THINKER_HOME. The suite must not write under the developer's home, so a run with no THINKER_HOME
// of its own keeps them in the cache it is working in.
const noticeHome = () => (isTestMode() && !process.env.THINKER_HOME ? null : process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'));
const cadenceFile = store => path.join(noticeHome() || store.dir, 'state', 'notice.json');
// What is waiting to be said is this cache's own: the ids only mean something in its own store.
const pendingFile = store => path.join(store.dir, 'state', 'notice-pending.json');

const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const write = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); } catch {} }; // a notice must never fail a turn

// What thinker last said at the end of a turn, kept beside the cadence and machine-wide like it.
// OpenCode 2's server part runs the Stop hook but has no client to toast with (opencode-v2.js), so
// its terminal part picks the summary up from here. Anything that reads it must judge by `at`, never
// by the text: a repeated summary carries the same figure.
export const noticeLastFile = store => path.join(noticeHome() || store.dir, 'state', 'notice-last.json');
export function writeNoticeLast(store, text, { now = Date.now() } = {}) {
  if (!text) return;
  write(noticeLastFile(store), { text, at: now });
}

// `notice: { everyPrompts, everyHours }` in .thinker/config.json moves the floors; 0 drops one of
// them. `notice: false` or `"off"` still turns the notices off outright (commands/hooks.js:noticeOn).
export function noticeCadence(store) {
  let cfg = {};
  try { cfg = store?.config?.() || {}; } catch {}
  const n = cfg.notice && typeof cfg.notice === 'object' ? cfg.notice : {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return { prompts: num(n.everyPrompts, NOTICE_PROMPTS), hours: num(n.everyHours, NOTICE_HOURS) };
}

// One per turn, counted where the notice is decided (the Stop hook), so a turn counts once however
// many hooks ran in it.
export function countPrompt(store) {
  const f = cadenceFile(store), st = read(f);
  st.prompts = (st.prompts || 0) + 1;
  write(f, st);
  return st.prompts;
}

// `prompts` is how many have passed since the last summary, which is the span the summary covers.
export function noticeDue(store, { now = Date.now() } = {}) {
  const { prompts, hours } = noticeCadence(store);
  const st = read(cadenceFile(store));
  const counted = st.prompts || 0;
  const since = st.at ? Date.parse(st.at) : NaN;
  if (!(since > 0)) return { due: true, prompts: counted };   // nothing said here yet
  return { due: counted >= prompts && now - since >= hours * 3600e3, prompts: counted };
}

// A summary was shown: the clock and the count start again and what was waiting has been said.
export function noticeShown(store, { now = Date.now() } = {}) {
  write(cadenceFile(store), { at: new Date(now).toISOString(), prompts: 0 });
  try { fs.rmSync(pendingFile(store), { force: true }); } catch {}
}

const MAX_PENDING = 200;   // a summary names a count and two titles; beyond this the count is the point

// A turn went by with nothing said: what it served waits for the summary, as a set, since a note
// served in three held turns is one note the sessions were shown. `turns` is what the summary speaks
// for, counted in this cache's own held turns -- the gate's count is the machine's and would speak
// for prompts in checkouts this summary says nothing about.
export function holdNotice(store, ids) {
  const f = pendingFile(store), st = read(f);
  const next = [...new Set([...(st.ids || []), ...(ids || []).filter(Boolean)])];
  write(f, { ids: next.slice(-MAX_PENDING), turns: (st.turns || 0) + 1 });
}

export function pendingNotice(store) {
  const st = read(pendingFile(store));
  return { ids: st.ids || [], turns: st.turns || 0 };
}
