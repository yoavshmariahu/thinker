// The context proxy: an agent's requests to the Anthropic API pass through a local process that asks the API
// to clear old tool results on its side (`clear_tool_uses_20250919`, beta `context-management-2025-06-27`).
// Off unless someone starts it (`thinker proxy`) and points the agent at it (ANTHROPIC_BASE_URL).
//
// Any client of the Messages API (2026-10-24): the edit needs the beta header, which Claude Code sends on every
// request and no other agent does (pi, OpenCode, Goose, Aider, Cline, Droid: checked on 2026-10-24, pi live). Until
// then a request without it was forwarded untouched (`no-beta`), so the proxy cleared for Claude Code alone; now the
// header is added upstream (`withBeta`, logged `betaAdded`) and the edit with it. The agent's own bytes are still
// not rewritten: a header is added, and a block appended to the body as before.
//
// Why the server's edit and not our own: on the models that run the preserved-thinking check (Opus 5.5,
// Sonnet 5.5, Haiku 5.5, Fable 5.1) a client-side rewrite of an earlier tool_result is an edited history,
// a 400 on enforced accounts and every later thinking block dropped elsewhere; the server's clearing is not
// counted as an edit. So the proxy keeps no state and rewrites nothing the agent sent: it appends one edit
// to `context_management.edits`, which Claude Code already sends (with `clear_thinking` alone).
//
// Seen live on 2026-10-20 (Claude Code 2.1.304, a subscription login): the cleared set is stable between
// clears, so the turns after a clear read the shorter prefix from the cache; a clear writes the cache again
// from the system prompt on, at 2x the input price (1-hour writes). The defaults are the replay's over
// 1,700 local sessions: 9.2% of billed-equivalent tokens saved, 29 sessions costlier, all of it in long
// sessions (14.7% over 120 requests, nothing under 60). The model's own reaction to the placeholders is not
// in that number; an experiment is.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { ProxyAgent } from 'proxy-agent';
import path from 'node:path';
import crypto from 'node:crypto';
import { transformResponses, responsesUsageTap, responsesReport } from './proxy-responses.js';
import { CODEX_PROXY_PATH, CODEX_UPSTREAMS } from './proxy-codex.js';
import { foreignAuth } from './proxy-route.js';
import { noteCompression } from './compression.js';
import { isRewrite, LONG_CONTEXT, clearedOf } from './cutting.js';
import { retryPlan, addressBook, cachingLookup } from './proxy-retry.js';
import { decideCut, cutResponse, cutStore, freshCut, MIN_CHARS as CUTTING_MIN_CHARS, placeholder as cutting_placeholder } from './cutting.js';
export { isRewrite, LONG_CONTEXT, clearedOf };

export const EDIT_BETA = 'context-management-2025-06-27';
// `keep`: how many of the newest tool uses a clear leaves, a count or `turn` (2026-10-22): the tool uses of the
// request's current turn, never under `keepMin`. The Context tab's measurement behind `turn`: on this repository's
// sessions 88% of what tool results cost is reading them again after the agent last used them, 82% after the turn
// that fetched them ended, and only 8% is a result used again later in its own turn (tool-outputs.js:sessionOutputs).
// A count clears results the agent is still working from in a long turn, and the model was seen to read the file
// again; `turn` clears only what earlier turns fetched, so it clears less and should cost the agent nothing. The
// server's edit takes a count alone, so the proxy works the count out from the request's messages on every call.
// `turn` is the default since 2026-10-22, the owner's decision on the replay alone (proxy-replay.js, 3,317 Claude Code
// sessions of this machine over 30 days): at this trigger it saves 1.44% of the billed-equivalent tokens against the
// count's 1.58%, with 17 sessions costlier against 20, and by construction never clears a result of the turn in hand;
// what the replay cannot see, the agent reading again what was cleared, is the experiment still to run
// (research/output-lifetime-2026-10-22). The proxy itself stays off until then: nothing points an agent at it.
// **`turn` sends `keepMin`, a constant, since 2026-11-02.** It used to send the count of the turn's tool uses, which grows
// by one with every call of the turn, and the server does not take a growing keep the way the replay modelled it: read
// from this machine's proxy log beside Claude Code's own transcripts, each increment un-cleared one earlier result
// (the server's `cleared_tool_uses` fell 108, 107, 106 ... as keep rose 3, 4, 5 ...), so the edited prompt differed
// from the one just cached at a result near its top, and everything after the system prompt was written again:
// 152 calls running in one session, 100k-236k tokens each, read pinned at 31,520. Over 30 days a long session rewrote
// its prefix on 1.2% of calls before its first clear and 1.4% held out, on 23.6% after it; 95% of the calls where the
// cleared set moved rewrote, 4% where it stayed; and when keep did not change between calls, 5%. At list it was -$801
// on the 16 sessions that cleared in the week to 2026-11-01, 4 of them ahead. A constant keep changes the cleared set
// only as the conversation grows at its end, where the rewrite is the tail. The name stays for configs that say `turn`;
// the Responses proxy keeps the turn by itself (transformResponses) and is not affected.
// Bigger cuts, less often (2026-10-28, the owner's call on the replay below). A clear rewrites the prompt cache
// from the first result it removes, and a 1h write costs ~200% of an input token against ~2.5% for a read, so what
// a clear costs is the rewrite and what it saves is every later read of what it took. Clearing from 100k paid that
// rewrite for the smallest cut it could make. Taking the call text and the earlier thinking with it already helped
// (they ride the same rewrite); raising the threshold is the other half, and it is where the harm was.
// `thinker proxy replay`, 264 Claude Code sessions, 1.05B billed-equivalent tokens, $3,750 at list:
//   100k/80k  +inputs +thinking  +7.8% at list  (<60 req -0.7%, 60-119 +1.2%, 120+ +10.9%, 12 sessions costlier)
//   140k/100k +inputs +thinking  +7.3% at list  (<60 req -0.1%, 60-119 +0.5%, 120+ +10.2%,  6 sessions costlier)
//   180k/140k +inputs +thinking  +5.8% at list  (<60 req +0.1%, 60-119 +0.7%, 120+  +8.0%,  4 sessions costlier)
// 140k gives up half a point of the saving to halve the sessions it can cost, and no long session is costlier.
// Still not measured, and the reason the holdout stays: the model reading again what was cleared, which the replay
// cannot see (proxy-replay.js).
export const PROXY_DEFAULTS = { upstream: 'https://api.anthropic.com', trigger: 140000, keepMin: 3, clearAtLeast: 100000, holdout: 0, clearDeep: true };
// The request as the decision needs it: the prompt in tokens, the cached prefix a cut keeps (`prefix`: the system
// prompt and the tool definitions, which is all the API finds again once a cut changes the history -- Claude Code
// sets its breakpoints on the system prompt and the newest messages, so a prefix ending mid-conversation is never
// matched; measured 2026-11-04, four cuts each read 12,895 tokens and wrote the whole post-cut context), the system
// prompt's own size, and the turn's id. All of it from what sits before the turn: within a turn the request grows
// with every call, and a verdict that moved from one call of a turn to the next would move the cut with it, which
// is the rewrite this exists to avoid.
export function measurePrompt(cfg, j) {
  const txt = v => { try { return v == null ? 0 : JSON.stringify(v).length; } catch { return 0; } };
  const tok = chars => Math.floor(chars * TOKENS_PER_CHAR);
  const all = Array.isArray(j?.messages) ? j.messages : [];
  const messages = all.slice(0, turnStart(all));
  const head = txt(j?.system) + txt(j?.tools);
  const prompt = tok(head + txt(messages));

  // `prompt` is the whole request less the turn in progress, and it exists for one thing: the trigger.
  // What a cut costs is not here -- it is the tail from the first replaced result, which only the
  // candidate walk can know (cutCandidates). `prefix` and `system` were read by the old cost model and
  // are gone with it.
  return { prompt, turn: turnId(all) };
}
// the boundary's id: how many prompts of the person's the conversation holds, by turnStart's rule for one
export function turnId(messages) {
  let n = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text' }];
    if (blocks.some(b => b?.type === 'text') && !blocks.some(b => b?.type === 'tool_result')) n++;
  }
  return n;
}
// What happens when a request never reached the upstream: the codes worth another try, the ladder a
// dead resolver is given, and the address a host last answered on. All of it in proxy-retry.js, with
// the measurement that set the policy. Re-exported because that is where every reader looked for it.
export { RETRY_CODES, DNS_CODES, RETRY_TLS, RETRY_WAITS, retryable, retryPlan, addressBook, cachingLookup, KNOWN_FOR } from './proxy-retry.js';
// How many refusals in a row mean the agent's credentials are not for the endpoint the proxy forwards to, rather
// than one expired token or one upstream hiccup: a session whose every call fails is broken either way, and the
// proxy is the one thing in the path that the person did not put there.
export const AUTH_REFUSALS = 3;
// How much of a 400 is read before deciding whether it is about the edit: an error body is small, and the point
// is to decide before the agent sees anything.
export const REFUSAL_BODY = 16_384;
// Whether a refusal is about the edit the proxy added, rather than about the agent's own request. Named fields
// and the words a gateway uses for something it does not know; a 400 that says none of this is the agent's to see.
const EDIT_WORDS = /context[_-]management|clear_tool_uses|clear_thinking|anthropic-beta|context-management-2025-06-27/i;
const UNKNOWN_WORDS = /unsupported|unrecognized|unknown|not supported|extra_forbidden|unexpected|invalid.{0,20}field|additionalProperties/i;
export function refusesEdit(body) {
  const text = String(body || '').slice(0, REFUSAL_BODY);
  if (!EDIT_WORDS.test(text)) return false;
  // the beta header or the field is named: that alone is enough when the gateway says it cannot take it
  return UNKNOWN_WORDS.test(text) || /context[_-]management/i.test(text);
}

