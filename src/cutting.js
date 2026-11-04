// The clearing, done here: thinker replaces an old tool result with a placeholder in the request it
// forwards, instead of asking the API to drop it.
//
// Why this is a policy of its own and not a port of `clearing.js`. The server-side edit has no
// state. The API re-derives the clearing from the edit on every call, so the proxy could never hold
// the cleared point still: it asked, the server chose oldest-first, re-applied on its own schedule,
// and every move rewrote the prefix -- 3 moves in one 9-turn run, 8 in another, 15 in a week of this
// machine's log, each a write nobody picked. `keep` was a count, so three echoes evicted a
// 25k-token read and the model answered "I can't see the line count" (4 of 14 turns, measured).
// And the exit was a rewrite too: dropping the edit un-cleared everything, 351,929 tokens of write
// in one session, 74% of the damage the gauge had stopped over, landing 43% costlier per call.
// #585-#600 spent five patches chasing a freeze that had nothing to freeze.
//
// Here a cut is a set of `tool_use` ids thinker keeps. Applying it is deterministic -- the agent
// always re-sends the whole conversation, so the same ids give the same bytes, call after call and
// across a restart. Three things follow, and they are the whole module:
//
//   1. **The ratchet.** A result that was cut stays cut, so the prompt below the cut never moves and
//      a call inside a turn is byte-identical to the one before it. That is the MANDATORY invariant
//      of AGENTS.md held by construction rather than by asking.
//   2. **One decision, priced exactly.** At a turn boundary we know which results we would cut and
//      where the first of them sits, so the rewrite it costs is the prompt from that point on -- a
//      measured number, not a guess at what a server might do.
//   3. **Stopping is free.** Keep applying the set and cut nothing more. The prefix is unchanged, so
//      there is no uneconomic stop to get wrong and no gauge pricing its own exit at zero.
//
// Nothing here reads a request. `proxy.js` measures the prompt and hands the numbers in, as it does
// for `clearing.js`.
import fs from 'node:fs';
import path from 'node:path';
import { relativeRate } from './model-usage.js';

// list-price ratios to an input token: what a cache write costs by its TTL (the same on every Anthropic model), what a
// cache read costs by the model (READ where the model is not priced: Anthropic's usual tenth)
export const WRITE_1H = 2.0, WRITE_5M = 1.25, READ = 0.1;
export const writeRate = ttl => (ttl === '5m' ? WRITE_5M : WRITE_1H);
export const readRate = model => { const r = relativeRate(model); return r ? Math.round(r.cacheRead / r.input * 1000) / 1000 : READ; };
// Past the cache's hour the next request writes its whole context whatever the proxy does, so a clear at that moment
// costs nothing extra: the decision prices it at zero. Not a state of its own.
export const COLD_MS = 65 * 60 * 1000;
// median further calls a session makes, by the calls it has made, measured on this machine's 146 proxied sessions
// (5 -> 47, 10 -> 47, 20 -> 40, 40 -> 68, 60 -> 90, 100 -> 92, 150 -> 68). Flat-ish and heavy-tailed, so the steps
// are coarse on purpose: a curve fitted to 146 sessions would be false precision.

// For the report: a call that wrote most of its context into the cache rather than reading it, on a context long
// enough for that to be a rewrite. A heuristic, and the gauge does not use it: under LONG_CONTEXT the newest result
// alone can be half the context, and a gauge built on this ratio stopped two sessions on their second cleared call
// over a 21k file read into a 40k conversation (2026-11-02).
export const LONG_CONTEXT = 100000;
export const isRewrite = u => { const ctx = (u?.read || 0) + (u?.write || 0) + (u?.input || 0); return ctx >= LONG_CONTEXT && (u?.write || 0) > 0.5 * ctx; };
// What the gauge uses instead is exact and in the API's own units: every answer reports the prompt's size as input
// plus cache read plus cache write plus what was cleared (`rawOf`), so the growth from one answer to the next is
// known, and new content is all a call should write. What the API wrote beyond that growth is the prefix written
// again. No estimate, no margin.

// A cut result's content, from the original length, so the bytes are the same every call.
// A cut must repay its rewrite inside this many later calls, and nothing is assumed about how long the
// session will run. The horizon it replaces (REMAINING, 40 rising to 90 with calls made) was wrong in the
// one direction that costs: it grew the longer a session had run, so the latest cuts -- which rewrite the
// largest post-cut context -- were valued the most generously. Measured 2026-11-04 on a 28-turn session,
// the four cuts needed 14, 32, 66 and 82 calls to repay and the horizon granted them 40, 40, 68 and 90;
// the last spent 1,542,268 tokens to save 168,646, and the two late cuts were the whole of a +38% loss.
// The floor is deliberately tight because the two errors are not symmetric: a cut refused costs nothing
// but the saving it would have made, while a cut taken wrongly pays a full prefix rewrite up front.
export const PAYBACK = 20;

export const MIN_CHARS = 200;
export const placeholder = chars =>
  `[tool result cleared by thinker to save context: ${chars} chars. Read the file or run the command again if you need it.]`;

export const freshCut = session => ({
  session: session || '', cut: [], turn: 0, calls: 0, clears: 0,
  saved: 0, written: 0, chars: 0, model: null, at: 0,
});

