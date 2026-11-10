// Anthropic Messages to OpenAI Chat Completions and back (2026-11-10), for a routed request whose provider was
// found to speak Chat alone (providers.js:probeProvider). Claude Code speaks Messages and nothing else, so a model
// behind a gateway with no Messages endpoint is reachable only through a translation, and this is the smallest one
// that carries what a subagent needs: the system prompt, the turns, the tools and their calls and results, images,
// a JSON schema for structured output, and the usage counts back. What it does not carry, and says so (`dropped`):
// thinking (a provider's reasoning is its own and never round-trips), the context-management edits (the cut has
// already been applied to the Messages body before this runs), cache_control (no equivalent; a provider caches as it
// likes), and Claude's server tools (a `type` on the tool definition). A request that depends on any of those is not
// one to route here; the routing policy, not this file, decides that.
//
// Ids pass through unchanged in both directions (`toolu_…` as a tool_call id, `call_…` as a tool_use id), since the
// agent matches results to calls by the id it was given and the gateways accept any string.
import crypto from 'node:crypto';

const DROPPED = ['thinking', 'context_management', 'metadata', 'cache_control', 'mcp_servers', 'container', 'service_tier', 'output_config'];

const textOfBlocks = v => typeof v === 'string' ? v : Array.isArray(v) ? v.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
const resultText = r => {
  const c = r.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '').join('\n') : '';
  return r.is_error ? `[tool error] ${text}` : text;
};

// the Messages request as a Chat Completions request, for `model`
export function toChat(j, { model }) {
  const out = { model, messages: [] };
  const sys = textOfBlocks(j.system);
  if (sys) out.messages.push({ role: 'system', content: sys });
  for (const m of Array.isArray(j.messages) ? j.messages : []) {
    const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
    if (m.role === 'user') {
      // a tool message must directly follow the assistant turn that called it, so the results go first and the person's text after
      for (const r of blocks) if (r?.type === 'tool_result') out.messages.push({ role: 'tool', tool_call_id: r.tool_use_id, content: resultText(r) });
      const parts = [];
      for (const b of blocks) {
        if (!b) continue;
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.type === 'base64' && b.source.data) parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } });
        else if (b.type === 'image' && b.source?.type === 'url' && b.source.url) parts.push({ type: 'image_url', image_url: { url: b.source.url } });
        else if (b.type === 'document') parts.push({ type: 'text', text: '[document omitted: not carried to this provider]' });
      }
      if (parts.length) out.messages.push({ role: 'user', content: parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts });
    } else if (m.role === 'assistant') {
      const text = blocks.filter(b => b?.type === 'text' && b.text).map(b => b.text).join('');
      const calls = blocks.filter(b => b?.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!text && !calls.length) continue;
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.messages.push(msg);
    }
  }
  const tools = (Array.isArray(j.tools) ? j.tools : []).filter(t => t?.name && (!t.type || t.type === 'custom')).map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  const dropped = DROPPED.filter(k => k in j);
  if ((j.tools || []).length > tools.length) dropped.push('server tools');
  if (tools.length) {
    out.tools = tools;
    const tc = j.tool_choice;
    if (tc?.type) out.tool_choice = tc.type === 'any' ? 'required' : tc.type === 'tool' ? { type: 'function', function: { name: tc.name } } : tc.type === 'none' ? 'none' : 'auto';
  }
  if (Number.isFinite(j.max_tokens)) out.max_tokens = j.max_tokens;
  if (j.temperature != null) out.temperature = j.temperature;
  if (j.top_p != null) out.top_p = j.top_p;
  if (Array.isArray(j.stop_sequences) && j.stop_sequences.length) out.stop = j.stop_sequences.slice(0, 4);
  if (j.stream) { out.stream = true; out.stream_options = { include_usage: true }; }
  if (j.output_format?.type === 'json_schema' && j.output_format.schema) out.response_format = { type: 'json_schema', json_schema: { name: 'output', schema: j.output_format.schema } };
  return { body: out, dropped };
}

const STOP = { stop: 'end_turn', tool_calls: 'tool_use', function_call: 'tool_use', length: 'max_tokens', content_filter: 'end_turn' };
const stopOf = r => STOP[r] || (r ? 'end_turn' : null);
// OpenAI counts the cached part inside prompt_tokens; Anthropic's input_tokens is the uncached remainder
export function usageOf(u) {
  if (!u) return null;
  const prompt = Number(u.prompt_tokens) || 0, cached = Number(u.prompt_tokens_details?.cached_tokens) || 0;
  return { input_tokens: Math.max(0, prompt - cached), cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: Number(u.completion_tokens) || 0 };
}
const parseArgs = s => { if (!s || !String(s).trim()) return {}; try { return JSON.parse(s); } catch { return { _raw: String(s) }; } };
const msgId = id => id ? `msg_${String(id).replace(/^(chatcmpl-|msg_)/, '')}` : `msg_${crypto.randomBytes(12).toString('hex')}`;