// The API's model calls: the only requests whose credentials the refusal count may judge.
export const MESSAGES_PATH = /^\/v1\/messages(\/|\?|$)/;
// Judged only when the proxy forwards to Anthropic's own API: with an upstream of someone's own (`--upstream`,
// `proxy: { upstream }`) the credentials are theirs to match, not the proxy's to doubt.
export const forwardsToAnthropic = upstream => { try { return /(^|\.)api\.anthropic\.com$/.test(new URL(upstream).hostname); } catch { return false; } };

// An agent routed through a model server of its own that reaches the proxy by mistake (proxy-route.js): its token
// was minted for that server, so forwarding the request to api.anthropic.com fails every call of every session of
// that harness, and the proxy is the one thing in the path the person did not put there. Two signs, in order of
// certainty: credentials that cannot be Anthropic's, and the API refusing them AUTH_REFUSALS times running. Either
// one stands the service down once (commands/proxy.js, proxy-service.js:standDown), so the next session goes
// straight to the API again and nothing writes the URL back. The request itself is forwarded as it is and the
// API's own answer reaches the agent: the proxy invents no failure, and a session under way hears it from the API.
// The clearing has its own gauge for the rewrites after a clear (clearing.js:response); the report still counts them
// (proxyReport, rewriteWarning) beside the held-out rate, which is the number that judges a policy.
export function authWatch(onStandDown, { limit = AUTH_REFUSALS, on = true } = {}) {
  let refusals = 0, stoodDown = false;
  const fire = reason => { if (stoodDown || !on) return; stoodDown = true; onStandDown(reason); };
  return {
    request: headers => { if (foreignAuth(headers)) fire('the agent sent credentials that are not Anthropic\'s, so it is routed through a model server of its own'); },
    response: status => {
      if ([401, 403].includes(status)) { if (++refusals >= limit) fire(`the API refused the agent's credentials on ${refusals} requests running (HTTP ${status})`); }
      else if (status < 400) refusals = 0;
    },
    get stoodDown() { return stoodDown; },
  };
}
// what a text block costs the model, for the proxy's own count: four characters are 1.44 tokens (report.js:CALIBRATION)
export const TOKENS_PER_CHAR = 1.44 / 4;
// the margin the proxy's count of the clearable results must clear by before it sends the thinking edit, since the
// server counts exactly and the proxy estimates: a thinking clear on a request whose tool clear does not fire would break
// the cache on its own
export const THINKING_MARGIN = 1.25;

const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

