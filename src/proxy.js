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
import path from 'node:path';
import crypto from 'node:crypto';

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
export const PROXY_DEFAULTS = { upstream: 'https://api.anthropic.com', trigger: 100000, keep: 'turn', keepMin: 3, clearAtLeast: 80000, holdout: 0 };

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
  cfg.upstream = flags.upstream || env.THINKER_PROXY_UPSTREAM || cfg.upstream;
  cfg.port = pick('port', 'THINKER_PROXY_PORT');
  return cfg;
}

// The tool uses of the request's current turn: those in the assistant messages after the last user message that
// carries text and no tool result, which is the person's request (a hook's context and the system reminders ride in
// the user message that holds the tool result they follow, so they do not start a turn).
export function turnToolUses(messages) {
  let start = 0;
  messages.forEach((m, i) => {
    if (m?.role !== 'user') return;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text' }];
    if (blocks.some(b => b?.type === 'text') && !blocks.some(b => b?.type === 'tool_result')) start = i;
  });
  let n = 0;
  for (const m of messages.slice(start)) if (m?.role === 'assistant' && Array.isArray(m.content)) n += m.content.filter(b => b?.type === 'tool_use').length;
  return n;
}
export const keepValue = (cfg, messages) => cfg.keep === 'turn' ? Math.max(cfg.keepMin ?? 0, turnToolUses(messages || [])) : cfg.keep;

export function clearEdit(cfg, messages) {
  return {
    type: EDIT_TYPE,
    trigger: { type: 'input_tokens', value: cfg.trigger },
    keep: { type: 'tool_uses', value: keepValue(cfg, messages) },
    clear_at_least: { type: 'input_tokens', value: cfg.clearAtLeast },
  };
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
  if (method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(url) || !body.length) return { body, reason: 'other' };
  if (heldOut(sessionOf(headers), cfg.holdout)) return { body, reason: 'holdout' };
  let j;
  try { j = JSON.parse(body); } catch { return { body, reason: 'unparsed' }; }
  if (!j || !Array.isArray(j.messages)) return { body, reason: 'other' };
  const cm = j.context_management && typeof j.context_management === 'object' ? j.context_management : {};
  const edits = Array.isArray(cm.edits) ? cm.edits : [];
  if (edits.some(e => e && e.type === EDIT_TYPE)) return { body, reason: 'agent-clears' };
  // the API applies edits in order; the thinking edit Claude Code sends stays first
  const edit = clearEdit(cfg, j.messages);
  j.context_management = { ...cm, edits: [...edits, edit] };
  return { body: Buffer.from(JSON.stringify(j)), injected: true, model: j.model, keep: edit.keep.value, addBeta: !betaOn(headers) };
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
        cleared: cleared.reduce((a, e) => a + (e.cleared_input_tokens || 0), 0), clearedUses: cleared.reduce((a, e) => a + (e.cleared_tool_uses || 0), 0),
      };
    },
  };
}

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'];

