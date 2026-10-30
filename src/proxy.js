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
export const PROXY_DEFAULTS = { upstream: 'https://api.anthropic.com', trigger: 140000, keep: 'turn', keepMin: 3, clearAtLeast: 100000, holdout: 0, clearInputs: true, clearThinking: true };
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
export function turnToolUses(messages) {
  let n = 0;
  for (const m of messages.slice(turnStart(messages))) if (m?.role === 'assistant' && Array.isArray(m.content)) n += m.content.filter(b => b?.type === 'tool_use').length;
  return n;
}
export const keepValue = (cfg, messages) => cfg.keep === 'turn' ? Math.max(cfg.keepMin ?? 0, turnToolUses(messages || [])) : cfg.keep;

export function clearEdit(cfg, messages) {
  return {
    type: EDIT_TYPE,
    trigger: { type: 'input_tokens', value: cfg.trigger },
    keep: { type: 'tool_uses', value: keepValue(cfg, messages) },
    clear_at_least: { type: 'input_tokens', value: cfg.clearAtLeast },
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
// Which of the agent's own actions a clear takes, named from the request the proxy is already scanning. The API
// reports how much it cleared and how many tool uses, never which: the names are the proxy's own reckoning of the
// same window the edit describes -- every tool use but the newest `keep`, with the size of its result at
// TOKENS_PER_CHAR. So the agent can be told what the saving was made of, which is the question the figure raises.
// Aggregated by tool name, biggest first, and the breakdown describes the set cleared out of *this* prompt: it is
// never added up across requests, since each request clears the same cumulative set again.
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
  const edit = clearEdit(cfg, j.messages), thinking = thinkingEdit(cfg, j.messages);
  const kept = thinking ? edits.filter(e => !(e && e.type === THINKING_EDIT_TYPE)) : edits;
  j.context_management = { ...cm, edits: [...(thinking ? [thinking] : []), ...kept, edit] };
  return { body: Buffer.from(JSON.stringify(j)), injected: true, model: j.model, keep: edit.keep.value, addBeta: !betaOn(headers), actions: clearedActions(j.messages, edit.keep.value), ...(cfg.clearInputs ? { inputs: true } : {}), ...(thinking ? { thinkingKeep: thinking.keep.value } : {}) };
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
        cleared: cleared.reduce((a, e) => a + (e.cleared_input_tokens || 0), 0), clearedUses: cleared.reduce((a, e) => a + (e.cleared_tool_uses || 0), 0), editAcknowledged: !!seen.acknowledged,
      };
    },
  };
}

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'];

// `notes`: a proxy-notes.js NoteInjector; the notes for an agent with no prompt hook go into the last user turn
export function startProxy(cfg, { logFile, host = '127.0.0.1', onListen, notes = null, onStandDown = null, agentOptions = {}, compressionDir = logFile ? path.join(path.dirname(logFile), 'compression') : null } = {}) {
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
      try { t = noEdit ? { body: raw, reason: 'edit-unsupported' } : transformRequest(req.method, requestUrl, req.headers, raw, requestCfg); } catch { t = { body: raw, reason: 'error' }; }
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
            if (tap) logProxy({ at: new Date().toISOString(), op: 'proxy', session: t.session || sessionOf(req.headers), model: t.model, status: ures.statusCode,
              ...(t.protocol === 'responses' ? { protocol: 'responses', removedBytes: t.removedBytes || 0, estimatedRemovedTokens: t.estimatedRemovedTokens || 0, clearedUses: t.clearedUses || 0 } : {}),
              injected: !!t.injected, ...(t.injected ? { keep: t.keep, ...(t.inputs ? { inputs: true } : {}), ...(t.thinkingKeep != null ? { thinkingKeep: t.thinkingKeep } : {}) } : { reason: t.reason }), ...(t.addBeta ? { betaAdded: true } : {}), ...(t.notes ? { notes: t.notes.served.length, notesReplayed: t.notes.replayed, ...(t.notes.reason ? { notesReason: t.notes.reason } : {}) } : {}), overheadMs: Math.round(overheadMs * 1000) / 1000, ...(attempt ? { retried: true } : {}), ...(truncated ? { truncated: true } : {}), ...tap.result() }, t.actions);
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
    const s = sides[side] ||= { requests: 0, sessions: new Set(), input: 0, read: 0, write: 0, out: 0, cleared: 0, clears: 0, truncated: 0, overheadMs: [] };
    s.requests++; if (r.session) s.sessions.add(r.session); if (r.truncated) s.truncated++;
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
      overheadP50: ms[Math.floor(ms.length / 2)] ?? 0, overheadP99: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.99))] ?? 0 };
  }
  const responses = responsesReport(rows, { since });
  return { ...outSides, ...(Object.keys(responses).length ? { responses } : {}) };
}
