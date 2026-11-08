// Responses API tool-output clearing (default-on service wiring at the owner's request).
// No model calls, no transcript writes:
// Codex keeps its history; only full-history requests sent upstream are shortened.
// Use Claude’s shared cut policy at turn boundaries; reapply the persisted set on every request.
// Never touch linked server-side histories or Codex's own compaction requests.
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { decideCut, freshCut, MIN_CHARS, placeholder } from './cutting.js';

export const CLEARED_OUTPUT = '[thinker: an older turn\'s tool output was cleared. Run the tool again if you need it.]';
export const responsesSession = (headers, request = {}) => headers['session_id'] || headers['x-codex-session-id'] || request.prompt_cache_key || null;
const heldOut = (session, share) => share >= 1 || (share > 0 && crypto.createHash('sha256').update(session).digest().readUInt32BE(0) / 2 ** 32 < share);
const outputItem = item => ['function_call_output', 'custom_tool_call_output'].includes(item?.type) && typeof item.call_id === 'string' && item.call_id.length > 0;
const isToolOutput = outputItem;
const isUserMessage = item => item?.role === 'user' && (!item.type || item.type === 'message');
// Responses has no measured Anthropic calibration factor; estimate its tokens
// from characters, then pass token quantities into the shared decision policy.
const TOKENS_PER_CHAR = 0.25;
const plainOutput = output => typeof output === 'string' ? output : Array.isArray(output) && output.length > 0 && output.every(b => b?.type === 'input_text' && typeof b.text === 'string') ? output.map(b => b.text).join('') : null;

// Wire-format adapters only. Selection thresholds, payback, and turn-boundary decisions
// live in cutting.js and are shared with Claude's Messages path.
export function applyResponsesCut(input, cut) {
  const ids = cut instanceof Set ? cut : new Set(cut || []);
  let removedBytes = 0, chars = 0, clearedUses = 0, firstChanged = -1;
  const out = input.map((item, i) => {
    if (!isToolOutput(item) || !ids.has(item.call_id)) return item;
    const old = plainOutput(item.output);
    if (old == null || old === CLEARED_OUTPUT || old.startsWith('[tool result removed by thinker after use:')) return item;
    const replacement = placeholder(old.length);
    if (old.length < MIN_CHARS || old.length <= replacement.length) return item;
    const output = typeof item.output === 'string' ? replacement : [{ type: 'input_text', text: replacement }];
    removedBytes += Buffer.byteLength(JSON.stringify(item.output)) - Buffer.byteLength(JSON.stringify(output));
    chars += old.length; clearedUses++;
    if (firstChanged < 0) firstChanged = i;
    return { ...item, output };
  });
  return { input: clearedUses ? out : input, removedBytes, chars, clearedUses, firstChanged };
}

export function responsesCandidates(input, { keepMin = 3, cut = [], minChars = MIN_CHARS } = {}) {
  const existing = new Set(cut), ids = [];
  let inLatestTurn = true, kept = 0, chars = 0, firstChanged = -1;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (isUserMessage(item)) { inLatestTurn = false; continue; }
    if (!isToolOutput(item)) continue;
    if (inLatestTurn || kept < keepMin) { kept++; continue; }
    if (existing.has(item.call_id)) continue;
    const value = plainOutput(item.output);
    if (value == null || value.length < minChars || value === CLEARED_OUTPUT || value.startsWith('[tool result removed by thinker after use:')) continue;
    ids.push(item.call_id); chars += value.length; firstChanged = i;
  }
  const sent = firstChanged < 0 ? [] : applyResponsesCut(input.slice(firstChanged), [...existing, ...ids]).input;
  return { ids, chars, tokens: chars * TOKENS_PER_CHAR, firstChanged, recache: JSON.stringify(sent).length * TOKENS_PER_CHAR };
}

