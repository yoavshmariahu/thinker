// Responses API tool-output clearing (default-on service wiring at the owner's request).
// No model calls, no transcript writes:
// Codex keeps its history; only full-history requests sent upstream are shortened.
// Use Claude’s shared cut policy at turn boundaries; reapply the persisted set on every request.
// Never touch linked server-side histories or Codex's own compaction requests.
import crypto from 'node:crypto';
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
  if (!applied.clearedUses) return { body, ...meta, ...state, estimatedInputTokens: prompt,
    reason: decision.held ? 'payback' : prompt < cfg.trigger ? 'below-trigger' : decision.candidate ? 'below-clear-minimum' : 'nothing-to-cut' };
  return { ...meta, ...state, body: Buffer.from(JSON.stringify({ ...j, input: applied.input })), injected: true,
    reason: 'client-clear', keep: cfg.keepMin ?? 3, removedBytes: applied.removedBytes,
    clearedUses: applied.clearedUses, estimatedRemovedTokens: applied.chars * TOKENS_PER_CHAR, estimatedInputTokens: prompt,
    clientCut: { cut: applied.clearedUses, chars: applied.chars, tokens: applied.chars * TOKENS_PER_CHAR, firstChanged: applied.firstChanged } };

}

// Usage stays in raw provider token units. Never apply Anthropic cache-price weights.
export function responsesUsageTap() {
  let tail = '', whole = '', usage;
  const take = event => { const u = event?.response?.usage || event?.usage; if (u) usage = u; };
  return {
    push(chunk) {
      const text = chunk.toString('utf8');
      if (whole.length < 65536) whole += text;
      tail += text;
      let end;
      while ((end = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, end).trim(); tail = tail.slice(end + 1);
        if (line.startsWith('data:')) { try { take(JSON.parse(line.slice(5))); } catch {} }
      }
      if (tail.length > 1024 * 1024) tail = ''; // a giant output line is not a usage event
    },
    result() {
      if (!usage) { try { take(JSON.parse(whole)); } catch {} }
      return { input: usage?.input_tokens, read: usage?.input_tokens_details?.cached_tokens, out: usage?.output_tokens };
    },
  };
}

export function responsesReport(rows, { since } = {}) {
  const sides = {};
  for (const r of rows) {
    if (r.op !== 'proxy' || r.protocol !== 'responses' || (since && r.at < since)) continue;
    const key = r.injected ? 'clearing' : r.reason === 'holdout' ? 'holdout' : 'unchanged';
    const s = sides[key] ||= { requests: 0, input: 0, cachedInput: 0, output: 0, removedBytes: 0, errors: 0, truncated: 0, reasons: {} };
    s.requests++; s.input += r.input || 0; s.cachedInput += r.read || 0; s.output += r.out || 0;
    s.removedBytes += r.removedBytes || 0;
    // `errors` is what the API answered; an answer that stopped partway answered 200 and then broke,
    // so it is counted here rather than left out of both.
    if (r.status >= 400) s.errors++;
    if (r.truncated) s.truncated++;
    if (r.reason) s.reasons[r.reason] = (s.reasons[r.reason] || 0) + 1;
  }
  return sides;
}
