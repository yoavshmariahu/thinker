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
import os from 'node:os';
import { ProxyAgent } from 'proxy-agent';
import path from 'node:path';
import crypto from 'node:crypto';
import { transformResponses, responsesUsageTap, responsesReport } from './proxy-responses.js';
import { transformChat, chatUsageTap, chatReport, refusesChatCut } from './proxy-chat.js';
import { rateTracker as createRateTracker, makeRatesResolver } from './gateway-rates.js';
import { statedRates } from './prices.js';
import { CODEX_PROXY_PATH, CODEX_UPSTREAMS } from './proxy-codex.js';
import { foreignAuth } from './proxy-route.js';
import { BEDROCK_PATH, bedrockRequest, bedrockBody } from './proxy-bedrock.js';
import { stubTools, stubReader } from './tool-stubs.js';
import { routeOf, routedHeaders, routedBody, routeRow } from './proxy-routing.js';
import { registryReader } from './providers.js';
import { chatStreamToMessages, fromChat, errorToMessages } from './wire-chat.js';
import { noteCompression } from './compression.js';
import { imageTokens } from './transcripts.js';
import { isRewrite, LONG_CONTEXT, clearedOf } from './cutting.js';
import { retryPlan, addressBook, cachingLookup } from './proxy-retry.js';
import { decideCut, cutResponse, cutStore, freshCut, addThink, policyId, sessionOf, MIN_CHARS as CUTTING_MIN_CHARS, placeholder as cutting_placeholder, imagePlaceholder, cutInput } from './cutting.js';
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
// The model reading again what was cleared, which the replay cannot see (proxy-replay.js), is measured per session
// from the transcript since 2026-11-12 (rereads.js) and taken off the netted saving; the holdout that was kept for it
// is off (proxy-service.js:SERVICE_HOLDOUT).
// `clearAtLeast` 8k since 2026-11-13, from 60k. The floor was the economics when a boundary had one candidate
// to take or leave: a big batch was the only way a rewrite of the whole conversation could pay. With the
// ladder (`cutCandidates`) the pricing chooses the depth and is exact at every rung, so a 60k floor only does
// harm -- 60k of results can only be found by reaching back to old ones, which is precisely what makes the
// rewrite span the conversation. What is left for a floor is a guard against acting on arithmetic noise:
// `recache` is an estimate at TOKENS_PER_CHAR, so a cut of a few hundred tokens priced against a six-figure
// tail is inside the estimator's error. 8k is one substantial result, and `payback` governs everything above.
// `cutBreakpoint` (2026-11-17): a cut is seeded with a cache breakpoint of the proxy's own and made on the next
// request (`cutting.js:SEED_MS`, `placeMark` below), which is what makes the tail the thing a cut writes. On by
// default the day it was written, at the owner's call: priced at the whole conversation a cut all but never
// pays, so a cut without the breakpoint is hardly a cut at all. It shipped before any live request had shown the
// API reading the seeded prefix; the first cut rows (`mark`, `clear.whole` beside the call's own cache read)
// are what confirm it, and `--no-cut-breakpoint` or `proxy: { cutBreakpoint: false }` is the way back.
export const PROXY_DEFAULTS = { upstream: 'https://api.anthropic.com', trigger: 140000, keepMin: 3, cutInputs: true, cutImages: true, clearAtLeast: 8000, holdout: 0, clearDeep: true, cutBreakpoint: true, cutThinking: false, thinkingKeepTurns: 0 };
// The request as the decision needs it: the prompt in tokens, the cached prefix a cut keeps (`prefix`: the system
// prompt and the tool definitions, which is all the API finds again once a cut changes the history -- Claude Code
// sets its breakpoints on the system prompt and the newest messages, so a prefix ending mid-conversation is never
// matched; measured 2026-11-04, four cuts each read 12,895 tokens and wrote the whole post-cut context), the system
// prompt's own size, and the turn's id. All of it from what sits before the turn: within a turn the request grows
// with every call, and a verdict that moved from one call of a turn to the next would move the cut with it, which
// is the rewrite this exists to avoid.
export function measurePrompt(cfg, j) {
  const txt = v => (v == null ? 0 : wireChars(v));
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

// Whether the API refused the HISTORY the proxy rewrote, which is a different refusal from the one above and was
// invisible until now: `EDIT_WORDS` knows only the names of the server-side edit (`context_management`,
// `clear_tool_uses`, the beta header), and a preserved-thinking refusal names none of them, so it reached the agent
// as its own 400 and nothing stood down (2026-11-15).
//
// What the check is. A thinking block is bound to the bytes of the conversation that produced it: `system`, `tools`
// and every earlier message must arrive byte-identical on the call that replays it. A pruned tool RESULT has a
// sanctioned client-side form -- at a declared boundary, as a pure function of the growing history, which the
// ratchet is. A rewritten tool_use INPUT has none: its only listed remedy is to echo `tool_use.input` exactly as
// received. So cutting a call's own text is the half of the cut that can be refused, on accounts created on or
// after 2026-08-31 and on Fable 5.2 and Mythos 5.2 for every account.
//
// Explicit only, which is the whole point (the owner's rule, 2026-11-15): this must name the check. A 400 about
// the agent's own request, a rate limit, a model name, a malformed body -- none of them may stop the cutting, and
// the October lesson was that treating a vague 400 as a refusal stopped the clearing over an unrelated error and
// sent every failing request twice. So both halves have to be there: a word for the thing checked AND a word for
// the thing the check found wrong.
const HISTORY_WORDS = /tool_use_rewritten|tool_results_rewritten|prefix_mismatch|block_binding|preserved[_ -]thinking|thinking[_ -]block/i;
const MISMATCH_WORDS = /mismatch|rewritten|does not match|do not match|modified|altered|byte|differs|changed since/i;
export function refusesHistory(body) {
  const text = String(body || '').slice(0, REFUSAL_BODY);
  if (!HISTORY_WORDS.test(text)) return false;
  // a field named on its own is enough where the name IS the verdict (`tool_use_rewritten` is not a field anyone
  // sets); otherwise the body has to say what was wrong with it, not merely mention thinking
  return /tool_use_rewritten|tool_results_rewritten|prefix_mismatch/i.test(text) || MISMATCH_WORDS.test(text);
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
// What a tool result's characters cost, for the saving the cut reports (`applyCut`, `cutActions`). The
// whole-prompt rate above is the Report's, measured over prose and code together; tool results tokenize
// denser. Measured 2026-11-08 from Claude Code transcripts, each call's usage delta less the previous
// answer's output over one result, 265 results of 4k+ chars (2.6M chars): median 0.433, weighted 0.445
// (Bash 0.446, Read 0.445, Grep 0.578), so the figure at 0.36 ran a fifth short. The one clean live cut
// the same day claimed 16,966 tokens where the API's context fell by 30,718.
// The decision prices what it removes at this rate too (`cutCandidates`, 2026-11-14, the owner's call), as the
// desktop mod's ladder always did (`register.tsx:ladderOf`). Until then a rung's `tokens` was at the whole-prompt
// rate, on the reasoning that the cut and the tail scale together -- but they are not the same matter: the tail
// is priced as it will be sent, with the results already placeholders, so it is thinking, call text and prose,
// and only the removed side is results. Pricing both at 0.36 ran the removed side a fifth short, which is the
// wrong direction at a margin where 62 payback refusals sat at a median 23% removed against the 42% needed.
// The tail keeps TOKENS_PER_CHAR. `POLICY_REV` 4 marks it (cutting.js).
export const RESULT_TOKENS_PER_CHAR = 0.445;
// What a result's text is in tokens, counted from the text itself (2026-11-17). A flat rate a character is right
// on average and wrong result by result: over 1,082 results from 159 of this machine's sessions, each held to
// what the API said the next call's prompt grew by, 0.445 a character was 10.6% off at the median and 37% at
// the ninetieth percentile, and ran 18% high on a whole PostHog session, where three cuts priced at 79k, 123k
// and 138k took 65k, 102k and 117k out and a fourth was made that the limit should have refused. Four counts
// fitted to the same figures -- letters, digits, symbols, newlines; spaces weigh nothing -- were 4.0% and 13%
// off, fitted on half the results and tested on the other half. Characters outside ASCII were too few there to
// fit alone and take the weight they had beside the four. No tokenizer is public for these models: the two
// libraries tried (Claude 2's and o200k) read 30% and 38% short.
export const RESULT_WEIGHTS = { letter: 0.34, digit: 0.78, symbol: 1.05, newline: 1.6, other: 0.7 };
export function resultTokens(text) {
  const t = String(text ?? '');
  let letter = 0, digit = 0, symbol = 0, newline = 0, other = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) letter++;
    else if (c >= 48 && c <= 57) digit++;
    else if (c === 10) newline++;
    else if (c === 32 || c === 9 || c === 13) continue;
    else if (c < 128) symbol++;
    else other++;
  }
  const w = RESULT_WEIGHTS;
  return Math.round(letter * w.letter + digit * w.digit + symbol * w.symbol + newline * w.newline + other * w.other);
}
// what else leaves with a result -- its images and its call's own text -- is still sized by the character
const charTokens = chars => Math.round(chars * RESULT_TOKENS_PER_CHAR);
// --- the earlier turns' thinking goes with a cut (2026-11-17, `cutThinking`, off by default) -----------------
// A thinking block of an earlier turn may be left out of a request: "outside tool use, omit prior turns'
// thinking, but not a block between two that you keep", and never edited (the API's thinking pages, read that
// day). On the models that keep earlier thinking -- Opus 4.5 on, Sonnet 4.6 on, every Fable -- it is billed as
// input on each later call, and on this machine's boundaries over the trigger it was 30% of the messages'
// characters. Left out from the top it would move the cached prefix to the top; left out from the cut down, it
// leaves a span the cut is writing again anyway. So that is the rule: a cut also leaves out the thinking of the
// messages after its own oldest replaced result and before the turn it was made in, on that request and on
// every one after it (`rec.think`, one [result id, turn] a cut). The turn in progress keeps its own, which
// the API requires. Nothing above a cut's own first result is touched, so the prefix a breakpoint there
// protects is still the one the cache holds, and thinking said since an earlier cut stays until a later
// cut reaches past it.
// Replayed over 30 days of this machine's proxied sessions (1,582 warm boundaries over the trigger): 200 cuts
// taking 9.2M tokens became 359 taking 22.4M with the breakpoint, 81 became 230 without it, because a tail
// with no thinking in it is one a deeper rung can pay for.
// What a block is worth is its signature at about 4.3 characters a token (transcripts.js), written here as a
// rate on the block's wire characters, which are the signature and a few dozen more.
export const THINKING_TOKENS_PER_CHAR = 1 / 4.3;
const isThinking = b => b?.type === 'thinking' || b?.type === 'redacted_thinking';
// the wire characters of the thinking a message would lose; none where thinking is all the message holds,
// since an assistant message may not be sent empty
export function thinkingChars(m) {
  if (m?.role !== 'assistant' || !Array.isArray(m.content) || !m.content.some(isThinking) || m.content.every(isThinking)) return 0;
  return m.content.reduce((n, b) => n + (isThinking(b) ? wireChars(b) + 1 : 0), 0);
}
// where turn `turn` starts, by `turnId`'s count of the person's prompts; the end of the messages if it has not
export function turnIndex(messages, turn) {
  if (turn < 1) return 0;   // before the first turn: a range that ends there holds nothing
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text' }];
    if (blocks.some(b => b?.type === 'text') && !blocks.some(b => b?.type === 'tool_result') && ++n === turn) return i;
  }
  return messages.length;
}
// the message holding the oldest result of a set of ids: the thinking after it is what goes
const cutAnchor = (messages, ids) => (ids.size ? messages.findIndex(m => Array.isArray(m?.content) && m.content.some(b => b?.type === 'tool_result' && ids.has(b.tool_use_id))) : -1);
// which messages have had their thinking left out by the cuts so far: one flag a message, from `rec.think`
export function thinkingGone(messages, ranges) {
  const gone = new Array(messages.length).fill(false);
  for (const [id, turn] of Array.isArray(ranges) ? ranges : []) {
    const a = cutAnchor(messages, new Set([id]));
    if (a < 0) continue;
    for (let i = a + 1, to = Math.min(turnIndex(messages, turn), messages.length); i < to; i++) gone[i] = true;
  }
  return gone;
}
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
    ['clearAtLeast', 'clear-at-least', 'THINKER_PROXY_CLEAR_AT_LEAST'], ['holdout', 'holdout', 'THINKER_PROXY_HOLDOUT'],
    ['thinkingKeepTurns', 'thinking-keep-turns', 'THINKER_PROXY_THINKING_KEEP_TURNS']]) {
    const v = pick(flag, name);
    // a guard the person set by hand is pinned, and the route's prices never move it (cutting.js:scaledPolicy)
    if (v !== undefined) { cfg[key] = v; if (key === 'trigger' || key === 'clearAtLeast') (cfg.pinned ??= {})[key] = true; }
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
  cfg.cutInputs = onOff('cut-inputs', 'THINKER_PROXY_CUT_INPUTS', PROXY_DEFAULTS.cutInputs);
  cfg.cutImages = onOff('cut-images', undefined, PROXY_DEFAULTS.cutImages);   // a flag or the machine config; no variable
  cfg.cutBreakpoint = onOff('cut-breakpoint', 'THINKER_PROXY_CUT_BREAKPOINT', PROXY_DEFAULTS.cutBreakpoint);
  cfg.cutThinking = onOff('cut-thinking', 'THINKER_PROXY_CUT_THINKING', PROXY_DEFAULTS.cutThinking);
  cfg.upstream = flags.upstream || env.THINKER_PROXY_UPSTREAM || cfg.upstream;
  cfg.port = pick('port', 'THINKER_PROXY_PORT');
  cfg.protocol = flags.protocol || env.THINKER_PROXY_PROTOCOL || 'anthropic';
  cfg.codex = flags.codex === true;
  // The model gateways (the owner's call, 2026-11-10): OpenAI Chat Completions upstreams routed by
  // path prefix on the same service, so one proxy serves every door. OpenRouter has a home of its
  // own; any other gateway (LiteLLM first) needs the base URL it is already served at. A new
  // gateway is a config entry here, not a new door: the wire format is the shared standard, and
  // what differs is only where the request is answered from.
  cfg.gateways = {};
  if (flags['gateway-openrouter']) {
    // bare flag: OpenRouter's own home. A URL: the same door at an upstream of the person's
    // (a self-hosted mirror, a test fixture), as LiteLLM always is.
    const u = typeof flags['gateway-openrouter'] === 'string' && flags['gateway-openrouter']
      ? flags['gateway-openrouter'] : 'https://openrouter.ai/api/v1';
    const parsed = new URL(u);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--gateway-openrouter must be an HTTP(S) base URL');
    cfg.gateways.openrouter = { upstream: u };
  }
  if (flags['gateway-litellm']) {
    const u = new URL(String(flags['gateway-litellm']));
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('--gateway-litellm must be an HTTP(S) base URL');
    cfg.gateways.litellm = { upstream: String(flags['gateway-litellm']) };
  }
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

// A screenshot in a tool result (2026-11-15, the owner's call: "remove screenshots from direct context but leave
// the filepaths where they can be reached if needed"). Until then a result was eligible by its text alone, so a
// browser session's screenshots -- an image and a line of text -- were never cut and stayed in the prompt for the
// whole session, and a result with text and an image lost the image with no way back to it. Now the image is
// saved to a file (`saveCutImages`), the placeholder names the file (`cutting.js:imagePlaceholder`), and the model
// reads it again with its own Read tool if it needs the picture. Only where there is somewhere to save
// (`imagePath`): a cut that cannot leave a path leaves the image where it is.
// An image is counted at what the API charges for it (its pixels, transcripts.js:imageTokens), never at its
// base64: one screenshot is ~1,500 tokens and ~1.3M characters, so read as text it put the prompt past the
// trigger on its own and made every rewrite look 400 times dearer than it was (`wireChars`).
const resultImages = b => (Array.isArray(b?.content) ? b.content.filter(x => x?.type === 'image' && x.source?.type === 'base64' && typeof x.source.data === 'string' && x.source.data) : []);
const imageCharsOf = (imgs, rate) => Math.round(imgs.reduce((n, x) => n + imageTokens(x), 0) / rate);
/** The characters `v` is worth on the wire: its JSON, with every base64 image counted at its tokens and not its bytes. */
export function wireChars(v) {
  let extra = 0, s = '';
  try {
    s = JSON.stringify(v, function (k, val) {
      if (k === 'data' && typeof val === 'string' && val.length > 400 && this?.type === 'base64') { extra += Math.round(imageTokens({ source: { data: val } }) / TOKENS_PER_CHAR); return ''; }
      return val;
    }) || '';
  } catch { return 0; }
  return s.length + extra;
}
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
/** Where a cut result's nth image is kept: one file per image, named by the call that made it. */
export const imagePathIn = dir => (id, k, media) => path.join(dir, `${String(id).replace(/[^\w.-]/g, '_')}-${k}.${IMAGE_EXT[media] || 'png'}`);
let imageWrites = 0;
/**
 * Write the images of the results about to be cut, each once (the agent resends the conversation on every call,
 * so the same image arrives again and its file is already there). False if any could not be written: then the
 * images stay in the prompt, since a placeholder naming a file that is not there is worse than no cut.
 */
export function saveCutImages(messages, cut, imagePath) {
  const ids = cut instanceof Set ? cut : new Set(cut || []);
  let ok = true, dir = null;
  for (const m of messages || []) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_result' || !ids.has(b.tool_use_id)) continue;
      resultImages(b).forEach((x, k) => {
        const f = imagePath(b.tool_use_id, k, x.source.media_type);
        try {
          if (fs.existsSync(f)) return;
          dir = path.dirname(f); fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(f, Buffer.from(x.source.data, 'base64'));
          imageWrites++;
        } catch { ok = false; }
      });
    }
  }
  // the files of sessions long over: kept as long as a cut's own record is (cutting.js:KEEP_DAYS)
  if (dir && imageWrites % 50 === 1) {
    try {
      const old = Date.now() - IMAGE_KEEP_DAYS * 86400000;
      for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); try { if (fs.statSync(p).mtimeMs < old) fs.unlinkSync(p); } catch { /* gone */ } }
    } catch { /* nothing to prune */ }
  }
  return ok;
}
const IMAGE_KEEP_DAYS = 2;