export function transformResponses(method, url, headers, body, cfg) {
  if (method !== 'POST' || !/^\/(?:v1\/)?responses(?:\?|$)/.test(url)) return { body, reason: 'other' };
  const unchanged = reason => ({ body, protocol: 'responses', reason });
  if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') return unchanged('encoded-request');
  let j;
  try { j = JSON.parse(body); } catch { return unchanged('unparsed'); }
  if (!j || typeof j !== 'object') return unchanged('unparsed');
  const session = responsesSession(headers, j);
  const meta = { protocol: 'responses', session, model: j.model };
  const pass = reason => ({ body, ...meta, reason });
  if (j.previous_response_id || j.conversation || !Array.isArray(j.input)) return pass('linked-or-non-array-history');
  if (j.input.some(i => i?.type === 'item_reference')) return pass('referenced-history');
  if (j.input.some(i => i?.type === 'compaction_trigger') || j.context_management != null) return pass('native-compaction');
  if (!session) return pass('missing-session');
  if (heldOut(String(session), cfg.holdout)) return pass('holdout');
  const turn = j.input.filter(isUserMessage).length;
  if (!turn) return pass('no-user-turn');
  const rec = cfg.cutRecord || cfg.readResponsesCut?.(session) || freshCut(session);
  const prompt = body.length * TOKENS_PER_CHAR;
  const candidate = responsesCandidates(j.input, { keepMin: cfg.keepMin ?? 3, cut: rec.cut });
  const decision = decideCut(rec, cfg, { prompt, turn }, { cand: candidate, ttl: cfg.ttl, now: cfg.now, model: j.model });
  const applied = applyResponsesCut(j.input, decision.cut);
  const state = { model: j.model, session, turn, cut: decision.cut,
    ...(decision.candidate != null ? { candidate: decision.candidate } : {}),
    ...(decision.held ? { held: decision.held } : {}),
    ...(decision.clear ? { clear: { tokens: decision.tokens, recache: decision.recache, cost: decision.cost, payback: decision.payback, ...(decision.cold ? { cold: true } : {}) }, tokens: decision.tokens, recache: decision.recache, cost: decision.cost, cold: decision.cold } : {}) };
  // the reason is the decision's, as on the Messages door: deriving it here saw neither mid-turn nor one-cut
  if (!applied.clearedUses) return { body, ...meta, ...state, estimatedInputTokens: prompt, reason: decision.reason || 'nothing-to-cut' };
  return { ...meta, ...state, body: Buffer.from(JSON.stringify({ ...j, input: applied.input })), injected: true,
    reason: 'client-clear', keep: cfg.keepMin ?? 3, removedBytes: applied.removedBytes,
    clearedUses: applied.clearedUses, estimatedRemovedTokens: applied.chars * TOKENS_PER_CHAR, estimatedInputTokens: prompt,
    clientCut: { cut: applied.clearedUses, chars: applied.chars, tokens: applied.chars * TOKENS_PER_CHAR, firstChanged: applied.firstChanged } };

}

// Usage stays in raw provider token units: Responses input includes both reads and writes.
// https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance
const tokenCount = n => Number.isSafeInteger(n) && n >= 0;
export function responsesUsage(usage) {
  const details = usage?.input_tokens_details, ttl = details?.cache_write_tokens_details;
  const values = { input: usage?.input_tokens, read: details?.cached_tokens, write: details?.cache_write_tokens,
    write30m: ttl?.ttl_30m_tokens, write12h: ttl?.ttl_12h_tokens, out: usage?.output_tokens };
  const out = Object.fromEntries(Object.entries(values).filter(([, n]) => tokenCount(n)));
  // Preserve the provider's usage fields beside normalization, never response output or credentials.
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    out.apiUsage = Object.fromEntries(['input_tokens', 'input_tokens_details', 'output_tokens', 'output_tokens_details', 'total_tokens']
      .filter(k => Object.hasOwn(usage, k)).map(k => [k, structuredClone(usage[k])]));
  }
  if (tokenCount(out.input) && tokenCount(out.read) && tokenCount(out.write)) {
    if (out.read + out.write <= out.input) out.freshInput = out.input - out.read - out.write;
    else out.usageInconsistent = true;
  }
  if (tokenCount(out.write) && tokenCount(out.write30m) && tokenCount(out.write12h) && out.write30m + out.write12h !== out.write) out.usageInconsistent = true;
  if (out.usageInconsistent) delete out.freshInput;
  return out;
}

export function responsesUsageTap() {
  const limit = 8 * 1024 * 1024, decoder = new StringDecoder('utf8');
  let tail = '', whole = '', usage, meta = {}, eventData = [], eventSize = 0, sse = false, limited = false, skipLine = false, final;
  const take = event => {
    const response = event?.response || event, u = response?.usage;
    if (!u || typeof u !== 'object' || Array.isArray(u)) return;
    usage = u;
    meta = Object.fromEntries([['responseId', response.id], ['responseModel', response.model], ['serviceTier', response.service_tier], ['responseStatus', response.status]]
      .filter(([, v]) => typeof v === 'string'));
  };
  const parse = text => { try { take(JSON.parse(text)); } catch {} };
  const line = value => {
    if (value.startsWith('data:')) {
      sse = true; whole = '';
      const data = value.slice(5).trimStart(); eventSize += data.length;
      if (eventSize > limit) { eventData = []; limited = true; }
      else { eventData.push(data); parse(eventData.join('\n')); } // Codex may close immediately at response.completed.
    } else if (!value.trim()) { if (eventData.length) parse(eventData.join('\n')); eventData = []; eventSize = 0; }
    else if (value.startsWith('event:')) { sse = true; whole = ''; }
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
      return final = { ...responsesUsage(usage), ...meta, ...(!usage && limited ? { usageCaptureLimited: true } : {}) };
    },
  };
}

