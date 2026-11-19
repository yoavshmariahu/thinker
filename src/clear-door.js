// The desktop door's clearing decision, made here and asked for by the mod (`thinker hook clear`).
//
// The clearing mod (src/integrations/claude-clear) runs inside a Claude Code session the proxy cannot reach, the
// desktop app's above all. Until 2026-11-18 it carried its own copy of the policy: the trigger, the size floor, the
// payback, the read rates, the token count, the keep list, the ladder. A mod has no import, so every one of them was
// written twice and a test held the two spellings together.
//
// That copy was also frozen. An open session keeps the mod it loaded at its start (claude-card.js: the folder is
// named by its bytes and an update never replaces it), so a session opened under one release went on clearing by
// that release's rules for as long as it stayed open. Measured on the fleet that day: one machine's sessions were
// still cut by the first revision of the rules a day after it had updated four times, and they were where its
// losses were. Two Claude Code hosts on the machine this was written on held the mods of two releases back.
//
// So the mod decides nothing now. It hands the conversation to the installed CLI, which an update replaces, and
// does what the answer says: a session opened last week is cut by today's rules on its very next turn, with no
// reload and nothing said in the chat. The stamp on the saving (cutting.js:policyId) is this process's version,
// which is the version of the rules that actually decided. One call a turn at most, at the turn's end, once the
// context is past the trigger: about 140 ms on the machine it was measured on, 200 with a 400k-token conversation.
//
// What stays in the mod is what only it can do: watch the turn, run the engine's /compact, put the placeholders
// where this file says, and keep the session's record.
import { COLD_MS, PAYBACK, WRITE_1H, MIN_CHARS, readRate, placeholder, policyId } from './cutting.js';
import { PROXY_DEFAULTS, resultTokens } from './proxy.js';
import { SERVICE_HOLDOUT } from './proxy-service.js';
import { keptCalls, keepPatterns, KEEP_DEFAULT } from './keep.js';
import { readMachineConfig } from './repo-switch.js';

// the tools a session record names, largest first
export const TOP_TOOLS = 3;
// An automatic attempt that cleared nothing holds the next one until the context has grown by this much. It was
// `clearAtLeast` while that was 60,000; the floor fell to 8,000 with the ladder, and a hold of 8k is no hold at
// all, since a working session grows that in a turn.
export const HOLD_GROWTH = 60000;
// The mod asks again at the first turn that ends at or past `askAt`. A session this door never clears by itself
// (the proxy serves it, the machine config turned the door off, it is held out) is told this, and the mod's own
// count of turns brings it back now and then in case the reason has gone.
export const NEVER = Number.MAX_SAFE_INTEGER;

// The proxy's policy as this door runs it: the same keys of the machine config's `proxy` block, the proxy's own
// defaults under them. `desktop: false` turns this door off and leaves the proxy alone. The mod never sees the
// request, so it places no breakpoint and leaves out no thinking, and a call's input in the desktop app is a file
// path and not a heredoc (the 2026-11-04 measurement that removed input cutting still holds there): none of the
// three is in the stamp of a saving made here.
//
// `cut` is the proxy's one switch over all of it (proxy.js:PROXY_DEFAULTS), and off since 2026-11-19: this door
// clears nothing either, because the two may not hold two policies -- and a desktop session is where most of the
// clearing on this machine happened, so leaving it on would have left the measurement exactly as unreadable as
// it was. `desktop: false` still turns this door off by itself, with the proxy's cutting on.
export function desktopPolicy(config) {
  const p = config?.proxy ?? {};
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    cut: p.cut === true,
    keepMin: num(p.keepMin, PROXY_DEFAULTS.keepMin),
    clearAtLeast: num(p.clearAtLeast, PROXY_DEFAULTS.clearAtLeast),
    trigger: num(p.trigger, PROXY_DEFAULTS.trigger),
    holdout: Math.min(1, Math.max(0, num(p.holdout, SERVICE_HOLDOUT))),
    auto: p.cut === true && p.desktop !== false,
    clearDeep: p.clearDeep !== false,
  };
}
export const stampOf = p => policyId({ cut: p.cut, trigger: p.trigger, clearAtLeast: p.clearAtLeast, clearDeep: p.clearDeep });

// A clear must repay its rewrite inside PAYBACK later calls (cutting.js, which carries the measurement that set
// it). Clearing writes `recache` tokens again at the one-hour rate where they would have been read; each later
// call then reads `dropped` fewer. A pause past the cache's hour is priced the same way (2026-11-18, the owner's
// call): it used to pass at any price, which cleared every resumed session over the trigger as deep as it went.
export const clearPays = (p, { dropped, recache, idle, cleared, model = '' }) => {
  if (!(dropped > 0)) return false;
  if (!p.clearDeep && cleared) return false;
  return (WRITE_1H / readRate(model) - 1) * recache <= (PAYBACK + 1) * dropped;
};

