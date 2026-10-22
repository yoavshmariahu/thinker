// `thinker proxy`: the context proxy (proxy.js) in the foreground, and the report of what it did.
// Nothing points an agent at it yet; that waits for an experiment (ANTHROPIC_BASE_URL by hand until then).
import fs from 'node:fs';
import path from 'node:path';
import { proxyConfig, startProxy, proxyReport } from '../proxy.js';
import { NoteInjector, PROXY_CLIENT } from '../proxy-notes.js';
import { orient, beginTurn, servesNotes, HOOK_BUDGET } from '../ops.js';
import { cacheBundleIntro } from '../cache-guidance.js';
import { Store, findRepoRoot } from '../store.js';
import { thinkerHome } from '../update.js';
import { formatTokens } from '../model-usage.js';

// The notes for a request, as the prompt hook serves them (commands/hooks.js): once a session, fresh only,
// the holdout turn opened on the session (ops.js:beginTurn), under the same bundle line.
export function noteInjectorFor(store) {
  return new NoteInjector({
    serve: async ({ task, session }) => {
      if (!servesNotes(store)) { store.log({ op: 'orient', session, client: PROXY_CLIENT, task: String(task).slice(0, 200), served: [], empty: 'too-few-notes' }); return { text: '', ids: [] }; }
      const { turn, holdout } = beginTurn(store, session);
      const r = await orient(store, { task, session, client: PROXY_CLIENT, budget: HOOK_BUDGET, once: true, freshOnly: true, holdout, turn: turn || undefined });
      if (!r.included.length) return { text: '', ids: [] };
      return { text: `<thinker-cache>\n${cacheBundleIntro()}\n\n${r.text}\n</thinker-cache>`, ids: r.included.map(n => n.id) };
    },
  });
}

export const proxyLogFile = (env = process.env) => env.THINKER_PROXY_LOG || path.join(thinkerHome(), 'state', 'proxy.jsonl');

async function proxyCommand({ pos, flags, out, repo }) {
  const sub = pos[0] || 'serve';
  const logFile = proxyLogFile();
  if (sub === 'report') {
    const rows = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const since = flags.days ? new Date(Date.now() - Number(flags.days) * 864e5).toISOString() : undefined;
    const sides = proxyReport(rows, { since });
    if (flags.json) { out(JSON.stringify(sides, null, 2)); return; }
    if (!Object.keys(sides).length) { out(`No requests through the proxy yet (${logFile}).`); return; }
    for (const [side, s] of Object.entries(sides)) {
      out(`${side}: ${s.requests} requests in ${s.sessions} sessions, ${formatTokens(s.billedInput)} billed-equivalent input` +
        `${s.requests ? ` (${formatTokens(Math.round(s.billedInput / s.requests))} a request)` : ''}` +
        `${side === 'clearing' ? `, ${formatTokens(s.cleared)} cleared on ${s.requestsCleared} requests` : ''}; proxy overhead p50 ${s.overheadP50} ms, p99 ${s.overheadP99} ms`);
    }
    return;
  }
  if (sub !== 'serve') { out('usage: thinker proxy [serve] --port n | thinker proxy report [--days n] [--json]'); process.exitCode = 2; return; }
  const cfg = proxyConfig(flags);
  if (!cfg.port) { out('thinker proxy: name a port (--port n, or THINKER_PROXY_PORT).'); process.exitCode = 2; return; }
  // --notes, or proxy: { notes: true } in the checkout's config: the notes of this checkout (--repo names another)
  // go to the agents that pass through (proxy-notes.js)
  let notes = null;
  let notesRepo = null;
  const wanted = flags.notes === true || (flags.repo && flags.notes !== false);
  const candidate = flags.repo ? path.resolve(String(flags.repo)) : repo;
  if (candidate && fs.existsSync(path.join(candidate, '.git'))) {
    const s = new Store(findRepoRoot(candidate));
    if (wanted || (flags.notes !== false && s.exists() && s.config().proxy?.notes === true)) { notes = noteInjectorFor(s); notesRepo = s.repo; }
  } else if (wanted) { out(`thinker proxy: --notes needs a git checkout (${candidate || 'none'}).`); process.exitCode = 2; return; }
  const server = startProxy(cfg, {
    logFile, notes,
    onListen: a => out(`thinker proxy on http://127.0.0.1:${a.port} -> ${cfg.upstream}: clears tool results past ${cfg.trigger} input tokens, keeping ${cfg.keep}, at least ${cfg.clearAtLeast} at a time${cfg.holdout ? `, ${cfg.holdout * 100}% of sessions held out` : ''}.` +
      (notes ? `\nServes the notes of ${notesRepo} to agents with no prompt hook (Anthropic and OpenAI chat requests; one carrying a Claude Code session is left to its hooks).` : '') +
      `\nPoint the agent at it: ANTHROPIC_BASE_URL=http://127.0.0.1:${a.port}${notes ? ` (Goose: ANTHROPIC_HOST; an OpenAI-compatible client: OPENAI_BASE_URL=http://127.0.0.1:${a.port}/v1)` : ''}`),
  });
  server.on('error', e => { out(`thinker proxy: ${e.message}`); process.exitCode = 1; });
  await new Promise(resolve => {
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => server.close(resolve));
  });
}

export const commands = { proxy: proxyCommand };
