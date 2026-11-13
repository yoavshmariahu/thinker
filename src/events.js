// Where a session's figures go when they leave the machine: one JSON object per session, newline-delimited.
//
// Why a session event and not the telemetry payload. The payload (`telemetry.js:buildTelemetryPayload`) is a
// 30-day window of sums sent every hour, which is right for a dashboard that divides sums by sums and wrong
// for anything that *adds* what it receives: 720 sends of one window would read as 720 months of work. A
// session is the opposite -- it happens once, it is never restated, and a sink can add them up. thinker
// already writes exactly that, the `op: session` row the Stop hook logs (`commands/hooks.js`), so this
// invents no format: it takes the row's session as the one pricing door already measures it, and ships it.
//
// One computation, not two. The figures come from `delivery.js:sessionsOf` -- the same walk that `thinker
// prs`, the posted comment and the Report read -- so a dollar here can never disagree with a dollar there.
// Nothing in this file multiplies a token by a rate; `prices.js` is the only door for that (AGENTS.md), and
// a sink that wants dollars gets the ones the machine already computed.
//
// A session is shipped at its end and may be shipped again: the clearing's own figure settles a few turns
// after the cut (`compression.js`), so a later row carries more than an earlier one. Events are therefore
// **upserts keyed on (install, session)**, newest wins -- the same rule `clearedBySession` follows for the
// rows it reads, and the reason the collector must not sum two events for one session.
//
// Targets, by `THINKER_EVENTS` or `events` in THINKER_HOME/config.json:
//   off | <absent>        nothing is shipped (the default: a machine exports when asked, not by itself)
//   stdout               one line per session on standard output, for a container whose logs are collected
//   /path/to/file.jsonl  appended, for a log agent (Vector, Fluent Bit, the Datadog agent) to tail
//   http(s)://host/path  POSTed as newline-delimited JSON, for a collector
// The shape is the same in all four, which is what makes "it speaks your sink" true rather than a claim:
// an OTLP or Prometheus emitter is another target here, not another measurement.
import fs from 'node:fs';
import path from 'node:path';
import { thinkerHome } from './update.js';
import { readMachineConfig } from './repo-switch.js';
import { sessionsOf } from './delivery.js';
import { sessionKey } from './usage.js';
import { readLabels } from './labels.js';
import { getInstallId } from './telemetry.js';
import { isTestMode } from './test-mode.js';

export const EVENTS = {
  schemaVersion: 1,
  timeoutMs: 2000,      // a hook may not hang on a sink that is down
  spoolMax: 500,        // lines kept when the sink refuses; oldest dropped first
  batchMax: 50,         // lines per POST when the spool is draining
  // How far back the one session's figures are read over. `sessionsOf` walks the log from `since`, and the
  // session being shipped has just ended, so two days is generous; the whole log would make a hook's cost
  // grow with the machine's history for nothing.
  windowDays: 2,
};
const defaultSince = (now = Date.now()) => new Date(now - EVENTS.windowDays * 864e5).toISOString();

const spoolFile = home => path.join(home, 'state', 'events-spool.jsonl');

