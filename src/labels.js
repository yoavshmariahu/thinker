// What a machine, a fleet or a harness says it is: the names a figure can be grouped by on the way out.
//
// Why this exists. Everything thinker sends is pseudonymous by construction -- an install id, a device id,
// counts and sums, and never a path, a repository, a prompt or a symbol. That is right for one person's
// machine and not enough for a company running thinker inside its own coding agent on its own cloud:
// `sessions.byClient` (delivery-telemetry.js) can already say what every OpenCode session cost, and nothing
// can say which customer, harness build or job it belonged to, because the only identity in a payload is the
// machine's own -- and a container's machine is nobody's, since a home that cannot keep an install id falls
// back to the device (`telemetry.js:getInstallId`).
//
// A label is set, never inferred. Nothing here reads the environment for a hostname, a cloud instance id, a
// cluster name or a git remote: a label exists because an operator wrote one, which also makes this the one
// place in a payload where identifying data can appear. That is the point of it, and the reason it is opt-in
// and documented as such: whether a customer's name leaves a machine is the operator's call to make, not a
// default of ours.
//
// Where they come from, lowest precedence first:
//   1. `labels` in THINKER_HOME/config.json      -- a machine or an image, baked in once
//   2. THINKER_LABELS                            -- the container's own, merged over it, per key
// A repository's own `.thinker/config.json` is deliberately not a source: a checkout is not a trust boundary
// for fleet attribution, and a cloned repository would otherwise relabel whoever ran it.
import { thinkerHome } from './update.js';
import { readMachineConfig } from './repo-switch.js';

// Small on purpose. These ride on every session row in the usage log and on every report, so a label set is
// a handful of short names, not a place to put a payload. What does not fit is dropped, never truncated into
// something that reads like a different value.
export const LABEL_LIMITS = { keys: 8, key: 40, value: 64 };

// A key is a name a dashboard can group by: letters, digits, underscore, dot, dash. Anything else -- a
// space, a quote, a newline, a whole sentence -- is not a key and is dropped rather than rewritten.
const KEY_OK = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/;

// `k=v,k2=v2` as well as JSON, because the common caller is a Dockerfile or a task definition where a
// JSON object has to survive two layers of quoting. A `=` may appear in a value; the first one splits.
function parsePairs(text) {
  const out = {};
  for (const part of text.split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    out[part.slice(0, at)] = part.slice(at + 1);
  }
  return out;
}

// JSON object, else `k=v` pairs, else nothing. A malformed value is never an error: a hook may not fail a
// tool call over a label, and a report that cannot be grouped is better than no report.
export function parseLabels(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return Array.isArray(raw) ? {} : raw;
  const text = String(raw).trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return parsePairs(text);
}

// What leaves the machine: string values, trimmed, newlines folded to spaces (a label is one line), keys
// sorted so the same set reads the same on every report, and the limits applied. A number or a boolean is
// written out -- a job index is a label people will reasonably pass as a number -- and anything structured
// is dropped, since a nested object has no meaning to group by.
export function normalizeLabels(raw) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(parseLabels(raw)).sort(([a], [b]) => a.localeCompare(b))) {
    if (Object.keys(out).length >= LABEL_LIMITS.keys) break;
    const key = String(rawKey).trim();
    if (!key || key.length > LABEL_LIMITS.key || !KEY_OK.test(key)) continue;
    if (rawValue == null || typeof rawValue === 'object') continue;
    const value = String(rawValue).replace(/\s+/g, ' ').trim();
    if (!value || value.length > LABEL_LIMITS.value) continue;
    out[key] = value;
  }
  return out;
}

// The labels in force here, `{}` where none is set -- which is every machine that has not asked for them.
export function readLabels({ env = process.env, home = thinkerHome() } = {}) {
  let configured = {};
  try { configured = normalizeLabels(readMachineConfig(home).labels); } catch { configured = {}; }
  const fromEnv = normalizeLabels(env.THINKER_LABELS);
  return normalizeLabels({ ...configured, ...fromEnv });
}

// For a caller that only wants to add a block when there is one: spread it.
export const labelBlock = opts => { const labels = readLabels(opts); return Object.keys(labels).length ? { labels } : {}; };
