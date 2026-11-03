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
import { decide, response as clearingResponse, store as clearingStore, isRewrite } from './clearing.js';
export { isRewrite };

export const EDIT_TYPE = 'clear_tool_uses_20250919';
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
export const PROXY_DEFAULTS = { upstream: 'https://api.anthropic.com', trigger: 140000, keep: 'turn', keepMin: 3, keepTurns: 2, clearAtLeast: 100000, holdout: 0, clearInputs: true, clearThinking: false, clearDeep: true };
// The clearing policy -- clear, freeze what was cleared, and clear again when it pays -- is clearing.js. What this
// file does for it is measure the request (`measureClearing`) and send the edit it decides (`transformRequest`,
// `cfg.record`). `clearDeep: false` (`--no-clear-deep`, `proxy: { clearDeep: false }`) keeps every ask at the floor.
// What a clear takes before the turn, as the API counts what it cleared: the results, and with `clearInputs` the
// text of their calls too (an ask that counted the results alone stopped the API half way, since the inputs it cleared
// with them counted toward the ask: 296k of inputs beside 345k of results in one session here).
// Less the newest `keep` tool uses before the turn, which the server never clears: counted in, they put the ask past
// what the server can meet, and an ask it cannot meet is an edit it does not apply at all. On 2026-11-02 (smoke5,
// mlflow PR26265) the policy asked 182k at a turn boundary with 120k cleared and 89k in the three kept results, the
// server cleared nothing on that call and the whole conversation came back uncleared: 171k read and 73k written for
// nothing, then the floor ask again the next call (`proxy-clear-unmet`).
export function clearableBeforeTurn(cfg, messages, keep = keepValue(cfg, messages)) {
  const textLen = c => typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, b) => a + (typeof b?.text === 'string' ? b.text.length : 0), 0) : 0;
  const results = [], inputs = [];
  for (const m of messages.slice(0, turnStart(messages))) {
    if (!Array.isArray(m?.content)) continue;
    if (m.role === 'user') for (const b of m.content) if (b?.type === 'tool_result') results.push(textLen(b.content));
    if (m.role === 'assistant') for (const b of m.content) if (b?.type === 'tool_use') inputs.push(JSON.stringify(b.input ?? {}).length);
  }
  const sum = a => a.slice(0, Math.max(0, a.length - keep)).reduce((x, y) => x + y, 0);
  return Math.round((sum(results) + (cfg.clearInputs ? sum(inputs) : 0)) * TOKENS_PER_CHAR);
}
// The request as the decision needs it: the prompt before the current turn in tokens, the cached prefix a deeper ask
// keeps (`prefix`: the system prompt and the tool definitions alone, so the write a deepening costs is everything
// after them less what it drops. Claude Code sets its cache breakpoints on the system prompt and the newest messages,
// and the API finds a cached prefix only at a breakpoint or within twenty blocks before one, so a prefix ending at
// the first result a deeper ask drops, mid-conversation, is never found: measured 2026-11-02 (mlflow PR26265, smoke6),
// two deeper asks read 12,707 tokens each, the system prompt, and wrote 60k, the whole post-clear context, where the
// tail from the drop point was priced at 44-51k), what the results and call text before the turn weigh by the proxy's count (`before`; what is clearable is that less what the server already cleared, clearing.js), and the turn's id. All of it from
// what sits before the turn: within a turn the request grows with every call, and a verdict that moved from one
// call of a turn to the next would move the edit with it, which is the rewrite this exists to avoid.
export function measureClearing(cfg, j, clearedUses = 0) {
  const txt = v => { try { return v == null ? 0 : JSON.stringify(v).length; } catch { return 0; } };
  const tok = chars => Math.floor(chars * TOKENS_PER_CHAR);
  const all = Array.isArray(j?.messages) ? j.messages : [];
  const messages = all.slice(0, turnStart(all));
  const head = txt(j?.system) + txt(j?.tools);
  const prompt = tok(head + txt(messages));
  const keep = keepForTurn(cfg, all);
  return { prompt, prefix: Math.min(prompt, tok(head)), before: clearableBeforeTurn(cfg, all, keep), turn: turnId(all), keep };
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
// Codes worth one more try when nothing of the answer has reached the agent: a dropped connection
// (a reused keep-alive socket the API had already closed), a connect timeout, and a name that did
// not resolve, which on a laptop means the resolver is not back yet after a sleep or a network
// change. In October 2026 these were 53 of the 91 errors the machines reported and none was retried,
// so each one cost the agent a 502 and a retry of its own.
export const RETRY_CODES = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
// A name that did not resolve is retried after a moment: an immediate second lookup asks a resolver
// that is still on its way up and fails the same way.
export const RETRY_DELAY = { ENOTFOUND: 250, EAI_AGAIN: 250 };
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
// Two more things a clear can take with it, both on by default since 2026-10-28 (the owner's call: this is the
// configuration this machine has run since 2026-10-25, and it is what makes clearing pay at all. The replay priced at
// list over 45 days of this machine's sessions, research/cost-levers-2026-10-25.md and `thinker proxy replay`: the
// shipped clear of results alone is break-even in dollars, -0.2%, since every clear writes the whole conversation again
// at twice the input rate and a Fable read costs 2.5% of an input token, while the three together save 7.8% overall and
// 10.8% on the sessions of 120 calls and more that are 71% of the bill, 2 of 73 of them costlier. An Artemis experiment
// cannot judge this: its tasks are one turn, and a clear needs a conversation. What the replay cannot see is the model
// reading again what was cleared, so those figures are an upper bound; the live holdout is the check):
// `clearInputs` (off again with `--no-clear-inputs`, THINKER_PROXY_CLEAR_INPUTS=off, `proxy: { clearInputs: false }`): the edit's
// `clear_tool_inputs`, so the text of the agent's own calls (its edits and commands) goes with their results; 2.3% of the
// bill in the replay, 5.8% on sessions of 120 calls and more, riding the same clear. `clearThinking` (`--clear-thinking`,
// THINKER_PROXY_CLEAR_THINKING=off, `proxy: { clearThinking: false }`): a `clear_thinking` edit that drops the thinking of
// the turns before the current one, sent only on a request where the results before the current turn are, by the
// proxy's own count, already enough for the tool clear to fire (thinkingEdit), so the two clears break the cache at the
// same point and never on their own: 5.0% of the bill in the replay, 10.1% on the long sessions; thinking cleared on its
// own schedule was negative, and a sliding keep (every call) cost 190%. This edit replaces the one the agent sent
// (Claude Code's `keep: all`), the one place the proxy changes an edit of the agent's rather than appending.
// Off by default since 2026-11-02: its keep is the count of the turn's assistant messages, which grows by one a call
// like the tool keep did, and on this machine's log the calls that carried it rewrote the prefix 45% of the time where
// the tool clear's set had not moved, against 6% without it. The docs say `thinking_turns` counts assistant turns with
// thinking; whether that is one per message or one per exchange decides which constant is stable, and only a live
// run can tell. `--clear-thinking` turns it back on. The desktop mod's thinking clear is one rewrite at a compaction
// boundary (claude-clear), not this edit, and stays on.
export const THINKING_EDIT_TYPE = 'clear_thinking_20251015';
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
  cfg.clearInputs = onOff('clear-inputs', 'THINKER_PROXY_CLEAR_INPUTS', PROXY_DEFAULTS.clearInputs);
  cfg.clearThinking = onOff('clear-thinking', 'THINKER_PROXY_CLEAR_THINKING', PROXY_DEFAULTS.clearThinking);
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
    if (cfg.keep !== 'turn') throw new Error('--protocol responses requires --keep turn; the current turn is always preserved');
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
// The tool uses of the last `turns` settled turns -- everything the model has fetched recently, which a clear
// must not take. Only settled turns are counted: the turn in progress grows a use at a time, and a keep that
// grows within a turn is what rewrote the cache on every call in #585/#588. Counting the last two turns rather
// than one gives the turn in progress headroom of about its own size before its oldest results fall out of the
// keep, and protects the turn before it outright, which is what a model still working on a task reaches back for.
export function recentTurnUses(messages, turns = 2) {
  const starts = [];
  (Array.isArray(messages) ? messages : []).forEach((m, i) => {
    if (m?.role !== 'user') return;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text' }];
    if (blocks.some(b => b?.type === 'text') && !blocks.some(b => b?.type === 'tool_result')) starts.push(i);
  });
  if (starts.length < 2) return 0;
  // from the start of the oldest turn we still protect, up to the turn in progress
  const from = starts[Math.max(0, starts.length - 1 - Math.max(1, turns))];
  let n = 0;
  for (const m of messages.slice(from, starts[starts.length - 1])) {
    if (m?.role === 'assistant' && Array.isArray(m.content)) n += m.content.filter(b => b?.type === 'tool_use').length;
  }
  return n;
}
// the keep a boundary decides: never fewer than the floor, never fewer than a turn of this session's shape
export const keepForTurn = (cfg, messages) => cfg.keep === 'turn'
  ? Math.max(cfg.keepMin ?? 0, recentTurnUses(messages, cfg.keepTurns ?? 2))
  : cfg.keep;
export function turnToolUses(messages) {
  let n = 0;
  for (const m of messages.slice(turnStart(messages))) if (m?.role === 'assistant' && Array.isArray(m.content)) n += m.content.filter(b => b?.type === 'tool_use').length;
  return n;
}
export const keepValue = (cfg, messages) => cfg.keep === 'turn' ? (cfg.keepMin ?? 0) : cfg.keep;

export function clearEdit(cfg, messages, plan = { keep: keepValue(cfg, messages), ask: cfg.clearAtLeast }) {
  return {
    type: EDIT_TYPE,
    trigger: { type: 'input_tokens', value: cfg.trigger },
    keep: { type: 'tool_uses', value: plan.keep },
    clear_at_least: { type: 'input_tokens', value: plan.ask },
    ...(cfg.clearInputs ? { clear_tool_inputs: true } : {}),
  };
}
// the proxy's count of what the tool results before the current turn weigh (the text of every tool_result block, at
// TOKENS_PER_CHAR; an image counts nothing here, which errs on the safe side), what a `keep: turn` clear would take
export function resultsBeforeTurn(messages) {
  const textLen = c => typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, b) => a + (typeof b?.text === 'string' ? b.text.length : 0), 0) : 0;
  let chars = 0;
  for (const m of messages.slice(0, turnStart(messages))) if (m?.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_result') chars += textLen(b.content);
  return Math.round(chars * TOKENS_PER_CHAR);
}
// how many tool calls sit before the turn: what the frozen keep is reckoned from
export function toolUsesBeforeTurn(messages) {
  let n = 0;
  for (const m of messages.slice(0, turnStart(messages))) if (m?.role === 'assistant' && Array.isArray(m.content)) n += m.content.filter(b => b?.type === 'tool_use').length;
  return n;
}
// the same for the text of the tool calls before the turn (their `input`, as JSON), what clear_tool_inputs takes with them
export function inputsBeforeTurn(messages) {
  let chars = 0;
  for (const m of messages.slice(0, turnStart(messages))) if (m?.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b?.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length;
  return Math.round(chars * TOKENS_PER_CHAR);
}
// Which of the agent's own actions a clear takes, named from the request the proxy is already scanning. The API
// reports how much it cleared and how many tool uses, never which: the names are the proxy's own reckoning of the
// same window the edit describes -- every tool use but the newest `keep`, with the size of its result at
// TOKENS_PER_CHAR. So the agent can be told what the saving was made of, which is the question the figure raises.
// Aggregated by tool name, biggest first, and the breakdown describes the set cleared out of *this* prompt: it is
// never added up across requests, since each request clears the same cumulative set again.
// What the clearing cost that the gauge could not see: material that came back.
//
// The gauge (clearing.js:response) weighs the clears against the cache rewrites after them, and that is the
// whole of the cost it knows. Measured 2026-11-03 (research/clearing-bench, B4): a session cost 81% more than
// its held-out pair, every penny of it in 75% more model calls, because the model re-read the files whose
// results had been cleared -- and the gauge never stopped it, because no term in it counts a call. B6, at the
// shipped trigger, was worse: the model stopped re-reading and answered "I couldn't give the line count (its
// Read result was cleared from my context)" instead, so the damage left the token figures altogether.
//
// A re-read is visible in the request, though: it is a tool use whose name and input repeat one whose result
// the server has already cleared. `fingerprints` of the cleared uses go in the session record, and a use in
// the newest turn that matches one is material the clear did not save -- it is back, as fresh input, at ten to
// forty times what clearing it saves on a call. One rule, and it is the cost the two runs above were made of.
export function toolPrint(name, input) {
  const text = `${name}\u0000${(() => { try { return JSON.stringify(input ?? {}); } catch { return ''; } })()}`;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = (h1 ^ text.charCodeAt(i)) * 0x01000193 >>> 0;
    h2 = (h2 + text.charCodeAt(i) * 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
// The cleared uses' prints, and any use of the newest turn that repeats one the record has already seen
// cleared. `seen` is the record's list; the result's `prints` replaces it, capped, newest kept.
export const REREAD_PRINTS = 400;
export function rereadOfCleared(messages, keep, seen = []) {
  const empty = { prints: Array.isArray(seen) ? seen : [], reread: null };
  if (!Array.isArray(messages)) return empty;
  const textLen = c => typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, b) => a + (typeof b?.text === 'string' ? b.text.length : 0), 0) : 0;
  const uses = [], sizes = new Map();
  const start = turnStart(messages);
  messages.forEach((m, i) => {
    if (!Array.isArray(m?.content)) return;
    for (const b of m.content) {
      if (m.role === 'assistant' && b?.type === 'tool_use') uses.push({ id: b.id, name: String(b.name || 'tool'), print: toolPrint(b.name, b.input), fresh: i >= start });
      if (m.role === 'user' && b?.type === 'tool_result') sizes.set(b.tool_use_id, (sizes.get(b.tool_use_id) || 0) + textLen(b.content));
    }
  });
  const was = new Set(Array.isArray(seen) ? seen : []);
  // a use of the turn in progress whose print the record saw cleared: the material is back
  const by = new Map();
  for (const u of uses) {
    if (!u.fresh || !was.has(u.print)) continue;
    const e = by.get(u.name) || { name: u.name, calls: 0, tokens: 0 };
    e.calls++; e.tokens += Math.round((sizes.get(u.id) || 0) * TOKENS_PER_CHAR);
    by.set(u.name, e);
  }
  const cleared = uses.slice(0, Math.max(0, uses.length - Math.max(0, keep | 0)));
  const prints = [...was];
  for (const u of cleared) if (!was.has(u.print)) prints.push(u.print);
  const tools = [...by.values()].sort((a, b) => b.tokens - a.tokens);
  return {
    prints: prints.slice(-REREAD_PRINTS),
    reread: tools.length ? { calls: tools.reduce((a, b) => a + b.calls, 0), tokens: tools.reduce((a, b) => a + b.tokens, 0), tools } : null,
  };
}
export function clearedActions(messages, keep) {
  if (!Array.isArray(messages)) return [];
  const textLen = c => typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((a, b) => a + (typeof b?.text === 'string' ? b.text.length : 0), 0) : 0;
  const uses = [], sizes = new Map();
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (m.role === 'assistant' && b?.type === 'tool_use') uses.push({ id: b.id, name: String(b.name || 'tool') });
      if (m.role === 'user' && b?.type === 'tool_result') sizes.set(b.tool_use_id, (sizes.get(b.tool_use_id) || 0) + textLen(b.content));
    }
  }
  const cleared = uses.slice(0, Math.max(0, uses.length - Math.max(0, keep | 0)));
  const by = new Map();
  for (const u of cleared) {
    const e = by.get(u.name) || { name: u.name, calls: 0, tokens: 0 };
    e.calls++; e.tokens += Math.round((sizes.get(u.id) || 0) * TOKENS_PER_CHAR);
    by.set(u.name, e);
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
}