// A test may ship to its own loopback collector and to nowhere else. Same rule as the telemetry's
// (`telemetry.js:isTestTelemetryBlocked`): a suite that reached a real host would publish a machine's
// sessions from a test run, and the one place that must never happen is the one nobody watches.
export function isTestShipBlocked(target, env = process.env) {
  if (!isTestMode(env) && !env.NODE_TEST_CONTEXT) return false;
  if (!target || target.kind !== 'http') return false;
  try {
    const url = new URL(target.url);
    return !['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return true; }
}

// Where this machine ships, or null for nowhere. The environment wins over the config, as everywhere else.
export function eventsTarget({ env = process.env, home = thinkerHome() } = {}) {
  const fromConfig = () => {
    let cfg; try { cfg = readMachineConfig(home).events; } catch { return undefined; }
    if (cfg === false || cfg === 'off') return 'off';
    if (typeof cfg === 'string') return cfg;
    if (cfg && typeof cfg === 'object') return cfg.url || cfg.path || (cfg.stdout ? 'stdout' : undefined);
    return undefined;
  };
  const raw = String(env.THINKER_EVENTS ?? fromConfig() ?? '').trim();
  if (!raw || /^(off|0|false|no)$/i.test(raw)) return null;
  if (/^(stdout|-)$/i.test(raw)) return { kind: 'stdout' };
  if (/^https?:\/\//i.test(raw)) { try { return { kind: 'http', url: new URL(raw).toString() }; } catch { return null; } }
  return { kind: 'file', path: path.resolve(raw) };
}

// The event: what one session was, cost and saved, as the machine already measured it. Counts and dollars
// only -- no path, no branch, no prompt, no repository name. `labels` is the one part somebody chose
// (labels.js), and the only place a customer, a harness build or a job can be named.
export function sessionEvent(store, { session, home = thinkerHome(), env = process.env, log = null, since = defaultSince(), now = new Date() } = {}) {
  if (!session || session === 'unknown') return null;
  const sessions = sessionsOf(store, { since, log, home, env });
  const x = sessions.get(sessionKey(session));
  if (!x) return null;
  const num = v => (Number.isFinite(v) ? v : null);
  return {
    v: EVENTS.schemaVersion,
    at: now.toISOString(),
    install: getInstallId(home),
    labels: readLabels({ env, home }),
    session: sessionKey(session),
    client: x.client || null,
    model: x.model || null,
    firstAt: x.firstAt || null,
    lastAt: x.lastAt || null,
    prompts: x.prompts || 0,
    tokens: num(x.tokens),
    ownTokens: num(x.ownTokens),
    subagentTokens: num(x.subagentTokens),
    subagents: x.subagents?.length || 0,
    cleared: x.cleared || 0,
    policy: x.policy || null,
    rereads: x.rereads ? { reads: x.rereads.reads || 0, tokens: x.rereads.tokens || 0 } : null,
    // dollars as `sessionsOf` priced them; `priced: false` where the model has no list price, and
    // `spend` null unless every counter of the session and of its subagents was complete
    cost: {
      saved: x.cost?.saved ?? 0,
      rewrite: x.cost?.rewrite ?? 0,
      reread: x.cost?.reread ?? 0,
      net: x.cost?.net ?? 0,
      spend: x.cost?.spend ?? null,
      priced: Boolean(x.cost?.priced),
    },
  };
}

const readSpool = home => {
  try { return fs.readFileSync(spoolFile(home), 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
const writeSpool = (home, lines) => {
  const f = spoolFile(home);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (!lines.length) { fs.rmSync(f, { force: true }); return; }
    fs.writeFileSync(f, lines.slice(-EVENTS.spoolMax).join('\n') + '\n');
  } catch { /* a spool that cannot be written loses the event, never the hook */ }
};

// Ship lines to the target. Returns how many left; a refusal is not an error here, it is a spool.
async function ship(lines, target, { fetchFn = globalThis.fetch, timeoutMs = EVENTS.timeoutMs } = {}) {
  if (!lines.length) return 0;
  const body = lines.join('\n') + '\n';
  if (target.kind === 'stdout') { process.stdout.write(body); return lines.length; }
  if (target.kind === 'file') {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.appendFileSync(target.path, body);
    return lines.length;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson', 'X-Thinker-Events': String(EVENTS.schemaVersion) },
      body,
      signal: ctl.signal,
    });
    // 2xx is taken; anything else is the sink's business and the lines wait in the spool
    return res && res.ok ? lines.length : 0;
  } catch {
    // A collector that is not listening, a DNS that does not answer, the timeout above: none of them is an
    // error here. They are all "nothing left", and the caller spools what did not go -- which is the whole
    // point of the spool, and was a real bug: a thrown fetch used to reach the outer catch and lose the line.
    return 0;
  } finally { clearTimeout(timer); }
}

// One session out, with whatever earlier sessions the sink refused. Never throws and never waits long: a
// collector that is down must cost a session nothing, and the spool is how the figures survive it.
export async function emitSession(store, { session, home = thinkerHome(), env = process.env, target = eventsTarget({ env, home }), event, fetchFn, log = null, since = defaultSince() } = {}) {
  if (!target) return { shipped: 0, skipped: 'no-target' };
  if (isTestShipBlocked(target, env)) return { shipped: 0, skipped: 'test' };
  try {
    const ev = event || sessionEvent(store, { session, home, env, log, since });
    const pending = [...readSpool(home), ...(ev ? [JSON.stringify(ev)] : [])];
    if (!pending.length) return { shipped: 0, skipped: 'nothing-to-ship' };
    const batch = pending.slice(0, EVENTS.batchMax);
    const sent = await ship(batch, target, { fetchFn });
    const left = sent ? pending.slice(sent) : pending;
    writeSpool(home, left);
    return { shipped: sent, spooled: left.length };
  } catch (err) {
    return { shipped: 0, error: String(err?.message || err).slice(0, 120) };
  }
}
