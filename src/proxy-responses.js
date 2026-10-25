// Experimental Responses API tool-output clearing. No model calls, no transcript writes:
// Codex keeps its history; only full-history requests sent upstream are shortened.
// Recompute from that history on every request, including retries and resumed sessions.
// Never touch linked server-side histories or Codex's own compaction requests.
import crypto from 'node:crypto';

export const CLEARED_OUTPUT = '[thinker: an older turn\'s tool output was cleared. Run the tool again if you need it.]';
export const responsesSession = (headers, request = {}) => headers['session_id'] || headers['x-codex-session-id'] || request.prompt_cache_key || null;
const heldOut = (session, share) => share >= 1 || (share > 0 && crypto.createHash('sha256').update(session).digest().readUInt32BE(0) / 2 ** 32 < share);
const outputItem = item => ['function_call_output', 'custom_tool_call_output'].includes(item?.type);
const textOutput = item => typeof item.output === 'string' || (Array.isArray(item.output) && item.output.length > 0 && item.output.every(b => b?.type === 'input_text' && typeof b.text === 'string'));

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
  if (cfg.holdout && !session) return pass('missing-session');
  if (session && heldOut(String(session), cfg.holdout)) return pass('holdout');
  // This is a size heuristic, not a tokenizer or a claim about billed tokens.
  if (body.length < cfg.trigger * 4) return pass('below-trigger');
  let turn = -1;
  j.input.forEach((item, i) => { if (item?.role === 'user' && (!item.type || item.type === 'message')) turn = i; });
  if (turn < 0) return pass('no-user-turn');
  const outputs = j.input.flatMap((item, i) => outputItem(item) ? [i] : []);
  const protectedFrom = outputs.length > cfg.keepMin ? outputs[outputs.length - cfg.keepMin] ?? j.input.length : 0;
  const candidates = outputs.filter(i => i < turn && i < protectedFrom && textOutput(j.input[i]));
  let removedBytes = 0;
  const replacements = new Map();
  for (const i of candidates) {
    const item = j.input[i];
    const output = typeof item.output === 'string' ? CLEARED_OUTPUT : [{ type: 'input_text', text: CLEARED_OUTPUT }];
    const saved = Buffer.byteLength(JSON.stringify(item.output)) - Buffer.byteLength(JSON.stringify(output));
    if (saved > 0) { replacements.set(i, { ...item, output }); removedBytes += saved; }
  }
  if (!removedBytes || removedBytes < cfg.clearAtLeast * 4) return pass('below-clear-minimum');
  const input = j.input.map((item, i) => replacements.get(i) || item);
  return { body: Buffer.from(JSON.stringify({ ...j, input })), ...meta, injected: true,
    clearedUses: replacements.size, removedBytes, estimatedRemovedTokens: Math.floor(removedBytes / 4) };
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
    const s = sides[key] ||= { requests: 0, input: 0, cachedInput: 0, output: 0, removedBytes: 0, errors: 0, reasons: {} };
    s.requests++; s.input += r.input || 0; s.cachedInput += r.read || 0; s.output += r.out || 0;
    s.removedBytes += r.removedBytes || 0;
    if (r.status >= 400) s.errors++;
    if (r.reason) s.reasons[r.reason] = (s.reasons[r.reason] || 0) + 1;
  }
  return sides;
}