// Opt-in gate for experiments: the summary is not evidence unless every request's
// normalized counters agree with preserved provider usage. Never interrupt serving.
export function verifyResponsesUsage(rows, { since } = {}) {
  const requests = rows.filter(r => r.op === 'proxy' && r.protocol === 'responses' && (!since || r.at >= since));
  if (!requests.length) throw Error('No Responses requests to verify');
  const ids = new Set();
  for (const [i, row] of requests.entries()) {
    const fail = reason => { throw Error(`Responses request ${i + 1}: ${reason}`); };
    if (row.status !== 200 || row.truncated || row.usageCaptureLimited || row.usageInconsistent) fail('failed, truncated, or inconsistent capture');
    if (!row.apiUsage) fail('raw provider usage missing');
    const usage = responsesUsage(row.apiUsage);
    if (usage.usageInconsistent) fail('provider counters are inconsistent');
    for (const field of ['input', 'read', 'write', 'out', 'freshInput']) {
      if (!tokenCount(usage[field])) fail(`${field} counter missing or invalid`);
      if (row[field] !== usage[field]) fail(`${field} differs from provider usage`);
    }
    // Zero writes need no lifetime assumption. Positive writes must be priceable.
    if ((usage.write > 0 || usage.write30m != null || usage.write12h != null) && (!tokenCount(usage.write30m) || !tokenCount(usage.write12h))) fail('cache writes lack their complete lifetime breakdown');
    for (const field of ['write30m', 'write12h']) if (row[field] !== usage[field]) fail(`${field} differs from provider usage`);
    if (!row.responseId || ids.has(row.responseId)) fail('response ID missing or duplicated');
    ids.add(row.responseId);
    if (!row.model || !row.responseModel || !row.serviceTier || row.responseStatus !== 'completed') fail('model, service tier, or completed response status missing');
  }
  return { complete: true, requests: requests.length, rawUsageVerified: true, uniqueResponses: true };
}

export function responsesUsageRecords(rows, { since } = {}) {
  const fields = ['at', 'status', 'model', 'responseModel', 'responseId', 'serviceTier', 'responseStatus',
    'input', 'read', 'write', 'write30m', 'write12h', 'freshInput', 'out', 'apiUsage',
    'usageInconsistent', 'usageCaptureLimited', 'truncated', 'reason', 'injected'];
  return rows.filter(r => r.op === 'proxy' && r.protocol === 'responses' && (!since || r.at >= since))
    .map(r => Object.fromEntries(fields.filter(k => Object.hasOwn(r, k)).map(k => [k, r[k]])));
}

export function responsesReport(rows, { since } = {}) {
  const sides = {};
  for (const r of rows) {
    if (r.op !== 'proxy' || r.protocol !== 'responses' || (since && r.at < since)) continue;
    const key = r.injected ? 'clearing' : r.reason === 'holdout' ? 'holdout' : 'unchanged';
    const s = sides[key] ||= { requests: 0, input: 0, cachedInput: 0, output: 0, removedBytes: 0, removedTokens: 0, errors: 0, truncated: 0, reasons: {},
      cacheWrite: null, cacheWrite30m: null, cacheWrite12h: null, freshInput: null,
      writeCoverage: { reported: 0, missing: 0, ttlReported: 0, inconsistent: 0 }, freshInputRequests: 0 };
    s.requests++; s.input += r.input || 0; s.cachedInput += r.read || 0; s.output += r.out || 0;
    for (const [field, key] of [['write','cacheWrite'],['write30m','cacheWrite30m'],['write12h','cacheWrite12h']]) {
      if (tokenCount(r[field])) s[key] = (s[key] ?? 0) + r[field];
    }
    if (tokenCount(r.write)) s.writeCoverage.reported++; else s.writeCoverage.missing++;
    if (tokenCount(r.write30m) && tokenCount(r.write12h) && tokenCount(r.write) && r.write30m + r.write12h === r.write) s.writeCoverage.ttlReported++;
    const inconsistent = r.usageInconsistent || (tokenCount(r.input) && tokenCount(r.read) && tokenCount(r.write) && r.read + r.write > r.input)
      || (tokenCount(r.write) && tokenCount(r.write30m) && tokenCount(r.write12h) && r.write30m + r.write12h !== r.write);
    if (inconsistent) s.writeCoverage.inconsistent++;
    if (!inconsistent && [r.input, r.read, r.write].every(tokenCount)) {
      s.freshInput = (s.freshInput ?? 0) + r.input - r.read - r.write; s.freshInputRequests++;
    }
    s.removedBytes += r.removedBytes || 0;
    // What a cut here took out, in the unit every other door speaks. The Messages path is told by the API how
    // much it cleared (`cleared`); this path cuts the text itself, so the row carries the proxy's own estimate
    // (proxy-responses.js:transformResponses, `chars * TOKENS_PER_CHAR`), which report-savings.js:49 already
    // reads as this protocol's cleared tokens. Dropping it here left the whole Codex side of the clearing with
    // no token figure at all: the telemetry's proxy block reported bytes, so every spend card that speaks
    // tokens read a Codex machine as zero.
    s.removedTokens += r.estimatedRemovedTokens || 0;
    // `errors` is what the API answered; an answer that stopped partway answered 200 and then broke,
    // so it is counted here rather than left out of both.
    if (r.status >= 400) s.errors++;
    if (r.truncated) s.truncated++;
    if (r.reason) s.reasons[r.reason] = (s.reasons[r.reason] || 0) + 1;
  }
  for (const s of Object.values(sides)) {
    // A partial sum must not masquerade as the whole session's ordinary input.
    if (s.freshInputRequests !== s.requests) s.freshInput = null;
  }
  return sides;
}