// in or out of the holdout for good: a hash of the session id, so a resumed session lands where it was
export function heldOut(session, share) {
  if (!share || !session) return false;
  if (share >= 1) return true;
  let h = 0x811c9dc5;
  for (let i = 0; i < session.length; i++) { h ^= session.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 2 ** 32 < share;
}
// thinker's own proxy, by its loopback address: a session it serves is cleared there and never twice
export const proxied = baseUrl => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(String(baseUrl ?? '').trim());
export const autoDue = (tokens, p, holdUntil) => tokens >= p.trigger && tokens >= (holdUntil || 0);

const charsOf = m => { try { return (m.text ?? '').length + (m.toolResults ?? []).reduce((n, r) => n + (r.text ?? '').length, 0) + (m.toolUses ?? []).reduce((n, u) => n + JSON.stringify(u.input ?? {}).length, 0); } catch { return 0; } };

// The newest copy of a kept file is no rung's to take (keep.js): a `*.md`, a file the person named, a file the
// model read again after a cut took it out. The rows are the mod's, so a result already cleared is one whose
// text is the placeholder.
const CLEARED_PREFIX = placeholder(0).split(':')[0] + ':';
export function keptOf(messages, patterns = KEEP_DEFAULT) {
  const calls = [], prompts = [], cut = [];
  for (const m of messages) {
    if (m.role === 'assistant') for (const u of m.toolUses ?? []) calls.push({ id: u.tool_use_id, name: u.tool, input: u.input });
    else if (m.role === 'user') {
      if ((m.text ?? '').trim()) prompts.push(m.text);
      for (const r of m.toolResults ?? []) if ((r.text ?? '').startsWith(CLEARED_PREFIX)) cut.push(r.tool_use_id);
    }
  }
  return keptCalls(calls, { patterns, prompts, cut }).ids;
}

// Every depth a clear could stop at, newest first: what taking the newest `depth` eligible results removes. The
// newest turn and the newest `keepMin` results always stay, and so does a result under MIN_CHARS (a placeholder
// costs about that much, and an earlier clear's placeholder is one of them).
export function clearLadder(messages, { keepMin = PROXY_DEFAULTS.keepMin, keep = null } = {}) {
  const pre = [0];
  for (let i = 0; i < messages.length; i++) pre.push(pre[i] + charsOf(messages[i]));
  const out = [];
  let kept = 0, inLatestTurn = true, tokens = 0, depth = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const rs = m.role === 'user' ? m.toolResults ?? [] : [];
    if (!rs.length) { if (m.role === 'user' && (m.text ?? '').trim()) inLatestTurn = false; continue; }
    let took = false;
    for (const r of [...rs].reverse()) {
      const text = r.text ?? '';
      if (inLatestTurn || kept < keepMin) { kept++; continue; }
      if (text.length < MIN_CHARS) continue;
      if (keep?.has(r.tool_use_id)) continue;
      depth++; tokens += resultTokens(text); took = true;
    }
    if (took) out.push({ depth, tokens, prefixChars: pre[i] });
  }
  return out;
}

// The deepest rung that repays its rewrite, or null: nothing over the size floor pays.
export function chooseDepth(messages, p, ctx) {
  let take = null;
  for (const rung of clearLadder(messages, { keepMin: p.keepMin, keep: ctx.keep ?? null })) {
    if (rung.tokens < p.clearAtLeast) continue;
    const recache = Math.max(0, ctx.tokens - rung.tokens);
    if (clearPays(p, { dropped: rung.tokens, recache, idle: ctx.idle, cleared: ctx.cleared, model: ctx.model ?? '' })) take = rung.depth;
  }
  return take;
}

