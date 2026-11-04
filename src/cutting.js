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
import { writeRate, readRate, remainingCalls, COLD_MS } from './clearing.js';

// A cut result's content, from the original length, so the bytes are the same every call.
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
export function priceCut(m, cand, { ttl = '1h', cold = false, calls = 0, model = null } = {}) {
  const read = readRate(model), have = remainingCalls(calls);
  const recache = Math.max(0, (m.prompt || cand.recache) - cand.tokens - (m.system || 0));
  const cost = cold ? 0 : recache * writeRate(ttl);
  const saving = cand.tokens * read * have;
  return { tokens: cand.tokens, recache, cost, saving, have, need: read > 0 ? Math.ceil(recache * writeRate(ttl) / (cand.tokens * read)) : 0, pays: cand.tokens > 0 && saving > cost };
}

// The decision, at a turn boundary only. Within a turn the set is returned unchanged, so the bytes
// are too. `cand` comes from proxy.js:cutCandidates -- the results outside the newest turn and the
// newest `keepMin`, big enough to be worth a placeholder, not already cut.
export function decideCut(rec, cfg, m, { turn = m.turn, cand = null, ttl = '1h', now = Date.now(), model = rec.model } = {}) {
  const same = { cut: rec.cut, clear: false };
  if (turn === rec.turn) return same;                        // mid-turn: never move the set
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
