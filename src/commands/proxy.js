// `thinker proxy`: the context proxy (proxy.js) in the foreground, and the report of what it did.
// Nothing points an agent at it yet; that waits for an experiment (ANTHROPIC_BASE_URL by hand until then).
import fs from 'node:fs';
import path from 'node:path';
import { proxyConfig, startProxy, proxyReport } from '../proxy.js';
import { thinkerHome } from '../update.js';
import { formatTokens } from '../model-usage.js';

export const proxyLogFile = (env = process.env) => env.THINKER_PROXY_LOG || path.join(thinkerHome(), 'state', 'proxy.jsonl');

async function proxyCommand({ pos, flags, out }) {
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
  const server = startProxy(cfg, {
    logFile,
    onListen: a => out(`thinker proxy on http://127.0.0.1:${a.port} -> ${cfg.upstream}: clears tool results past ${cfg.trigger} input tokens, keeping ${cfg.keep}, at least ${cfg.clearAtLeast} at a time${cfg.holdout ? `, ${cfg.holdout * 100}% of sessions held out` : ''}.\nPoint Claude Code at it: ANTHROPIC_BASE_URL=http://127.0.0.1:${a.port}`),
  });
  server.on('error', e => { out(`thinker proxy: ${e.message}`); process.exitCode = 1; });
  await new Promise(resolve => {
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => server.close(resolve));
  });
}

export const commands = { proxy: proxyCommand };
