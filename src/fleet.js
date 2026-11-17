// Fleet reporting: a machine that holds an org API key tells that org's dashboard what its agents'
// sessions cost and saved. Beside the telemetry and nothing to do with it: the telemetry is thinker's
// own, anonymous, hourly and a 30-day window; this is the person's own org, keyed, and incremental.
//
// The rules it is built on.
//
// 1. **No key, nothing.** Without a key this file opens no socket, writes no state and spawns nothing:
//    thinker runs exactly as it does today. The key is `THINKER_API_KEY`, else the machine's own key file
//    (`thinker config set api-key`, mode 0600, never config.json, which other things read). `THINKER_FLEET=off`
//    is local mode with a key still set.
//
// 2. **It reports from the hooks, at most every five minutes, and only what changed.** A session's figures
//    move when a turn ends, so the Stop hook is where they are noted (`fleetTick`). If five minutes have
//    passed since the last report it is sent then; otherwise one detached process is left to send at the
//    five-minute mark, so what a machine did reaches the dashboard within five minutes without a scheduler
//    to install, and an idle machine sends nothing at all.
//
// 3. **A report is increments, applied exactly once.** It carries, for each session that moved, the
//    difference between its figures now and its figures as last acknowledged. The server adds them. So a
//    report is written to disk under its own id *before* it is sent, and that same report is sent again
//    until the server acknowledges it; nothing new is built while one is waiting. The server refuses the
//    last id it applied, so an answer lost on the way back costs nothing and counts nothing twice. One
//    sender at a time (a lock file), because two building from the same state would both send the same
//    increment under different ids.
//
// 4. **It may never cost a session anything.** Two seconds, then it gives up until next time; every
//    failure is "still waiting", never an error a hook could raise.
//
// 5. **What leaves is a closed list**: the machine's id, hostname, OS and thinker version; per session
//    its id, agent, model, the repository's name (never a URL, never a path), two times and numbers. No prompt,
//    no code, no path. The server drops anything else too, so a bug here cannot store one there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { thinkerHome } from './update.js';
import { getInstallId } from './telemetry.js';
import { readMachineConfig } from './repo-switch.js';
import { appVersion } from './proxy-service.js';
import { sessionEvent, isTestShipBlocked } from './events.js';
import { repoId } from './store.js';
import { isTestMode } from './test-mode.js';

export const FLEET = {
  url: 'https://api.thinker.sh/v1',
  everyMs: 5 * 60_000,
  timeoutMs: 2000,
  sessionsMax: 10,       // a report's sessions; one in depth is ~15 KB, and the server takes 20
  reportsMax: 5,         // reports sent back to back when more sessions moved than one holds
  keepDays: 2,           // a session untouched this long with nothing left to send is forgotten
  lockMs: 30_000,        // a lock older than this was left by a process that died
};
const KEY_RE = /^thk_live_[0-9A-Za-z]{43}$/;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const keyFile = home => path.join(home, 'fleet-key');
const stateFile = home => path.join(home, 'state', 'fleet.json');
const lockFile = home => path.join(home, 'state', 'fleet.lock');

// ---------------------------------------------------------------- the key
export function fleetKey({ env = process.env, home = thinkerHome() } = {}) {
  if (String(env.THINKER_FLEET || '').toLowerCase() === 'off') return null;
  if (env.THINKER_API_KEY) return { key: env.THINKER_API_KEY.trim(), from: 'env' };
  try {
    const key = fs.readFileSync(keyFile(home), 'utf8').trim();
    return key ? { key, from: 'file' } : null;
  } catch { return null; }
}
export function setFleetKey(key, { home = thinkerHome() } = {}) {
  const value = String(key || '').trim();
  if (!KEY_RE.test(value)) throw new Error('That is not a thinker API key: it starts with thk_live_ and is 52 characters long.');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(keyFile(home), value + '\n', { mode: 0o600 });
  fs.chmodSync(keyFile(home), 0o600);
}
export function unsetFleetKey({ home = thinkerHome() } = {}) {
  try { fs.unlinkSync(keyFile(home)); return true; } catch { return false; }
}
// Never the key itself in anything printed or logged.
export const redactKey = text => String(text).replace(/thk_[0-9A-Za-z_]+/g, 'thk_<redacted>');

