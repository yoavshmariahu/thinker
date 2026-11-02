// The clearing policy, in one place (2026-11-02, the owner's call): clear, freeze what was cleared, and clear again
// when it pays.
//
// A clear is an investment. It costs one cache write now, of everything that sits after the first result it drops,
// and it pays back a cache read on every later call that no longer carries what was dropped. At list a 1h write is
// ~2x an input token, a 5m write ~1.25x, a cache read ~2.5% of one, so a written token needs ~80 later reads to
// break even (50 at the 5-minute rate). That is the whole policy; three rules follow from it.
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

// list-price ratios to an input token: what a cache write costs by its TTL, what a cache read costs
export const WRITE_1H = 2.0, WRITE_5M = 1.25, READ = 0.025;
export const writeRate = ttl => (ttl === '5m' ? WRITE_5M : WRITE_1H);
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

// a call that wrote most of its context into the cache rather than reading it, on a context worth caching
export const isRewrite = u => ((u?.write || 0) > 0.5 * ((u?.read || 0) + (u?.write || 0) + (u?.input || 0))) && ((u?.read || 0) + (u?.write || 0)) > 20000;

// A session's record. `edit` is what every call sends until a decision changes it; `turn` the boundary the edit was
// last decided at; `cleared` and `clearedUses` the server's own count from its last answer; `saved` and `written`
// the gauge's two sides in input-equivalent tokens; `stopped` the reason the session no longer clears, if any.
export const freshRecord = (session, cfg) => ({
  session, edit: { keep: cfg.keepMin ?? 0, ask: cfg.clearAtLeast }, turn: -1, changedAt: 0, calls: 0, lastAt: 0,
  cleared: 0, clearedUses: 0, clears: 0, moves: 0, saved: 0, written: 0, unmet: false, stopped: null,
});

// What is clearable: what sits before the turn by the proxy's count, less what the server already cleared. The
// proxy sees the agent's whole request, cleared results included, and only the server's count says how much of it
// is already out; what is already cleared is never considered again.
export const clearable = (rec, m) => Math.max(0, m.before - rec.cleared);

// What clearing `dropped` more tokens would cost and save, from the request as proxy.js measured it (`m`: `prompt`
// tokens before the turn, `prefix` tokens up to the first result the clear would newly drop). The write is the tail
// after that drop point less what the clear takes out of it: dropping 102,691 tokens from a 137k context cost a
// 26,694-token write, because most of what followed the drop point was the dropped material (measured 2026-11-02).
// A deeper ask only ever extends the cleared region oldest-first, so the cached prefix up to the old drop point
// survives and only the tail is written: that is why several clears a session are fine, each priced as its own tail.
export function price(m, dropped, { ttl = '1h', cold = false, calls = 0 } = {}) {
  const recache = Math.max(0, m.prompt - m.prefix - dropped);
  const cost = cold ? 0 : recache * writeRate(ttl);
  const have = remainingCalls(calls);
  const saving = dropped * READ * have;
  return { dropped, recache, cost, saving, have, pays: dropped > 0 && saving > cost, need: dropped ? Math.ceil(cost / (dropped * READ)) : 0 };
}

// The decision, at a turn boundary: the edit this turn sends. The same edit as last turn unless clearing more pays
// for its own write. The ask is what is already cleared plus DEEP_MARGIN of what is clearable, so it only ever grows.
// `turn` is the boundary's id (the count of the person's prompts); within a turn the edit in force is returned
// untouched, so what the proxy adds is identical from one call of the turn to the next.
export function decide(rec, cfg, m, { turn = m.turn, ttl = '1h', now = Date.now() } = {}) {
  const same = { edit: rec.edit, clear: false };
  if (rec.stopped || turn === rec.turn) return same;
  const left = clearable(rec, m);
  const dropped = cfg.clearDeep === false || rec.unmet ? 0 : Math.floor(DEEP_MARGIN * left);
  const ask = Math.max(cfg.clearAtLeast, rec.cleared + dropped);
  if (ask <= rec.edit.ask) return { ...same, turn, clearable: left };
  const cold = rec.lastAt > 0 && now - rec.lastAt > COLD_MS;
  const p = price(m, ask - rec.cleared, { ttl, cold, calls: rec.calls });
  // nothing applied yet: a deeper ask changes no cached prompt, and the first clear is cheaper the deeper it is,
  // since more of the tail it writes is the dropped material itself
  if (rec.cleared === 0 || p.pays) return { edit: { keep: rec.edit.keep, ask }, clear: true, turn, cold, clearable: left, ...p };
  return { ...same, turn, clearable: left, held: p };
}

// The record after an answer. `t` is what the request carried (`turn`, `changed`, `keep`, `asked`: the decision,
// applied here), `usage` what the API reported. Returns the events worth a log line: `clear` when this call carried
// a changed edit, `moved` when the server's cleared count left where the frozen edit held it, `unmet` when a deep
// ask past the trigger cleared nothing, `stopped` when the gauge gives the session up.
export function response(rec, cfg, t, usage, { now = Date.now() } = {}) {
  const events = [];
  const cold = rec.lastAt > 0 && now - rec.lastAt > COLD_MS;
  if (t.turn != null) rec.turn = t.turn;
  if (t.changed) { rec.edit = { keep: t.keep, ask: t.asked }; rec.changedAt = now; events.push({ clear: true, ...(t.clear || {}) }); }
  rec.calls++;
  rec.lastAt = now;
  if (!usage) return events;
  const cleared = usage.cleared || 0, uses = usage.clearedUses || 0;
  const ctx = (usage.input || 0) + (usage.read || 0) + (usage.write || 0);
  // a write the policy meant: the session's first clear, a call that carries a changed edit, or the edit in force
  // applied for the first time (the server clears at least what the ask says, so the count reaching the ask is that
  // moment: an ask raised at a boundary before the trigger is applied on a later call)
  const planned = t.changed || rec.cleared === 0 || (rec.cleared < rec.edit.ask && cleared >= rec.edit.ask);
  if (cleared > 0) {
    if (planned) rec.clears++;
    else if (uses !== rec.clearedUses) { rec.moves++; events.push({ moved: true, from: rec.clearedUses, to: uses }); }
    rec.cleared = cleared; rec.clearedUses = uses;
    rec.saved += cleared * READ;
  } else if (t.asked > cfg.clearAtLeast && usage.editAcknowledged && ctx >= cfg.trigger && !rec.unmet) {
    // an ask the API could not meet is an edit it did not apply: back to the floor for the session
    rec.unmet = true; rec.edit = { ...rec.edit, ask: cfg.clearAtLeast };
    events.push({ unmet: true, asked: t.asked });
  }
  // The cost side: a rewrite the policy did not plan. A call after a cold pause writes whatever the proxy does;
  // every other rewrite after the first clear is the server moving the block, or the clear itself not holding, and
  // it counts against what the clears have saved. The session stops once those rewrites cost more than the clears
  // have saved plus what they can still save over the calls the session likely has left: one 245k rewrite after a
  // 100k clear needs ~200 more calls to earn back, and the median session has 50 to 90.
  if (rec.clears > 0 && !planned && !cold && isRewrite(usage)) {
    rec.written += (usage.write || 0) * writeRate(usage.write5m > 0 && !(usage.write1h > 0) ? '5m' : '1h');
    const ahead = rec.cleared * READ * remainingCalls(rec.calls);
    if (rec.written > rec.saved + ahead) { rec.stopped = 'uneconomic'; events.push({ stopped: 'uneconomic', saved: Math.round(rec.saved), ahead: Math.round(ahead), written: Math.round(rec.written) }); }
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