// What a cut would cost and save. `recache` is the prompt from the first result we would replace to
// the end: that is what a changed prefix makes the API write again, and we know it exactly because we
// choose the result. `saving` is the tokens we take out, read back over the calls the session likely
// has left. A pause past COLD_MS writes the context anyway, so the rewrite is free then.
// A cut costs the WHOLE post-cut prompt, less the system prompt. Claude Code sets its cache
// breakpoints on the system prompt and the newest messages, and the API finds a cached prefix only
// at a breakpoint, so an edit in the middle leaves the system prompt as the only reusable part and
// everything after it is written again. Measured on four cuts, 2026-11-04: the write was the
// post-cut prompt minus 12,895 every time, and 12,895 was that call's entire cache read. Pricing it
// as the tail from the first changed result (what this did until then) underpriced cuts 2, 3 and 4
// by 2.3x, 3.0x and 3.8x -- the same flattering arithmetic the server-side gauge used.
export function priceCut(m, cand, { ttl = '1h', cold = false, model = null } = {}) {
  const read = readRate(model);
  const recache = Math.max(0, (m.prompt || cand.recache) - cand.tokens - (m.system || 0));
  const cost = cold ? 0 : recache * writeRate(ttl);
  // How many later calls until the cut has paid for its rewrite. No horizon is guessed: see PAYBACK.
  const payback = cand.tokens > 0 && read > 0 ? Math.ceil(cost / (cand.tokens * read)) : Infinity;
  return { tokens: cand.tokens, recache, cost, payback, pays: cand.tokens > 0 && payback <= PAYBACK };
}

// The decision, at a turn boundary only. Within a turn the set is returned unchanged, so the bytes
// are too. `cand` comes from proxy.js:cutCandidates -- the results outside the newest turn and the
// newest `keepMin`, big enough to be worth a placeholder, not already cut.
export function decideCut(rec, cfg, m, { turn = m.turn, cand = null, ttl = '1h', now = Date.now(), model = rec.model } = {}) {
  const same = { cut: rec.cut, clear: false };
  if (turn === rec.turn) return same;                        // mid-turn: never move the set
  if (cfg.clearDeep === false && rec.cut.length) return { ...same, turn };  // one cut a session, as the mod reads it
  if (m.prompt < cfg.trigger) return { ...same, turn };      // nothing is big enough to be worth it
  if (!cand || !cand.ids.length) return { ...same, turn, candidate: 0 };
  if (cand.tokens < cfg.clearAtLeast) return { ...same, turn, candidate: cand.tokens };
  const cold = rec.at > 0 && now - rec.at > COLD_MS;
  const p = priceCut(m, cand, { ttl, cold, calls: rec.calls, model });
  if (!p.pays) return { ...same, turn, candidate: cand.tokens, held: p };
  return { cut: [...rec.cut, ...cand.ids], clear: true, turn, cold, candidate: cand.tokens, ...p };
}

// Accounting after an answer. There is no gauge: a cut that does not pay is not made, and the set
// cannot move under us, so a session has no runaway to be given up on.
export function cutResponse(rec, cfg, t, usage, { now = Date.now() } = {}) {
  const events = [];
  rec.calls++; rec.at = now;
  if (t.model) rec.model = t.model;
  if (t.turn != null) rec.turn = t.turn;
  if (t.cut) rec.cut = t.cut;
  if (t.clear) {
    rec.clears++; rec.chars += t.clientCut?.chars || 0;
    events.push({ clear: true, tokens: Math.round(t.tokens || 0), recache: Math.round(t.recache || 0), cost: Math.round(t.cost || 0), saving: Math.round(t.saving || 0), ...(t.cold ? { cold: true } : {}), results: t.clientCut?.cut || 0 });
  }
  // what the cut is worth on this call: the tokens it took out, read at this model's rate
  if (rec.cut.length && usage) rec.saved += (t.clientCut?.tokens || 0) * readRate(rec.model);
  return events;
}

export const KEEP_FILES = 400, KEEP_DAYS = 2;
export function cutStore(dir) {
  const file = session => path.join(dir, `${String(session).replace(/[^\w.-]/g, '_')}.json`);
  let writes = 0;
  return {
    read(session) {
      if (!dir || !session) return freshCut(session);
      try { const r = JSON.parse(fs.readFileSync(file(session), 'utf8')); if (r && Array.isArray(r.cut)) return { ...freshCut(session), ...r }; } catch { /* no record yet */ }
      return freshCut(session);
    },
    write(rec) {
      if (!dir || !rec?.session) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file(rec.session), JSON.stringify(rec));
        if (++writes % 50 === 0) prune(dir);
      } catch { /* a record is never worth a failed request */ }
    },
  };
}
function prune(dir) {
  try {
    const old = Date.now() - KEEP_DAYS * 86400000;
    const fs_ = fs.readdirSync(dir).map(n => ({ n, p: path.join(dir, n) }));
    for (const f of fs_) { try { if (fs.statSync(f.p).mtimeMs < old) fs.unlinkSync(f.p); } catch { /* gone */ } }
    const left = fs.readdirSync(dir);
    if (left.length > KEEP_FILES) {
      const byAge = left.map(n => ({ n, p: path.join(dir, n), t: (() => { try { return fs.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } })() })).sort((a, b) => a.t - b.t);
      for (const f of byAge.slice(0, left.length - KEEP_FILES)) { try { fs.unlinkSync(f.p); } catch { /* gone */ } }
    }
  } catch { /* pruning is never worth a failed request */ }
}