// flags win over the environment, the environment over the defaults
export function proxyConfig(flags = {}, env = process.env) {
  const pick = (flag, name) => num(flags[flag]) ?? num(env[name]);
  const cfg = { ...PROXY_DEFAULTS };
  for (const [key, flag, name] of [['trigger', 'trigger', 'THINKER_PROXY_TRIGGER'], ['keep', 'keep', 'THINKER_PROXY_KEEP'], ['keepMin', 'keep-min', 'THINKER_PROXY_KEEP_MIN'],
    ['clearAtLeast', 'clear-at-least', 'THINKER_PROXY_CLEAR_AT_LEAST'], ['holdout', 'holdout', 'THINKER_PROXY_HOLDOUT']]) {
    const v = pick(flag, name);
    if (v !== undefined) cfg[key] = v;
  }
  if (String(flags.keep ?? env.THINKER_PROXY_KEEP ?? '').trim() === 'turn') cfg.keep = 'turn';
  // on by default: a flag, `--no-<flag>`, the variable (on|off) or the machine config may say otherwise
  const onOff = (flag, name, dflt) => {
    const raw = flags[flag] ?? (flags[`no-${flag}`] ? 'off' : undefined) ?? env[name];
    if (raw === undefined || raw === '') return dflt;
    if (raw === true) return true;
    const s = String(raw).trim();
    if (/^(1|on|true|yes)$/i.test(s)) return true;
    if (/^(0|off|false|no)$/i.test(s)) return false;
    return dflt;
  };
  cfg.clearDeep = onOff('clear-deep', 'THINKER_PROXY_CLEAR_DEEP', PROXY_DEFAULTS.clearDeep);
  cfg.upstream = flags.upstream || env.THINKER_PROXY_UPSTREAM || cfg.upstream;
  cfg.port = pick('port', 'THINKER_PROXY_PORT');
  cfg.protocol = flags.protocol || env.THINKER_PROXY_PROTOCOL || 'anthropic';
  cfg.codex = flags.codex === true;
  if (!['anthropic', 'responses'].includes(cfg.protocol)) throw new Error('--protocol must be anthropic or responses');
  if (cfg.protocol === 'responses') {
    if (!flags.upstream && !env.THINKER_PROXY_UPSTREAM) throw new Error('--protocol responses needs an explicit --upstream (the existing provider base URL)');
    const upstream = new URL(cfg.upstream);
    if (!['http:', 'https:'].includes(upstream.protocol)) throw new Error('--upstream must be an HTTP(S) provider base URL');
    for (const [flag, variable] of [['trigger', 'THINKER_PROXY_TRIGGER'], ['clear-at-least', 'THINKER_PROXY_CLEAR_AT_LEAST'], ['keep-min', 'THINKER_PROXY_KEEP_MIN'], ['holdout', 'THINKER_PROXY_HOLDOUT']]) {
      const value = flags[flag] ?? env[variable];
      if (value != null && (typeof value === 'boolean' || String(value).trim() === '' || !Number.isFinite(Number(value)))) throw new Error(`--${flag} needs a number`);
    }
    for (const k of ['trigger', 'clearAtLeast', 'keepMin']) if (!Number.isSafeInteger(cfg[k]) || cfg[k] < (k === 'keepMin' ? 0 : 1)) throw new Error(`responses ${k} must be a ${k === 'keepMin' ? 'non-negative' : 'positive'} integer`);
    if (!Number.isFinite(cfg.holdout) || cfg.holdout < 0 || cfg.holdout > 1) throw new Error('--holdout must be between 0 and 1');
  }
  return cfg;
}

// The tool uses of the request's current turn: those in the assistant messages after the last user message that
// carries text and no tool result, which is the person's request (a hook's context and the system reminders ride in
// the user message that holds the tool result they follow, so they do not start a turn).
export function turnStart(messages) {
  let start = 0;
  messages.forEach((m, i) => {
    if (m?.role !== 'user') return;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text' }];
    if (blocks.some(b => b?.type === 'text') && !blocks.some(b => b?.type === 'tool_result')) start = i;
  });
  return start;
}
// How many tool uses the turn before this one made. `keep` is a count of the newest tool uses the API
// holds back, and it knows nothing about turns, so a keep smaller than a turn's own tool calls lets the
// server clear the results of the turn in progress -- the reads the model is about to answer from.
// Measured 2026-11-03: a turn of 1 read + 1 grep + 2 echoes against `keep: 3` lost its read mid-turn in
// 4 of 14 turns, and the model answered "I couldn't give the line count (its Read result was cleared
// from my context)". The current turn's own count cannot be used: it grows with every call of the turn,
// which is the rewrite of #585/#588. The previous turn's is settled, so a boundary can freeze it.
// Thinker cuts the context itself (`src/cutting.js` holds the policy and says why). Two functions:
// `cutCandidates` lists what a boundary could newly cut, and `applyCut` replaces a known set. Both
// walk from the end, because the rule is about recency: the newest turn is kept whole whatever its
// shape, then the newest `keepMin` results, then anything too small to be worth a placeholder. That
// is a rule, where the API's `keep` was a count -- which is why three echoes could evict a 25k read.
// Thinking blocks and tool_use inputs are left exactly as the agent wrote them: October's breakage
// was an in-place edit of the history, and a tool_result-only edit is accepted (checked live,
// 2026-11-04, 6 and 8 placeholders beside 3 untouched thinking blocks, every call 200).
const resultText = b => typeof b.content === 'string' ? b.content
  : Array.isArray(b.content) ? b.content.filter(x => x?.type === 'text').map(x => x.text || '').join('') : '';

// Walk the conversation newest-first, calling back for each tool result with whether the recency
// rule protects it. `keepMin` counts only results the rule would otherwise let go.
function walkResults(messages, keepMin, fn) {
  let kept = 0, inLatestTurn = true;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i], blocks = Array.isArray(m?.content) ? m.content : null;
    const results = blocks ? blocks.filter(b => b?.type === 'tool_result') : [];
    if (!results.length) {
      if (m?.role === 'user' && (!blocks || blocks.some(b => b?.type === 'text'))) inLatestTurn = false;
      continue;
    }
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k];
      if (b?.type !== 'tool_result') continue;
      const protectedByRule = inLatestTurn || kept < keepMin;
      if (protectedByRule) kept++;
      fn(b, i, protectedByRule);
    }
  }
}

// What a boundary could newly cut, and what replacing it would cost: `recache` is the prompt from
// the first result we would replace to the end, which is what a changed prefix makes the API write.
export function cutCandidates(messages, { keepMin = 3, cut = [], minChars = CUT_MIN_CHARS } = {}) {
  const have = new Set(cut), ids = [];
  let chars = 0, firstChanged = -1;
  walkResults(messages, keepMin, (b, i, prot) => {
    if (prot || have.has(b.tool_use_id)) return;
    const text = resultText(b);
    if (text.length < minChars) return;
    ids.push(b.tool_use_id); chars += text.length; firstChanged = i;
  });
  // What the rewrite actually pays for: the messages from the first replaced one onward, AS THEY WILL BE
  // SENT -- the new placeholders and the ones already in the set, not the full results the agent resent.
  // Measured on the original messages instead, this over-stated the cost by 3.1x, 7.9x and 14.9x on the
  // second, third and fourth cut of a 28-turn session (2026-11-04), because every result cut earlier was
  // still counted at full size. The API's own writes on those four calls were 47k, 58k, 56k and 52k --
  // flat, because the band runs up to the protection boundary, so everything between the first replaced
  // result and the live turn is itself replaced and the tail is only the part that survives.
  let tail = 0;
  if (firstChanged >= 0) {
    const sent = applyCut(messages.slice(firstChanged), new Set([...have, ...ids])).messages;
    tail = JSON.stringify(sent).length * TOKENS_PER_CHAR;
  }
  return { ids, chars, tokens: Math.round(chars * TOKENS_PER_CHAR), recache: Math.round(tail), firstChanged };
}

