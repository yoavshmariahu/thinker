// The clearing policy, in one place (2026-11-02, the owner's call): clear, freeze what was cleared, and clear again
// when it pays.
//
// A clear is an investment. It costs one cache write now, of everything that sits after the first result it drops,
// and it pays back a cache read on every later call that no longer carries what was dropped. At list a 1h write is
// ~2x an input token, a 5m write ~1.25x, and a cache read 10% of one on most models, 5% on Opus 5.5 and 2.5% on Fable
// (model-usage.js:RATES, `readRate`), so a written token needs 20, 40 or 80 later reads to break even. Until
// 2026-11-02 the read was priced at 2.5% for every model, so on Opus 5.5 every clear was valued at half what it saves
// and the gauge gave sessions up after one moved block; on the same day the list rate for Opus 5.5 was read as 10%. That is the whole policy; three rules follow from it.
//
// 1. The edit changes only at a turn boundary, and only when clearing more pays (`decide`). Between changes the same
//    edit goes on every call, byte for byte: that is the freeze. What was cleared stays cleared, a later clear only
//    extends the cleared region at its newer end, and within a turn nothing moves.
// 2. The session's record lives on disk (`store`), not in the process: the edit in force, what the server reported
//    cleared, what the clears have saved and what the rewrites after them have cost. A restarted proxy sends the
//    same edit. Ten restarts on 2026-11-02 each re-did a deep clear from nothing, 400-600k tokens written apiece.
// 3. One gauge (`response`): when the unplanned rewrites since the first clear have cost more than the clears have
//    saved, the session stops clearing, once, with the numbers. A block the server moves on its own is not a
//    special case. It is a rewrite, it lands on the cost side, and the gauge decides.
//
// Nothing here reads a request: proxy.js measures the prompt (`measureClearing`) and hands the numbers in.
import fs from 'node:fs';
import path from 'node:path';
import { relativeRate } from './model-usage.js';

// list-price ratios to an input token: what a cache write costs by its TTL (the same on every Anthropic model), what a
// cache read costs by the model (READ where the model is not priced: Anthropic's usual tenth)
export const WRITE_1H = 2.0, WRITE_5M = 1.25, READ = 0.1;
export const writeRate = ttl => (ttl === '5m' ? WRITE_5M : WRITE_1H);
export const readRate = model => { const r = relativeRate(model); return r ? Math.round(r.cacheRead / r.input * 1000) / 1000 : READ; };
// A clear asks for this share of what is clearable. An ask the API cannot meet is an edit it does not apply at all,
// and a count by characters overshoots prose, so the ask stays under the estimate.
export const DEEP_MARGIN = 0.7;
// Past the cache's hour the next request writes its whole context whatever the proxy does, so a clear at that moment
// costs nothing extra: the decision prices it at zero. Not a state of its own.
export const COLD_MS = 65 * 60 * 1000;
// median further calls a session makes, by the calls it has made, measured on this machine's 146 proxied sessions
// (5 -> 47, 10 -> 47, 20 -> 40, 40 -> 68, 60 -> 90, 100 -> 92, 150 -> 68). Flat-ish and heavy-tailed, so the steps
// are coarse on purpose: a curve fitted to 146 sessions would be false precision.
export const REMAINING = [[10, 40], [20, 40], [40, 68], [100, 90]];
export const remainingCalls = n => (REMAINING.find(([at]) => n <= at) || [0, 90])[1];

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
export const rawOf = u => (u?.input || 0) + (u?.read || 0) + (u?.write || 0) + (u?.cleared || 0);

// A session's record. `edit` is what every call sends until a decision changes it; `turn` the boundary the edit was
// last decided at; `cleared` and `clearedUses` the server's own count from its last answer; `saved` and `written`
// the gauge's two sides in input-equivalent tokens; `stopped` the reason the session no longer clears, if any.
export const freshRecord = (session, cfg) => ({
  session, edit: { keep: cfg.keepMin ?? 0, ask: cfg.clearAtLeast }, turn: -1, changedAt: 0, calls: 0, lastAt: 0,
  cleared: 0, clearedUses: 0, clears: 0, moves: 0, saved: 0, written: 0, returned: 0, seenCleared: [], raw: 0, unmet: false, stopped: null, model: null,
});

// What is clearable: what sits before the turn by the proxy's count, less what the server already cleared. The
// proxy sees the agent's whole request, cleared results included, and only the server's count says how much of it
// is already out; what is already cleared is never considered again.
export const clearable = (rec, m) => Math.max(0, m.before - rec.cleared);