// The thinking edit, on a request where the tool clear will fire by the proxy's count (the results before the current
// turn weigh clearAtLeast with the margin; keep turn alone, since a count keeps results of earlier turns and the two
// clears would part): the thinking of the turns before this one goes, that of the current turn stays (`thinking_turns`,
// the assistant messages since the person's request, at least one, as the API requires). Deterministic in the
// conversation, so once the thinking before a turn is cleared every later request clears it too and the cache holds;
// at each new turn the cleared set grows by one turn, the moment the tool clear grows by the same turn's results.
export function thinkingEdit(cfg, messages) {
  if (!cfg.clearThinking || cfg.keep !== 'turn' || !Array.isArray(messages)) return null;
  if (resultsBeforeTurn(messages) < cfg.clearAtLeast * THINKING_MARGIN) return null;
  const turns = messages.slice(turnStart(messages)).filter(m => m?.role === 'assistant').length;
  return { type: THINKING_EDIT_TYPE, keep: { type: 'thinking_turns', value: Math.max(1, turns) } };
}

// a session is on one side of the holdout for all its requests: switching sides mid-session would bring
// the cleared results back and write the cache again
export function heldOut(session, share) {
  if (!share || !session) return false;
  if (share >= 1) return true;
  const h = crypto.createHash('sha256').update(String(session)).digest().readUInt32BE(0);
  return h / 2 ** 32 < share;
}