// `notes`: a proxy-notes.js NoteInjector; the notes for an agent with no prompt hook go into the last user turn
export function startProxy(cfg, { logFile, host = '127.0.0.1', onListen, notes = null } = {}) {
  const up = new URL(cfg.upstream);
  const lib = up.protocol === 'http:' ? http : https;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 256 });
  const log = row => {
    if (!logFile) return;
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(row) + '\n'); } catch { /* a log is never worth a failed request */ }
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const t0 = process.hrtime.bigint();
      let t;
      try { t = transformRequest(req.method, req.url, req.headers, raw, cfg); } catch { t = { body: raw, reason: 'error' }; }
      let n = null;
      if (notes) { try { n = await notes.transform(req.method, req.url, req.headers, t.body); } catch { n = null; } if (n) { t.body = n.body; t.notes = n; if (t.reason === 'other') t.reason = 'notes'; } }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k)) headers[k] = v;
      headers.host = up.host;
      if (t.addBeta) headers['anthropic-beta'] = withBeta(req.headers['anthropic-beta']);
      headers['content-length'] = t.body.length;
      const overheadMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const base = up.pathname.replace(/\/$/, '');
      let ureq;
      // A connection dropped before any answer came back (a reset or a broken pipe: twice in one
      // 84-request Opus session on 2026-10-20) is tried once more on a fresh connection. The agent's
      // own retry of the 502 cost it 10 to 40 seconds each time. Nothing has reached the agent yet, so
      // the second try is invisible to it; a drop after the answer started cannot be retried.
      const send = attempt => {
        const started = Date.now();
        ureq = lib.request({ protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, path: base + req.url, method: req.method, headers, agent: attempt ? false : agent }, ures => {
          const out = {};
          for (const [k, v] of Object.entries(ures.headers)) if (!['connection', 'keep-alive', 'transfer-encoding'].includes(k)) out[k] = v;
          res.writeHead(ures.statusCode, out);
          const tap = t.reason === 'other' ? null : usageTap();
          ures.on('data', c => { res.write(c); tap?.push(c); });
          ures.on('end', () => {
            res.end();
            if (tap) log({ at: new Date().toISOString(), op: 'proxy', session: sessionOf(req.headers), model: t.model, status: ures.statusCode,
              injected: !!t.injected, ...(t.injected ? { keep: t.keep } : { reason: t.reason }), ...(t.addBeta ? { betaAdded: true } : {}), ...(t.notes ? { notes: t.notes.served.length, notesReplayed: t.notes.replayed, ...(t.notes.reason ? { notesReason: t.notes.reason } : {}) } : {}), overheadMs: Math.round(overheadMs * 1000) / 1000, ...(attempt ? { retried: true } : {}), ...tap.result() });
          });
          ures.on('error', () => res.destroy());
        });
        ureq.on('error', e => {
          const retry = !attempt && !res.headersSent && !res.destroyed && ['ECONNRESET', 'EPIPE'].includes(e.code);
          log({ at: new Date().toISOString(), op: 'proxy-error', error: e.message, code: e.code, reused: !!ureq.reusedSocket, afterMs: Date.now() - started, retried: retry });
          if (retry) return send(1);
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
  server.listen(cfg.port || 0, host, () => onListen?.(server.address()));
  return server;
}

// What the log says: per side of the holdout, the requests, their billed-equivalent input (a cache read at
// 0.1, a write at 2: Claude Code's writes are one-hour ones) and what the server cleared.
export function proxyReport(rows, { since } = {}) {
  const sides = {};
  for (const r of rows) {
    if (r.op !== 'proxy' || (since && r.at < since)) continue;
    const side = r.injected ? 'clearing' : r.reason === 'holdout' ? 'holdout' : null;
    if (!side) continue;
    const s = sides[side] ||= { requests: 0, sessions: new Set(), input: 0, read: 0, write: 0, out: 0, cleared: 0, clears: 0, overheadMs: [] };
    s.requests++; if (r.session) s.sessions.add(r.session);
    s.input += r.input || 0; s.read += r.read || 0; s.write += r.write || 0; s.out += r.out || 0;
    s.cleared += r.cleared || 0; if (r.cleared) s.clears++;
    s.overheadMs.push(r.overheadMs || 0);
  }
  const outSides = {};
  for (const [k, s] of Object.entries(sides)) {
    const ms = s.overheadMs.sort((a, b) => a - b);
    outSides[k] = { requests: s.requests, sessions: s.sessions.size, input: s.input, read: s.read, write: s.write, out: s.out,
      billedInput: Math.round(s.input + 0.1 * s.read + 2 * s.write), cleared: s.cleared, requestsCleared: s.clears,
      overheadP50: ms[Math.floor(ms.length / 2)] ?? 0, overheadP99: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.99))] ?? 0 };
  }
  return outSides;
}
