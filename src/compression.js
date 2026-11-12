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
import { isRewrite, clearedOf, clearedUsesOf, clearedEstimated } from './cutting.js';
import { listPrice } from './prices.js';

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

// The proxy's side: one row of its log. Only a request something was actually taken out of counts -- a row
// that cleared nothing is a request under the trigger, and saying a clear happened there would be a lie.
// What was taken out is `cutting.js:clearedOf`: the API's own report where the API did the clearing, the
// cut's own count since thinker does it itself.
export function noteCompression(dir, row, { now = Date.now(), actions = null } = {}) {
  // a `compaction` row is Devin's own compactor measured from its session database (devin-compaction.js)
  const cleared = clearedOf(row);
  if (!dir || !row || !['proxy', 'compaction'].includes(row.op) || !row.session || !(cleared > 0)) return null;
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
    saved: (prev?.saved || 0) + cleared,
    uses: (prev?.uses || 0) + clearedUsesOf(row),
    // thinker's own count of what it removed, not a figure the API reported: said once on the record so no
    // door shows it as measured (every row since the cut shipped is this)
    ...(clearedEstimated(row) || prev?.estimated ? { estimated: true } : {}),
    // Which cut policy made this saving (cutting.js:policyId; the clearing mod writes its own, from the same
    // constants). Every door that compares savings groups by it, because the policies differ by more than
    // rounding and nothing on this machine can know when another machine updated to one. A session spanning an
    // update carries the newest and says so, so a comparison can leave it out rather than read it as either.
    ...(row.policy || prev?.policy ? { policy: row.policy || prev.policy } : {}),
    ...((prev?.policy && row.policy && prev.policy !== row.policy) || prev?.policyChanged ? { policyChanged: true } : {}),
    ...(Array.isArray(actions) && actions.length ? { tools: actions.slice(0, TOP_TOOLS) } : prev?.tools ? { tools: prev.tools } : {}),
    recent: [...(prev?.recent || []), { at: row.at, cleared, uses: clearedUsesOf(row) }].slice(-RECENT),
    ...(prev?.firstTurn != null ? { firstTurn: prev.firstTurn } : {}),
    ...(prev?.told ? { told: prev.told } : {}),
    ...(row.op === 'compaction' ? { kind: 'compaction' } : prev?.kind ? { kind: prev.kind } : {}),
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

// The parsed tail, kept per process by the file's size and mtime: the Report reads it three times a repository
// (clearingRows, clearingCostBySession, clearedBySession) and `thinker report --refresh --all` does that once per
// repository on the machine -- 8 MB of rows parsed fifty times over, two and a half seconds of the fifteen that run
// took here (2026-11-10). The rows are read, never written, so every caller shares one array.
const parsedTail = new Map(); // file -> { stamp, rows }

export function compressionRecords(file) {
  if (!file) return [];
  let stamp = null; try { const s = fs.statSync(file); stamp = `${s.size}\t${s.mtimeMs}`; } catch {}
  const hit = stamp && parsedTail.get(file);
  if (hit && hit.stamp === stamp) return hit.rows;
  const rows = readCompressionTail(file);
  if (stamp) parsedTail.set(file, { stamp, rows });
  return rows;
}

function readCompressionTail(file) {
  const out = [];
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
    if (r.op === 'proxy' && r.session) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a clear cost, per session: the cache writes on the calls from the clear onwards.
//
// A cleared token is not worth an input token. It was being read from the prompt cache at a tenth of the
// input price, and the clear writes that cache again at twice it, so the saving is only ever the difference.
// Priced at the input rate this machine's cleared tokens read as thousands of dollars a month, where the
// clearing was in fact losing money for most of its life: on the old API-side path the calls after a clear
// rewrote their prefix on 15% of the calls over LONG_CONTEXT against 1% before one, which is $1.4k of writes
// against $354 of saving over seven days here. `thinker proxy report` says the same in rates and warns on it.
//
// So the figure is netted: what the calls after a clear wrote into the cache again, charged against what the
// clearing saved. Deliberately the conservative reading -- a rewrite the clearing did not cause is charged to
// it anyway, and 1% to 3% of long calls rewrite their prefix on the held-out side where nothing is cleared --
// because a saving figure that flatters itself is worth nothing to the person reading it. The clearing
// request itself counts as after the clear, as in `proxyReport`: it is the request that carries the edit.
// A clear the proxy never saw. The Claude desktop app sets its own ANTHROPIC_BASE_URL, so its sessions
// bypass the proxy and the clearing mod (src/integrations/claude-clear) runs inside the session instead,
// writing this directory's record and nothing to the proxy's log; Devin's compactor is measured the same
// way (devin-compaction.js). The dollar ledger and the Report priced cleared tokens from the log alone, so
// every such clear was a saving on the card under the answer and nowhere else (found 2026-11-06: a desktop
// session's 7.8M cleared tokens, in no footer and no Report).
//
// So the records of the sessions the log has no rows for are read as rows of the log's own shape, one per
// session: `saved` is already the sum over every later request of what left the prompt, which is what
// `weeklySavings` adds up per row, and it is dated the session's last request (the figure accrues
// through the session, so an earlier date would put a saving before it was made). A session the log does
// have rows for is left to the log, since the proxy writes the same record beside its rows and counting
// both would count the clear twice. The mod keeps the model the API answered with on the record (since
// 2026-11-06); a record from before that carries none, and `modelOf` names it from the machine's log, else
// the row is unpriced and the ledger says so rather than guessing a rate.
function desktopRecords(dir, { covered = new Set(), key = s => String(s) } = {}) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const r = read(path.join(dir, n));
    if (!r?.session || !(r.saved > 0) || covered.has(key(r.session))) continue;
    const last = r.lastAt || r.firstAt;
    const at = typeof last === 'number' ? new Date(last).toISOString() : last;
    if (!Number.isFinite(Date.parse(at))) continue;
    out.push({ record: r, at });
  }
  return out;
}