export const fleetUrl = ({ home = thinkerHome() } = {}) => {
  let url = null;
  try { url = readMachineConfig(home).fleet?.url || null; } catch {}
  return String(url || FLEET.url).replace(/\/+$/, '');
};
// The install id thinker already has, so a machine is one machine to the telemetry and to the fleet;
// `THINKER_MACHINE_ID` names it where a machine is rebuilt for every job and should stay one row.
export const machineId = ({ env = process.env, home = thinkerHome() } = {}) => {
  const named = String(env.THINKER_MACHINE_ID || '').trim();
  return /^[A-Za-z0-9._:-]{1,64}$/.test(named) ? named : getInstallId(home);
};

// ---------------------------------------------------------------- state
const emptyState = () => ({ v: 1, sessions: {}, pending: null, sentAt: 0, flushAt: 0, orgName: null, last: null });
export function readFleetState(home = thinkerHome()) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
    return state && state.v === 1 && state.sessions ? { ...emptyState(), ...state } : emptyState();
  } catch { return emptyState(); }
}
function writeFleetState(home, state) {
  const file = stateFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}
// One sender at a time. Taken with an exclusive create; a lock past `lockMs` is a dead process's.
function withLock(home, now, run) {
  const file = lockFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const take = () => { fs.writeFileSync(file, String(process.pid), { flag: 'wx' }); };
  try { take(); } catch {
    try { if (now - fs.statSync(file).mtimeMs < FLEET.lockMs) return null; fs.unlinkSync(file); take(); } catch { return null; }
  }
  const release = () => { try { fs.unlinkSync(file); } catch {} };
  let result;
  try { result = run(); } catch (error) { release(); throw error; }
  return Promise.resolve(result).finally(release);
}

// ---------------------------------------------------------------- what a session is, as numbers
// The session's own figures as `events.js:sessionEvent` reads them -- one computation, the Report's and
// `thinker prs`'s -- flattened to the numbers a report carries. Dollars only where the session was priced.
export function metricsOf(event) {
  const n = value => (Number.isFinite(value) ? value : 0);
  const out = { prompts: n(event.prompts), tokens: n(event.tokens), cleared_tokens: n(event.cleared),
    calls: n(event.decisions?.calls), cuts: n(event.decisions?.cuts) };
  if (event.cost?.priced) {
    Object.assign(out, { saved_usd: n(event.cost.saved), net_usd: n(event.cost.net), rewrite_usd: n(event.cost.rewrite), reread_usd: n(event.cost.reread) });
    if (event.cost.spend != null) out.spend_usd = n(event.cost.spend);
  }
  return out;
}
// A repository's name and never where it is: the last two parts of its origin, or nothing where it has none
// (`repoId` falls back to the checkout's path, which must not leave the machine).
export function repoName(repo) {
  if (!repo) return null;
  const id = repoId(repo);
  if (!id || id === repo || path.isAbsolute(id)) return null;
  const name = id.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).slice(-2).join('/');
  return /^[\w.-]+(?:\/[\w.-]+)?$/.test(name) ? name : null;
}
// A session in depth, for the dashboard's session page: one point a model call, what thinker did, and the
// cost by token type. Rebuilt here field by field from what `events.js` holds, so only numbers and names
// from closed sets go: a delegation's file names and its error text stay on the machine.
export function detailOf(event) {
  const d = event?.decisions;
  if (!d || !(d.series?.length || d.actions?.length)) return null;
  const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] != null && o[k] !== false).map(k => [k, o[k]]));
  return {
    series: d.series.map(p => pick(p, ['c', 'at', 'carried', 'out', 'cost', 'turn', 'cut', 'cold', 'reason', 'fresh', 'read', 'write'])),
    actions: (d.actions || []).map(a => ({
      ...pick(a, ['kind', 'at', 'turn', 'tokens', 'results', 'lines', 'chars', 'usd', 'cold', 'held', 'cached', 'afterCompaction', 'policy', 'arm', 'of', 'model']),
      ...(a.tools ? { tools: a.tools.map(t => pick(t, ['name', 'calls', 'tokens'])) } : {}),
    })),
    by_type: d.byType ? Object.fromEntries(Object.entries(d.byType).map(([k, v]) => [k, Math.round(v * 1e4) / 1e4])) : {},
  };
}
const stampOf = detail => (detail ? crypto.createHash('sha256').update(JSON.stringify(detail)).digest('hex').slice(0, 16) : null);
const round = value => Math.round(value * 1e6) / 1e6;
const deltaOf = (seen = {}, sent = {}) => {
  const out = {};
  for (const name of new Set([...Object.keys(seen), ...Object.keys(sent)])) {
    const d = round((seen[name] || 0) - (sent[name] || 0));
    if (d) out[name] = d;
  }
  return out;
};