// a whole Chat Completions answer as a Messages answer
export function fromChat(j, { model }) {
  const c = j?.choices?.[0] || {}, m = c.message || {};
  const content = [];
  if (typeof m.content === 'string' && m.content) content.push({ type: 'text', text: m.content });
  for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) content.push({ type: 'tool_use', id: tc.id || `call_${crypto.randomBytes(8).toString('hex')}`, name: tc.function?.name || '', input: parseArgs(tc.function?.arguments) });
  return { id: msgId(j?.id), type: 'message', role: 'assistant', model, content, stop_reason: stopOf(c.finish_reason) || 'end_turn', stop_sequence: null, usage: usageOf(j?.usage) || { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } };
}

// an OpenAI error body as the API's own shape, at the same status
const ERR = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };
export function errorToMessages(status, text) {
  let j = null; try { j = JSON.parse(text); } catch {}
  const message = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : null) || String(text || '').slice(0, 500) || `upstream answered ${status}`;
  return { type: 'error', error: { type: ERR[status] || (status >= 500 ? 'api_error' : 'invalid_request_error'), message } };
}

// The stream, chunk by chunk: Chat Completions server-sent events in, Messages events out. One text block, then
// one tool_use block per tool call, in the order they start; the usage rides the final message_delta as the API
// sends it, so proxy.js:usageTap reads this stream as it reads the API's own.
export function chatStreamToMessages({ model }) {
  let tail = '', started = false, finished = false, index = -1, open = null, finish = null, usage = null, id = null;
  const tools = new Map();   // tool_call index -> { block, args }
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const out = [];
  const start = () => { if (started) return; started = true; out.push(ev('message_start', { message: { id: msgId(id), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } } })); };
  const close = () => {
    if (open == null) return;
    const t = [...tools.values()].find(x => x.block === open);
    if (t && !t.args) out.push(ev('content_block_delta', { index: open, delta: { type: 'input_json_delta', partial_json: '{}' } }));
    out.push(ev('content_block_stop', { index: open })); open = null;
  };
  const text = s => { start(); if (open != null && ![...tools.values()].some(x => x.block === open)) { /* the text block is open */ } else { close(); index++; open = index; out.push(ev('content_block_start', { index, content_block: { type: 'text', text: '' } })); } out.push(ev('content_block_delta', { index: open, delta: { type: 'text_delta', text: s } })); };
  const call = tc => {
    start();
    let t = tools.get(tc.index ?? 0);
    if (!t) { close(); index++; open = index; t = { block: index, args: '' }; tools.set(tc.index ?? 0, t); out.push(ev('content_block_start', { index, content_block: { type: 'tool_use', id: tc.id || `call_${crypto.randomBytes(8).toString('hex')}`, name: tc.function?.name || '', input: {} } })); }
    else if (open !== t.block) { close(); open = t.block; }
    const a = tc.function?.arguments;
    if (a) { t.args += a; out.push(ev('content_block_delta', { index: t.block, delta: { type: 'input_json_delta', partial_json: a } })); }
  };
  const take = j => {
    if (j?.id && !id) id = j.id;
    if (j?.usage) usage = j.usage;
    const c = j?.choices?.[0];
    if (!c) return;
    if (typeof c.delta?.content === 'string' && c.delta.content) text(c.delta.content);
    for (const tc of Array.isArray(c.delta?.tool_calls) ? c.delta.tool_calls : []) call(tc);
    if (c.finish_reason) finish = c.finish_reason;
    // an upstream that answers in one chunk with a whole message
    if (c.message) { if (c.message.content) text(c.message.content); for (const tc of c.message.tool_calls || []) call({ ...tc, index: tc.index ?? tools.size }); }
  };
  const done = () => {
    if (finished) return; finished = true; start(); close();
    const u = usageOf(usage);
    out.push(ev('message_delta', { delta: { stop_reason: stopOf(finish) || 'end_turn', stop_sequence: null }, usage: u ? { output_tokens: u.output_tokens, input_tokens: u.input_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: 0 } : { output_tokens: 0 } }));
    out.push(ev('message_stop', {}));
  };
  return {
    push(chunk) {
      tail += chunk.toString('utf8');
      let i;
      while ((i = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, i).trim(); tail = tail.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') { done(); continue; }
        try { take(JSON.parse(data)); } catch { /* a keep-alive or a partial line */ }
      }
      return out.splice(0).join('');
    },
    end() { if (tail.trim().startsWith('data:')) this.push('\n'); done(); return out.splice(0).join(''); },
  };
}
