// The context proxy: an agent's requests to the Anthropic API pass through a local process that asks the API
// to clear old tool results on its side (`clear_tool_uses_20250919`, beta `context-management-2025-06-27`).
// Off unless someone starts it (`thinker proxy`) and points the agent at it (ANTHROPIC_BASE_URL).
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
export const PROXY_DEFAULTS = { upstream: 'https://api.anthropic.com', trigger: 100000, keep: 3, clearAtLeast: 80000, holdout: 0 };

const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

// flags win over the environment, the environment over the defaults
export function proxyConfig(flags = {}, env = process.env) {
  const pick = (flag, name) => num(flags[flag]) ?? num(env[name]);
  const cfg = { ...PROXY_DEFAULTS };
  for (const [key, flag, name] of [['trigger', 'trigger', 'THINKER_PROXY_TRIGGER'], ['keep', 'keep', 'THINKER_PROXY_KEEP'],
    ['clearAtLeast', 'clear-at-least', 'THINKER_PROXY_CLEAR_AT_LEAST'], ['holdout', 'holdout', 'THINKER_PROXY_HOLDOUT']]) {
    const v = pick(flag, name);
    if (v !== undefined) cfg[key] = v;
  }
  cfg.upstream = flags.upstream || env.THINKER_PROXY_UPSTREAM || cfg.upstream;
  cfg.port = pick('port', 'THINKER_PROXY_PORT');
  return cfg;
}

export function clearEdit(cfg) {
  return {
    type: EDIT_TYPE,
    trigger: { type: 'input_tokens', value: cfg.trigger },
    keep: { type: 'tool_uses', value: cfg.keep },
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
  if (!betaOn(headers)) return { body, reason: 'no-beta' };
  if (heldOut(sessionOf(headers), cfg.holdout)) return { body, reason: 'holdout' };
  let j;
  try { j = JSON.parse(body); } catch { return { body, reason: 'unparsed' }; }
  if (!j || !Array.isArray(j.messages)) return { body, reason: 'other' };
  const cm = j.context_management && typeof j.context_management === 'object' ? j.context_management : {};
  const edits = Array.isArray(cm.edits) ? cm.edits : [];
  if (edits.some(e => e && e.type === EDIT_TYPE)) return { body, reason: 'agent-clears' };
  // the API applies edits in order; the thinking edit Claude Code sends stays first
  j.context_management = { ...cm, edits: [...edits, clearEdit(cfg)] };
  return { body: Buffer.from(JSON.stringify(j)), injected: true, model: j.model };
}

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

export function startProxy(cfg, { logFile, host = '127.0.0.1', onListen } = {}) {
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
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const t0 = process.hrtime.bigint();
      let t;
      try { t = transformRequest(req.method, req.url, req.headers, raw, cfg); } catch { t = { body: raw, reason: 'error' }; }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k)) headers[k] = v;
      headers.host = up.host;
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
              injected: !!t.injected, ...(t.injected ? {} : { reason: t.reason }), overheadMs: Math.round(overheadMs * 1000) / 1000, ...(attempt ? { retried: true } : {}), ...tap.result() });
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