// What a clear to `depth` replaces: each result's id and the placeholder that takes its place, and what that
// comes to. The mod puts the placeholders in; nothing else of a row changes, so every call keeps its arguments.
export function clearPlan(messages, { keepMin = PROXY_DEFAULTS.keepMin, depth = Infinity, keep = null } = {}) {
  const nameOf = new Map();
  for (const m of messages) if (m.role === 'assistant') for (const u of m.toolUses ?? []) nameOf.set(u.tool_use_id, u.tool);
  const byTool = new Map(), replace = {};
  let kept = 0, cleared = 0, chars = 0, tokens = 0, inLatestTurn = true, firstChanged = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const rs = m.role === 'user' ? m.toolResults ?? [] : [];
    if (!rs.length) { if (m.role === 'user' && (m.text ?? '').trim()) inLatestTurn = false; continue; }
    for (const r of [...rs].reverse()) {
      const text = r.text ?? '';
      if (inLatestTurn || kept < keepMin) { kept++; continue; }
      if (text.length < MIN_CHARS) continue;
      if (keep?.has(r.tool_use_id)) continue;
      if (cleared >= depth) continue;
      const n = resultTokens(text);
      cleared++; chars += text.length; tokens += n; firstChanged = i;
      const name = nameOf.get(r.tool_use_id) ?? 'tool';
      const t = byTool.get(name) ?? { calls: 0, tokens: 0 };
      t.calls++; t.tokens += n; byTool.set(name, t);
      replace[r.tool_use_id] = placeholder(text.length);
    }
  }
  const prefixChars = firstChanged > 0 ? messages.slice(0, firstChanged).reduce((n, m) => n + charsOf(m), 0) : 0;
  const tools = [...byTool].map(([name, t]) => ({ name, calls: t.calls, tokens: t.tokens })).sort((a, b) => b.tokens - a.tokens).slice(0, TOP_TOOLS);
  // `inputTokens` and `rows` are what the two piggybacks took (a call's own text, earlier thinking) until
  // 2026-11-04; the record and the card still read the fields, so they travel as the zero they now are.
  return { replace, cleared, chars, tokens, resultTokens: tokens, inputTokens: 0, rows: 0, prefixChars, tools };
}

// The answer to one question from the mod. `ev.op`:
//   start   the session began: does this door clear it by itself (for the one-time notice in the desktop app)
//   decide  a turn ended (`from: 'auto'`) or the person ran /thinker-clear (`from: 'manual'`): is there a clear to make
//           (`askAt`: the context to ask again at; `hold`: how far a failed attempt holds the next)
//   apply   the engine's compaction is in the mod's hands: which results to replace, with what
// Every answer carries `policy`, the stamp of the rules that gave it, and nothing here is remembered between
// calls: what the session knows (when it last cleared, the context an attempt is held until) comes in with the question.
export function clearAnswer(ev = {}, { home, config = undefined } = {}) {
  const p = desktopPolicy(config === undefined ? readMachineConfig(home) : config);
  const policy = stampOf(p);
  const auto = p.auto && !ev.test && !proxied(ev.baseUrl) && !heldOut(String(ev.session || ''), p.holdout);
  if (ev.op === 'start') return { auto, policy };
  const rows = Array.isArray(ev.messages) ? ev.messages : null;
  const manual = ev.from === 'manual';
  const keep = rows ? keptOf(rows, keepPatterns({ dir: home })) : null;
  if (ev.op === 'decide') {
    if (manual) {
      // the window could not be read: a hand-run clear may try, the automatic one never guesses
      if (!rows) return { clear: true, depth: null, policy };
      return { clear: clearPlan(rows, { keepMin: p.keepMin, keep }).cleared > 0, depth: null, policy };
    }
    if (!auto) return { clear: false, depth: null, askAt: NEVER, policy, reason: !p.auto ? 'off' : ev.test ? 'test' : proxied(ev.baseUrl) ? 'proxied' : 'holdout' };
    const tokens = Number(ev.tokens) || 0, holdUntil = Number(ev.holdUntil) || 0;
    const askAt = Math.max(p.trigger, holdUntil);
    if (!autoDue(tokens, p, holdUntil)) return { clear: false, depth: null, askAt, hold: HOLD_GROWTH, policy, reason: tokens < p.trigger ? 'below-trigger' : 'held' };
    const depth = rows ? chooseDepth(rows, p, { tokens, idle: Number(ev.idle) || 0, cleared: !!ev.cleared, model: ev.model || '', keep }) : null;
    return { clear: depth != null, depth, askAt: p.trigger, hold: HOLD_GROWTH, policy, ...(depth == null ? { reason: rows ? 'payback' : 'unreadable' } : {}) };
  }
  if (ev.op === 'apply') {
    if (!rows) return { skip: 'thinker-clear: the conversation could not be read', policy };
    const c = clearPlan(rows, { keepMin: p.keepMin, depth: ev.depth == null ? Infinity : Number(ev.depth), keep });
    if (!c.cleared) return { skip: 'thinker-clear: nothing old enough to clear', policy };
    if (!manual && c.tokens < p.clearAtLeast) return { skip: `thinker-clear: ${c.tokens.toLocaleString()} tokens to clear, under ${p.clearAtLeast.toLocaleString()}`, policy };
    return { ...c, policy };
  }
  return { policy };
}
