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
// What a reader sees: the value each setting actually has on the machine, which the machine itself reports on
// every event (`managed.values`). A setting is never "in force" because a server said so -- it is in force
// when the machine says it is, and until then the page shows what was set beside what is running. There is no
// revision to follow: settings carry the time they were set, newest wins, which is the rule the session
// events already use, and an answer that arrives out of order cannot walk a setting back.
import fs from 'node:fs';
import path from 'node:path';
import { thinkerHome } from './update.js';

export const MANAGED_FILE = home => path.join(home, 'state', 'managed.json');

const int = (min, max) => v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : undefined; };
const bool = v => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);

// Every setting an operator may set, with the type and bounds it is coerced to. The path is the one
// `readMachineConfig` already answers at, so nothing downstream changes. `label`, `help`, `dflt` and the
// slider's bounds are what the page draws from: this list is the single description of the control surface,
// read by the UI through /api/schema, so a control that does nothing cannot appear on the page.
//
// Four, and deliberately four. Each is a decision an operator running other people's agents actually makes
// -- when to cut, whether to delegate and from what size, whether to serve the profile -- and each of them
// changes what a session costs. What is not here: the holdouts (an experiment arm, set for a measurement and
// not per machine), the cut's floor and kept-results count (internals of a policy that is judged as a whole,
// `cutting.js:policyId`), the subagent's model, and the sink URL. They are all still settings; they are not
// knobs to hand somebody looking at a fleet. A short list a reader can hold in their head beats a long one
// where the two that matter are lost.
//
// A slider's `min`/`max` are the coercion's bounds, never wider: what the page offers is exactly what a
// machine will take, so a value cannot be set that is then silently dropped on arrival.
export const MANAGED = [
  { path: 'proxy.trigger', type: 'int', coerce: int(40_000, 400_000), min: 40_000, max: 400_000, step: 10_000, dflt: 140_000,
    label: 'Cut above', unit: 'tokens', help: 'Context size a call must reach before thinker cuts finished tool results out of it. Lower cuts sooner and more often; too low and the cache rewrite costs more than the cut saves.' },
  { path: 'delegate.enabled', type: 'bool', coerce: bool, dflt: false,
    label: 'Delegate big reads', help: 'A read past the size below, or a whole-suite test run, is handed to a Sonnet subagent and its report comes back instead of the file.' },
  { path: 'delegate.threshold', type: 'int', coerce: int(8_000, 120_000), min: 8_000, max: 120_000, step: 1_000, dflt: 35_000,
    label: 'Delegate above', unit: 'tokens', help: "One read this size fires at once; smaller reads fire once the turn's reads have passed it together." },
  { path: 'learn.profile', type: 'bool', coerce: bool, dflt: true,
    label: 'Session profile', help: 'Whether what thinker learns about how someone works is compiled and served on the first prompt of a session.' },
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

// Take what the sink answered: `{ at, config }`, where `at` is when the operator set it. Returns the time now
// in force, or null if nothing was taken. Never throws: a collector that answers rubbish must cost a session
// nothing.
//
// Newest wins, by that time. That is all the ordering there is -- no revision to count and nothing to keep in
// step between the two sides. An answer from before what this machine already holds is dropped, which is what
// makes a spool draining behind a live session harmless, and the same settings arriving again are not rewritten.
export function applyManaged(payload, { home = thinkerHome(), env = process.env, from = '' } = {}) {
  try {
    if (!managedAllowed({ home, env })) return null;
    if (!payload || typeof payload !== 'object') return null;
    const at = typeof payload.at === 'string' ? payload.at : '';
    if (!at || Number.isNaN(Date.parse(at))) return null;
    const current = readManaged(home);
    if (current?.at && !(Date.parse(at) > Date.parse(current.at))) return current.at;
    const { config, dropped } = sanitize(payload.config);
    const record = { at, took: new Date().toISOString(), from, config, ...(dropped.length ? { dropped } : {}) };
    const f = MANAGED_FILE(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(record, null, 2) + '\n');
    return at;
  } catch { return null; }
}

// What goes on the event: the value each managed setting actually has on this machine -- its own file's where
// nobody set it, ours where somebody did. This is what a page draws its controls from, so what it shows is
// the machine's state rather than a guess at a default, and a setting just changed reads as pending until the
// machine's own next event agrees. These four are operational figures, and nothing here says whose machine
// this is: the only identity on an event is the install id.
//
// It reads the merged config the way `readMachineConfig` does, rather than calling it: repo-switch.js imports
// this file, so the dependency runs one way only.
export function managedValues({ home = thinkerHome(), env = process.env } = {}) {
  const cfg = mergeManaged(readLocalConfig(home), { home, env });
  const out = {};
  for (const { path: p } of MANAGED) {
    const v = get(cfg, p);
    if (v !== undefined) out[p] = v;
  }
  return out;
}

export function managedBlock({ home = thinkerHome(), env = process.env } = {}) {
  if (!managedAllowed({ home, env })) return { managed: { rev: null, off: true } };
  const m = readManaged(home);
  return { managed: { rev: m ? Number(m.rev) : 0, ...(m ? { at: m.at } : {}), values: managedValues({ home, env }) } };
}