// What clearing `dropped` more tokens would cost and save, from the request as proxy.js measured it (`m`: `prompt`
// tokens before the turn, `prefix` the cached head the clear keeps: the system prompt and the tools, proxy.js). The
// write is everything after that less what the clear takes out: dropping 102,691 tokens from a 137k context cost a
// 26,694-token write, because most of what followed was the dropped material (measured 2026-11-02). A deeper ask
// extends the cleared region oldest-first, but the cached prefix up to the old drop point is not found again (it ends
// mid-conversation, where no breakpoint is), so each deepening writes the whole post-clear context: on Opus 5.5 a
// 60k write for 12-28k dropped (smoke6, 2026-11-02), which is why a deeper ask rarely pays there.
export function price(m, dropped, { ttl = '1h', cold = false, calls = 0, model = null } = {}) {
  const recache = Math.max(0, m.prompt - m.prefix - dropped);
  const cost = cold ? 0 : recache * writeRate(ttl);
  const have = remainingCalls(calls), read = readRate(model);
  const saving = dropped * read * have;
  return { dropped, recache, cost, saving, have, pays: dropped > 0 && saving > cost, need: dropped ? Math.ceil(cost / (dropped * read)) : 0 };
}

// The decision, at a turn boundary: the edit this turn sends. The same edit as last turn unless clearing more pays
// for its own write. The ask is what is already cleared plus DEEP_MARGIN of what is clearable, so it only ever grows.
// `turn` is the boundary's id (the count of the person's prompts); within a turn the edit in force is returned
// untouched, so what the proxy adds is identical from one call of the turn to the next.
export function decide(rec, cfg, m, { turn = m.turn, ttl = '1h', now = Date.now(), model = rec.model } = {}) {
  const same = { edit: rec.edit, clear: false };
  if (rec.stopped || turn === rec.turn) return same;
  const left = clearable(rec, m);
  const dropped = cfg.clearDeep === false || rec.unmet ? 0 : Math.floor(DEEP_MARGIN * left);
  const keep = m.keep ?? rec.edit.keep;
  // The ask may never exceed what is clearable before the turn. The server satisfies it oldest-first and
  // stops, so an ask it cannot meet from earlier turns is met out of the turn in progress: at B6 turn 5
  // (2026-11-03) ~54k sat before the turn, the ask in force was the 100k floor, and the server cleared
  // 106k -- the missing ~52k being the reads the model was about to answer from. `reach` is also what
  // keeps a raised ask meetable at all: an ask the API cannot meet applies nothing, which after a clear
  // un-clears the whole conversation for that call. Before the first clear an unmet floor costs nothing,
  // so the floor still stands on its own and the clear simply waits for enough to accumulate.
  const reach = rec.cleared + left;
  const ask = Math.min(Math.max(cfg.clearAtLeast, rec.cleared + dropped), Math.max(cfg.clearAtLeast, reach));
  if (ask <= rec.edit.ask && keep === rec.edit.keep) return { ...same, turn, clearable: left };
  // a keep that has to grow to cover this turn is not a deepening and is not priced: it only ever holds
  // material back, and the alternative is the model losing work it is in the middle of using
  if (ask <= rec.edit.ask) return { edit: { keep, ask: rec.edit.ask }, clear: false, turn, clearable: left };
  const cold = rec.lastAt > 0 && now - rec.lastAt > COLD_MS;
  const p = price(m, ask - rec.cleared, { ttl, cold, calls: rec.calls, model });
  // nothing applied yet: a deeper ask changes no cached prompt, and the first clear is cheaper the deeper it is,
  // since more of the tail it writes is the dropped material itself
  if (rec.cleared === 0 || p.pays) return { edit: { keep, ask }, clear: true, turn, cold, clearable: left, ...p };
  return { edit: { keep, ask: rec.edit.ask }, clear: false, turn, clearable: left, held: p };
}