// Apply a known set. Deterministic: the agent re-sends the whole conversation every call, so the
// same ids give the same bytes, which is what keeps the prefix still.
//
// Three operations, the same three the desktop mod performs (`register.tsx:clearOld`), so the two
// doors do the same thing and not merely hold the same config keys: an old result becomes a
// placeholder, and nothing else is touched. Measured 2026-11-04 in the final request of a seven-turn
// session: the tool results held 487,332 chars, the tool_use inputs 2,800 (a file path each) and the
// thinking no text at all, Claude Code asking for `display: omitted` so only a signature comes back.
// So emptying the calls bought 0.6% of what the results buy, and in a 28-turn run the model read its
// own blanked calls, reported that it had been "making the tool calls without file paths", and began
// doing so -- a false history of itself that it then copied. Dropping thinking bought nothing and was
// the one edit that broke the API in October. The results are the feature; both piggybacks are gone.
export function applyCut(messages, cut) {
  const ids = cut instanceof Set ? cut : new Set(cut || []);
  if (!ids.size) return { messages, cut: 0, chars: 0, tokens: 0, firstChanged: -1 };
  let n = 0, chars = 0, firstChanged = -1;
  const out = messages.map((m, i) => {
    const c = m?.content;
    if (!Array.isArray(c)) return m;
    let touched = false;
    const blocks = c.map(b => {
      if (b?.type !== 'tool_result' || !ids.has(b.tool_use_id)) return b;
      const text = resultText(b);
      if (text.length < CUT_MIN_CHARS) return b;
      n++; chars += text.length; touched = true;
      return { ...b, content: [{ type: 'text', text: cutPlaceholder(text.length) }] };
    });
    if (!touched) return m;
    if (firstChanged < 0) firstChanged = i;
    return { ...m, content: blocks };
  });
  // `tokens` is what this prompt is shorter by, and that is the whole of the saving: the set is cumulative
  // within a conversation, so every later call reads the shorter prefix again (compression.js). Reported
  // here rather than worked out by a reader, because only this walk knows which results it replaced -- one
  // below `CUT_MIN_CHARS` is left in place, and a cut id whose result the agent no longer sends is not in
  // the prompt to save anything.
  return { messages: out, cut: n, chars, tokens: Math.round(chars * TOKENS_PER_CHAR), firstChanged };
}

// What the cut took out, by tool, for the card and the Stop hook's line (compression.js). The cut
// knows which uses it replaced, so this needs no guess at what a server chose.
export function cutActions(messages, cut) {
  const ids = new Set(cut), nameOf = new Map(), by = new Map();
  for (const m of (Array.isArray(messages) ? messages : [])) for (const b of (Array.isArray(m?.content) ? m.content : [])) if (b?.type === 'tool_use') nameOf.set(b.id, b.name);
  for (const id of ids) { const name = nameOf.get(id) || 'tool'; if (!by.has(name)) by.set(name, { name, calls: 0, tokens: 0 }); by.get(name).calls++; }
  for (const m of (Array.isArray(messages) ? messages : [])) for (const b of (Array.isArray(m?.content) ? m.content : [])) {
    if (b?.type !== 'tool_result' || !ids.has(b.tool_use_id)) continue;
    const e = by.get(nameOf.get(b.tool_use_id) || 'tool');
    if (e) e.tokens += Math.round(resultText(b).length * TOKENS_PER_CHAR);
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens);
}

export const CUT_MIN_CHARS = CUTTING_MIN_CHARS;
export const cutPlaceholder = cutting_placeholder;




// a session is on one side of the holdout for all its requests: switching sides mid-session would bring
// the cleared results back and write the cache again
export function heldOut(session, share) {
  if (!share || !session) return false;
  if (share >= 1) return true;
  const h = crypto.createHash('sha256').update(String(session)).digest().readUInt32BE(0);
  return h / 2 ** 32 < share;
}

