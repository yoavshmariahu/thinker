// thinker's hooks over HTTP, for an agent built on a framework.
//
// A coding agent reaches the hooks by running a command: its settings name `thinker hook <event>` and the
// agent runs it with the event on stdin. An agent somebody builds with LangChain (or any framework) has no
// settings file and often no thinker on its own filesystem at all -- it runs in a container, and thinker
// runs in the one beside it. So the same hooks are served here, on the port the proxy already listens on,
// and a small adapter in the agent's own language calls them at the framework's extension points
// (python/thinker-langchain). One port, one address to configure, and the proxy and the hooks arrive
// together: the owner's call of 2026-11-15 is that an agent of this kind is wired with hooks, never with
// the proxy alone.
//
// Nothing is reimplemented. A route translates the adapter's JSON into the event the hook command already
// reads and runs that command, exactly as the OpenCode and Pi plugins do from their own long-lived
// processes (integrations/runner.js): no transcript on disk, so the hooks record the session themselves
// (`--record`, transcripts.js:recordEvent) and the Stop hook reads that trace.
//
// The one thing a framework agent lacks that every hook assumes is a repository: a hook does nothing
// outside a git checkout, because the checkout is where the cache lives (hooks.js). So each named agent
// gets a **workspace** -- `<THINKER_HOME>/agents/<name>`, an empty git repository thinker makes on first
// use -- and that is its checkout: its profile, its traces and its log key. Two agents with different
// names never share one, and the same agent keeps its own across restarts where THINKER_HOME is a volume.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hookRunner } from './integrations/runner.js';

export const HOOK_PREFIX = '/thinker/';
export const HOOK_EVENTS = ['prompt', 'pretool', 'tool', 'stop'];
// the frameworks an adapter exists for; the name is the hook's `--client`, so it is never taken from a request as given
export const FRAMEWORK_CLIENTS = ['langchain'];
export const MAX_BODY = 4 * 1024 * 1024;

const slug = name => String(name || 'agent').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'agent';

/** An agent's checkout: made on first use, an empty git repository under thinker's home. Null if git cannot make one. */
export function workspaceFor(home, name) {
  const dir = path.join(home, 'agents', slug(name));
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
    return fs.existsSync(path.join(dir, '.git')) ? dir : null;
  } catch { return null; }
}

/** The adapter's body as the event the hook command reads (the fields the Claude Code hooks carry). */
export function hookEvent(what, body, cwd) {
  const ev = { session_id: String(body.session || ''), cwd };
  if (what === 'prompt') ev.prompt = String(body.prompt ?? '');
  if (what === 'pretool' || what === 'tool') { ev.tool_name = String(body.tool ?? ''); ev.tool_input = body.input ?? {}; ev.tool_use_id = body.call_id; }
  if (what === 'tool') { ev.tool_response = body.output ?? ''; if (body.error) ev.error = true; }
  if (what === 'stop') ev.last_assistant_message = String(body.answer ?? '');
  return ev;
}

/** What the hook printed, as the adapter's answer. */
export function hookAnswer(what, printed) {
  const text = String(printed || '').trim();
  if (!text) return {};
  if (what === 'prompt') return { context: text };
  if (what === 'stop') return { notice: text };
  if (what === 'pretool') {
    // the delegation hook answers in Claude Code's shape (delegate.js): a denial whose reason is the report
    try {
      const o = JSON.parse(text).hookSpecificOutput;
      if (o?.permissionDecision === 'deny' && o.permissionDecisionReason) return { decision: 'deny', reason: String(o.permissionDecisionReason) };
    } catch { /* not a decision */ }
    return {};
  }
  return {};
}

const readBody = req => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', d => { size += d.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(d); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/**
 * The handler for everything under `/thinker/`. `run` is injectable so the routing is testable without
 * starting the CLI; by default it is the same runner the plugins use.
 */
export function hookService({ cli, home, version = '', run = null, log = () => {} }) {
  const runners = new Map();
  const runnerFor = (client, repo) => {
    const key = `${client}\0${repo}`;
    if (!runners.has(key)) runners.set(key, hookRunner({ cli, client, repo, learn: true }));
    return runners.get(key);
  };
  const send = (res, code, obj) => { const raw = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) }); res.end(raw); };
  return async function handle(req, res) {
    const url = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && url === `${HOOK_PREFIX}health`) return send(res, 200, { ok: true, version, hooks: HOOK_EVENTS });
    const m = url.match(/^\/thinker\/hook\/([a-z]+)$/);
    if (req.method !== 'POST' || !m || !HOOK_EVENTS.includes(m[1])) return send(res, 404, { error: 'no such thinker route' });
    const what = m[1];
    let body;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch { return send(res, 400, { error: 'the body is not JSON, or is too large' }); }
    if (!body || typeof body !== 'object' || !body.session) return send(res, 400, { error: 'a hook needs the session it belongs to' });
    const client = FRAMEWORK_CLIENTS.includes(body.client) ? body.client : FRAMEWORK_CLIENTS[0];
    const repo = workspaceFor(home, body.name);
    // no workspace is no cache, and a hook without one has nothing to do: say so once in the log, never fail the agent
    if (!repo) { log({ op: 'hook-service', event: what, error: 'no-workspace' }); return send(res, 200, {}); }
    try {
      const printed = await (run || runnerFor(client, repo))(what, hookEvent(what, body, repo));
      return send(res, 200, hookAnswer(what, printed));
    } catch (e) {
      log({ op: 'hook-service', event: what, error: String(e?.message || e).slice(0, 200) });
      return send(res, 200, {});
    }
  };
}