// Note what a session is now. Nothing is sent here.
export function noteSession(store, { session, home = thinkerHome(), env = process.env, now = Date.now(), event = null } = {}) {
  const ev = event || sessionEvent(store, { session, home, env, now: new Date(now) });
  if (!ev?.session) return false;
  const state = readFleetState(home);
  const known = state.sessions[ev.session] || { sent: {}, lastSentAt: null };
  state.sessions[ev.session] = { ...known, startedAt: known.startedAt || ev.firstAt || new Date(now).toISOString(), lastAt: ev.lastAt || new Date(now).toISOString(),
    agent: ev.client || null, model: ev.model || null, repo: repoName(store?.repo), seen: metricsOf(ev), notedAt: now };
  // The depth is a picture of the session as it stands, not an increment: it is kept whole, and sent again
  // only when it has changed (its stamp), since most turns move the figures and not every one adds a call.
  const detail = detailOf(ev);
  Object.assign(state.sessions[ev.session], { detail, detailStamp: stampOf(detail) });
  writeFleetState(home, state);
  return true;
}

// The next report: every session whose figures or last activity moved since it was last acknowledged.
function buildReport(state, { home, env, now }) {
  const moved = Object.entries(state.sessions).map(([id, s]) => ({ id, s, metrics: deltaOf(s.seen, s.sent) }))
    .filter(({ s, metrics }) => Object.keys(metrics).length || s.lastAt !== s.lastSentAt || (s.detailStamp || null) !== (s.detailSent || null))
    .sort((a, b) => (a.s.notedAt || 0) - (b.s.notedAt || 0)).slice(0, FLEET.sessionsMax);
  return {
    marks: Object.fromEntries(moved.map(({ id, s }) => [id, { sent: s.seen, lastSentAt: s.lastAt, detailSent: s.detailStamp || null }])),
    body: {
      machine_id: machineId({ env, home }), report_id: crypto.randomUUID(), hostname: os.hostname(), os: `${process.platform} ${os.release()}`,
      thinker_version: appVersion(),
      sessions: moved.map(({ id, s, metrics }) => ({ session_id: id, started_at: s.startedAt, last_at: s.lastAt, agent: s.agent, model: s.model || null, repo: s.repo, metrics,
        ...(s.detail && (s.detailStamp || null) !== (s.detailSent || null) ? { detail: s.detail } : {}) })),
    },
  };
}

// One report: what is waiting, or what has moved. `force` sends even an empty one -- a machine saying it
// is there -- which is what `thinker status` asks for. Never throws.
async function sendOne({ home = thinkerHome(), env = process.env, now = Date.now(), fetchFn = globalThis.fetch, force = false } = {}) {
  const found = fleetKey({ env, home });
  if (!found) return { mode: 'local' };
  const url = fleetUrl({ home }) + '/reports';
  if (isTestShipBlocked({ kind: 'http', url }, env)) return { mode: 'fleet', sent: false, reason: 'test' };
  const done = await withLock(home, now, async () => {
    const state = readFleetState(home);
    if (!state.pending) {
      const next = buildReport(state, { home, env, now });
      if (!next.body.sessions.length && !force) return { mode: 'fleet', sent: false, reason: 'nothing-new' };
      state.pending = next;
      writeFleetState(home, state);   // on disk before it is sent: the same report goes again if this one's answer is lost
    }
    const pending = state.pending;
    // Written over the state as it is *now*, not as it was before the request: a hook may have noted a
    // session while this one was on the wire, and that note must not be lost under an older copy.
    const finish = (result, patch = () => ({})) => {
      const fresh = readFleetState(home);
      Object.assign(fresh, { pending }, patch(fresh), { last: { at: now, ...result } });
      writeFleetState(home, fresh);
      return { mode: 'fleet', ...result, orgName: fresh.orgName };
    };
    let response;
    try {
      response = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + found.key },
        body: JSON.stringify(pending.body), signal: AbortSignal.timeout(FLEET.timeoutMs) });
    } catch (error) {
      return finish({ sent: false, reason: 'unreachable', detail: redactKey(error?.name || 'error') });
    }
    if (response.status === 401) return finish({ sent: false, reason: 'invalid-key' });
    // The request itself was refused as malformed: sending it again cannot help, and holding it would hold
    // everything behind it. Its increments stay unsent and go into the next report.
    if (response.status === 400) return finish({ sent: false, reason: 'refused' }, () => ({ pending: null }));
    if (!response.ok) return finish({ sent: false, reason: 'unreachable', detail: 'HTTP ' + response.status });
    let answer = {};
    try { answer = await response.json(); } catch {}
    return finish({ sent: true, sessions: pending.body.sessions.length }, fresh => {
      for (const [id, mark] of Object.entries(pending.marks)) if (fresh.sessions[id]) Object.assign(fresh.sessions[id], mark);
      const cutoff = now - FLEET.keepDays * 86400e3;
      for (const [id, s] of Object.entries(fresh.sessions)) {
        if ((s.notedAt || 0) < cutoff && !Object.keys(deltaOf(s.seen, s.sent)).length) delete fresh.sessions[id];
      }
      return { pending: null, sentAt: now, flushAt: 0, orgName: answer.org_name ?? fresh.orgName };
    });
  });
  return done || { mode: 'fleet', sent: false, reason: 'busy' };
}