// Walk the conversation newest-first, calling back for each tool result with whether the recency
// rule protects it. `keepMin` counts only results the rule would otherwise let go.
function walkResults(messages, keepMin, fn) {
  const keep = keepMin;
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
      const protectedByRule = inLatestTurn || kept < keep;
      if (protectedByRule) kept++;
      fn(b, i, protectedByRule);
    }
  }
}

// What a boundary could newly cut, and what replacing it would cost: `recache` is the messages as they
// will be sent, all of them, which is what a result replaced in the middle makes the API write (below).
// The ladder a boundary could cut, from the tail backwards (2026-11-13).
//
// Until now this took EVERY eligible result and handed back one candidate. That is the most a boundary can
// remove and also the most it can cost: the rewrite runs from the first result replaced to the end, so a set
// that reaches the oldest eligible result makes the rewritten span nearly the whole conversation. Measured on
// this machine's 93 priced warm boundaries, such a set removed 26-34% of the span it rewrote, against the 42%
// Anthropic's hourly rates need -- which is why 0 of the 12 boundaries under the current policy were cut.
//
// A removed token saves the same wherever it sat: its read, on every later call. Only the COST depends on
// position. So the sets worth considering are the nested suffixes -- the newest eligible result, then the two
// newest, and so on -- and the decision picks among them (cutting.js:decideCut). Each is priced exactly, as
// the single set was, because the rewrite is still measured, never guessed.
//
// One backward pass builds all of them. Walking from the end, the set only ever grows backwards, so a message
// already passed never changes which of its results are replaced: its sent length is final, and the running
// sum is the tail for every deeper step. `+ count + 1` is what JSON.stringify adds to an array of that many
// messages (two brackets and the commas), which the old single stringify of the slice included.
export function cutCandidates(messages, { keepMin = 3, cut = [], minChars = CUT_MIN_CHARS, cutInputs = PROXY_DEFAULTS.cutInputs, imagePath = null, thinking = null } = {}) {
  const have = new Set(cut), ids = [];
  let chars = 0, inputChars = 0, firstChanged = -1, tokens = 0;
  const takeAt = new Map();
  // What each call's own text would give up, by its id (`cutting.js:cutInput`). Read once here, because the
  // ladder prices what it will send and a call's bytes leave the prompt exactly as its result's do -- a step
  // that counted only the results would understate its own saving and be refused for a payback it in fact makes.
  const inputOf = new Map();
  if (cutInputs) for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type !== 'tool_use' || !b.id || have.has(b.id)) continue;
      const red = cutInput(b.input, { minChars });
      if (red) inputOf.set(b.id, red.chars);
    }
  }
  walkResults(messages, keepMin, (b, i, prot) => {
    if (prot || have.has(b.tool_use_id)) return;
    const text = resultText(b), imgs = imagePath ? resultImages(b) : [];
    const own = inputOf.get(b.tool_use_id) || 0;
    // A long call with a short result is a candidate on the call's text alone (2026-11-17). Until now a call's
    // text went only where its result did, so a heredoc, a Write or an Edit that answered in one line kept its
    // whole body for the rest of the session: on this machine's boundaries over the trigger that was 6% of the
    // messages' characters (Bash 4.8%, Write 0.8%, Edit 0.3%), about 20k tokens a boundary. The short result
    // stays as it is, which is still the pair the model reads to know what the call did.
    if (text.length < minChars && !imgs.length && !own) return;
    // what leaves: the text where it is long enough to be replaced, and the images at what they cost
    const pics = imageCharsOf(imgs, RESULT_TOKENS_PER_CHAR), long = text.length >= minChars;
    const gone = (long ? text.length : 0) + pics;
    // in tokens: the text counted (`resultTokens`), the images and the call's own text by the character
    const tok = (long ? resultTokens(text) : 0) + charTokens(pics) + charTokens(own);
    ids.push(b.tool_use_id); chars += gone; inputChars += own; tokens += tok; firstChanged = i;
    if (!takeAt.has(i)) takeAt.set(i, []);
    takeAt.get(i).push({ id: b.tool_use_id, len: gone + own, tok });
  });
  // the ladder, smallest (newest) first. Empty when there is nothing to cut, and one step long when every
  // eligible result sits in one message, in which case this is exactly what the old single candidate was.
  // What a rung makes the API write: EVERY message as sent after the cut, not the tail from the first replaced
  // result (2026-11-16). The API reads a cached prefix only where an earlier request left a breakpoint, and
  // looks back at most 20 positions from this request's own; Claude Code's breakpoints sit on the newest
  // messages, so a result replaced further back than that leaves the system prompt as the only thing read and
  // the whole conversation is written again. The ladder priced the tail alone, and the three warm cuts it
  // made on this machine (2026-11-15/16) were predicted at 35k, 54k and 55k and wrote 245k, 87k and 124k,
  // each with a cache read of exactly the 19,256-token system prompt: paybacks of 23-25 calls that were
  // really 40 to 180, in sessions that ended first. It is the fact `cutting.js:priceCut` has recorded since
  // 2026-11-04 (566,723 predicted, 548,009 written). `tail` is still measured and logged beside it, so a row
  // says which of the two the API's own write was nearer.
  const before = [0];
  if (takeAt.size) for (let i = 0; i < messages.length; i++) before.push(before[i] + wireChars(applyCut([messages[i]], have, { cutInputs, imagePath }).messages[0]));
  const steps = [];
  if (takeAt.size) {
    const sent = new Set(have);
    let acc = 0, count = 0, took = 0, sum = 0, sumTok = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const take = takeAt.get(i) || [];
      for (const t of take) sent.add(t.id);
      acc += wireChars(applyCut([messages[i]], sent, { cutInputs, imagePath }).messages[0]);
      count++;
      if (!take.length) continue;
      for (const t of take) { took++; sum += t.len; sumTok += t.tok; }
      // The tail runs from the first message this rung changes, and that is the assistant message before the
      // results wherever a call's own text is cut with its result (2026-11-17): the breakpoint goes before it.
      const pre = i > 0 && take.some(t => inputOf.has(t.id)) ? wireChars(applyCut([messages[i - 1]], sent, { cutInputs, imagePath }).messages[0]) : 0;
      // And it runs from where the breakpoint can actually go (2026-11-17). `placeMark` walks back from the
      // first changed message to the nearest one that can carry a breakpoint, and whatever it steps over is
      // written again with the tail. Priced from the first changed message, the first cut of a nine-turn
      // PostHog session was predicted at 41,465 and wrote 57,346: Claude Code's second message there is the
      // environment block, 50k characters that the walk passed over, so the breakpoint sat on the message
      // before it and the API read 31,363 where the price assumed 48,718.
      let over = 0, stepped = 0;
      for (let q = i - (pre ? 1 : 0) - 1; q >= 0 && markBlock(messages[q]) < 0; q--) { over += before[q + 1] - before[q]; stepped++; }
      steps.push({
        ids: ids.slice(0, took), chars: sum, tokens: sumTok,
        recache: Math.round((before[i] + acc + messages.length + 1) * TOKENS_PER_CHAR),
        tail: Math.round((acc + pre + over + count + (pre ? 1 : 0) + stepped + 1) * TOKENS_PER_CHAR), firstChanged: i,
        tailFrom: i - (pre ? 1 : 0) - stepped,
      });
    }
  }
  // What the rewrite actually pays for: the messages from the first replaced one onward, AS THEY WILL BE
  // SENT -- the new placeholders and the ones already in the set, not the full results the agent resent.
  // Measured on the original messages instead, this over-stated the cost by 3.1x, 7.9x and 14.9x on the
  // second, third and fourth cut of a 28-turn session (2026-11-04), because every result cut earlier was
  // still counted at full size. The API's own writes on those four calls were 47k, 58k, 56k and 52k --
  // flat, because the band runs up to the protection boundary, so everything between the first replaced
  // result and the live turn is itself replaced and the tail is only the part that survives.
  // The deepest step IS this set, and its `recache` is that same tail summed message by message rather than
  // stringified in one slice, which `test/cut-ladder.test.js` holds to the old figure. So the whole-set
  // candidate the other doors and the old tests read is the last rung, and nothing is measured twice.
  // With `thinking` ({ to, done }: where the turn in progress starts, and the ranges earlier cuts left out) every
  // rung also loses the thinking between its oldest result and that turn. It comes off what the rung writes,
  // at the rate the ladder counted it, and what an earlier cut had not already left out is added to what the
  // rung removes, at a thinking block's own rate.
  let thinkAll = 0;
  if (thinking && steps.length) {
    const gone = thinkingGone(messages, thinking.done), pre = [0], preGone = [0];
    messages.forEach((m, i) => { const n = thinkingChars(m); pre.push(pre[i] + n); preGone.push(preGone[i] + (gone[i] ? n : 0)); });
    const to = Math.min(thinking.to ?? messages.length, messages.length);
    for (const s of steps) {
      // `thinking.from` (set where `thinkingKeepTurns` holds recent thinking back): the earliest range so far is
      // carried on to `to`, so thinking that was too new for an earlier cut goes with this one now it is old.
      const from = Math.min(s.firstChanged + 1, thinking.from ?? Infinity, to);
      const span = pre[to] - pre[from], had = preGone[to] - preGone[from];   // all the thinking in the rung's span, and what was gone already
      s.thinking = Math.round((span - had) * THINKING_TOKENS_PER_CHAR);
      s.tokens += s.thinking;
      // Thinking that goes above the rung's own first change moves where the rewrite starts: the tail then runs
      // from the nearest message below it that can carry the breakpoint (`thinkFirst`, which `placeMark` is given).
      let start = s.tailFrom, more = 0;
      const end = Math.min(to, s.tailFrom);
      let g = from; while (g < end && !(pre[g + 1] > pre[g] && !gone[g])) g++;
      if (g < end) {
        let q = g - 1; while (q >= 0 && markBlock(messages[q]) < 0) q--;
        start = q + 1; more = before[s.tailFrom] - before[start] + (s.tailFrom - start); s.thinkFirst = g;
      }
      s.tail = Math.max(0, s.tail + Math.round(more * TOKENS_PER_CHAR) - Math.round((pre[to] - pre[Math.min(to, Math.max(start, from))]) * TOKENS_PER_CHAR));
      s.recache = Math.max(0, s.recache - Math.round((span + preGone[from]) * TOKENS_PER_CHAR));
    }
    thinkAll = steps[steps.length - 1].thinking;
  }
  const whole = steps.length ? steps[steps.length - 1] : null;
  return {
    // `chars` is the results, `inputChars` the finished calls' own text, and `tokens` the two together, because
    // both leave the prompt and the saving is what the prompt is shorter by (`applyCut`).
    ids, chars, inputChars, tokens: tokens + thinkAll, ...(thinking ? { thinking: thinkAll } : {}),
    recache: whole ? whole.recache : 0, firstChanged, steps,
  };
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
export function applyCut(messages, cut, { cutInputs = PROXY_DEFAULTS.cutInputs, imagePath = null, thinking = null } = {}) {
  const ids = cut instanceof Set ? cut : new Set(cut || []);
  if (!ids.size) return { messages, cut: 0, chars: 0, tokens: 0, inputChars: 0, firstChanged: -1 };
  let chars = 0, inputChars = 0, firstChanged = -1, tokens = 0;
  // the calls this changed, by id: a result replaced, a call's own text replaced, or both -- one use either way
  const done = new Set();
  const out = messages.map((m, i) => {
    const c = m?.content;
    if (!Array.isArray(c)) return m;
    let touched = false;
    const blocks = c.map(b => {
      // the call's own text, where the result it produced is going too (`cutInput`, 2026-11-14). Only ever
      // alongside the result: a call whose result the model still has keeps its text, because the pair is what
      // the model reads to know what it did.
      if (cutInputs && b?.type === 'tool_use' && ids.has(b.id)) {
        const red = cutInput(b.input, { minChars: CUT_MIN_CHARS });
        if (!red) return b;
        inputChars += red.chars; tokens += charTokens(red.chars); touched = true; done.add(b.id);
        return { ...b, input: red.input };
      }
      if (b?.type !== 'tool_result' || !ids.has(b.tool_use_id)) return b;
      const text = resultText(b), imgs = imagePath ? resultImages(b) : [];
      if (text.length < CUT_MIN_CHARS && !imgs.length) return b;
      const long = text.length >= CUT_MIN_CHARS;
      const pics = imageCharsOf(imgs, RESULT_TOKENS_PER_CHAR);
      done.add(b.tool_use_id); chars += (long ? text.length : 0) + pics; tokens += (long ? resultTokens(text) : 0) + charTokens(pics); touched = true;
      // a short line beside a screenshot ("Screenshot captured") stays as it is: it is what the model reads to
      // know what the call did, and it is under the size worth a placeholder
      const words = [long ? cutPlaceholder(text.length) : text, imgs.length ? imagePlaceholder(imgs.map((x, k) => imagePath(b.tool_use_id, k, x.source.media_type))) : ''].filter(Boolean).join('\n');
      return { ...b, content: [{ type: 'text', text: words }] };
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
  // `chars` is the results and `inputChars` the calls' own text; both leave the prompt, so both are the saving,
  // and they are reported apart so a reader can see which half a policy's figure came from.
  // The earlier turns' thinking, in the ranges the cuts so far left out (`thinking`: `rec.think`). A pure
  // function of those ranges, so every request of the conversation leaves out the same blocks: a thinking block
  // is bound to what came before it, and one that came and went would be a change above everything said since.
  let thinkingChars_ = 0;
  if (thinking?.length) {
    const gone = thinkingGone(messages, thinking);
    for (let i = 0; i < out.length; i++) {
      const n = gone[i] ? thinkingChars(out[i]) : 0;
      if (!n) continue;
      thinkingChars_ += n;
      if (firstChanged < 0 || i < firstChanged) firstChanged = i;
      out[i] = { ...out[i], content: out[i].content.filter(b => !isThinking(b)) };
    }
  }
  const thought = Math.round(thinkingChars_ * THINKING_TOKENS_PER_CHAR);
  return { messages: out, cut: done.size, chars, inputChars, ...(thinking ? { thinking: thought } : {}),
    tokens: tokens + thought, firstChanged };
}

// --- the proxy's own cache breakpoint (2026-11-17, `cutBreakpoint`, on by default) -------------------------
// A breakpoint is `cache_control` on a content block: the API stores the prompt up to that block and, on a
// later request, looks for a stored prefix from each breakpoint backwards. At most four a request, and a
// longer lifetime may not follow a shorter one (a 400 otherwise, which would be the person's request failing).
// `breakpointsOf` is what the request already carries, which decides whether there is room for one more.
const MAX_BREAKPOINTS = 4;
const MARKABLE = new Set(['text', 'tool_use', 'tool_result', 'image', 'document']);
// The block of a message a breakpoint can sit on: its last one of a kind that may carry `cache_control`, or -1.
// A thinking block may not, an empty text block may not, and a message whose content is a plain string is
// left alone, because turning it into a block is a change to the prefix itself. One rule for where the
// breakpoint goes (`placeMark`) and for what the ladder prices as written (`cutCandidates`).
export function markBlock(m) {
  const c = m?.content;
  if (!Array.isArray(c)) return -1;
  for (let n = c.length - 1; n >= 0; n--) { const b = c[n]; if (MARKABLE.has(b?.type) && !(b.type === 'text' && !b.text)) return n; }
  return -1;
}
export function breakpointsOf(j) {
  const ttls = [], at = [];
  const see = (b, i) => { if (b && typeof b === 'object' && b.cache_control) { ttls.push(b.cache_control.ttl || '5m'); if (i != null) at.push(i); } };
  if (j?.cache_control) ttls.push(j.cache_control.ttl || '5m');   // automatic caching: the last block's slot
  for (const t of Array.isArray(j?.tools) ? j.tools : []) see(t);
  for (const b of Array.isArray(j?.system) ? j.system : []) see(b);
  (Array.isArray(j?.messages) ? j.messages : []).forEach((m, i) => {
    for (const b of Array.isArray(m?.content) ? m.content : []) {
      see(b, i);
      if (b?.type === 'tool_result') for (const c of Array.isArray(b.content) ? b.content : []) see(c, i);
    }
  });
  return { n: ttls.length, ttls, at };
}
// The first message a cut of `ids` changes: the one holding the oldest result of the set, or the call that
// produced it where the call's own text goes too (`cutInput`). Asked of the request as the agent sent it:
// in the messages as cut the call's text is already short, and would read as untouched.
const firstTouched = (messages, ids, cutInputs) => messages.findIndex(m => Array.isArray(m?.content)
  && m.content.some(b => (b?.type === 'tool_result' && ids.has(b.tool_use_id))
    || (cutInputs && b?.type === 'tool_use' && ids.has(b.id) && !!cutInput(b.input, { minChars: CUT_MIN_CHARS }))));
// One breakpoint on the last block before the first one the cut changes. Its lifetime is copied from the
// next breakpoint after it (or the request's automatic one), which keeps the order the API insists on
// whatever Claude Code chose. Null where it cannot be placed: no room, nothing after it to copy, or no
// block before the cut that may carry one (a thinking block may not, and a message whose content is a
// plain string is left alone, because turning it into a block is a change to the prefix itself).
export function placeMark(j, messages, cutIds, { cutInputs = PROXY_DEFAULTS.cutInputs, first = null } = {}) {
  const ids = cutIds instanceof Set ? cutIds : new Set(cutIds || []);
  // `first`: a message the cut changes above its oldest result (thinking left out there), which the breakpoint must precede
  const touched = firstTouched(j.messages, ids, cutInputs), k = first != null && touched > first ? first : touched;
  if (k <= 0) return null;
  const bp = breakpointsOf({ ...j, messages });
  let copy = null;
  for (let i = k; i < messages.length && !copy; i++) for (const b of Array.isArray(messages[i]?.content) ? messages[i].content : []) {
    copy = b?.cache_control || (b?.type === 'tool_result' && Array.isArray(b.content) ? b.content.find(c => c?.cache_control)?.cache_control : null) || copy;
  }
  copy ||= j?.cache_control || null;
  if (!copy) return null;
  // No slot free: Claude Code sends four on every request after its first -- two on the system prompt and one
  // on the last block of each of the last two messages (read from its request bodies, 2026-11-17). The older
  // of those two is the one given up: the newest is what stores this request for the next one to read, and
  // the next request finds that entry from its own newest breakpoint without the older one's help.
  // Without this the breakpoint was never placed on a Claude Code request at all. Measured live the same day,
  // one nine-turn Haiku session each way, the cut's first replaced result some 30 positions from the end:
  // with the breakpoint the seeding request read 142,791 and wrote 43, and the cut read 78,931 and wrote
  // 2,100 (the tail was priced at 5,130); without it the cut read 18,588 -- the system prompt and tools --
  // and wrote 62,338 (priced whole at 70,201). The cut turn cost $0.027 against $0.136 by Claude Code's own
  // figure, and the turn after cost the same either way.
  let give = null;
  if (bp.n >= MAX_BREAKPOINTS) {
    const later = [];
    for (let i = k; i < messages.length; i++) (Array.isArray(messages[i]?.content) ? messages[i].content : []).forEach((b, n) => { if (b?.cache_control) later.push([i, n]); });
    if (later.length < 2) return null;
    give = later[0];
  }
  for (let i = k - 1; i >= 0; i--) {
    const n = markBlock(messages[i]);
    if (n < 0) continue;
    const c = messages[i].content, b = c[n];
    const ttl = copy.ttl || '5m';
    if (b.cache_control) return { messages, at: i, ttl, n: bp.n, had: true };   // one is already there
    const out = messages.slice();
    out[i] = { ...messages[i], content: c.map((x, q) => (q === n ? { ...x, cache_control: { ...copy } } : x)) };
    if (give) out[give[0]] = { ...out[give[0]], content: out[give[0]].content.map((x, q) => { if (q !== give[1]) return x; const { cache_control: _gone, ...rest } = x; return rest; }) };
    return { messages: out, at: i, ttl, n: give ? bp.n : bp.n + 1, ...(give ? { moved: give[0] } : {}) };
  }
  return null;
}
// Whether a cut on this request could be given its breakpoint, asked before anything is priced: room for
// one more, and a breakpoint at or after the oldest eligible result to copy the lifetime from.
export function canMark(j, cand, { cutInputs = PROXY_DEFAULTS.cutInputs } = {}) {
  if (!cand?.ids?.length) return null;
  const bp = breakpointsOf(j);
  // the newest eligible result is the shallowest cut there is, so a breakpoint after it is after every rung
  const k = firstTouched(j.messages, new Set([cand.ids[0]]), cutInputs);
  if (k <= 0) return null;
  // full already: there is room only where two of the agent's own sit after the cut, one of which can move
  if (bp.n >= MAX_BREAKPOINTS && bp.at.filter(i => i >= k).length < 2) return null;
  if (bp.at.length && bp.at[bp.at.length - 1] >= k) return { ttl: bp.ttls[bp.ttls.length - 1] };
  return j.cache_control ? { ttl: j.cache_control.ttl || '5m' } : null;
}

// What the cut took out, by tool, for the card and the Stop hook's line (compression.js). The cut
// knows which uses it replaced, so this needs no guess at what a server chose.
// `cutInputs`: the call's own text counts where it went too, so a call cut on its text alone (a long command
// that answered in a line) shows what it gave up and not the size of the line that stayed.
export function cutActions(messages, cut, { cutInputs = false } = {}) {
  const ids = new Set(cut), nameOf = new Map(), by = new Map();
  for (const m of (Array.isArray(messages) ? messages : [])) for (const b of (Array.isArray(m?.content) ? m.content : [])) if (b?.type === 'tool_use') nameOf.set(b.id, b.name);
  for (const id of ids) { const name = nameOf.get(id) || 'tool'; if (!by.has(name)) by.set(name, { name, calls: 0, tokens: 0 }); by.get(name).calls++; }
  for (const m of (Array.isArray(messages) ? messages : [])) for (const b of (Array.isArray(m?.content) ? m.content : [])) {
    if (cutInputs && b?.type === 'tool_use' && ids.has(b.id)) {
      const red = cutInput(b.input, { minChars: CUT_MIN_CHARS }), e = by.get(b.name || 'tool');
      if (red && e) e.tokens += Math.round(red.chars * RESULT_TOKENS_PER_CHAR);
      continue;
    }
    if (b?.type !== 'tool_result' || !ids.has(b.tool_use_id)) continue;
    const e = by.get(nameOf.get(b.tool_use_id) || 'tool');
    // a result too short to replace is still in the prompt, so it is nothing the cut took
    const text = resultText(b);
    if (e && (!cutInputs || text.length >= CUT_MIN_CHARS)) e.tokens += resultTokens(text);
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
  if (cfg.protocol === 'chat') return transformChat(method, url, headers, body, cfg);
  if (method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(url) || !body.length) return { body, reason: 'other' };
  let j;
  try { j = JSON.parse(body); } catch { return { body, reason: 'unparsed' }; }
  if (!j || !Array.isArray(j.messages)) return { body, reason: 'other' };
  // A switched-off tool's definition is replaced by the sentence that names its file (tool-stubs.js), on
  // every request, held-out ones included: the switch is the person's own decision, not the clearing's
  // experiment, and the same definition sent in full and as a stub in turn would rewrite the cache.
  const st = cfg.stubs ? stubTools(j.tools, cfg.stubs.read(), { seen: cfg.stubs.seen }) : null;
  const stubbed = st?.replaced.length ? { tools: st.replaced.map(r => r.name), chars: st.chars } : null;
  if (stubbed) j.tools = st.tools;
  // what goes upstream when the cut leaves the messages alone: the agent's bytes, unless a stub changed them
  const asCame = reason => stubbed ? { body: Buffer.from(JSON.stringify(j)), stubbed, ...reason } : { body, ...reason };
  if (heldOut(sessionOf(headers), cfg.holdout)) return asCame({ reason: 'holdout' });
  const cm = j.context_management && typeof j.context_management === 'object' ? j.context_management : {};
  const edits = Array.isArray(cm.edits) ? cm.edits : [];
  // an agent clearing for itself is left alone: two mechanisms over one conversation is nobody's policy
  if (edits.some(e => e && e.type === AGENT_CLEAR_TYPE)) return asCame({ reason: 'agent-clears' });
  // Thinker cuts the context itself (cutting.js): one decision at a turn boundary, then the same set
  // applied byte for byte on every call of the turn. Nothing is asked of the API.
  // the record is the conversation's, not the session's (`conversationKey`), and the store is asked for it
  // here because this is the first point the body has been parsed
  const rec = cfg.cutRecord || cfg.readCut?.(conversationKey(sessionOf(headers), j)) || freshCut('');
  const m = measurePrompt(cfg, j);
  // the thinking earlier cuts left out, and where a cut made now would stop: the start of the turn in progress,
  // or `thinkingKeepTurns` turns before it, so that only thinking that old goes (2026-11-17, 0 by default)
  const thinkTo = Math.max(m.turn - Math.max(0, Math.floor(cfg.thinkingKeepTurns || 0)), 0);
  // with turns held back, the earliest range so far is the one a new cut carries on (cutCandidates prices it)
  let firstRange = null;
  if (cfg.cutThinking && thinkTo < m.turn) for (const [id] of rec.think || []) { const at = cutAnchor(j.messages, new Set([id])); if (at >= 0 && (!firstRange || at < firstRange.at)) firstRange = { id, at }; }
  const thinking = cfg.cutThinking ? { to: turnIndex(j.messages, thinkTo), done: rec.think || [], ...(firstRange ? { from: firstRange.at + 1 } : {}) } : null;
  const cand = cutCandidates(j.messages, { keepMin: cfg.keepMin ?? 3, cut: rec.cut, cutInputs: cfg.cutInputs, imagePath: cfg.imagePath || null, thinking });
  // what the request carries for breakpoints rides on every row, because how many Claude Code sends and for
  // how long is what decides whether the proxy can add one, and no log said (2026-11-17)
  const had = breakpointsOf(j);
  const bp = { n: had.n, ttl: [...new Set(had.ttls)].join(',') };
  const room = cfg.cutBreakpoint ? canMark(j, cand, { cutInputs: cfg.cutInputs }) : null;
  const d = decideCut(rec, cfg, m, { cand, ttl: cfg.ttl, now: cfg.now, model: j.model, mark: !!room, markTtl: room?.ttl });
  // the images are on disk before the prompt loses them, or they stay in the prompt
  const imagePath = cfg.imagePath && d.cut?.length && saveCutImages(j.messages, d.cut, cfg.imagePath) ? cfg.imagePath : null;
  // a cut made on this request adds its own range: from the oldest result it newly replaces to this turn
  const fresh = thinking && d.clear ? d.cut.slice(rec.cut.length) : [];
  const anchor = fresh.length ? cutAnchor(j.messages, new Set(fresh)) : -1;
  const own = anchor >= 0 && thinkTo >= 1 ? j.messages[anchor].content.find(b => b?.type === 'tool_result' && fresh.includes(b.tool_use_id)).tool_use_id : null;
  const oldest = own && firstRange && firstRange.at < anchor ? firstRange.id : own;
  const think = thinking ? [...thinking.done, ...(oldest ? [[oldest, thinkTo]] : [])] : null;
  const applied = applyCut(j.messages, d.cut, { cutInputs: cfg.cutInputs, imagePath, thinking: think });
  // the breakpoint, on the request that seeds a cut and on the one that makes it (`cutting.js:SEED_MS`)
  const markStep = d.markIds && thinking ? cand.steps.find(s => s.ids.length === d.markIds.length) : null;
  const marked = d.markIds ? placeMark(j, applied.messages, d.markIds, { cutInputs: cfg.cutInputs, first: markStep?.thinkFirst ?? null }) : null;
  const markRow = marked ? { mark: { at: marked.at, ttl: marked.ttl, n: marked.n, ...(marked.had ? { had: true } : {}), ...(marked.moved != null ? { moved: marked.moved } : {}) } } : {};
  // A seed whose breakpoint could not be placed after all is no seed: the request goes as it came and the
  // next boundary decides again.
  const seed = 'seed' in d ? { seed: d.seed && !marked ? null : d.seed } : {};
  if (d.reason === 'seed' && marked) {
    j.messages = marked.messages;
    return { body: Buffer.from(JSON.stringify(j)), ...(stubbed ? { stubbed } : {}), policy: d.policy || policyId(cfg), reason: 'seed', model: j.model, turn: m.turn, cut: d.cut,
      bp, ...markRow, ...seed, ...(d.planned ? { planned: { tokens: d.planned.tokens, recache: d.planned.recache, whole: d.planned.whole, cost: Math.round(d.planned.cost), payback: d.planned.payback, depth: d.planned.depth, rungs: d.planned.rungs } } : {}),
      ...(d.candidate != null ? { candidate: d.candidate } : {}) };
  }
  // A refusal for size carries the size (`candidate`, 2026-11-06): until then the row said only
  // 'below-clear-minimum', so the log could not say whether a lower floor would have admitted the boundary,
  // and that question had to be answered by rebuilding request bodies from transcripts. The reason itself is
  // the decision's, never derived here from `candidate` (2026-11-08): see `cutting.js:decideCut`.
  // the policy that decided this, named on the row so no reader has to date it (cutting.js:policyId): on a
  // refusal it says which floor refused, on a clear it says what the saving is worth comparing with
  if (!applied.cut) return asCame({ policy: d.policy || policyId(cfg), reason: d.reason === 'seed' ? 'seed-unplaced' : d.reason || 'nothing-to-cut', model: j.model, turn: m.turn, cut: d.cut, bp, ...seed, ...(d.held ? { held: d.held } : {}), ...(d.candidate ? { candidate: d.candidate } : {}) });
  // What each action's result was worth is read from the request as the agent sent it, before the cut
  // replaces it: in `applied.messages` every cut result is already the placeholder, so the breakdown the
  // card, the Codex card, `thinker proxy report` and the agent's own `<thinker-compression>` block read
  // was the placeholders' own size -- 59 tokens for a 42k-char read, 531 against a session's 1.48M saved.
  // Wrong since the cut shipped (#610). `saved` was never affected: that is `applied.tokens`.
  const actions = cutActions(j.messages, d.cut, { cutInputs: cfg.cutInputs });
  j.messages = marked ? marked.messages : applied.messages;
  return { body: Buffer.from(JSON.stringify(j)), injected: true, bp, ...markRow, ...seed, model: j.model, keep: cfg.keepMin ?? 3, policy: d.policy || policyId(cfg),
    cut: d.cut, changed: !!d.clear, addBeta: false, actions, ...(stubbed ? { stubbed } : {}),
    // `inputChars` and `thinking` stood here until 2026-11-05 and `applyCut` returned neither: they are the
    // API-side clearing's fields, and the cut touches neither the call text nor the thinking.
    clientCut: { cut: applied.cut, chars: applied.chars, tokens: applied.tokens, firstChanged: applied.firstChanged, ...(applied.thinking != null ? { thinking: applied.thinking } : {}) },
    ...(oldest ? { think: [oldest, thinkTo] } : {}),
    // the decision's own arithmetic, so a cut can be audited against the floor that allowed it. `saving`,
    // `need` and `have` stood here until 2026-11-06 and `priceCut` returns none of them: it returns the
    // payback. No row ever carried them -- until the floor moved to 25 the Claude path made no cut at all,
    // so this branch had never run, and `Math.round(undefined)` would have logged `"saving":null`.
    ...(d.clear ? { clear: { tokens: d.tokens, recache: d.recache, ...(d.tail != null ? { tail: d.tail } : {}), ...(d.marked ? { whole: d.whole } : {}), ...(d.thinking != null ? { thinking: d.thinking } : {}), ...(d.seeded ? { seeded: true } : {}), cost: Math.round(d.cost), payback: d.payback, ...(d.depth != null ? { depth: d.depth, rungs: d.rungs } : {}), ...(d.cold ? { cold: true } : {}) }, tokens: d.tokens, recache: d.recache, cost: d.cost, payback: d.payback, cold: d.cold } : {}),
    ...(d.held ? { held: d.held } : {}),
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

export function startProxy(cfg, { logFile, host = '127.0.0.1', onListen, onStandDown = null, bedrock = null, agentOptions = {}, retryWaits = undefined, resolver = undefined, compressionDir = logFile ? path.join(path.dirname(logFile), 'compression') : null, clearingDir = logFile ? path.join(path.dirname(logFile), 'clearing') : null, dumpDir = process.env.THINKER_PROXY_DUMP || null, stubsHome = process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), routes = undefined } = {}) {
  // the model routes (providers.js): a request naming `thinker/…` goes to its provider (proxy-routing.js). The
  // registry is the machine's, re-read when its file moves; `routes: false` leaves every request on the upstream.
  const readRoutes = routes === false ? null : typeof routes === 'function' ? routes : stubsHome ? registryReader(stubsHome) : null;
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
  // Two refusals, two scopes. An upstream that cannot take the server-side edit will never take it, so that one
  // stops the editing for the proxy's whole life (`cutRejected`). A history the API will not accept is one
  // CONVERSATION's bound thinking, so that one stops the cutting for that session alone (`rejectedSessions`, the
  // owner's call, 2026-11-15): a proxy serves every agent on the machine at once, and one session's refusal is no
  // reason to stop saving tokens in the others. A session that has stood down never cuts again -- the binding it
  // broke does not heal, and trying again would spend another whole request to learn the same thing.
  let cutRejected = false;
  const rejectedSessions = new Set();
  // Where each upstream host last answered, so a resolver that goes quiet is not the end of a request
  // (proxy-retry.js). Filled from the lookups the requests make anyway; read only once one has failed.
  const addresses = addressBook();
  const lookup = cachingLookup(addresses, {
    ...(resolver ? { lookup: resolver } : {}),
    onFallback: (host, known) => log({ at: new Date().toISOString(), op: 'proxy-dns-fallback', host, family: known.family || null }),
  });
  // the cut's record, one per session, on disk: a restarted proxy re-applies the same set (cutting.js)
  const cutting = cutStore(clearingDir);
  // where a cut result's screenshots are kept, beside the cut's own records
  const imagePath = cfg.cutImages !== false && clearingDir ? imagePathIn(path.join(clearingDir, 'images')) : null;
  // the switched-off tools whose definitions live on disk (tool-stubs.js): the registry is the machine's, read when it changes
  if (!cfg.stubs) cfg = { ...cfg, stubs: stubsHome ? stubReader(stubsHome) : null };
  const responseCutting = cutStore(clearingDir ? path.join(clearingDir, 'responses') : null);
  const chatCutting = cutStore(clearingDir ? path.join(clearingDir, 'chat') : null);
  // one store per door, so a restarted proxy re-applies the same set whichever door wrote it
  const cutStoreOf = t => t.protocol === 'responses' ? responseCutting : t.protocol === 'chat' ? chatCutting : cutting;
  // Dynamic rates for the gateway door (gateway-rates.js): the gateways' own answers are the
  // price list. Fitted in memory from the `cost` each response carries; a restart refits within
  // a few calls, and config (`proxy: { rates }`) beats the fit until it exists.
  // The fit needs a gateway that reports its own `cost`; the price list does not, which is the only source a
  // direct provider route (providers.js) ever has. So the resolver is always built: without it a GLM route is
  // priced at Anthropic's ratios, which is wrong by a factor of ten in the direction that refuses every cut.
  const rates = createRateTracker();
  const ratesFor = makeRatesResolver({ tracker: rates, configured: cfg.ratesConfig, prices: statedRates });
  const watch = authWatch(reason => { log({ at: new Date().toISOString(), op: 'proxy-standdown', reason }); try { onStandDown(reason); } catch { /* the request in hand matters more */ } }, { on: !!onStandDown });
  // what is in flight, for a restart that waits until nothing is (proxy-service.js:idleRestartWatcher)
  let inFlight = 0, lastDone = Date.now();
  const server = http.createServer((req, res) => {
    inFlight++; res.once('close', () => { inFlight--; lastDone = Date.now(); });
    let requestUrl = req.url, requestCfg = cfg, onBedrock = false;
    if (requestUrl === BEDROCK_PATH || requestUrl.startsWith(BEDROCK_PATH + '/')) {
      try {
        const route = bedrockRequest(req, typeof bedrock === 'function' ? bedrock() : bedrock);
        requestUrl = route.url;
        req.headers = route.headers;
        requestCfg = { ...cfg, protocol: 'anthropic', upstream: route.upstream };
        onBedrock = true;
      } catch (e) {
        req.resume();
        res.writeHead(e.status || 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: e.message } }));
        return;
      }
    }
    if (cfg.codex && (requestUrl.startsWith(`${CODEX_PROXY_PATH}/`) || requestUrl === CODEX_PROXY_PATH)) {
      requestUrl = requestUrl.slice(CODEX_PROXY_PATH.length) || '/';
      // Codex adds this header when using ChatGPT auth. API-key requests have none.
      // Destinations are fixed OpenAI endpoints, never supplied by an incoming request.
      const upstreams = cfg.codexUpstreams || CODEX_UPSTREAMS;
      requestCfg = { ...cfg, protocol: 'responses', keep: 'turn', upstream: req.headers['chatgpt-account-id'] ? upstreams.chatgpt : upstreams.api };
    }
    // A gateway is a path prefix on this proxy (`/openrouter/v1/chat/completions`), as `/codex` is:
    // the agent's provider baseURL names the door, the prefix names the upstream, and one service
    // serves every door. Nothing configured passes through as it came.
    if (requestCfg.gateways) for (const [name, g] of Object.entries(requestCfg.gateways)) {
      if (requestUrl !== `/${name}` && !requestUrl.startsWith(`/${name}/`)) continue;
      requestUrl = requestUrl.slice(name.length + 1) || '/';
      // The agent's base URL ends in `/v1` (proxy-service.js writes `/openrouter/v1`, as an OpenAI client
      // expects) and so does OpenRouter's own (`https://openrouter.ai/api/v1`), and the two were joined as
      // they came: every request went to `/api/v1/v1/chat/completions` and came back 404. Found live on
      // 2026-11-15, the first time the door was pointed at OpenRouter itself rather than a fixture. One
      // version segment is the upstream's to name, so the agent's is dropped where the upstream has its own.
      if (/\/v1\/?$/.test(new URL(g.upstream).pathname)) requestUrl = requestUrl.replace(/^\/v1(?=\/|\?|$)/, '') || '/';
      requestCfg = { ...requestCfg, protocol: 'chat', gateway: name, upstream: g.upstream };
      break;
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const received = Buffer.concat(chunks);
      const raw = onBedrock ? bedrockBody(received) : received;
      // a routed request (proxy-routing.js): the provider is the upstream, and a route nobody registered is refused here
      let routed = null;
      if (readRoutes && !onBedrock && requestCfg.protocol !== 'responses' && requestCfg.protocol !== 'chat') {
        const r = routeOf(raw, requestUrl, readRoutes());
        if (r?.error) {
          log({ at: new Date().toISOString(), op: 'proxy-route-refused', session: sessionOf(req.headers), route: r.route, says: r.error.body.error.message });
          res.writeHead(r.error.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r.error.body));
          return;
        }
        if (r) { routed = r; requestCfg = { ...requestCfg, upstream: r.provider.url }; }
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
      const t0 = process.hrtime.bigint();
      let t;
      const noEdit = cutRejected || rejectedSessions.has(sessionOf(req.headers));
      // The record is read inside the transform, which is where the conversation can be told from the
      // session it shares with the others (`conversationKey`). Both protocols hand the key back the same way.
      let cutRec = null;
      try { t = noEdit ? { body: raw, reason: 'cut-rejected' } : transformRequest(req.method, requestUrl, req.headers, raw, { ...requestCfg, ratesFor, imagePath, readCut: key => (cutRec = key ? cutting.read(key) : null), readResponsesCut: session => (cutRec = responseCutting.read(session)), readChatCut: session => (cutRec = chatCutting.read(session)) }); } catch { t = { body: raw, reason: 'error' }; }
      // Reserve the boundary's decision before forwarding, including a decision not to cut.
      // Retries and concurrent requests in this turn must reuse the same set, even when a
      // later tool result would make a previously refused candidate profitable.
      if (cutRec && Array.isArray(t.cut) && t.turn != null) {
        cutRec.cut = t.cut; cutRec.turn = t.turn;
        if ('seed' in t) cutRec.seed = t.seed || null;   // null, not absent: a write merges over what is stored
        if (t.think) cutRec.think = addThink(cutRec.think, t.think);
        cutStoreOf(t).write(cutRec);
      }
      let n = null;
      let routedPath = requestUrl, routedStream = false, routeDropped = null;
      if (routed) {
        let rb;
        try { rb = routedBody(t.body, routed); } catch (e) { rb = null; log({ at: new Date().toISOString(), op: 'proxy-route-refused', session: sessionOf(req.headers), route: routed.route, says: e.message }); }
        if (!rb) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'thinker proxy: the request could not be translated for the route' } })); return; }
        t = { ...t, body: rb.body, addBeta: false };
        routedStream = rb.stream; routeDropped = rb.dropped;
        if (rb.path) routedPath = rb.path;
      }
      const headers = {};
      if (routed) {
        let rh;
        try { rh = routedHeaders(req.headers, routed); } catch (e) {
          log({ at: new Date().toISOString(), op: 'proxy-route-refused', session: sessionOf(req.headers), route: routed.route, says: e.message });
          res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `thinker proxy: ${e.message}` } })); return;
        }
        for (const [k, v] of Object.entries(rh)) if (!HOP.includes(k)) headers[k] = v;
      } else for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k)) headers[k] = v;
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
        else if (!routed && req.headers['anthropic-beta'] != null) headers['anthropic-beta'] = req.headers['anthropic-beta'];
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
        ureq = lib.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, path: base + routedPath, method: req.method, headers, agent: getAgent(!!attempt), lookup }, ures => {
          if (judgeAuth) watch.response(ures.statusCode);
          const firstByteMs = Date.now() - started;
          // A 400 on a request the proxy cut may be the cut itself being rejected -- a history the API will not
          // take -- or it may be about the request, which is the agent's own to see. The body says which
          // (`refusesEdit`), so it is read before anything reaches the agent: a rejection means the same request
          // goes again as the agent wrote it and nothing is cut for the rest of the proxy's life. This matters
          // more than it did when the API did the clearing: the edit is the proxy's own now, so a history the API
          // will not accept is the proxy's fault and the only safe answer is to stop editing. An in-place edit of
          // the history did exactly that in October. Anything else is passed on once, as it came: a real router
          // (LiteLLM 1.106.5, 2026-10-28) answered 400 over a model name it did not know, and taking that for a
          // rejection stopped the clearing over an unrelated error and sent every failing request twice.
          if (t.injected && !cutRejected && ures.statusCode === 400 && !res.headersSent && routed?.format !== 'chat') {
            const parts = [];
            let read = 0;
            let ended = false;
            const decide = () => {
              const body = Buffer.concat(parts);
              // not about the edit: the agent's own to see. The bytes are in hand and the stream may already be
              // over, so `deliver` is told to finish the response itself rather than wait for an 'end' that has been
              const refused = t.protocol === 'chat' ? refusesChatCut(body) : refusesEdit(body);
              // the history the proxy rewrote, refused by name. Checked second so that a body saying both still
              // reads as the edit, which is the wider stand-down of the two.
              const history = !refused && t.protocol !== 'chat' && refusesHistory(body);
              if (!refused && !history) return deliver(Buffer.from(body), ended);
              const session = t.session || sessionOf(req.headers) || null;
              if (history) rejectedSessions.add(session); else cutRejected = true;
              ures.resume();
              // `session` is what makes the figure a count of conversations rather than of requests: it was missing
              // from this row until 2026-11-15, so `proxyReport`'s `sessionsRejected` -- which keys on it -- could
              // only ever read 1 however many sessions had been refused. `says` stays on the machine; only counts
              // are ever sent (telemetry.js:proxyMetrics).
              // which door was refused. The Messages path is the only one that rewrites a call's own text, and the
              // only one where a thinking block is bound to the conversation's bytes at all -- but the Responses
              // (Codex) door replaces results through this same path, so a refusal there must not read as blank on a
              // machine that uses only that door (test/metrics-dashboard.test.js holds every card to both).
              log({ at: new Date().toISOString(), op: 'proxy-cut-rejected', kind: history ? 'history' : 'edit',
                door: t.protocol === 'responses' ? 'responses' : 'messages',
                session, upstream: up.origin, status: 400, says: String(body).slice(0, 200),
                ...(t.policy ? { policy: t.policy } : {}), ...(t.clientCut?.cut ? { cut: t.clientCut.cut } : {}) });
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
          const chat = routed?.format === 'chat';
          const out = {};
          for (const [k, v] of Object.entries(ures.headers)) if (!['connection', 'keep-alive', 'transfer-encoding', ...(chat ? ['content-length', 'content-type', 'content-encoding'] : [])].includes(k)) out[k] = v;
          const tap = t.reason === 'other' ? null : t.protocol === 'responses' ? responsesUsageTap() : t.protocol === 'chat' ? chatUsageTap() : usageTap();
          const okStatus = ures.statusCode >= 200 && ures.statusCode < 300;
          const record = () => {
            if (recorded) return;
            recorded = true;
            res.removeListener('close', record);
            const usage = tap ? tap.result() : null;
            // the gateway's own accounting feeds the rates the next decision is priced with
            if (rates && t.protocol === 'chat' && ures.statusCode === 200 && Number.isFinite(usage?.cost)) { try { rates.observe(t.model, usage); } catch { /* a rate is never worth a failed request */ } }
            if (tap) logProxy({ at: new Date().toISOString(), op: 'proxy', session: t.session || sessionOf(req.headers), model: t.model, status: ures.statusCode,
              ...(t.protocol === 'responses' || t.protocol === 'chat' ? { protocol: t.protocol, ...(t.gateway ? { gateway: t.gateway } : {}), ...(t.usageRequested ? { usageRequested: true } : {}), ...(t.rates ? { rates: t.rates } : {}), removedBytes: t.removedBytes || 0, estimatedRemovedTokens: t.estimatedRemovedTokens || 0, clearedUses: t.clearedUses || 0 } : {}),
              injected: !!t.injected, ...(t.stubbed ? { stubbed: t.stubbed } : {}), ...(t.clientCut ? { clientCut: t.clientCut } : {}), ...(t.clear ? { clear: t.clear } : {}), ...(t.bp ? { bp: t.bp } : {}), ...(t.mark ? { mark: t.mark } : {}), ...(t.planned ? { planned: t.planned } : {}), ...(t.held ? { held: t.held } : {}), ...(t.candidate != null ? { candidate: t.candidate } : {}), ...(t.policy ? { policy: t.policy } : {}), ...(t.turn != null ? { turn: t.turn } : {}), ...(t.injected ? { keep: t.keep, ...(t.inputs ? { inputs: true } : {}) } : { reason: t.reason }), ...(t.addBeta ? { betaAdded: true } : {}), ...(t.notes ? { notes: t.notes.served.length, notesReplayed: t.notes.replayed, ...(t.notes.reason ? { notesReason: t.notes.reason } : {}) } : {}), overheadMs: Math.round(overheadMs * 1000) / 1000, ...(attempt ? { retried: true } : {}), ...(truncated ? { truncated: true } : {}), ...(routed ? routeRow(routed, { firstByteMs, ...(routeDropped?.length ? { dropped: routeDropped } : {}) }) : {}), ...usage, ...clearedBy(t) }, t.actions);
            dump(t.session || sessionOf(req.headers), t, usage);
            // the record after the answer (cutting.js:cutResponse): what the cut saved, what the rewrite cost;
            // each event is a log line, and the record goes back to disk
            if (tap && cutRec && Array.isArray(t.cut) && ures.statusCode >= 200 && ures.statusCode < 300) {
              // through the store's read-modify-write, so the counters land on the record as it is now: another
              // request of this conversation may have reserved the next boundary while this answer streamed
              for (const ev of cutStoreOf(t).update(cutRec.session, rec => cutResponse(rec, requestCfg, t, usage))) log({ at: new Date().toISOString(), op: 'proxy-cut', session: t.session || sessionOf(req.headers), model: t.model, ...ev, read: usage.read, write: usage.write });
            }
          };
          if (chat && (!okStatus || !routedStream)) {
            // whole: the provider's JSON becomes the API's shape (an error at its own status) once it is all here
            const parts = [];
            ures.removeAllListeners('data');
            ures.on('data', c => parts.push(c));
            if (ures.isPaused?.()) ures.resume();
            const finish = () => {
              const text = Buffer.concat(parts).toString('utf8');
              let bodyOut;
              if (okStatus) { let j = null; try { j = JSON.parse(text); } catch {} bodyOut = JSON.stringify(j ? fromChat(j, { model: routed.model }) : errorToMessages(502, 'the provider answered something that is not JSON')); }
              else bodyOut = JSON.stringify(errorToMessages(ures.statusCode, text));
              if (!res.headersSent) res.writeHead(okStatus ? ures.statusCode : ures.statusCode, { ...out, 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyOut) });
              res.write(bodyOut); tap?.push(bodyOut);
              record(); res.end();
            };
            ures.on('end', finish);
            ures.on('error', e => { if (!recorded) { truncated = true; logError(e, { retried: false, truncated: true }); } res.destroy(); });
            res.once('close', record);
            return;
          }
          const chatStream = chat ? chatStreamToMessages({ model: routed.model }) : null;
          res.writeHead(ures.statusCode, chat ? { ...out, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } : out);
          if (prefix?.length) { res.write(prefix); tap?.push(prefix); }
          ures.removeAllListeners('data');
          ures.on('data', c => { if (chatStream) { const s = chatStream.push(c); if (s) { res.write(s); tap?.push(s); } } else { res.write(c); tap?.push(c); } });
          if (ures.isPaused?.()) ures.resume();
          // Codex closes SSE as soon as response.completed arrives, before the HTTP
          // body ends. Record that request too, exactly once, using usage seen so far.
          res.once('close', record);
          ures.on('end', () => {
            if (chatStream) { const s = chatStream.end(); if (s) { res.write(s); tap?.push(s); } }
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
  server.load = () => ({ inFlight, idleMs: Date.now() - lastDone });
  server.on('close', () => { for (const agent of agents.values()) { agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy(); } });
  server.listen(cfg.port || 0, host, () => onListen?.(server.address()));
  return server;
}

// What the log says: per side of the holdout, the requests, their billed-equivalent input (a cache read at
// 0.1, a write at 2: Claude Code's writes are one-hour ones) and what the server cleared.
export function proxyReport(rows, { since } = {}) {
  const sides = {};
  for (const r of rows) {
    if (r.protocol === 'responses' || r.protocol === 'chat') continue;
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
  const chat = chatReport(rows, { since });
  // A cut refused by the API is the one way the cutting stops now (proxy.js:cutRejected, rejectedSessions). Two
  // kinds, counted apart because they mean different things and have different scopes: `edit` is an upstream that
  // cannot take the server-side field at all and stops the editing for the proxy's life; `history` is the API
  // refusing the rewritten conversation and stops the cutting for that session. A row with no session is from
  // before the session was written on it (2026-11-15) and counts as a refusal but not as a conversation.
  const refusals = rows.filter(r => r.op === 'proxy-cut-rejected' && (!since || r.at >= since));
  const rejected = new Set(refusals.filter(r => r.session).map(r => r.session));
  if (outSides.clearing) {
    outSides.clearing.sessionsRejected = rejected.size;
    outSides.clearing.rejected = refusals.length;
    outSides.clearing.rejectedHistory = refusals.filter(r => r.kind === 'history').length;
  }
  const warning = rewriteWarning(outSides);
  return { ...outSides, ...(warning ? { warning } : {}), ...(Object.keys(responses).length ? { responses } : {}), ...(Object.keys(chat).length ? { chat } : {}) };
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
