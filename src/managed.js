// Settings an operator sets centrally, for a fleet of machines they run (the dashboard in demo/collector).
//
// The shape of it. A machine ships a session event to its sink (events.js); the sink answers with the settings
// it wants that machine to run. There is no inbound connection and no agent listening on the machine: a cloud
// harness behind NAT is reached the same way a laptop is, by answering the request it already makes. The
// settings land in THINKER_HOME/state/managed.json and are merged by `readMachineConfig`, which is the one
// door every machine-scope setting is read through (repo-switch.js), so the proxy's cut, the delegation
// trigger and the rest pick them up without knowing this file exists.
//
// Three rules, and they are the whole of the trust model:
//
// 1. **The person's config.json is never written.** It is their file. A managed setting sits in thinker's own
//    state and is merged over it in memory; `thinker config` and `updateMachineConfig` still read and write
//    the local file alone, so taking the machine out of the fleet restores exactly what they had.
// 2. **Only the settings in `MANAGED` may be set, and each is coerced to its own type and bounds.** A sink
//    cannot reach `prices` (that would move every dollar figure thinker reports), `proxy.upstream` or
//    `proxy.gateways` (that would move a fleet's model traffic to a host of the sink's choosing), or
//    `disabledRepos` (a repository someone switched off is not something a server may switch back on).
//    Anything else in the payload is dropped, not an error: a newer collector may know keys this build does not.
// 3. **A machine opts in by naming a sink.** `events: false` or `THINKER_EVENTS=off` is no sink, so nothing is
//    asked for and nothing arrives; `managed: false` in config.json or `THINKER_MANAGED=off` keeps the sink for
//    the figures and refuses its settings.
//
// What wins: environment over managed over config.json. The environment is the container's own switch, set by
// whoever started it, and it is read at the point of use (`THINKER_DELEGATE`, `THINKER_PROXY_*`); the managed
// layer is the fleet's; the file is the machine's. So a central policy beats a machine's own file -- otherwise
// it is advice, not control -- and a person at the keyboard can still override it for one process.
//
// What a reader sees: `rev` rises on every change the operator makes, the machine echoes the rev it is running
// in the next event (`managed` on the event), and the page shows sent against confirmed. A setting is never
// "applied" because a server said so; it is applied when a machine says it is.
import fs from 'node:fs';
import path from 'node:path';
import { thinkerHome } from './update.js';

export const MANAGED_FILE = home => path.join(home, 'state', 'managed.json');

const int = (min, max) => v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : undefined; };
const rate = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined; };
const bool = v => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const text = max => v => { const s = String(v ?? '').trim(); return s && s.length <= max ? s : undefined; };
const url = v => { try { const u = new URL(String(v)); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined; } catch { return undefined; } };

// Every setting an operator may set, with the type and bounds it is coerced to. The path is the one
// `readMachineConfig` already answers at, so nothing downstream changes. `label` and `help` are what the
// page shows; this list is the single description of the control surface, read by the UI through /api/schema.
export const MANAGED = [
  { path: 'proxy.trigger', type: 'int', coerce: int(20_000, 1_000_000), label: 'Cut above', unit: 'tokens', help: 'Context size a call must reach before thinker cuts finished tool results out of it. Default 140,000.' },
  { path: 'proxy.clearAtLeast', type: 'int', coerce: int(0, 1_000_000), label: 'Smallest cut', unit: 'tokens', help: 'A cut smaller than this is not worth the cache rewrite it costs, so it is refused (below-clear-minimum). Default 60,000.' },
  { path: 'proxy.keep', type: 'int', coerce: int(0, 100), label: 'Results kept', unit: 'results', help: 'Tool results kept whole at the end of the conversation, newest first. Default 3, plus the whole newest turn.' },
  { path: 'proxy.holdout', type: 'rate', coerce: rate, label: 'Clearing holdout', unit: 'share', help: 'Share of sessions held out from the cut as a control arm, by hash of the session id. 0 runs the cut everywhere; 0.5 is an experiment.' },
  { path: 'delegate.enabled', type: 'bool', coerce: bool, label: 'Delegate big reads', help: 'A read past the threshold, or a whole-suite test run, is handed to a Sonnet subagent and its report comes back instead of the file.' },
  { path: 'delegate.model', type: 'text', coerce: text(80), label: 'Subagent model', help: 'The model the delegated read runs on. Default claude-sonnet-5-5.' },
  { path: 'delegate.threshold', type: 'int', coerce: int(4_000, 500_000), label: 'Delegate above', unit: 'tokens', help: "One read this size fires at once; smaller reads fire once the turn's reads have passed it. Default 35,000." },
  { path: 'delegate.holdout', type: 'rate', coerce: rate, label: 'Delegation holdout', unit: 'share', help: 'Share of sessions that read as they would have, so the trigger can be measured against them. Default 0.5.' },
  { path: 'learn.profile', type: 'bool', coerce: bool, label: 'Session profile', help: 'Whether what a machine learns about how someone works is compiled and served on the first prompt.' },
  { path: 'learn.profileHoldout', type: 'rate', coerce: rate, label: 'Profile holdout', unit: 'share', help: 'Share of sessions served no profile, so its effect on cost can be read. Default 0.5.' },
  { path: 'events.url', type: 'url', coerce: url, label: 'Report to', help: 'Where this machine ships one JSON object per session. Changing it moves the machine to another collector; it takes effect on the next session.' },
];
const BY_PATH = new Map(MANAGED.map(m => [m.path, m]));