export function desktopClearRows(dir, { covered = new Set(), modelOf = () => null, key = s => String(s) } = {}) {
  return desktopRecords(dir, { covered, key }).map(({ record: r, at }) =>
    ({ op: 'proxy', session: r.session, at, model: r.model || modelOf(r.session) || null, status: 200, cleared: Math.round(r.saved), clearedUses: r.uses || 0, recorded: 'session',
      ...(r.policy ? { policy: r.policy } : {}), ...(r.policyChanged ? { policyChanged: true } : {}) }));
}

// What a desktop session's clears cost, read from the record: the mod counts, on every request from its first
// clear onward, the ones that rewrote their prefix and the cache-write tokens they carried (register.tsx:charge,
// the proxy's own isRewrite), and keeps the model that answered. Priced as the proxy's rows are, below. A record
// with no `cost` block is from before the mod counted it: no cost figure, rather than a zero that reads as free.
export function desktopClearingCost(dir, { covered = new Set(), since = '', key = s => String(s), config } = {}) {
  const out = new Map();
  for (const { record: r, at } of desktopRecords(dir, { covered, key })) {
    if (!r.cost || (since && at < since)) continue;
    const x = { rewrites: r.cost.rewrites || 0, write: r.cost.write || 0, usd: 0, unpriced: 0, ...(r.model ? { model: r.model } : {}) };
    const price = listPrice(r.model, { config });
    if (price) x.usd += writeCostOf(x.write, price); else if (x.write > 0) x.unpriced++;
    out.set(r.session, x);
  }
  return out;
}

// The rows the ledger and the Report price: the proxy's log, and the recorded clears of the sessions it
// has none for (above). `events` is the machine's log, where a session's own rows name its model; `key`
// is usage.js:sessionKey, passed in because usage.js imports this module.
// --- a desktop clear has to outlive the card's record --------------------------------------------------
// The record above is a card's working memory: at most MAX_FILES of them, pruned after PRUNE_AGE. For a
// session the proxy served that is fine, because the log holds the same clear for months. A desktop session
// reaches no proxy, so its clear lived in that file and nowhere else -- gone in two days, which is shorter
// than every window that reads it: the 30 days a person's savings are reported over, and the days a pull
// request takes to merge. A desktop user's saving was therefore real on the card that evening and absent
// from the Report, `thinker prs` and the telemetry by the end of the week.
//
// So the Stop hook mirrors each clear into the machine's log once (`mirrorClearing`), where it lives as long
// as the log. The figure is the session's own running total, not a per-request delta like a proxy row, so a
// reader takes the newest row per session and NEVER adds them; `logged` on the record keeps the hook from
// writing the same total twice.
export const CLEARING_OP = 'clearing';
export function mirrorClearing(dir, session, log) {
  if (!dir || !session || session === 'unknown' || typeof log !== 'function') return null;
  const file = fileFor(dir, session);
  const r = read(file);
  const saved = Math.round(r?.saved || 0);
  if (!r || !(saved > 0) || saved <= Math.round(r.logged || 0)) return null;
  const row = { op: CLEARING_OP, session, cleared: saved, uses: r.uses || 0, requests: r.requests || 0,
    ...(r.policy ? { policy: r.policy } : {}), ...(r.policyChanged ? { policyChanged: true } : {}),
    ...(r.model ? { model: r.model } : {}), ...(r.kind ? { kind: r.kind } : {}),
    ...(r.cost ? { cost: { rewrites: r.cost.rewrites || 0, write: r.cost.write || 0 } } : {}) };
  try { log(row); } catch { return null; }                      // a card is never worth a failed turn
  try { write(file, { ...r, logged: saved }); } catch {}
  return row;
}

// The newest mirrored row per session. Cumulative, so the largest is the session's figure; a row carries what
// the record carried, including the policy that cleared and what the clear cost.
export function loggedClearing(events = [], { key = s => String(s), since = '' } = {}) {
  const out = new Map();
  for (const e of events) {
    if (e?.op !== CLEARING_OP || !e.session || !(e.cleared > 0)) continue;
    if (since && e.t && e.t < since) continue;
    const id = key(e.session), prev = out.get(id);
    if (!prev || e.cleared >= prev.cleared) out.set(id, { ...e, at: e.t || prev?.at || null });
  }
  return out;
}