// The record after an answer. `t` is what the request carried (`turn`, `changed`, `keep`, `asked`: the decision,
// applied here), `usage` what the API reported. Returns the events worth a log line: `clear` when this call carried
// a changed edit, `moved` when the server's cleared count left where the frozen edit held it, `unmet` when a deep
// ask past the trigger cleared nothing, `stopped` when the gauge gives the session up.
export function response(rec, cfg, t, usage, { now = Date.now() } = {}) {
  const events = [];
  const cold = rec.lastAt > 0 && now - rec.lastAt > COLD_MS;
  if (t.turn != null) rec.turn = t.turn;
  if (Array.isArray(t.prints)) rec.seenCleared = t.prints;
  if (t.model) rec.model = t.model;
  const read = readRate(rec.model);
  if (t.changed) { rec.edit = { keep: t.keep, ask: t.asked }; rec.changedAt = now; events.push({ clear: true, ...(t.clear || {}) }); }
  rec.calls++;
  rec.lastAt = now;
  if (!usage) return events;
  const cleared = usage.cleared || 0, uses = usage.clearedUses || 0;
  // the prompt's growth since the previous answer, in the API's tokens; the first answer seen sets the mark
  const raw = rawOf(usage), grew = rec.raw > 0 && raw > 0 ? Math.max(0, raw - rec.raw) : null;
  if (raw > 0) rec.raw = raw;
  const ctx = (usage.input || 0) + (usage.read || 0) + (usage.write || 0);
  // a write the policy meant: the session's first clear, a call that carries a changed edit, or the edit in force
  // applied for the first time (the server clears at least what the ask says, so the count reaching the ask is that
  // moment: an ask raised at a boundary before the trigger is applied on a later call)
  const planned = t.changed || rec.cleared === 0 || (rec.cleared < rec.edit.ask && cleared >= rec.edit.ask);
  if (cleared > 0) {
    if (planned) rec.clears++;
    else if (uses !== rec.clearedUses) { rec.moves++; events.push({ moved: true, from: rec.clearedUses, to: uses }); }
    rec.cleared = cleared; rec.clearedUses = uses;
    rec.saved += cleared * read;
  } else if (t.asked > cfg.clearAtLeast && usage.editAcknowledged && ctx >= cfg.trigger && !rec.unmet) {
    // an ask the API could not meet is an edit it did not apply: back to the floor for the session
    rec.unmet = true; rec.edit = { ...rec.edit, ask: cfg.clearAtLeast };
    events.push({ unmet: true, asked: t.asked });
  }
  // The cost side: what the API wrote beyond the request's own growth, on a call the policy did not plan -- not the
  // session's first clear, not a changed edit's call, not the ask's first application, not after a cold pause (that
  // request writes its context whatever the proxy does). It is the prefix written again: the server moving the block,
  // or the clear itself not holding. The session stops once those writes cost more than the clears have saved plus
  // what they can still save over the calls the session likely has left: one 245k rewrite after a 100k clear needs
  // ~200 more calls to earn back, and the median session has 50 to 90.
  // What the clear did not save, because the model fetched it again (proxy.js:rereadOfCleared). A cleared
  // token is worth `read` on each later call; a token that comes back is fresh input at 1, ten to forty
  // times that, and it is read on every call after it too. B4 (2026-11-03) lost 81% this way with nothing
  // on the cost side of this gauge at all, since the loss was in model calls and the gauge counts rewrites.
  if (rec.clears > 0 && t.reread?.tokens > 0) {
    rec.returned = (rec.returned || 0) + t.reread.tokens;
    events.push({ reread: true, calls: t.reread.calls, tokens: t.reread.tokens, returned: Math.round(rec.returned), tools: (t.reread.tools || []).slice(0, 3).map(x => x.name).join(',') });
  }
  let again = 0;
  if (rec.clears > 0 && !planned && !cold && grew != null) {
    again = Math.max(0, (usage.write || 0) - grew);
    if (again > 0) rec.written += again * writeRate(usage.write5m > 0 && !(usage.write1h > 0) ? '5m' : '1h');
  }
  // one gauge, both costs: the rewrites the clears provoked and the material they failed to remove
  const cost = rec.written + (rec.returned || 0);
  if (rec.clears > 0 && !rec.stopped && cost > 0) {
    const ahead = rec.cleared * read * remainingCalls(rec.calls);
    if (cost > rec.saved + ahead) {
      rec.stopped = 'uneconomic';
      events.push({ stopped: 'uneconomic', saved: Math.round(rec.saved), ahead: Math.round(ahead), written: Math.round(rec.written), returned: Math.round(rec.returned || 0), ...(again > 0 ? { again: Math.round(again) } : {}) });
    }
  }
  return events;
}

// The records on disk, one file per session beside the proxy log (`<log dir>/clearing/<session>.json`). Read on
// every request and written after every answer: a restart changes nothing. Files older than KEEP_DAYS go when the
// directory grows past KEEP_FILES, as the compression records do.
export const KEEP_FILES = 400, KEEP_DAYS = 2;
export function store(dir, cfg) {
  const file = session => path.join(dir, `${String(session).replace(/[^\w.-]/g, '_')}.json`);
  let writes = 0;
  return {
    read(session) {
      if (!dir || !session) return freshRecord(session || '', cfg);
      try { const r = JSON.parse(fs.readFileSync(file(session), 'utf8')); if (r && r.edit) return { ...freshRecord(session, cfg), ...r }; } catch { /* no record yet */ }
      return freshRecord(session, cfg);
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
function prune(dir, { now = Date.now() } = {}) {
  try {
    const names = fs.readdirSync(dir);
    if (names.length <= KEEP_FILES) return;
    for (const n of names) { const p = path.join(dir, n); try { if (now - fs.statSync(p).mtimeMs > KEEP_DAYS * 864e5) fs.unlinkSync(p); } catch {} }
  } catch { /* nothing to prune */ }
}