const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const set = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); let t = o; for (const k of ks) t = (t[k] && typeof t[k] === 'object') ? t[k] : (t[k] = {}); t[last] = v; return o; };

// What of a payload this build will actually run: every known path coerced to its type, everything else dropped.
// A value of null is "unset this", which is how an operator hands a setting back to the machine's own file.
export function sanitize(raw) {
  const out = {}, dropped = [];
  if (!raw || typeof raw !== 'object') return { config: out, dropped };
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (BY_PATH.has(p)) {
        if (v === null) { set(out, p, null); continue; }
        const c = BY_PATH.get(p).coerce(v);
        if (c === undefined) dropped.push(p); else set(out, p, c);
      } else if (v && typeof v === 'object' && !Array.isArray(v) && MANAGED.some(m => m.path.startsWith(`${p}.`))) walk(v, p);
      else dropped.push(p);
    }
  };
  walk(raw, '');
  return { config: out, dropped };
}

// { rev, at, from, config } -- what this machine was last told to run, as it stands on disk.
export function readManaged(home = thinkerHome()) {
  try {
    const v = JSON.parse(fs.readFileSync(MANAGED_FILE(home), 'utf8'));
    return v && typeof v === 'object' && v.config && typeof v.config === 'object' ? v : null;
  } catch { return null; }
}

// Whether this machine takes settings from its sink at all. Off is a local decision and a server cannot change it
// (`managed` is not in MANAGED), so a machine can always be taken out of the fleet's control from the machine.
export function managedAllowed({ home = thinkerHome(), env = process.env, config } = {}) {
  if (String(env.THINKER_MANAGED || '').toLowerCase() === 'off') return false;
  const cfg = config || readLocalConfig(home);
  return cfg.managed !== false;
}

// The local file alone, with no managed layer over it: what `updateMachineConfig` must read before it writes,
// so a central setting is never baked into the person's file.
export function readLocalConfig(home = thinkerHome()) {
  try { return JSON.parse(fs.readFileSync(path.join(home || thinkerHome(), 'config.json'), 'utf8')) || {}; } catch { return {}; }
}

// The machine's own config with the fleet's settings merged over it, leaf by leaf, for the allowed paths only.
export function mergeManaged(local, { home = thinkerHome(), env = process.env, managed } = {}) {
  if (!managedAllowed({ home, env, config: local })) return local;
  const m = managed !== undefined ? managed : readManaged(home);
  if (!m?.config) return local;
  const out = structuredClone(local);
  for (const { path: p } of MANAGED) {
    const v = get(m.config, p);
    if (v === undefined) continue;
    if (v === null) continue; // handed back to the machine's own file
    set(out, p, v);
  }
  return out;
}

// Take what the sink answered. Returns the rev now in force, or null if nothing changed or nothing was allowed.
// Never throws: a collector that answers rubbish must cost a session nothing.
export function applyManaged(payload, { home = thinkerHome(), env = process.env, from = '' } = {}) {
  try {
    if (!managedAllowed({ home, env })) return null;
    if (!payload || typeof payload !== 'object') return null;
    const rev = Number(payload.rev);
    if (!Number.isFinite(rev) || rev < 0) return null;
    const current = readManaged(home);
    if (current && Number(current.rev) === rev) return rev; // already running it
    if (current && Number(current.rev) > rev) return Number(current.rev); // an older answer never walks a setting back
    const { config, dropped } = sanitize(payload.config);
    const record = { rev, at: new Date().toISOString(), from, config, ...(dropped.length ? { dropped } : {}) };
    const f = MANAGED_FILE(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(record, null, 2) + '\n');
    return rev;
  } catch { return null; }
}

// What goes on the event, so the page can show what a machine is actually running against what was sent to it.
export function managedBlock({ home = thinkerHome(), env = process.env } = {}) {
  if (!managedAllowed({ home, env })) return { managed: { rev: null, off: true } };
  const m = readManaged(home);
  return m ? { managed: { rev: Number(m.rev), at: m.at } } : {};
}
