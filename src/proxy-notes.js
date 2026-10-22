// Notes through the context proxy (proxy.js), for an agent that runs no prompt hook but honours a base URL
// (Goose's ANTHROPIC_HOST, Aider's ANTHROPIC_BASE_URL and OPENAI_BASE_URL, any OpenAI-compatible client).
// Off until `thinker proxy --notes` (or `proxy: { notes: true }` in .thinker/config.json) and the agent is
// pointed at the proxy: a serving path that ships off, under the rule that a new one is measured first.
//
// What it does: each request is a whole conversation. The last user turn (a user message with text, not
// one carrying tool results alone) is the request's prompt; the first time a conversation reaches that turn
// the notes are served for it exactly as the prompt hook serves them (ops.js:orient: once per session,
// fresh notes only, the holdout turn, logged as client `proxy`), and the bundle is put in front of that
// message's text. Every later request of the conversation gets the same text at the same turn again: the
// agent's own history does not hold it, and a prefix that changed between requests would miss the prompt
// cache from that message on. A conversation is known by its system prompt and its first user turn, so a
// resumed one keeps its injections while the proxy runs; the state is in memory and dies with the process.
// A request that carries a Claude Code session id is left alone: that agent's hooks serve it already.
//
// Reach: an agent whose model calls go through its vendor's servers (Windsurf, Auggie) never passes here.
// Learning is not covered: the proxy records no session; the catch-up `thinker learn` reads no transcript of
// these agents either, so what the session learned stays unlearned until the agent gets a hook or a recorder.
import crypto from 'node:crypto';

export const PROXY_CLIENT = 'proxy';
export const MAX_CONVERSATIONS = 500;

const textOf = content => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n');
};
const userTurn = (m, format) => m && m.role === 'user' && (format === 'openai' ? true : !(Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result'))) && textOf(m.content).trim().length > 0;

// The request's shape: Anthropic Messages (`/v1/messages`) or OpenAI Chat Completions (`/v1/chat/completions`).
export function requestFormat(url) {
  if (/^\/v1\/messages(\?|$)/.test(url)) return 'anthropic';
  if (/\/v1\/chat\/completions(\?|$)/.test(url)) return 'openai';
  return null;
}

// The user turns of a request in order, each with its index in `messages`, and whether the request ends on one.
export function userTurns(j, format) {
  const turns = [];
  const messages = Array.isArray(j?.messages) ? j.messages : [];
  messages.forEach((m, i) => { if (userTurn(m, format)) turns.push({ index: i, text: textOf(m.content) }); });
  const last = messages.length - 1;
  return { turns, endsOnTurn: turns.length > 0 && turns.at(-1).index === last };
}

export function conversationKey(j, format) {
  const sys = format === 'openai' ? textOf((j.messages || []).find(m => m?.role === 'system' || m?.role === 'developer')?.content) : textOf(j.system);
  const first = userTurns(j, format).turns[0]?.text || '';
  return crypto.createHash('sha256').update(sys.slice(0, 4000)).update('\n--\n').update(first.slice(0, 4000)).digest('hex').slice(0, 24);
}

// the bundle in front of the message's own text, in the message's own shape
export function withBundle(m, bundle, format) {
  if (!bundle) return m;
  if (typeof m.content === 'string') return format === 'anthropic' ? { ...m, content: [{ type: 'text', text: bundle }, { type: 'text', text: m.content }] } : { ...m, content: `${bundle}\n\n${m.content}` };
  return { ...m, content: [{ type: 'text', text: bundle }, ...m.content] };
}

// serve({ task, session, turn }) -> { text, ids } (the bundle text, '' when nothing was served)
export class NoteInjector {
  constructor({ serve, hookedHeader = 'x-claude-code-session-id' }) {
    this.serve = serve;
    this.hookedHeader = hookedHeader;
    this.conversations = new Map(); // key -> Map(turn ordinal -> bundle text)
  }
  remember(key, ordinal, text) {
    if (!this.conversations.has(key) && this.conversations.size >= MAX_CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value);
    const c = this.conversations.get(key) || new Map();
    c.set(ordinal, text);
    this.conversations.delete(key); this.conversations.set(key, c); // most recently used last
  }
  // -> null when the request is not one to touch, else { body, served: [ids], replayed: n, reason? }
  async transform(method, url, headers, body) {
    if (method !== 'POST' || !body.length) return null;
    const format = requestFormat(url);
    if (!format) return null;
    if (headers[this.hookedHeader]) return { body, served: [], replayed: 0, reason: 'hooked-client' };
    let j;
    try { j = JSON.parse(body); } catch { return { body, served: [], replayed: 0, reason: 'unparsed' }; }
    const { turns, endsOnTurn } = userTurns(j, format);
    if (!turns.length) return { body, served: [], replayed: 0, reason: 'no-user-turn' };
    const key = conversationKey(j, format);
    const known = this.conversations.get(key) || new Map();
    const ordinal = turns.length - 1;
    let served = [];
    if (endsOnTurn && !known.has(ordinal)) {
      let r = { text: '', ids: [] };
      try { r = await this.serve({ task: turns[ordinal].text, session: `${PROXY_CLIENT}-${key}`, turn: ordinal + 1 }); } catch { /* an unavailable cache never costs the request */ }
      this.remember(key, ordinal, r.text || '');
      served = r.ids || [];
    }
    const now = this.conversations.get(key) || known;
    let replayed = 0;
    let changed = false;
    const messages = j.messages.map(m => m);
    turns.forEach((t, i) => {
      const text = now.get(i);
      if (!text) return;
      messages[t.index] = withBundle(messages[t.index], text, format);
      changed = true;
      if (!(served.length && i === ordinal)) replayed++;
    });
    if (!changed) return { body, served, replayed: 0, reason: served.length ? undefined : 'nothing-served' };
    return { body: Buffer.from(JSON.stringify({ ...j, messages })), served, replayed };
  }
}