// What a mirrored clear cost, priced as the proxy's rows and the records are (`desktopClearingCost`).
export function loggedClearingCost(events, { covered = new Set(), key = s => String(s), since = '', config } = {}) {
  const out = new Map();
  for (const [id, e] of loggedClearing(events, { key, since })) {
    if (covered.has(id) || !e.cost) continue;
    const x = { rewrites: e.cost.rewrites || 0, write: e.cost.write || 0, usd: 0, unpriced: 0, ...(e.model ? { model: e.model } : {}) };
    const price = listPrice(e.model, { config });
    if (price) x.usd += writeCostOf(x.write, price); else if (x.write > 0) x.unpriced++;
    out.set(id, x);
  }
  return out;
}

export function clearingRows(file, dir, { events = [], key = s => String(s) } = {}) {
  const rows = compressionRecords(file);
  const covered = new Set(rows.map(r => key(r.session)));
  const models = new Map();
  for (const e of events) if (e.op === 'session' && e.session && e.model) models.set(key(e.session), e.model);
  const desktop = desktopClearRows(dir, { covered, key, modelOf: id => models.get(key(id)) || null });
  // and the clears whose record is gone: the log's own mirror, for the sessions neither source covers
  for (const r of desktop) covered.add(key(r.session));
  const mirrored = [...loggedClearing(events, { key })].filter(([id]) => !covered.has(id))
    .map(([, e]) => ({ op: 'proxy', session: e.session, at: e.at, model: e.model || models.get(key(e.session)) || null,
      status: 200, cleared: e.cleared, clearedUses: e.uses || 0, recorded: 'log',
      ...(e.policy ? { policy: e.policy } : {}), ...(e.policyChanged ? { policyChanged: true } : {}) }));
  return [...rows, ...desktop, ...mirrored];
}

// a write after a clear is a one-hour write for the agents the proxy serves, as proxy-replay.js prices it
const writeCostOf = (write, price) => (write || 0) * (price.cacheWrite1h ?? 2 * price.input) / 1e6;

// With `dir`, the sessions the log has no rows for are read from their records (desktopClearingCost): a clear
// made inside a desktop session is charged its writes as a proxied one is, so no door shows it gross.
export function clearingCostBySession(file, { since = '', config, dir = null, key = s => String(s), events = [] } = {}) {
  const out = new Map(), cleared = new Set(), covered = new Set();
  const rows = compressionRecords(file);
  for (const r of rows) {
    covered.add(key(r.session));
    if (since && r.at && r.at < since) continue;
    if (clearedOf(r) > 0) cleared.add(r.session);
    if (!cleared.has(r.session) || !isRewrite(r)) continue;
    // A cold cut's own call is not the clearing's cost. Past the cache's hour the request writes its whole
    // context again whether or not anything was replaced, which is exactly why `decideCut` prices that cut at
    // zero (cutting.js, the cold branch) -- and then this door charged the very same write to the clearing.
    // Measured on this machine: both Fable cuts of the five days to 2026-11-11 were cold, each wrote its
    // context with a cache read of ZERO (202k and 349k, nothing to read back), and no call after either one
    // rewrote a prefix at all -- 0 of 227 over 100k of context. Those two writes were the whole of the $11.01
    // charged against $3.89 saved, and at Fable's 80 reads to a written token they read as the clearing
    // losing money on a session it had not cost a token. The two doors have to price a cold cut alike.
    if (r.clear?.cold) continue;
    const price = listPrice(r.model, { config });
    const x = out.get(r.session) || { rewrites: 0, write: 0, usd: 0, unpriced: 0 };
    x.rewrites++; x.write += r.write || 0;
    if (price) x.usd += writeCostOf(r.write, price); else x.unpriced++;
    out.set(r.session, x);
  }
  if (dir) for (const [id, x] of desktopClearingCost(dir, { covered, since, key, config })) { out.set(id, x); covered.add(id); }
  for (const [id, x] of loggedClearingCost(events, { covered, since, key, config })) out.set(id, x);
  return out;
}

export function clearedBySession(file, { since = '' } = {}) {
  const out = new Map();
  for (const r of compressionRecords(file)) {
    const cleared = clearedOf(r);
    if (!(cleared > 0) || (since && r.at && r.at < since)) continue;
    const prev = out.get(r.session) || { cleared: 0, requests: 0 };
    out.set(r.session, { cleared: prev.cleared + cleared, requests: prev.requests + 1,
      // The model the API answered with, from the rows themselves. Without it a session is priced only when
      // the usage log's own `session` row names one, and on this machine that left 96% of the cleared tokens
      // in a five-day window unpriced -- so the netted dollars were computed from a handful of sessions and
      // read as noise. The proxy has known the model all along; nothing asked it.
      ...(r.model || prev.model ? { model: r.model || prev.model } : {}),
      // the policy the rows name (cutting.js:policyId), the newest winning, and a mark where a session spans two
      ...(r.policy || prev.policy ? { policy: r.policy || prev.policy } : {}),
      ...((prev.policy && r.policy && prev.policy !== r.policy) || prev.policyChanged ? { policyChanged: true } : {}) });
  }
  return out;
}
