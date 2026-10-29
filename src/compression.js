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
// Clears kept for the agent to read back: enough to show how the saving built up, few enough to cost nothing.
const RECENT = 8;
// Tools named in the breakdown: four in the prompt block, three on a card, whose line has to fit.
const TOP_TOOLS = 4;
export const CARD_TOOLS = 3;
// An MCP tool's name reaches the agent as its server and its own name run together with the prefix the protocol
// adds (`mcp__artemis__get_experiment`), long enough to push everything else off a card's line. Written as the
// person reads it (`artemis/get_experiment`), and cut only if it is still too long for the line.
const NAME = 26;
export const shortTool = name => {
  const n = String(name || 'tool').replace(/^mcp__/, '').replace(/__/g, '/');
  return n.length <= NAME ? n : n.slice(0, NAME - 1) + '…';
};
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
export function noteCompression(dir, row, { now = Date.now(), actions = null } = {}) {
  if (!dir || !row || row.op !== 'proxy' || !row.session || !(row.cleared > 0)) return null;
  const file = fileFor(dir, row.session);
  const prev = read(file);
  if (!prev) prune(dir, { now });
  // `saved` adds up, because every request genuinely leaves those tokens out again. `tools` does not: it
  // describes the set cleared out of *this* prompt, and the same results are in the next request's set too, so
  // adding the breakdowns up would count one `Bash` call as many. The latest one is what is cleared now.
  const state = {
    session: row.session,
    firstAt: prev?.firstAt || row.at,
    lastAt: row.at,
    requests: (prev?.requests || 0) + 1,
    saved: (prev?.saved || 0) + row.cleared,
    uses: (prev?.uses || 0) + (row.clearedUses || 0),
    ...(Array.isArray(actions) && actions.length ? { tools: actions.slice(0, TOP_TOOLS) } : prev?.tools ? { tools: prev.tools } : {}),
    recent: [...(prev?.recent || []), { at: row.at, cleared: row.cleared, uses: row.clearedUses || 0 }].slice(-RECENT),
    ...(prev?.firstTurn != null ? { firstTurn: prev.firstTurn } : {}),
    ...(prev?.told ? { told: prev.told } : {}),
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

// Which of the agent's actions the saving was made of: the tools whose results are out of the prompt now.
export const compressionTools = (s, format, { limit = TOP_TOOLS } = {}) =>
  (s?.tools || []).slice(0, limit).map(t => `${shortTool(t.name)} ×${t.calls} (${format(t.tokens)})`).join(', ');

// The state of the clearing, for the agent's own prompt, said once a session (`told`) when the saving comes
// due. In the prompt rather than behind a link: the question the figure raises is what was cleared, and an
// agent that can answer it needs the answer in hand. Said once, because a block that changes every turn
// rewrites the prompt cache -- which is the very cost this whole feature exists to avoid.
export function compressionDetail(state, format, { turnsAfter = TURNS_AFTER } = {}) {
  const s = compressionSaving(state, { turnsAfter });
  if (!s) return '';
  const tools = compressionTools(state, format);
  const recent = (state.recent || []).map(r => `${String(r.at).slice(11, 16)} ${format(r.cleared)} out, ${r.uses} results`);
  return ['<thinker-compression>',
    `The context proxy is clearing this session's older tool results on the API's side. What it has saved so far: ~${format(s.saved)} tokens left out of the prompt, added up over the ${s.requests} ${s.requests === 1 ? 'call' : 'calls'} it has cleared, ${s.uses} tool results in all.`,
    tools ? `Out of the prompt right now, by the action that fetched it: ${tools}. Those results are gone from your context; read a file again if you need it rather than relying on remembering it.` : '',
    recent.length ? `The last ${recent.length} ${recent.length === 1 ? 'clear' : 'clears'}: ${recent.join('; ')}.` : '',
    'Told once a session. `thinker proxy report` has the figures for the machine; the saving is gross, and `thinker proxy replay` prices the cache rewrite a clear costs.',
    '</thinker-compression>'].filter(Boolean).join('\n');
}

// The one call a prompt hook makes: the turn is counted, and the block comes back the first turn the saving is
// due and never again in that session. Nothing where the proxy cleared nothing, as a notice describes only what
// genuinely happened.
export function compressionBlock(dir, session, turn, format, { turnsAfter = TURNS_AFTER } = {}) {
  const state = markCompressionTurn(dir, session, turn);
  if (!state || state.told) return '';
  const text = compressionDetail(state, format, { turnsAfter });
  if (!text) return '';
  try { write(fileFor(dir, session), { ...state, turns: undefined, told: true }); } catch { /* better said twice than not at all */ }
  return text;
}

// What the clearing saved in each session, from the proxy's own log rather than from the state above.
//
// The state files are a card's working memory: at most MAX_FILES of them, pruned after PRUNE_AGE, because
// the card is drawn in the session that paid for the clear. A pull request merges days later, so by the time
// anybody asks what was saved on it those files are gone. The log is the durable record -- one row per
// request, `cleared` on the ones the API cleared something from -- so a figure about a pull request is read
// from there, and the state is only consulted for what the log's tail no longer reaches.
const LOG_TAIL = 16 * 1024 * 1024;   // a day of heavy use is ~50 KB of rows; the tail covers months

export function clearedBySession(file, { since = '' } = {}) {
  const out = new Map();
  if (!file) return out;
  let text = '';
  try {
    const size = fs.statSync(file).size, start = Math.max(0, size - LOG_TAIL);
    const fd = fs.openSync(file, 'r');
    try { const buf = Buffer.alloc(size - start); if (buf.length) fs.readSync(fd, buf, 0, buf.length, start); text = buf.toString('utf8'); }
    finally { fs.closeSync(fd); }
    if (start) text = text.slice(text.indexOf('\n') + 1);
  } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.op !== 'proxy' || !r.session || !(r.cleared > 0) || (since && r.at && r.at < since)) continue;
    const prev = out.get(r.session) || { cleared: 0, requests: 0 };
    out.set(r.session, { cleared: prev.cleared + r.cleared, requests: prev.requests + 1 });
  }
  return out;
}