const betaOn = headers => String(headers['anthropic-beta'] || '').split(',').map(s => s.trim()).includes(EDIT_BETA);
const sessionOf = headers => headers['x-claude-code-session-id'] || null;

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
  if (edits.some(e => e && e.type === EDIT_TYPE)) return { body, reason: 'agent-clears' };
  // the API applies edits in order; the thinking edit Claude Code sends stays first, unless the proxy's own thinking edit
  // takes its place (thinkingEdit, `--clear-thinking`): then that one is first and the agent's goes
  // The edit this call sends: the session record's, decided at the turn boundary (clearing.js:decide) where the
  // proxy holds one (cfg.record), else the floor. Between decisions the same edit goes byte for byte.
  const rec = cfg.record, m = rec ? measureClearing(cfg, j, rec.clearedUses) : null;
  const d = rec ? decide(rec, cfg, m, { turn: m.turn, ttl: cfg.ttl, now: cfg.now, model: j.model }) : { edit: { keep: keepValue(cfg, j.messages), ask: cfg.clearAtLeast }, clear: false };
  const edit = clearEdit(cfg, j.messages, d.edit), thinking = thinkingEdit(cfg, j.messages);
  // material the clear did not save, because the model fetched it again (rereadOfCleared)
  const rr = rec ? rereadOfCleared(j.messages, edit.keep.value, rec.seenCleared) : { prints: null, reread: null };
  const kept = thinking ? edits.filter(e => !(e && e.type === THINKING_EDIT_TYPE)) : edits;
  // a held edit (clearing.js:decide, nothing safe to clear yet) is not sent at all
  const hold = !!d.edit.hold, sent = [...(thinking ? [thinking] : []), ...kept, ...(hold ? [] : [edit])];
  if (sent.length) j.context_management = { ...cm, edits: sent };
  return { body: Buffer.from(JSON.stringify(j)), injected: true, model: j.model, keep: edit.keep.value, asked: edit.clear_at_least.value, changed: !!d.clear, ...(hold ? { hold: true } : {}), ...(d.turn != null ? { turn: d.turn } : {}), ...(d.clear ? { clear: { dropped: d.dropped, recache: d.recache, cost: Math.round(d.cost), saving: Math.round(d.saving), ...(d.cold ? { cold: true } : {}) } } : {}), ...(d.held ? { held: { dropped: d.held.dropped, recache: d.held.recache, cost: Math.round(d.held.cost), saving: Math.round(d.held.saving), need: d.held.need, have: d.held.have } } : {}), ...(d.clearable != null ? { clearable: d.clearable } : {}), addBeta: !betaOn(headers), actions: hold ? [] : clearedActions(j.messages, edit.keep.value), ...(rr.prints ? { prints: rr.prints } : {}), ...(rr.reread ? { reread: rr.reread } : {}), ...(cfg.clearInputs ? { inputs: true } : {}), ...(thinking ? { thinkingKeep: thinking.keep.value } : {}) };
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
      const cleared = (seen.applied || []).filter(e => e.type === EDIT_TYPE);
      return {
        input: seen.input_tokens, read: seen.cache_read_input_tokens, write: seen.cache_creation_input_tokens, out: seen.output_tokens,
        write1h: seen.write1h, write5m: seen.write5m,
        cleared: cleared.reduce((a, e) => a + (e.cleared_input_tokens || 0), 0), clearedUses: cleared.reduce((a, e) => a + (e.cleared_tool_uses || 0), 0), editAcknowledged: !!seen.acknowledged,
      };
    },
  };
}

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'];

