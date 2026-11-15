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
// A re-read is a read of a file whose last earlier read was in the cleared set when it ran: the Read tool, or a shell
// line that prints a file (delegate.js:shellRead: cat, sed -n, head; a `cd <dir> &&` in front is allowed, since that is
// how a worktree is read, and the file is taken relative to it). A path written relative matches the absolute path the
// Read tool wrote, by its tail. A re-read is priced like the
// clearing itself, at list (delivery.js): its result is written into the cache once, and read again on every later
// call until a cut takes it too -- the very reads the saving counted as avoided, since the old copy is still out of
// the prompt. Both come off the saving. One rule: a re-read of a cleared file costs its write and its reads after.
//
// Never understated: a read the model would have made anyway (checking an edit) counts too, so the figure is a ceiling
// on what the clearing cost in reading, not a floor. What it cannot see is an answer that went wrong without a read,
// which is the graded run's question (Artemis), not this one's.
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { PROXY_DEFAULTS, RESULT_TOKENS_PER_CHAR } from './proxy.js';
import { MIN_CHARS, KEEP_TURN, clearedOf } from './cutting.js';
import { shellRead } from './delegate.js';
import { compressionRecords, readCompression, CLEARING_OP } from './compression.js';

const ms = v => (typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) || 0 : 0);
const CD = /^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/;
const clean = f => String(f).replace(/^["']|["']$/g, '').replace(/^\.\//, '');
// the files a tool call reads, as paths: the Read tool's, or a shell read's (relative to a leading `cd`, where there is one)
export function filesReadBy(name, input = {}) {
  if (name === 'Read') return input.file_path ? [clean(input.file_path)] : [];
  if (name !== 'Bash' || !input.command) return [];
  const m = String(input.command).match(CD);
  const dir = m ? clean(m[1]) : '';
  const r = shellRead(m ? String(input.command).slice(m[0].length) : input.command);
  if (!r) return [];
  return r.files.map(clean).map(f => (dir && !path.isAbsolute(f) ? path.join(dir, f) : f));
}
// the same file, written absolute by one tool and relative by another: equal, or one the tail of the other
const sameFile = (a, b) => a === b || (path.isAbsolute(a) && !path.isAbsolute(b) ? a.endsWith('/' + b) : (!path.isAbsolute(a) && path.isAbsolute(b) ? b.endsWith('/' + a) : false));
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

// The identity of a tool call, for every tool that is not reading a file: the tool's name and its input, exactly.
// This is what makes a re-DO visible. The cut takes every tool result over `MIN_CHARS`, whatever made it, and on this
// machine's own sessions reads are 1.7% of what it takes by tokens -- Bash is 84%, and only 6% of that prints a file
// (measured 2026-11-14 over 12 cut sessions, 2.1M tokens). A model that runs the same grep again, or the same suite,
// because the result is gone pays exactly what a re-read pays: the write once more, and a cache read on every later
// call. Counting only files left 93% of the cut's cost scoring zero.
//
// Exact, where the file rule is loose. A read of the same file by any means is the same read (`sameFile` matches an
// absolute path against a relative one), because the file is the thing recovered. A search is not: `grep -rn foo src`
// and `grep -rn foo lib` recover different things, and calling the second a re-do would invent a cost. So the key is
// the input as sent, with object keys ordered so that formatting alone never makes two calls differ. The figure is
// therefore a ceiling on re-reads and a count of exact repeats for everything else; a near-repeat is new work here.
const ordered = v => (Array.isArray(v) ? v.map(ordered)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordered(v[k])])) : v);
export const callKey = (name, input) => {
  if (!name) return null;
  try { return `${name}\u0000${JSON.stringify(ordered(input ?? {}))}`; } catch { return null; }
};

// The cut policy this session's cuts were made under (cutting.js:policyId, e.g. `r3-t140k-f8k-p25-deep-lt`), as the
// options `rereadsOf` needs: whether the long-turn rule was in force (`-lt`) and the trigger that was (`t140k`). Read
// off the stamp the cut itself left and never off today's settings, because a session may predate a change -- the same
// reason the stamp exists (AGENTS.md, "Every saving names the cut policy that made it"). The record's stamp first, the
// proxy's rows after; where a session spans an update, a single `-lt` anywhere in it is enough, since the set
// `rereadsOf` reconstructs may hold such a cut and the figure must never understate.
export function cutPolicyFor({ session, proxyLog = null, dir = null } = {}) {
  const names = [];
  let record = null; try { record = dir ? readCompression(dir, session) : null; } catch { record = null; }
  if (record?.policy) names.push(String(record.policy));
  for (const r of proxyLog ? compressionRecords(proxyLog) : []) if (r.session === session && r.policy) names.push(String(r.policy));
  const lt = names.find(n => /-lt\d*$/.test(n));
  if (!lt) return {};
  const m = lt.match(/-t(\d+)(k?)-/);
  const trigger = m ? Number(m[1]) * (m[2] ? 1000 : 1) : PROXY_DEFAULTS.trigger;
  // `-lt10`: how many of the running turn's newest results that cut left alone. A stamp from before the count was
  // named (a bare `-lt`) is read at the number in force then, which was `keepMin`.
  const k = lt.match(/-lt(\d+)$/);
  return { longTurn: true, trigger, keepTurn: k ? Number(k[1]) : PROXY_DEFAULTS.keepMin };
}

