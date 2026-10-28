// What the context proxy's clearing left out of a prompt, shown the way a cache hit is shown
// (usage.js:turnNotice, notice-card.js, integrations/claude-card).
//
// The proxy asks the API to clear the older tool results of a conversation (proxy.js). The API answers with
// `applied_edits`, and the proxy records `cleared` on the request's row: the tokens it left out of *that*
// prompt. The cleared set is cumulative within a conversation, so the same results are left out of every
// later request too, each one reported again on its own row. Adding those up over the session is therefore
// the whole of the saving, measured rather than modelled:
//
//   Tokens saved = the tokens the server left out of each prompt since the clear, added up.
//
// It is a gross figure, as the cache-hit card's is: a clear also writes the prompt cache again from the first
// result it removed, which the replay prices (proxy-replay.js). The card says what was left out; what that is
// worth after the rewrite is `thinker proxy replay`.
//
// Why not at the clear. The first cleared request saves nothing anybody would notice -- the saving is every
// *later* request that reads the shorter prefix -- and a card at the moment of the clear would show the
// rewrite and none of the return. So the card waits TURNS_AFTER turns, by which time the figure is real.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// Turns after the first clear of a session before the saving is shown. Three: enough that the figure is the
// clearing's return and not its cost, few enough that it still lands in the session that paid for it.
export const TURNS_AFTER = 3;
// Session files kept here; pruned like the card marks (claude-card.js) rather than left to gather.
const MAX_FILES = 200;
const PRUNE_AGE = 2 * 86400e3;

export const compressionDir = (home = process.env.THINKER_HOME || path.join(os.homedir(), '.thinker')) =>
  path.join(home, 'state', 'compression');
const fileFor = (dir, session) => path.join(dir, `${String(session).replace(/[^\w.-]/g, '_')}.json`);

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function write(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(state)); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}

function prune(dir, { now = Date.now() } = {}) {
  try {
    const names = fs.readdirSync(dir);
    if (names.length <= MAX_FILES) return;
    for (const n of names) {
      const f = path.join(dir, n);
      try { if (now - fs.statSync(f).mtimeMs > PRUNE_AGE) fs.rmSync(f, { force: true }); } catch { /* another process got there first */ }
    }
  } catch { /* nothing to prune */ }
}

// The proxy's side: one row of its log. Only a request the server actually cleared something from counts --
// a row with `cleared: 0` is a request under the trigger, and saying a clear happened there would be a lie.
export function noteCompression(dir, row, { now = Date.now() } = {}) {
  if (!dir || !row || row.op !== 'proxy' || !row.session || !(row.cleared > 0)) return null;
  const file = fileFor(dir, row.session);
  const prev = read(file);
  if (!prev) prune(dir, { now });
  const state = {
    session: row.session,
    firstAt: prev?.firstAt || row.at,
    lastAt: row.at,
    requests: (prev?.requests || 0) + 1,
    saved: (prev?.saved || 0) + row.cleared,
    uses: (prev?.uses || 0) + (row.clearedUses || 0),
    ...(prev?.firstTurn != null ? { firstTurn: prev.firstTurn } : {}),
  };
  try { write(file, state); } catch { return null; } // a card is never worth a failed request
  return state;
}

export const readCompression = (dir, session) => (dir && session && session !== 'unknown' ? read(fileFor(dir, session)) : null);

// The consumer's side, once a turn. The first turn that sees a cleared session is remembered, so the wait is
// counted in the turns the person took and not in the model calls behind them.
export function markCompressionTurn(dir, session, turn) {
  const state = readCompression(dir, session);
  if (!state) return null;
  if (!(turn > 0)) return state;
  if (state.firstTurn == null) {
    state.firstTurn = turn;
    try { write(fileFor(dir, session), state); } catch { /* the figure is still right for this turn */ }
  }
  return { ...state, turns: turn - state.firstTurn };
}

// What to show, or nothing while the saving is still too young to mean anything.
export function compressionSaving(state, { turnsAfter = TURNS_AFTER } = {}) {
  if (!state || !(state.saved > 0) || !(state.requests > 0)) return null;
  const turns = state.turns ?? 0;
  if (turns < turnsAfter) return null;
  return { saved: state.saved, requests: state.requests, uses: state.uses || 0, turns };
}

// Shared by every door, so the card and the line never say different things.
export const compressionHeader = (s, format) =>
  `context cleared · ~${format(s.saved)} tokens not re-read over ${s.requests} ${s.requests === 1 ? 'call' : 'calls'}`;