// Send what is waiting or has moved. A report holds `sessionsMax` sessions, so a machine with more than
// that to say sends a few back to back rather than waiting five minutes for each; the first failure stops it.
export async function sendFleetReport(options = {}) {
  let result = await sendOne(options), sessions = result.sessions || 0;
  for (let n = 1; n < FLEET.reportsMax && result.sent && result.sessions === FLEET.sessionsMax; n++) {
    const next = await sendOne({ ...options, force: false });
    if (!next.sent) break;
    result = next; sessions += next.sessions || 0;
  }
  return result.sent ? { ...result, sessions } : result;
}

// The hook's whole part in this: note the session, then send now if a report is due, else make sure one
// process is waiting for the five-minute mark. Returns what it did, for the tests.
export async function fleetTick(store, { session, home = thinkerHome(), env = process.env, now = Date.now(), fetchFn, spawnFn = spawn, cliPath = path.join(HERE, 'cli.js') } = {}) {
  try {
    if (!fleetKey({ env, home })) return { mode: 'local' };
    if (session && session !== 'unknown') noteSession(store, { session, home, env, now });
    const state = readFleetState(home);
    if (now - (state.sentAt || 0) >= FLEET.everyMs) return await sendFleetReport({ home, env, now, fetchFn });
    const due = state.sentAt + FLEET.everyMs;
    if (state.flushAt >= due) return { mode: 'fleet', sent: false, reason: 'scheduled', at: state.flushAt };
    state.flushAt = due;
    writeFleetState(home, state);
    // Not under test: a suite must not leave processes behind it.
    if (!isTestMode(env) || spawnFn !== spawn) {
      const child = spawnFn(process.execPath, [cliPath, 'fleet-report', '--background', '--at', String(due)], { detached: true, stdio: 'ignore', env: { ...env, THINKER_HOME: home } });
      child.unref?.();
    }
    return { mode: 'fleet', sent: false, reason: 'scheduled', at: due };
  } catch (error) {
    return { mode: 'fleet', sent: false, reason: 'error', detail: redactKey(error?.message || error).slice(0, 120) };
  }
}

// `thinker status`: which mode, which org, which machine, and whether the fleet answers. Asking is a real
// report (whatever is waiting, or an empty one), so "reachable" means the key was accepted just now.
export async function fleetStatus({ home = thinkerHome(), env = process.env, now = Date.now(), fetchFn } = {}) {
  const found = fleetKey({ env, home });
  const off = String(env.THINKER_FLEET || '').toLowerCase() === 'off';
  if (!found) return { mode: 'local', reason: off ? 'THINKER_FLEET=off' : 'no API key', machineId: machineId({ env, home }) };
  const result = await sendFleetReport({ home, env, now, fetchFn, force: true });
  return { mode: 'fleet', keyFrom: found.from, machineId: machineId({ env, home }), url: fleetUrl({ home }), orgName: result.orgName ?? null,
    reachable: result.sent === true, reason: result.sent ? null : result.reason };
}