// Claude Code can send a tool clearing of its own; this is the type to recognise it by, not to send.
const AGENT_CLEAR_TYPE = 'clear_tool_uses_20250919';
const betaOn = headers => String(headers['anthropic-beta'] || '').split(',').map(s => s.trim()).includes(EDIT_BETA);
const sessionOf = headers => headers['x-claude-code-session-id'] || null;
// A session is not a conversation, and the cut's record belongs to the conversation.
//
// Claude Code sends one `x-claude-code-session-id` for everything a session does: the person's own
// thread, each subagent's thread, and the small side calls it makes beside them (a title, a summary).
// Each of those is a conversation with a turn count of its own, so keyed on the session alone they
// shared one record and one reservation. Measured on this machine's proxy log, the 12 days to
// 2026-11-05: 13 of 968 sessions had two conversations interleaved within a turn, and the clobber is
// not subtle -- a side call's first and only turn writes `turn: 1`, and the next request of the
// person's thread, still inside turn 7, reads the boundary as new and may cut mid-turn at exactly the
// moment a cut is most expensive. Simulated the same day: the set moved on a mid-turn request.
//
// The conversation is named by its own first user message, which every later request of it resends
// unchanged -- its text alone, because Claude Code moves `cache_control` markers between calls and a
// hash over the blocks would change with them. Two conversations opened with the same words (two
// subagents given one prompt) still share a record; that is the residue, and it is the narrow case.
export function conversationKey(session, j) {
  if (!session) return null;                                 // no session, no reliable ratchet
  const first = (Array.isArray(j?.messages) ? j.messages : []).find(m => m?.role === 'user');
  const c = first?.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b?.text || '').join('\n') : '';
  if (!text) return session;
  return `${session}#${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

// What goes upstream. Anything unexpected forwards the agent's bytes as they came.
export function transformRequest(method, url, headers, body, cfg) {
  if (cfg.protocol === 'responses') return transformResponses(method, url, headers, body, cfg);
  if (method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(url) || !body.length) return { body, reason: 'other' };
  if (heldOut(sessionOf(headers), cfg.holdout)) return { body, reason: 'holdout' };
  let j;
  try { j = JSON.parse(body); } catch { return { body, reason: 'unparsed' }; }
  if (!j || !Array.isArray(j.messages)) return { body, reason: 'other' };
  const cm = j.context_management && typeof j.context_management === 'object' ? j.context_management : {};
  const edits = Array.isArray(cm.edits) ? cm.edits : [];
  // an agent clearing for itself is left alone: two mechanisms over one conversation is nobody's policy
  if (edits.some(e => e && e.type === AGENT_CLEAR_TYPE)) return { body, reason: 'agent-clears' };
  // Thinker cuts the context itself (cutting.js): one decision at a turn boundary, then the same set
  // applied byte for byte on every call of the turn. Nothing is asked of the API.
  // the record is the conversation's, not the session's (`conversationKey`), and the store is asked for it
  // here because this is the first point the body has been parsed
  const rec = cfg.cutRecord || cfg.readCut?.(conversationKey(sessionOf(headers), j)) || freshCut('');
  const m = measurePrompt(cfg, j);
  const cand = cutCandidates(j.messages, { keepMin: cfg.keepMin ?? 3, cut: rec.cut });
  const d = decideCut(rec, cfg, m, { cand, ttl: cfg.ttl, now: cfg.now, model: j.model });
  const applied = applyCut(j.messages, d.cut);
  if (!applied.cut) return { body, reason: d.candidate ? 'below-clear-minimum' : 'nothing-to-cut', model: j.model, turn: m.turn, cut: d.cut, ...(d.held ? { held: d.held } : {}) };
  j.messages = applied.messages;
  return { body: Buffer.from(JSON.stringify(j)), injected: true, model: j.model, keep: cfg.keepMin ?? 3,
    cut: d.cut, changed: !!d.clear, addBeta: false, actions: cutActions(applied.messages, d.cut),
    // `inputChars` and `thinking` stood here until 2026-11-05 and `applyCut` returned neither: they are the
    // API-side clearing's fields, and the cut touches neither the call text nor the thinking.
    clientCut: { cut: applied.cut, chars: applied.chars, tokens: applied.tokens, firstChanged: applied.firstChanged },
    ...(d.clear ? { clear: { tokens: d.tokens, recache: d.recache, cost: Math.round(d.cost), saving: Math.round(d.saving), ...(d.cold ? { cold: true } : {}) }, tokens: d.tokens, recache: d.recache, cost: d.cost, saving: d.saving, cold: d.cold } : {}),
    ...(d.held ? { held: { tokens: d.held.tokens, recache: d.held.recache, cost: Math.round(d.held.cost), saving: Math.round(d.held.saving), need: d.held.need, have: d.held.have } } : {}),
    ...(d.candidate != null ? { candidate: d.candidate } : {}),
    ...(d.turn != null ? { turn: d.turn } : {}) };
}
// the client's beta header with the edit's beta added
export const withBeta = value => [value, EDIT_BETA].filter(Boolean).join(',');

// Usage and applied edits, read from the response as it streams past (server-sent events) or from a
// plain JSON body; the bytes themselves are passed on untouched.
export function usageTap() {
  let tail = '';
  let whole = '';
  const seen = {};
  const take = ev => {
    const u = ev?.message?.usage || ev?.usage;
    if (u) for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) if (u[k] != null) seen[k] = u[k];
    // Which TTL the write was at, because it is most of what a clear costs and the two prices differ by a third:
    // a 1h write is ~2x an input token, a 5m write ~1.25x, against a cache read at ~2.5% of one. So the same clear
    // is worth 80 avoided reads at 1h and 50 at 5m, and the decision (clearing.js:price) cannot judge a clear without knowing which.
    if (u?.cache_creation) {
      if (u.cache_creation.ephemeral_1h_input_tokens != null) seen.write1h = u.cache_creation.ephemeral_1h_input_tokens;
      if (u.cache_creation.ephemeral_5m_input_tokens != null) seen.write5m = u.cache_creation.ephemeral_5m_input_tokens;
    }
    const cm = ev?.context_management || ev?.message?.context_management || ev?.delta?.context_management;
    // Whether the answer spoke about the edit at all, apart from what it cleared. A gateway that passes the field
    // on reports `applied_edits`, even empty; one that strips it on the way sends nothing back, and the request
    // then looks exactly like one whose trigger was never met. Recorded, not yet acted on: whether a conforming
    // API always echoes the key when it clears nothing is not verified, so no message is built on it.
    if (cm) seen.acknowledged = true;
    if (cm?.applied_edits) seen.applied = cm.applied_edits;
  };
  return {
    push(chunk) {
      const s = chunk.toString('utf8');
      if (whole.length < 65536) whole += s;
      tail += s;
      let i;
      while ((i = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, i).trim();
        tail = tail.slice(i + 1);
        if (line.startsWith('data:')) { try { take(JSON.parse(line.slice(5))); } catch { /* not an event */ } }
      }
    },
    result() {
      if (!Object.keys(seen).length) { try { take(JSON.parse(whole)); } catch { /* not JSON */ } }

      return {
        input: seen.input_tokens, read: seen.cache_read_input_tokens, write: seen.cache_creation_input_tokens, out: seen.output_tokens,
        write1h: seen.write1h, write5m: seen.write5m,
        // The API clears nothing now, so it reports nothing: what the cut took out is the cut's own figure,
        // put on the row by `clearedBy`.
        cleared: 0, clearedUses: 0,
      };
    },
  };
}

// What this request was shorter by, and how many results that was: the two fields every door that speaks
// about a saving reads off this row (`compression.js:noteCompression` writes the session's record from it,
// `clearedBySession` sums it, `cache-savings.js:clearBoundaries` finds the clears by the count rising).
//
// They used to come from the API, which reported what its own edit had cleared. Thinker cuts the context
// itself now and asks the API for nothing, so from 2026-11-04 there was nothing for the API to report and
// `usageTap` returned 0 -- while the field the cut fills instead (`clientCut`) is read by nobody outside
// this file. So every saving went unrecorded: on this machine the last session record was written
// 2026-11-04 04:01, the API's last cleared figure came at 12:01 the same day, and the `proxy-cut` rows
// after it account for 666,516 tokens taken out that reached no card, no `thinker proxy report` and no
// pull request. Only a request the cut actually shortened carries the fields, so a row that cleared
// nothing still says nothing (`noteCompression` would otherwise record a clear that never happened).
const clearedBy = t => (t?.clientCut?.tokens > 0 ? { cleared: Math.round(t.clientCut.tokens), clearedUses: t.clientCut.cut || 0 } : {});

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'];

// `notes`: a proxy-notes.js NoteInjector; the notes for an agent with no prompt hook go into the last user turn
export function startProxy(cfg, { logFile, host = '127.0.0.1', onListen, notes = null, onStandDown = null, agentOptions = {}, retryWaits = undefined, resolver = undefined, compressionDir = logFile ? path.join(path.dirname(logFile), 'compression') : null, clearingDir = logFile ? path.join(path.dirname(logFile), 'clearing') : null, dumpDir = process.env.THINKER_PROXY_DUMP || null } = {}) {
  // Research only (`THINKER_PROXY_DUMP=<dir>`): every model request as it went up, the edit included, beside what
  // the API answered about it, one file a call under the session. The server's clearing rule can only be read from
  // consecutive requests side by side (2026-11-02: its cleared count fell 23, 22, 20, 19 under a byte-identical edit,
  // each a rewrite from the system prompt, and the log alone cannot say what in the request moved it). Never on by
  // default: a request holds the whole conversation.
  const dump = (session, t, usage) => {
    if (!dumpDir || !session || !t?.body) return;
    try {
      const dir = path.join(dumpDir, String(session).replace(/[^\w.-]/g, '_'));
      fs.mkdirSync(dir, { recursive: true });
      let sent; try { sent = JSON.parse(t.body.toString('utf8')); } catch { sent = null; }
      fs.writeFileSync(path.join(dir, `${Date.now()}.json`), JSON.stringify({ at: new Date().toISOString(), injected: !!t.injected, asked: t.asked, keep: t.keep, turn: t.turn, usage, sent }));
    } catch { /* research output is never worth a failed request */ }
  };
  const agents = new Map();
  const log = row => {
    if (!logFile) return;
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(row) + '\n'); } catch { /* a log is never worth a failed request */ }
  };
  // A model server of the person's own (proxy-service.js:proxyThrough) need not speak the API's
  // context-management beta. If it refuses the request the edit rides on, nothing of the answer has reached the
  // agent yet, so the same request goes again untouched -- the retry path that is already there for a dropped
  // connection -- and the proxy stops adding the edit for the rest of its life rather than breaking every call.
  // Only for an upstream that is not Anthropic's: a 400 from the API itself is the agent's own to see.
  // What the server cleared, per session, for what the agent is told a few turns later (compression.js). Kept
  // beside the log rather than worked out from it: the log is a megabyte within a week, and nothing that runs on
  // a turn may read it. The actions are the request's own, which only this side of the exchange knows.
  const logProxy = (row, actions) => {
    log(row);
    try { noteCompression(compressionDir, row, { actions }); } catch { /* a card is never worth a failed request */ }
  };
  let cutRejected = false;
  // Where each upstream host last answered, so a resolver that goes quiet is not the end of a request
  // (proxy-retry.js). Filled from the lookups the requests make anyway; read only once one has failed.
  const addresses = addressBook();
  const lookup = cachingLookup(addresses, {
    ...(resolver ? { lookup: resolver } : {}),
    onFallback: (host, known) => log({ at: new Date().toISOString(), op: 'proxy-dns-fallback', host, family: known.family || null }),
  });
  // the cut's record, one per session, on disk: a restarted proxy re-applies the same set (cutting.js)
  const cutting = cutStore(clearingDir);
  const responseCutting = cutStore(clearingDir ? path.join(clearingDir, 'responses') : null);
  const watch = authWatch(reason => { log({ at: new Date().toISOString(), op: 'proxy-standdown', reason }); try { onStandDown(reason); } catch { /* the request in hand matters more */ } }, { on: !!onStandDown });
  const server = http.createServer((req, res) => {
    let requestUrl = req.url, requestCfg = cfg;
    if (cfg.codex && (requestUrl.startsWith(`${CODEX_PROXY_PATH}/`) || requestUrl === CODEX_PROXY_PATH)) {
      requestUrl = requestUrl.slice(CODEX_PROXY_PATH.length) || '/';
      // Codex adds this header when using ChatGPT auth. API-key requests have none.
      // Destinations are fixed OpenAI endpoints, never supplied by an incoming request.
      const upstreams = cfg.codexUpstreams || CODEX_UPSTREAMS;
      requestCfg = { ...cfg, protocol: 'responses', keep: 'turn', upstream: req.headers['chatgpt-account-id'] ? upstreams.chatgpt : upstreams.api };
    }
    const up = new URL(requestCfg.upstream);
    const lib = up.protocol === 'http:' ? http : https;
    // A gateway URL is the destination; HTTP(S)_PROXY/ALL_PROXY is how this machine reaches it.
    // Direct http.Agent connections bypassed corporate proxies (including their DNS), failing
    // even while the agent's own connection worked. NO_PROXY remains the person's decision.
    const getAgent = fresh => {
      const key = `${up.origin}:${fresh}`;
      if (!agents.has(key)) agents.set(key, new ProxyAgent({ ...agentOptions, keepAlive: !fresh, maxSockets: 256 }));
      return agents.get(key);
    };
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const t0 = process.hrtime.bigint();
      let t;
      const noEdit = cutRejected;
      // The record is read inside the transform, which is where the conversation can be told from the
      // session it shares with the others (`conversationKey`). Both protocols hand the key back the same way.
      let cutRec = null;
      try { t = noEdit ? { body: raw, reason: 'cut-rejected' } : transformRequest(req.method, requestUrl, req.headers, raw, { ...requestCfg, readCut: key => (cutRec = key ? cutting.read(key) : null), readResponsesCut: session => (cutRec = responseCutting.read(session)) }); } catch { t = { body: raw, reason: 'error' }; }
      // Reserve the boundary's decision before forwarding, including a decision not to cut.
      // Retries and concurrent requests in this turn must reuse the same set, even when a
      // later tool result would make a previously refused candidate profitable.
      if (cutRec && Array.isArray(t.cut) && t.turn != null) {
        cutRec.cut = t.cut; cutRec.turn = t.turn;
        (t.protocol === 'responses' ? responseCutting : cutting).write(cutRec);
      }
      let n = null;
      if (notes && requestCfg.protocol !== 'responses') { try { n = await notes.transform(req.method, req.url, req.headers, t.body); } catch { n = null; } if (n) { t.body = n.body; t.notes = n; if (t.reason === 'other') t.reason = 'notes'; } }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k)) headers[k] = v;
      headers.host = up.host;
      if (t.addBeta) headers['anthropic-beta'] = withBeta(req.headers['anthropic-beta']);
      headers['content-length'] = t.body.length;   // set again in `send`: a retry without the edit sends fewer bytes
      const overheadMs = Number(process.hrtime.bigint() - t0) / 1e6;
      // the two signs of an agent routed elsewhere (`authWatch`), on the model calls alone: an agent sends more
      // than those through the proxy, and a 200 on one of the others used to reset the refusal count, so three
      // refusals in a row never arrived and the count never fired (seen in the container on 2026-10-28, three
      // sessions and three 401s with no stand-down).
      const judgeAuth = requestCfg.protocol === 'anthropic' && forwardsToAnthropic(requestCfg.upstream) && MESSAGES_PATH.test(requestUrl);
      if (judgeAuth) watch.request(req.headers);
      const base = up.pathname.replace(/\/$/, '');
      let ureq;
      // A request that never reached the API (RETRY_CODES: a dropped connection -- a reset or a broken
      // pipe, twice in one 84-request Opus session on 2026-10-20 -- a connect timeout, or a name that
      // did not resolve) is tried once more on a fresh connection. The agent's own retry of the 502
      // cost it 10 to 40 seconds each time. Nothing has reached the agent yet, so the second try is
      // invisible to it; a drop after the answer started cannot be retried, and a request the agent
      // has already walked away from is not retried at all.
      const send = attempt => {
        const started = Date.now();
        headers['content-length'] = t.body.length;
        if (t.addBeta) headers['anthropic-beta'] = withBeta(req.headers['anthropic-beta']);
        else if (req.headers['anthropic-beta'] != null) headers['anthropic-beta'] = req.headers['anthropic-beta'];
        // One error row per request: a break the agent and the API both notice (the agent leaves, so
        // the proxy drops the upstream request, so that request errors too) is one event, not two.
        // A cancellation gets an op of its own (2026-11-05): 174 of this machine's 830 error rows are
        // the person pressing Esc, and while `aborted` has flagged them since October every reader
        // had to know to look for it -- `thinker proxy report --verify-usage` did not, and called the
        // accounting incomplete because somebody had changed their mind. The flag stays beside the
        // new op, because a log written before this is still read for a fortnight.
        let logged = false, recorded = false, truncated = false;
        const logError = (e, extra) => {
          if (logged) return;
          logged = true;
          log({ at: new Date().toISOString(), op: extra?.aborted ? 'proxy-cancelled' : 'proxy-error', error: e.message, code: e.code, reused: !!ureq.reusedSocket, afterMs: Date.now() - started, ...extra });
        };
        ureq = lib.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, path: base + requestUrl, method: req.method, headers, agent: getAgent(!!attempt), lookup }, ures => {
          if (judgeAuth) watch.response(ures.statusCode);
          // A 400 on a request the proxy cut may be the cut itself being rejected -- a history the API will not
          // take -- or it may be about the request, which is the agent's own to see. The body says which
          // (`refusesEdit`), so it is read before anything reaches the agent: a rejection means the same request
          // goes again as the agent wrote it and nothing is cut for the rest of the proxy's life. This matters
          // more than it did when the API did the clearing: the edit is the proxy's own now, so a history the API
          // will not accept is the proxy's fault and the only safe answer is to stop editing. An in-place edit of
          // the history did exactly that in October. Anything else is passed on once, as it came: a real router
          // (LiteLLM 1.106.5, 2026-10-28) answered 400 over a model name it did not know, and taking that for a
          // rejection stopped the clearing over an unrelated error and sent every failing request twice.
          if (t.injected && !cutRejected && ures.statusCode === 400 && !res.headersSent) {
            const parts = [];
            let read = 0;
            let ended = false;
            const decide = () => {
              const body = Buffer.concat(parts);
              // not about the edit: the agent's own to see. The bytes are in hand and the stream may already be
              // over, so `deliver` is told to finish the response itself rather than wait for an 'end' that has been
              if (!refusesEdit(body)) return deliver(Buffer.from(body), ended);
              cutRejected = true;
              ures.resume();
              log({ at: new Date().toISOString(), op: 'proxy-cut-rejected', upstream: up.origin, status: 400, says: String(body).slice(0, 200) });
              t = { ...t, body: raw, injected: false, addBeta: false, reason: 'cut-rejected' };
              send(attempt);
            };
            ures.on('data', c => {
              if (read >= REFUSAL_BODY) return;
              parts.push(c); read += c.length;
              if (read >= REFUSAL_BODY) decide();
            });
            ures.once('end', () => { ended = true; if (read < REFUSAL_BODY) decide(); });
            ures.once('error', () => { ended = true; if (read < REFUSAL_BODY) decide(); });
            return;
          }
          deliver();
          function deliver(prefix, done = false) {
          const out = {};
          for (const [k, v] of Object.entries(ures.headers)) if (!['connection', 'keep-alive', 'transfer-encoding'].includes(k)) out[k] = v;
          res.writeHead(ures.statusCode, out);
          const tap = t.reason === 'other' ? null : t.protocol === 'responses' ? responsesUsageTap() : usageTap();
          if (prefix?.length) { res.write(prefix); tap?.push(prefix); }
          ures.removeAllListeners('data');
          ures.on('data', c => { res.write(c); tap?.push(c); });
          if (ures.isPaused?.()) ures.resume();
          const record = () => {
            if (recorded) return;
            recorded = true;
            res.removeListener('close', record);
            const usage = tap ? tap.result() : null;
            if (tap) logProxy({ at: new Date().toISOString(), op: 'proxy', session: t.session || sessionOf(req.headers), model: t.model, status: ures.statusCode,
              ...(t.protocol === 'responses' ? { protocol: 'responses', removedBytes: t.removedBytes || 0, estimatedRemovedTokens: t.estimatedRemovedTokens || 0, clearedUses: t.clearedUses || 0 } : {}),
              injected: !!t.injected, ...(t.clientCut ? { clientCut: t.clientCut } : {}), ...(t.clear ? { clear: t.clear } : {}), ...(t.held ? { held: t.held } : {}), ...(t.candidate != null ? { candidate: t.candidate } : {}), ...(t.turn != null ? { turn: t.turn } : {}), ...(t.injected ? { keep: t.keep, ...(t.inputs ? { inputs: true } : {}) } : { reason: t.reason }), ...(t.addBeta ? { betaAdded: true } : {}), ...(t.notes ? { notes: t.notes.served.length, notesReplayed: t.notes.replayed, ...(t.notes.reason ? { notesReason: t.notes.reason } : {}) } : {}), overheadMs: Math.round(overheadMs * 1000) / 1000, ...(attempt ? { retried: true } : {}), ...(truncated ? { truncated: true } : {}), ...usage, ...clearedBy(t) }, t.actions);
            dump(t.session || sessionOf(req.headers), t, usage);
            // the record after the answer (cutting.js:cutResponse): what the cut saved, what the rewrite cost;
            // each event is a log line, and the record goes back to disk
            if (tap && cutRec && Array.isArray(t.cut) && ures.statusCode >= 200 && ures.statusCode < 300) {
              // through the store's read-modify-write, so the counters land on the record as it is now: another
              // request of this conversation may have reserved the next boundary while this answer streamed
              const store = t.protocol === 'responses' ? responseCutting : cutting;
              for (const ev of store.update(cutRec.session, rec => cutResponse(rec, requestCfg, t, usage))) log({ at: new Date().toISOString(), op: 'proxy-cut', session: t.session || sessionOf(req.headers), model: t.model, ...ev, read: usage.read, write: usage.write });
            }
          };
          // Codex closes SSE as soon as response.completed arrives, before the HTTP
          // body ends. Record that request too, exactly once, using usage seen so far.
          res.once('close', record);
          ures.on('end', () => {
            record();
            res.end();
          });
          if (done) { record(); res.end(); }   // the body was read to decide on it: there is no 'end' still to come
          // The answer stopped partway. The agent is left with a broken stream and the row recorded
          // for this request holds only the tokens that arrived, so both say so; before this the
          // request passed for a complete 200 and the drop was in no count at all. Once that row is
          // written there is nothing to report: the agent closed the stream itself, as Codex does on
          // response.completed, and the answer it has is the whole one.
          ures.on('error', e => {
            if (!recorded) { truncated = true; logError(e, { retried: false, truncated: true }); }
            res.destroy();
          });
          }
        });
        ureq.on('error', e => {
          // Already accounted for: the answer arrived and its usage row is written.
          if (recorded) return;
          // The agent itself went away -- the person pressed Esc, or its client gave up -- so the
          // proxy destroyed this request and Node reports the reset here. That is a cancellation,
          // and counting it as an error made 34 of the 36 resets the machines reported in October
          // 2026 (20 of 20 on one Codex machine) look like failures of the API, which hid the 53
          // that were real. Nobody is waiting for an answer, so there is nothing to retry or send.
          const cancelled = res.destroyed && !res.writableFinished;
          // A resolver that will not answer gets the ladder rather than one 250 ms rung, which
          // recovered 1 of 110 requests (proxy-retry.js). Nothing of the answer has reached the
          // agent, so none of this is visible to it; the wait is abandoned if it leaves.
          const plan = !cancelled && !res.headersSent
            ? retryPlan(e, attempt, { address: addresses.has(up.hostname), ...(retryWaits ? { waits: retryWaits } : {}) })
            : { retry: false };
          logError(e, { retried: !!plan.retry, attempt, ...(cancelled ? { aborted: true } : {}) });
          if (plan.retry) {
            if (!plan.waitMs) return send(attempt + 1);
            return void setTimeout(() => { if (res.destroyed) return; send(attempt + 1); }, plan.waitMs);
          }
          if (res.destroyed) return;
          if (res.headersSent) return res.destroy();
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `thinker proxy: the API could not be reached (${e.message})` } }));
        });
        ureq.end(t.body);
      };
      send(0);
      res.on('close', () => { if (!res.writableFinished) ureq.destroy(); });
    });
  });
  // This proxy processes full HTTP requests. A WebSocket upgrade must fail promptly,
  // not hang or quietly bypass the policy. Codex providers can select SSE instead.
  server.on('upgrade', (req, socket) => {
    socket.on('error', () => socket.destroy());
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nthinker proxy uses HTTP/SSE; set supports_websockets = false in the Codex provider.\n');
  });
  server.on('close', () => { for (const agent of agents.values()) { agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy(); } });
  server.listen(cfg.port || 0, host, () => onListen?.(server.address()));
  return server;
}

// What the log says: per side of the holdout, the requests, their billed-equivalent input (a cache read at
// 0.1, a write at 2: Claude Code's writes are one-hour ones) and what the server cleared.
export function proxyReport(rows, { since } = {}) {
  const sides = {};
  for (const r of rows) {
    if (r.protocol === 'responses') continue;
    if (r.op !== 'proxy' || (since && r.at < since)) continue;
    const side = r.injected ? 'clearing' : r.reason === 'holdout' ? 'holdout' : null;
    if (!side) continue;
    const s = sides[side] ||= { requests: 0, sessions: new Set(), input: 0, read: 0, write: 0, out: 0, cleared: 0, clears: 0, truncated: 0, overheadMs: [], long: { before: [0, 0], after: [0, 0] }, seenClear: new Set() };
    s.requests++; if (r.session) s.sessions.add(r.session); if (r.truncated) s.truncated++;
    // the cache after a clear: of the calls over LONG_CONTEXT, how many wrote their prefix rather than read it, before
    // the session's first clear and after it (a held-out session has no clear, so all of its calls are `before`)
    const cleared = clearedOf(r);
    if (cleared) s.seenClear.add(r.session);
    if ((r.input || 0) + (r.read || 0) + (r.write || 0) >= LONG_CONTEXT) { const b = s.long[s.seenClear.has(r.session) ? 'after' : 'before']; b[0]++; if (isRewrite(r)) b[1]++; }
    s.input += r.input || 0; s.read += r.read || 0; s.write += r.write || 0; s.out += r.out || 0;
    s.cleared += cleared; if (cleared) s.clears++;
    s.overheadMs.push(r.overheadMs || 0);
  }
  const outSides = {};
  for (const [k, s] of Object.entries(sides)) {
    const ms = s.overheadMs.sort((a, b) => a - b);
    outSides[k] = { requests: s.requests, sessions: s.sessions.size, input: s.input, read: s.read, write: s.write, out: s.out,
      billedInput: Math.round(s.input + 0.1 * s.read + 2 * s.write), cleared: s.cleared, requestsCleared: s.clears,
      // These sums are the tokens that arrived. An answer that stopped partway is counted as a request
      // and contributes what it got through, so the two sides are read beside this.
      requestsTruncated: s.truncated,
      rewrites: { before: { calls: s.long.before[0], rewrites: s.long.before[1] }, after: { calls: s.long.after[0], rewrites: s.long.after[1] } },
      overheadP50: ms[Math.floor(ms.length / 2)] ?? 0, overheadP99: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.99))] ?? 0 };
  }
  const responses = responsesReport(rows, { since });
  // a cut rejected by the API is the one way the editing stops now (proxy.js:cutRejected)
  const rejected = new Set(rows.filter(r => r.op === 'proxy-cut-rejected' && (!since || r.at >= since)).map(r => r.session));
  if (outSides.clearing) outSides.clearing.sessionsRejected = rejected.size;
  const warning = rewriteWarning(outSides);
  return { ...outSides, ...(warning ? { warning } : {}), ...(Object.keys(responses).length ? { responses } : {}) };
}
// a call this long is one where a rewrite is a cost worth noticing and a clear can have happened
// LONG_CONTEXT is cutting.js's, re-exported above: it was declared here too, at the same 100000.
// how far back `thinker proxy status` reads the rewrite rates: a verdict on the policy running now, not on the month
// behind it (a fault fixed on 2026-11-02 would otherwise have kept the warning up for a month)
export const REWRITE_DAYS = 7;
// The clearing is breaking the cache when the calls after a clear rewrite their prefix far more often than long
// calls do without one: the held-out sessions where there are enough of them, the same sessions before their
// first clear otherwise. Held-out long sessions ran at 1.4% and clearing sessions after a clear at 23.6% when the
// keep grew (2026-11-02); a clear itself is one rewrite per new turn, so a few percent is the policy working.
export function rewriteWarning(sides, { minCalls = 50, minBaseCalls = 20, floor = 0.08, ratio = 3 } = {}) {
  const c = sides.clearing?.rewrites; if (!c || c.after.calls < minCalls) return null;
  const after = c.after.rewrites / c.after.calls;
  const bases = [sides.holdout?.rewrites?.before, c.before].filter(b => b && b.calls >= minBaseCalls);
  const base = bases.length ? bases[0].rewrites / bases[0].calls : null;
  if (after < floor || (base != null && after < ratio * base)) return null;
  return `the calls after a clear write their prefix into the cache again on ${Math.round(after * 100)}% of ${c.after.calls} calls over ${LONG_CONTEXT / 1000}k of context` +
    (base != null ? ` against ${Math.round(base * 100)}% without a clear` : '') + ': the clearing is breaking the cache instead of saving on it. Check that the cut set holds from one call to the next (cutting.js:decideCut); thinker proxy off until it is understood.';
}
