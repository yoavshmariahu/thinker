// `thinker proxy`: the context proxy (proxy.js) in the foreground (`serve`, what the service runs), the service on this
// machine (`on`, `off`, `status`: proxy-service.js, on by default since 2026-10-24 through `thinker connect`), the report
// of what it did and the offline replay.
import fs from 'node:fs';
import path from 'node:path';
import { proxyConfig, startProxy, proxyReport } from '../proxy.js';
import { replay, renderReplay, parsePolicies } from '../proxy-replay.js';
import { NoteInjector, PROXY_CLIENT } from '../proxy-notes.js';
import { findSessions } from '../transcripts.js';
import { orient, beginTurn, servesNotes, HOOK_BUDGET } from '../ops.js';
import { cacheBundleIntro } from '../cache-guidance.js';
import { Store, findRepoRoot } from '../store.js';
import { thinkerHome } from '../update.js';
import { formatTokens } from '../model-usage.js';
import { enableProxyService, disableProxyService, serviceState, isListening, wiredLines, serviceArgs, proxyUrl, proxyLogFile, standDown, proxyThrough } from '../proxy-service.js';

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

export { proxyLogFile };

async function proxyCommand({ pos, flags, out, repo, HERE }) {
  const sub = pos[0] || 'serve';
  const logFile = proxyLogFile();
  const cli = path.join(HERE, 'cli.js');
  if (sub === 'on') {
    // --gateway: sit in front of the model server this machine already routes Claude Code through, instead of
    // Anthropic's API, so the clearing reaches those sessions too (proxy-route.js:ownGateway). --upstream names one.
    // --no-gateway goes back to the API. Nothing but these puts the proxy in front of someone's gateway.
    const gateway = flags.upstream ? String(flags.upstream) : flags.gateway === true ? true : flags.gateway === false || flags['no-gateway'] ? false : undefined;
    const p = await enableProxyService({ cli, force: true, gateway });
    if (gateway === true && !p.upstream) { out('thinker proxy on --gateway: no model server of your own was found to forward to (no ANTHROPIC_BASE_URL in your settings, environment or shell files). The proxy forwards to the API as usual.'); }
    out(`Context proxy on: ${p.url}${p.upstream ? ` -> ${p.upstream}${p.gatewayFrom ? ` (your route, from ${p.gatewayFrom})` : ''}` : ''}${p.listening === false ? ' (not listening yet; the next prompt starts it)' : ''}, kept running by ${p.service.type === 'hook' ? 'the prompt hook' : p.service.type}${p.service.reason ? ` (${p.service.reason})` : ''}.`);
    for (const l of wiredLines(p.wired, p.url, p.upstream)) out(`  ${l}`);
    for (const u of p.wired.unchanged) if (!u.absent) out(`  ${u.agent}: already pointed at it`);
    out(`Flags of the service: thinker ${serviceArgs().join(' ')} (proxy: { holdout, trigger, keep, keepMin, clearAtLeast } in ${path.join(thinkerHome(), 'config.json')} changes them; thinker proxy off turns it off).`);
    return;
  }
  if (sub === 'off') {
    const r = disableProxyService();
    out('Context proxy off: the agents call the API directly again.');
    for (const l of wiredLines(r.wired, null)) out(`  ${l}`);
    if (r.removed.length) out(`  service entry removed: ${r.removed.join(', ')}`);
    return;
  }
  if (sub === 'status') {
    const s = serviceState();
    if (!s.enabled) {
      out(`Context proxy off${s.off ? ` since ${s.off.slice(0, 10)}` : ''} (thinker proxy on turns it on).`);
      // it stood aside by itself (proxy-service.js:standDown): say why, since nothing else will
      if (s.standDown) out(`  it stepped aside on ${s.standDown.at.slice(0, 10)}: ${s.standDown.reason}. Your agents call the API directly; thinker proxy on puts it back.`);
      return;
    }
    const listening = await isListening(s.port);
    const through = proxyThrough();
    out(`Context proxy on: ${proxyUrl()}${through ? ` -> ${through} (a model server of your own)` : ''}, ${listening ? 'listening' : 'NOT listening (the next prompt starts it)'}; flags: thinker ${serviceArgs().join(' ')}.`);
    flags.days ||= 30;
    pos[0] = 'report';
    return proxyCommand({ pos, flags, out, repo, HERE });
  }
  if (sub === 'report') {
    const rows = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const since = flags.days ? new Date(Date.now() - Number(flags.days) * 864e5).toISOString() : undefined;
    const sides = proxyReport(rows, { since });
    if (flags.json) { out(JSON.stringify(sides, null, 2)); return; }
    if (!Object.keys(sides).length) {
      // Requests the proxy passed on without the edit are in neither side of the holdout, so they were reported
      // as nothing at all -- which read as "no requests yet" for a gateway that refuses the edit (seen in the
      // container, 2026-10-28). The reasons are what there is to say.
      const passed = rows.filter(r => r.op === 'proxy' && (!since || r.at >= since) && !r.injected);
      if (passed.length) {
        const why = {};
        for (const r of passed) { const k = r.reason || 'other'; why[k] = (why[k] || 0) + 1; }
        out(`${passed.length} requests passed through the proxy untouched, none with the clearing edit: ${Object.entries(why).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
        if (why['edit-unsupported']) out('  edit-unsupported: the model server this proxy forwards to refused the API\'s context-management edit, so the proxy stopped adding it. Nothing is being saved on those requests.');
        return;
      }
      out(`No requests through the proxy yet (${logFile}).`);
      return;
    }
    for (const [side, s] of Object.entries(sides)) {
      if (side === 'responses') {
        for (const [name, r] of Object.entries(s)) out(`Responses ${name}: ${r.requests} requests, ${formatTokens(r.input)} input tokens (${formatTokens(r.cachedInput)} cached, included in input), ${formatTokens(r.output)} output tokens; ${r.removedBytes} tool-output bytes removed from requests, ${r.errors} errors` +
          (Object.keys(r.reasons).length ? `; ${Object.entries(r.reasons).map(([k, n]) => `${k}: ${n}`).join(', ')}` : '') + '.');
        continue;
      }
      out(`${side}: ${s.requests} requests in ${s.sessions} sessions, ${formatTokens(s.billedInput)} billed-equivalent input` +
        `${s.requests ? ` (${formatTokens(Math.round(s.billedInput / s.requests))} a request)` : ''}` +
        `${side === 'clearing' ? `, ${formatTokens(s.cleared)} cleared on ${s.requestsCleared} requests` : ''}; proxy overhead p50 ${s.overheadP50} ms, p99 ${s.overheadP99} ms`);
    }
    return;
  }
  // the policies replayed over this checkout's Claude Code sessions, no model call (proxy-replay.js)
  if (sub === 'replay') {
    const target = flags.repo ? path.resolve(String(flags.repo)) : repo;
    if (!target) { out('thinker proxy replay: run it in a git checkout, or name one with --repo (its Claude Code sessions are replayed).'); process.exitCode = 2; return; }
    let policies; try { policies = parsePolicies(flags.policies); } catch (e) { out(`thinker proxy replay: ${e.message}`); process.exitCode = 2; return; }
    const days = Number(flags.days) || 30;
    const files = findSessions(target, { sinceMs: days * 864e5 }).filter(s => s.client === 'claude').map(s => s.file);
    const r = replay(files, policies);
    if (flags.json) { out(JSON.stringify(r, null, 2)); return; }
    if (!r.all.sessions) { out(`No Claude Code sessions of ${target} in the last ${days} days.`); return; }
    out(`Claude Code sessions of ${target}, last ${days} days, replayed with the API clearing old tool results as each policy asks (no model call; the model's reaction to the placeholders is not in these numbers, an experiment is).`);
    out(renderReplay(r, formatTokens));
    return;
  }
  if (sub !== 'serve') { out('usage: thinker proxy on [--gateway] [--upstream url] | off | status | thinker proxy [serve] --port n | thinker proxy report [--days n] [--json] | thinker proxy replay [--days n] [--policies spec] [--json]'); process.exitCode = 2; return; }
  let cfg;
  try { cfg = proxyConfig(flags); } catch (e) { out(`thinker proxy: ${e.message}`); process.exitCode = 2; return; }
  if (!cfg.port) { out('thinker proxy: name a port (--port n, or THINKER_PROXY_PORT).'); process.exitCode = 2; return; }
  if (cfg.protocol === 'responses' && (flags.notes || flags.repo)) { out('thinker proxy: --protocol responses clears old tool outputs; --notes and --repo are not supported in this mode.'); process.exitCode = 2; return; }
  // --notes, or proxy: { notes: true } in the checkout's config: the notes of this checkout (--repo names another)
  // go to the agents that pass through (proxy-notes.js)
  let notes = null;
  let notesRepo = null;
  const wanted = flags.notes === true || (flags.repo && flags.notes !== false);
  const candidate = flags.repo ? path.resolve(String(flags.repo)) : repo;
  if (cfg.protocol !== 'responses' && candidate && fs.existsSync(path.join(candidate, '.git'))) {
    const s = new Store(findRepoRoot(candidate));
    if (wanted || (flags.notes !== false && s.exists() && s.config().proxy?.notes === true)) { notes = noteInjectorFor(s); notesRepo = s.repo; }
  } else if (wanted) { out(`thinker proxy: --notes needs a git checkout (${candidate || 'none'}).`); process.exitCode = 2; return; }
  const server = startProxy(cfg, {
    logFile, notes,
    // the service's own process: a routed harness that reaches it by mistake takes the proxy out of the agents'
    // settings, so the harness is whole again at the next session (proxy-service.js:standDown; no-op for a proxy
    // somebody started by hand on another port). `manage: false` leaves this process alone -- the service entry
    // goes, so nothing starts it again, but the requests in hand are answered rather than cut off, which matters
    // most where the refusals were an expired token and not a gateway after all.
    onStandDown: reason => { try { standDown(reason, { port: cfg.port, manage: false }); } catch { /* the request in hand matters more */ } },
    onListen: a => out(cfg.protocol === 'responses'
      ? `Responses proxy on http://127.0.0.1:${a.port} -> ${cfg.upstream}: clears old text tool outputs, preserving the current turn and at least ${cfg.keepMin} newest outputs.\nTriggers at ~${cfg.trigger} tokens and removes at least ~${cfg.clearAtLeast} (request bytes / 4; estimates, not measured savings).${cfg.holdout ? ` ${cfg.holdout * 100}% holdout.` : ''}\nIn a separate Codex provider, set base_url = "http://127.0.0.1:${a.port}" and supports_websockets = false. Keep the existing authentication and model. See docs/codex-proxy.md.\nNo Codex settings were changed. Restart the client after selecting the provider. Native compaction and linked histories pass through unchanged.`
      : `thinker proxy on http://127.0.0.1:${a.port} -> ${cfg.upstream}: clears tool results past ${cfg.trigger} input tokens, keeping ${cfg.keep === 'turn' ? `the current turn's (at least ${cfg.keepMin})` : cfg.keep}, at least ${cfg.clearAtLeast} at a time${cfg.holdout ? `, ${cfg.holdout * 100}% of sessions held out` : ''}.` +
      (notes ? `\nServes the notes of ${notesRepo} to agents with no prompt hook (Anthropic and OpenAI chat requests; one carrying a Claude Code session is left to its hooks).` : '') +
      `\nPoint the agent at it: ANTHROPIC_BASE_URL=http://127.0.0.1:${a.port}${notes ? ` (Goose: ANTHROPIC_HOST; an OpenAI-compatible client: OPENAI_BASE_URL=http://127.0.0.1:${a.port}/v1)` : ''}` +
      (cfg.codex ? `\nCodex: http://127.0.0.1:${a.port}/codex (existing OpenAI auth; HTTP/SSE; current turn preserved).` : '')),
  });
  server.on('error', e => { out(`thinker proxy: ${e.message}`); process.exitCode = 1; });
  await new Promise(resolve => {
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => server.close(resolve));
  });
}

export const commands = { proxy: proxyCommand };
