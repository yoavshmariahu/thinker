// OpenAI Chat Completions tool-output clearing, for the model gateways (the owner's call, 2026-11-10):
// OpenRouter and a LiteLLM proxy today, a new gateway is a config entry, not a new door.
// No model calls, no transcript writes: only full-history requests sent upstream are shortened.
// The same shared cut policy as the Messages and Responses doors (`src/cutting.js:decideCut`);
// what differs here is wire format and where the request is answered from, never the policy.
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { decideCut, freshCut, MIN_CHARS, placeholder } from './cutting.js';

// OpenRouter answers every call with the account's own cost and cache split in the usage object
// (openrouter.ai/docs/use-cases/usage-accounting); LiteLLM normalizes tokens and needs
// stream_options.include_usage asked for. Preserved raw beside the normalized fields.
// Responses has no measured calibration for either shape; estimate tokens from characters.
const TOKENS_PER_CHAR = 0.25;
const isToolMessage = m => m?.role === 'tool' && typeof m.tool_call_id === 'string' && m.tool_call_id.length > 0;
const isUserMessage = m => m?.role === 'user';
const isCutText = t => t.startsWith('[tool result removed by thinker') || t === '[thinker: an older turn\'s tool output was cleared. Run the tool again if you need it.]';
const plainContent = content => typeof content === 'string' ? content
  : Array.isArray(content) && content.length > 0 && content.every(p => p?.type === 'text' && typeof p.text === 'string')
    ? content.map(p => p.text).join('') : null;

