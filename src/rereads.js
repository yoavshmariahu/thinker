// What the model read again after the clearing took it out (2026-11-12, the owner's call: "turn off holdout and
// start measuring re-reads").
//
// The clearing's saving is exact per session (compression.js: the tokens each later request left out), and what it
// costs is exact too (delivery.js: the cache writes after a clear). What neither could see was the model asking for a
// cleared result back: a file read again because its result was gone. The holdout existed to catch that by comparing
// sessions, and a session that got a cut is a long session, so the comparison was never of like with like
// (AGENTS.md, "What a user's savings are"). This reads the answer out of the session's own transcript instead.
//
// The rule, from the policy the proxy and the clearing mod share (cutting.js, proxy.js:cutCandidates,
// claude-clear/hooks/register.tsx:clearOld): a cut made at time T takes every tool result outside the newest turn at T,
// except the newest `keepMin`, of `MIN_CHARS` or more, not taken already. So the cleared set at any point of the
// session is a function of the transcript and the cut times alone, and both are on the machine: the transcript the
// agent wrote, and the cut times on the proxy's log rows (`clear`), the mod's record (`recent`) and the log's mirror of
// it (compression.js:mirrorClearing). No ids are needed, and nothing is asked of a model.
//
// A re-read is a Read of a file whose last earlier Read was in the cleared set when it ran. It is priced like the
// clearing itself, at list (delivery.js): its result is written into the cache once, and read again on every later
// call until a cut takes it too -- the very reads the saving counted as avoided, since the old copy is still out of
// the prompt. Both come off the saving. One rule: a re-read of a cleared file costs its write and its reads after.
//
// Never understated: a read the model would have made anyway (checking an edit) counts too, so the figure is a ceiling
// on what the clearing cost in reading, not a floor. What it cannot see is an answer that went wrong without a read,
// which is the graded run's question (Artemis), not this one's.
import { Buffer } from 'node:buffer';
import { PROXY_DEFAULTS, RESULT_TOKENS_PER_CHAR } from './proxy.js';
import { MIN_CHARS, clearedOf } from './cutting.js';
import { compressionRecords, readCompression, CLEARING_OP } from './compression.js';

const ms = v => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) || 0 : 0);
const chars = v => (typeof v === 'string' ? v.length : v == null ? 0 : Buffer.byteLength(JSON.stringify(v)));

// When a session's cuts were made, in ms, oldest first: the proxy's rows (one cut wherever the set left out of the
// prompt grew), the mod's record (`recent`, the last few clears, in ms), and the log's own mirror of that record
// (`events`, a row per turn the figure grew in: the cut was made inside that turn, and `rereadsOf` places a time by
// the turn it falls in, so the end of the turn names the same cut as its start).
export function cutTimesFor({ session, proxyLog = null, dir = null, events = [] } = {}) {
  if (!session || session === 'unknown') return [];
  const out = new Set();
  let max = 0;
  for (const r of proxyLog ? compressionRecords(proxyLog) : []) {
    if (r.session !== session) continue;
    const cleared = clearedOf(r);
    if (r.clear || cleared > max) { const t = ms(r.at); if (t) out.add(t); }
    if (cleared > max) max = cleared;
  }
  let record = null; try { record = dir ? readCompression(dir, session) : null; } catch { record = null; }
  for (const r of record?.recent || []) { const t = ms(r.at); if (t && r.cleared > 0) out.add(t); }
  let logged = 0;
  for (const e of events) {
    if (e?.op !== CLEARING_OP || e.session !== session || !(e.cleared > 0)) continue;
    if (e.cleared > logged) { const t = ms(e.t); if (t) out.add(t); logged = e.cleared; }
  }
  return [...out].sort((a, b) => a - b);
}

// The re-reads of a parsed transcript (transcripts.js:parseTranscript: `events` with the prompts and the tool calls,
// each tool call stamped `at` and indexed `call` into `calls`, the model calls with their own `t`), given the cut times.
// Returns the count, the tokens read again, and `laterTokens`: each re-read's tokens times the calls it stayed in
// the prompt for -- what delivery.js prices at the cache-read rate.
export function rereadsOf({ events = [], calls = [] } = {}, cuts = [], { keepMin = PROXY_DEFAULTS.keepMin, minChars = MIN_CHARS } = {}) {
  const none = { reads: 0, tokens: 0, laterTokens: 0 };
  const times = [...new Set((cuts || []).map(ms).filter(Boolean))].sort((a, b) => a - b);
  if (!times.length) return none;
  // the turns, by the prompt that opened each: a cut at T sits in the last turn opened at or before T
  const turnAt = []; // index k (1-based) -> ms the turn opened
  const results = []; // tool calls with a result, in transcript order
  let turn = 0;
  for (const e of events) {
    if (e.t === 'prompt') { turn++; turnAt[turn] = ms(e.at) || turnAt[turn - 1] || 0; continue; }
    if (e.t !== 'tool') continue;
    results.push({ e, turn, at: ms(e.at), chars: chars(e.result), cleared: 0 });
  }
  if (!results.length) return none;
  const turnOf = T => { let k = 0; for (let i = 1; i < turnAt.length; i++) if (turnAt[i] <= T) k = i; return k; };
  // the cleared set: each cut takes the results of the turns before its own, bar the newest keepMin, bar the small
  for (const T of times) {
    const k = turnOf(T);
    if (!k) continue;
    const older = results.filter(r => r.turn < k);
    const protect = new Set(older.slice(-keepMin));
    for (const r of older) if (!r.cleared && !protect.has(r) && r.chars >= minChars) r.cleared = turnAt[k];
  }
  // the model calls, for how long a re-read stays in the prompt
  const callTimes = calls.map(c => ms(c.t)).filter(Boolean).sort((a, b) => a - b);
  const laterCalls = r => {
    const from = r.at || 0, to = r.cleared || Infinity;
    let n = 0; for (const t of callTimes) if (t > from && t < to) n++;
    return n;
  };
  // a Read whose last earlier Read of the same file was out of the prompt when it ran
  const last = new Map();
  const out = { reads: 0, tokens: 0, laterTokens: 0 };
  for (const r of results) {
    const file = r.e.name === 'Read' && r.e.input?.file_path ? String(r.e.input.file_path) : null;
    if (!file) continue;
    const prev = last.get(file);
    last.set(file, r);
    if (!prev?.cleared || prev.cleared > r.at) continue;
    const tokens = Math.round(r.chars * RESULT_TOKENS_PER_CHAR) + (r.e.imageTokens || 0);
    out.reads++; out.tokens += tokens; out.laterTokens += tokens * laterCalls(r);
  }
  return out;
}

// Dollars at list for a session's re-reads: the write once, the reads after at the cache-read rate (prices.js).
export function rereadCost(rereads, price) {
  if (!rereads || !price || !(rereads.reads > 0)) return 0;
  const write = (rereads.tokens || 0) * (price.cacheWrite1h ?? 2 * price.input);
  const read = (rereads.laterTokens || 0) * price.cacheRead;
  return (write + read) / 1e6;
}