// `notes`: a proxy-notes.js NoteInjector; the notes for an agent with no prompt hook go into the last user turn
export function startProxy(cfg, { logFile, host = '127.0.0.1', onListen, notes = null, onStandDown = null, agentOptions = {}, compressionDir = logFile ? path.join(path.dirname(logFile), 'compression') : null, clearingDir = logFile ? path.join(path.dirname(logFile), 'clearing') : null, dumpDir = process.env.THINKER_PROXY_DUMP || null } = {}) {
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
  let editRejected = false;
  // the clearing records, one per session, on disk: a restarted proxy sends the edit it was sending (clearing.js)
  const clearing = clearingStore(clearingDir, cfg);
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
      const noEdit = editRejected && !forwardsToAnthropic(requestCfg.upstream);
      const rec = requestCfg.protocol !== 'responses' && sessionOf(req.headers) ? clearing.read(sessionOf(req.headers)) : null;
      try { t = noEdit ? { body: raw, reason: 'edit-unsupported' } : transformRequest(req.method, requestUrl, req.headers, raw, { ...requestCfg, record: rec }); } catch { t = { body: raw, reason: 'error' }; }
      // the gauge gave this session up: the agent's own bytes, and the results come back once
      if (t.injected && rec?.stopped) t = { body: raw, reason: 'uneconomic', model: t.model };
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
        let logged = false, recorded = false, truncated = false;
        const logError = (e, extra) => {
          if (logged) return;
          logged = true;
          log({ at: new Date().toISOString(), op: 'proxy-error', error: e.message, code: e.code, reused: !!ureq.reusedSocket, afterMs: Date.now() - started, ...extra });
        };
        ureq = lib.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, path: base + requestUrl, method: req.method, headers, agent: getAgent(!!attempt) }, ures => {
          if (judgeAuth) watch.response(ures.statusCode);
          // A 400 from an upstream that is not Anthropic's may be the gateway refusing the edit the proxy added --
          // or it may be about the request itself, which is the agent's own to see. The body says which
          // (`refusesEdit`), so it is read before anything reaches the agent: a refusal of the edit means the same
          // request goes again untouched, anything else is passed on as it came. Reading the body first is the
          // whole point. A real router (LiteLLM 1.106.5, 2026-10-28) answered 400 over a model name it did not
          // know, and taking that for a refusal switched the clearing off for the life of the process and sent
          // every failing request twice.
          if (t.injected && !editRejected && ures.statusCode === 400 && !res.headersSent && !forwardsToAnthropic(requestCfg.upstream)) {
            const parts = [];
            let read = 0;
            let ended = false;
            const decide = () => {
              const body = Buffer.concat(parts);
              // not about the edit: the agent's own to see. The bytes are in hand and the stream may already be
              // over, so `deliver` is told to finish the response itself rather than wait for an 'end' that has been
              if (!refusesEdit(body)) return deliver(Buffer.from(body), ended);
              editRejected = true;
              ures.resume();
              log({ at: new Date().toISOString(), op: 'proxy-edit-rejected', upstream: up.origin, status: 400, says: String(body).slice(0, 200) });
              t = { ...t, body: raw, injected: false, addBeta: false, reason: 'edit-unsupported' };
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
              injected: !!t.injected, ...(t.hold ? { hold: true } : {}), ...(t.clear ? { clear: t.clear } : {}), ...(t.held ? { held: t.held } : {}), ...(t.reread ? { reread: { calls: t.reread.calls, tokens: t.reread.tokens } } : {}), ...(t.clearable != null ? { clearable: t.clearable } : {}), ...(t.turn != null ? { turn: t.turn } : {}), ...(t.injected ? { keep: t.keep, ...(t.inputs ? { inputs: true } : {}), asked: t.asked, ...(t.thinkingKeep != null ? { thinkingKeep: t.thinkingKeep } : {}) } : { reason: t.reason }), ...(t.addBeta ? { betaAdded: true } : {}), ...(t.notes ? { notes: t.notes.served.length, notesReplayed: t.notes.replayed, ...(t.notes.reason ? { notesReason: t.notes.reason } : {}) } : {}), overheadMs: Math.round(overheadMs * 1000) / 1000, ...(attempt ? { retried: true } : {}), ...(truncated ? { truncated: true } : {}), ...usage }, t.actions);
            dump(t.session || sessionOf(req.headers), t, usage);
            // the record after the answer (clearing.js:response): the decision applied, the server's count kept, the
            // gauge read; each event is a log line, and the record goes back to disk
            if (tap && rec && t.injected && t.protocol !== 'responses') {
              for (const ev of clearingResponse(rec, requestCfg, t, usage)) log({ at: new Date().toISOString(), op: ev.stopped ? 'proxy-clearing-stopped' : ev.unmet ? 'proxy-clear-unmet' : ev.moved ? 'proxy-clear-moved' : ev.reread ? 'proxy-clear-reread' : 'proxy-clear', session: sessionOf(req.headers), model: t.model, asked: t.asked, keep: t.keep, ...ev, read: usage.read, write: usage.write, cleared: usage.cleared, clearedUses: usage.clearedUses });
              clearing.write(rec);
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
          const retry = !attempt && !cancelled && !res.headersSent && RETRY_CODES.includes(e.code);
          logError(e, { retried: retry, ...(cancelled ? { aborted: true } : {}) });
          if (retry) {
            const wait = RETRY_DELAY[e.code] || 0;
            if (!wait) return send(1);
            return void setTimeout(() => { if (res.destroyed) return; send(1); }, wait);
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
    if (r.cleared) s.seenClear.add(r.session);
    if ((r.input || 0) + (r.read || 0) + (r.write || 0) >= LONG_CONTEXT) { const b = s.long[s.seenClear.has(r.session) ? 'after' : 'before']; b[0]++; if (isRewrite(r)) b[1]++; }
    s.input += r.input || 0; s.read += r.read || 0; s.write += r.write || 0; s.out += r.out || 0;
    s.cleared += r.cleared || 0; if (r.cleared) s.clears++;
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
  const stopped = new Set(rows.filter(r => r.op === 'proxy-clearing-stopped' && (!since || r.at >= since)).map(r => r.session));
  if (outSides.clearing) outSides.clearing.sessionsStopped = stopped.size;
  const warning = rewriteWarning(outSides);
  return { ...outSides, ...(warning ? { warning } : {}), ...(Object.keys(responses).length ? { responses } : {}) };
}
// a call this long is one where a rewrite is a cost worth noticing and a clear can have happened
export const LONG_CONTEXT = 100000;
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
    (base != null ? ` against ${Math.round(base * 100)}% without a clear` : '') + ': the clearing is breaking the cache instead of saving on it. Check what the edit sends from one call to the next (proxy.js:keepValue); thinker proxy off until it is understood.';
}