// A conversation is named by its own first user message, as on the Messages door
// (proxy.js:conversationKey): a gateway sends no session header of thinker's, and the ratchet
// needs a key that every later request of the conversation resends unchanged. `j.user` (the
// OpenAI end-user field) wins where an agent sets one. Two conversations opened with the same
// first message share a record; that residue is the conversationKey rule's own.
export function chatSession(j) {
  if (typeof j?.user === 'string' && j.user) return j.user;
  const first = (Array.isArray(j?.messages) ? j.messages : []).find(isUserMessage);
  const text = plainContent(first?.content);
  if (!text) return null;
  return `chat#${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

const heldOut = (session, share) => share >= 1 || (share > 0 && crypto.createHash('sha256').update(session).digest().readUInt32BE(0) / 2 ** 32 < share);

// Wire-format adapter only. Selection thresholds, payback and turn boundaries live in cutting.js.
export function applyChatCut(messages, cut) {
  const ids = cut instanceof Set ? cut : new Set(cut || []);
  let removedBytes = 0, chars = 0, clearedUses = 0, firstChanged = -1;
  const out = messages.map((m, i) => {
    if (!isToolMessage(m) || !ids.has(m.tool_call_id)) return m;
    const old = plainContent(m.content);
    if (old == null || isCutText(old)) return m;
    const replacement = placeholder(old.length);
    if (old.length < MIN_CHARS || old.length <= replacement.length) return m;
    const content = typeof m.content === 'string' ? replacement : [{ type: 'text', text: replacement }];
    removedBytes += Buffer.byteLength(JSON.stringify(m.content)) - Buffer.byteLength(JSON.stringify(content));
    chars += old.length; clearedUses++;
    if (firstChanged < 0) firstChanged = i;
    return { ...m, content };
  });
  return { messages: clearedUses ? out : messages, removedBytes, chars, clearedUses, firstChanged };
}

export function chatCandidates(messages, { keepMin = 3, cut = [], minChars = MIN_CHARS } = {}) {
  const existing = new Set(cut), ids = [];
  let inLatestTurn = true, kept = 0, chars = 0, firstChanged = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isUserMessage(m)) { inLatestTurn = false; continue; }
    if (!isToolMessage(m)) continue;
    if (inLatestTurn || kept < keepMin) { kept++; continue; }
    if (existing.has(m.tool_call_id)) continue;
    const value = plainContent(m.content);
    if (value == null || value.length < minChars || isCutText(value)) continue;
    ids.push(m.tool_call_id); chars += value.length; firstChanged = i;
  }
  const sent = firstChanged < 0 ? [] : applyChatCut(messages.slice(firstChanged), [...existing, ...ids]).messages;
  return { ids, chars, tokens: Math.round(chars * TOKENS_PER_CHAR), firstChanged, recache: JSON.stringify(sent).length * TOKENS_PER_CHAR };
}

// LiteLLM only reports usage on a streamed call when asked (OpenRouter deprecated the flag and
// always includes it). A field the standard defines, asked for once, never over an answer the
// agent set itself.
const withUsageAsked = j => {
  if (j.stream !== true || j.stream_options != null) return j;
  return { ...j, stream_options: { include_usage: true } };
};

export function transformChat(method, url, headers, body, cfg) {
  if (method !== 'POST' || !/^\/(?:v1\/)?chat\/completions(?:\?|$)/.test(url)) return { body, reason: 'other' };
  const unchanged = reason => ({ body, protocol: 'chat', reason });
  if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') return unchanged('encoded-request');
  let j;
  let out = body;   // the bytes to forward: the agent's own unless something was rewritten
  try { j = JSON.parse(body); } catch { return unchanged('unparsed'); }
  if (!j || typeof j !== 'object' || !Array.isArray(j.messages)) return unchanged('not-chat-shape');
  // LiteLLM only reports usage on a streamed call when asked (OpenRouter deprecated the flag and
  // always includes it), and a row is logged whatever the decision was, so the ask rides on every
  // forwarded request, cut or not. A field the standard defines, asked for once, never over an
  // answer the agent set itself.
  const asked = withUsageAsked(j);
  const usageAsked = asked !== j;
  if (usageAsked) { j = asked; out = Buffer.from(JSON.stringify(j)); }
  const session = chatSession(j);
  const meta = { protocol: 'chat', gateway: cfg.gateway, session, model: j.model, ...(usageAsked ? { usageRequested: true } : {}) };
  const pass = reason => ({ body: out, ...meta, reason });
  if (j.messages.some(m => m?.role === 'tool' && Array.isArray(m.content) && m.content.some(p => p?.type !== 'text'))) return pass('mixed-content');
  if (!session) return pass('missing-session');
  if (heldOut(String(session), cfg.holdout)) return pass('holdout');
  const turn = j.messages.filter(isUserMessage).length;
  if (!turn) return pass('no-user-turn');
  const rec = cfg.cutRecord || cfg.readChatCut?.(session) || freshCut(session);
  // the decision's rates, per model: config first, then the gateway's own measured prices
  // (gateway-rates.js), then the Anthropic defaults the shared policy has always kept.
  const rates = cfg.ratesFor?.(j.model) || null;
  const prompt = out.length * TOKENS_PER_CHAR;
  const candidate = chatCandidates(j.messages, { keepMin: cfg.keepMin ?? 3, cut: rec.cut });
  const decision = decideCut(rec, cfg, { prompt, turn }, { cand: candidate, ttl: cfg.ttl, now: cfg.now, model: j.model, rates });
  const applied = applyChatCut(j.messages, decision.cut);
  const state = { model: j.model, session, turn, cut: decision.cut, policy: decision.policy,
    ...(decision.rates ? { rates: decision.rates } : {}),
    ...(decision.candidate != null ? { candidate: decision.candidate } : {}),
    ...(decision.held ? { held: decision.held } : {}),
    ...(decision.clear ? { clear: { tokens: decision.tokens, recache: decision.recache, cost: decision.cost, payback: decision.payback, ...(decision.depth != null ? { depth: decision.depth, rungs: decision.rungs } : {}), ...(decision.cold ? { cold: true } : {}) }, tokens: decision.tokens, recache: decision.recache, cost: decision.cost, cold: decision.cold } : {}) };
  // the reason is the decision's own, as on both other doors: deriving it here saw neither mid-turn nor one-cut
  if (!applied.clearedUses) return { body: out, ...meta, ...state, estimatedInputTokens: prompt, usageRequested: meta.usageRequested, reason: decision.reason || 'nothing-to-cut' };
  return { ...meta, ...state, body: Buffer.from(JSON.stringify({ ...j, messages: applied.messages })), injected: true,
    usageRequested: meta.usageRequested,
    reason: 'client-clear', keep: cfg.keepMin ?? 3, removedBytes: applied.removedBytes,
    clearedUses: applied.clearedUses, estimatedRemovedTokens: applied.chars * TOKENS_PER_CHAR, estimatedInputTokens: prompt,
    clientCut: { cut: applied.clearedUses, chars: applied.chars, tokens: applied.chars * TOKENS_PER_CHAR, firstChanged: applied.firstChanged } };
}

// A 400 to a cut chat request may be the cut itself refused (a gateway that will not take the
// placeholder) or about the request (a model name LiteLLM does not know). The lesson of the
// Messages door holds: taking every 400 for a refusal switched the clearing off over an
// unrelated error and sent every failing request twice. Here the error names the cut when the
// cut is the problem -- gateways echo offending content -- so only that stops the editing;
// anything else is passed on once, as it came.
export const refusesChatCut = body => String(body).includes('tool result removed by thinker');

// Usage from an OpenAI-shaped answer, streamed or plain, in the row's own field names.
// Reads and writes are the details the gateway passes through: `cached_tokens` is what the
// upstream read from its cache, `cache_write_tokens` what it wrote (OpenRouter, for models with
// explicit-cache pricing; implicit caching has no writes and reports none). `cost` is
// OpenRouter's own accounting in dollars -- the account's ground truth, kept as data.
const tokenCount = n => Number.isSafeInteger(n) && n >= 0;
export function chatUsage(usage) {
  const details = usage?.prompt_tokens_details;
  const values = { input: usage?.prompt_tokens, read: details?.cached_tokens, write: details?.cache_write_tokens, out: usage?.completion_tokens };
  const out = Object.fromEntries(Object.entries(values).filter(([, n]) => tokenCount(n)));
  if (Number.isFinite(usage?.cost)) out.cost = usage.cost;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    out.apiUsage = structuredClone(usage);
  }
  if (tokenCount(out.input) && tokenCount(out.read) && tokenCount(out.write)) {
    if (out.read + out.write <= out.input) out.freshInput = out.input - out.read - out.write;
    else out.usageInconsistent = true;
  }
  return out;
}

export function chatUsageTap() {
  const limit = 8 * 1024 * 1024, decoder = new StringDecoder('utf8');
  let tail = '', whole = '', usage, meta = {}, eventData = [], eventSize = 0, sse = false, limited = false, skipLine = false, final;
  const take = chunk => {
    const u = chunk?.usage;
    if (!u || typeof u !== 'object' || Array.isArray(u)) return;
    usage = u;
    meta = Object.fromEntries([['responseId', chunk.id], ['responseModel', chunk.model]]
      .filter(([, v]) => typeof v === 'string'));
  };
  const parse = text => { try { take(JSON.parse(text)); } catch {} };
  const line = value => {
    if (value.startsWith('data:')) {
      sse = true; whole = '';
      const data = value.slice(5).trimStart(); eventSize += data.length;
      if (eventSize > limit) { eventData = []; limited = true; }
      else { eventData.push(data); parse(eventData.join('\n')); }
    } else if (!value.trim()) { if (eventData.length) parse(eventData.join('\n')); eventData = []; eventSize = 0; }
  };
  const consume = text => {
    if (!sse) { if (whole !== null && whole.length + text.length <= limit) whole += text; else { whole = null; limited = true; } }
    tail += text;
    let end;
    while ((end = tail.indexOf('\n')) >= 0) {
      const value = tail.slice(0, end).replace(/\r$/, ''); tail = tail.slice(end + 1);
      if (!skipLine && value.length <= limit) line(value);
      else { limited = true; skipLine = false; eventData = []; eventSize = 0; }
    }
    if (tail.length > limit) { tail = ''; skipLine = true; limited = true; }
  };
  return {
    push(chunk) { consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); },
    result() {
      if (final) return final;
      consume(decoder.end());
      if (!skipLine && tail.trim()) { if (sse || tail.startsWith('data:')) line(tail); }
      if (eventData.length) parse(eventData.join('\n'));
      if (!usage && whole) parse(whole);
      return final = { ...chatUsage(usage), ...meta, ...(!usage && limited ? { usageCaptureLimited: true } : {}) };
    },
  };
}

export function chatReport(rows, { since } = {}) {
  const sides = {};
  for (const r of rows) {
    if (r.op !== 'proxy' || r.protocol !== 'chat' || (since && r.at < since)) continue;
    const key = `${r.gateway || 'gateway'}:${r.injected ? 'clearing' : r.reason === 'holdout' ? 'holdout' : 'unchanged'}`;
    const s = sides[key] ||= { requests: 0, sessions: new Set(), input: 0, cachedInput: 0, output: 0, cost: 0, costRequests: 0,
      removedBytes: 0, removedTokens: 0, errors: 0, truncated: 0, reasons: {}, cacheWrite: null, writeCoverage: { reported: 0, missing: 0 }, freshInput: null, freshInputRequests: 0 };
    s.requests++; s.sessions.add(r.session); s.input += r.input || 0; s.cachedInput += r.read || 0; s.output += r.out || 0;
    if (Number.isFinite(r.cost)) { s.cost += r.cost; s.costRequests++; }
    if (tokenCount(r.write)) s.cacheWrite = (s.cacheWrite ?? 0) + r.write;
    if (tokenCount(r.write)) s.writeCoverage.reported++; else s.writeCoverage.missing++;
    const inconsistent = r.usageInconsistent || (tokenCount(r.input) && tokenCount(r.read) && tokenCount(r.write) && r.read + r.write > r.input);
    if (!inconsistent && [r.input, r.read, r.write].every(tokenCount)) {
      s.freshInput = (s.freshInput ?? 0) + r.input - r.read - r.write; s.freshInputRequests++;
    }
    s.removedBytes += r.removedBytes || 0;
    // The cut's own estimate, the same unit the Responses door reports (`proxy-responses.js:responsesReport`):
    // no gateway is told anything, so the row's estimate is the only token figure this path has.
    s.removedTokens += r.estimatedRemovedTokens || 0;
    if (r.status >= 400) s.errors++;
    if (r.truncated) s.truncated++;
    if (r.reason) s.reasons[r.reason] = (s.reasons[r.reason] || 0) + 1;
  }
  for (const s of Object.values(sides)) {
    if (s.freshInputRequests !== s.requests) s.freshInput = null;
    if (!s.costRequests) { s.cost = null; s.costRequests = 0; } // a partial sum is not the account
    else s.cost = Math.round(s.cost * 1e6) / 1e6;
  }
  return sides;
}