// The re-reads of a parsed transcript (transcripts.js:parseTranscript: `events` with the prompts and the tool calls,
// each tool call stamped `at` and indexed `call` into `calls`, the model calls with their own `t`), given the cut times.
// Returns the count, the tokens read again, and `laterTokens`: each re-read's tokens times the calls it stayed in
// the prompt for -- what delivery.js prices at the cache-read rate.
export function rereadsOf({ events = [], calls = [] } = {}, cuts = [], { keepMin = PROXY_DEFAULTS.keepMin, minChars = MIN_CHARS, longTurn = false, trigger = PROXY_DEFAULTS.trigger, keepTurn = KEEP_TURN } = {}) {
  const none = { reads: 0, tokens: 0, laterTokens: 0, files: 0, calls: 0 };
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
  // the cleared set: each cut takes the results of the turns before its own, bar the newest keepMin, bar the small.
  // With the long-turn rule in force (`longTurn`, cutting.js:openTurn) a cut also takes the results its OWN turn has
  // already finished, once that turn has passed the trigger -- so the set this reconstructs is the set the cut made.
  // Without this the figure reads 0 for exactly the cuts the rule is on trial for.
  for (const T of times) {
    const k = turnOf(T);
    if (!k) continue;
    let older = results.filter(r => r.turn < k);
    let keep = keepMin;
    if (longTurn) {
      // the turn's own finished results at T, and whether they had reached the trigger -- the turn's size as the
      // transcript can tell it (its results), where the proxy measured the whole turn, so this opens no earlier
      const inTurn = results.filter(r => r.turn === k && r.at && r.at <= T);
      const tok = inTurn.reduce((n, r) => n + Math.round(r.chars * RESULT_TOKENS_PER_CHAR), 0);
      // and such a cut protects `keepTurn`, not `keepMin` (proxy.js:walkResults): the reconstruction has to keep
      // the same number the cut kept, or it reads results as gone that the model still had
      if (tok >= trigger) { older = older.concat(inTurn); keep = keepTurn; }
    }
    // `slice(-0)` is `slice(0)` -- the whole array -- so a keep of zero would protect everything rather than nothing
    const protect = new Set(keep > 0 ? older.slice(-keep) : []);
    for (const r of older) if (!r.cleared && !protect.has(r) && r.chars >= minChars) r.cleared = turnAt[k];
  }
  // the model calls, for how long a re-read stays in the prompt
  const callTimes = calls.map(c => ms(c.t)).filter(Boolean).sort((a, b) => a - b);
  const laterCalls = r => {
    const from = r.at || 0, to = r.cleared || Infinity;
    let n = 0; for (const t of callTimes) if (t > from && t < to) n++;
    return n;
  };
  // A call that fetches again what a cut took out. Two ways of being the same fetch, and a call is tried against one
  // of them, never both: a call that names files is matched on the files (a shell line naming several is one read,
  // and a re-read if any of them was), and every other call on its own identity (`callKey`).
  const last = [];   // [file, result], newest last
  const lastOf = file => { for (let i = last.length - 1; i >= 0; i--) if (sameFile(last[i][0], file)) return last[i][1]; return null; };
  const lastCall = new Map();   // callKey -> the newest result under it
  const out = { reads: 0, tokens: 0, laterTokens: 0, files: 0, calls: 0 };
  for (const r of results) {
    const files = filesReadBy(r.e.name, r.e.input);
    let again = false, kind = null;
    if (files.length) {
      kind = 'files';
      again = files.some(f => { const prev = lastOf(f); return prev?.cleared && prev.cleared <= r.at; });
      for (const f of files) last.push([f, r]);
    } else {
      const key = callKey(r.e.name, r.e.input);
      if (!key) continue;
      kind = 'calls';
      const prev = lastCall.get(key);
      again = !!(prev?.cleared && prev.cleared <= r.at);
      lastCall.set(key, r);
    }
    if (!again) continue;
    const tokens = Math.round(r.chars * RESULT_TOKENS_PER_CHAR) + (r.e.imageTokens || 0);
    out.reads++; out[kind]++; out.tokens += tokens; out.laterTokens += tokens * laterCalls(r);
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
