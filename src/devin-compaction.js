// Devin's own compaction, steered and measured (2026-11-01).
//
// Devin exposes no model endpoint, so the context proxy cannot clear its prompts, and no hook or API edits
// its history. What it has is a compactor of its own: at a token threshold it summarizes the conversation in
// the background and swaps the summary in at the next turn. The threshold is an undocumented integer in the
// user config, `agent.compaction_threshold_tokens` (the binary names it, and a wrong value draws "Ignoring
// invalid value for agent.compaction_threshold_tokens"); the finer `DEVIN_COMPACTION_THRESHOLDS=spawn,apply,hard`
// is an environment variable no config file can set. Measured over ACP on 2026-11-01: with the key at 20k a
// session that sat at 41k tokens a call held at 19k-20k, the first applied compaction taking it from 25.9k to
// 17.3k. A print-mode session (`devin -p`) exits before the summary applies, so the key does nothing there.
//
// Two things here. The policy: the key is written at `DEVIN_COMPACT_AT`, the proxy's own trigger, **on by
// default at the owner's call (2026-11-01)**, an exception to the rule that a context reduction strategy ships
// off until an experiment; `devin: { compactAt: <tokens> }` in the machine config moves it, 0 or `off` turns it
// off and puts back what was there. The saving is still unmeasured in agent sessions: judge it by the summary
// calls and cache rewrites it adds, not by the tokens it removes. The meter: Devin's session database records
// the context size at every assistant node (`num_tokens_preceding`) and marks the summary nodes
// (`summarized_from`), so what each compaction left out is read from there at the end of a turn and recorded
// as the proxy's clears are -- per later call, since every call after a summary leaves those tokens out again
// -- whether the threshold is thinker's or Devin's own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readMachineConfig } from './repo-switch.js';
import { noteCompression } from './compression.js';

export const DEVIN_COMPACT_KEY = 'compaction_threshold_tokens';
// The default: the proxy's result-clearing trigger (proxy.js:PROXY_DEFAULTS.trigger), held equal by test/cli-ui-sync.test.js.
export const DEVIN_COMPACT_AT = 140_000;
const thinkerHome = () => process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };

// The policy: tokens at which Devin should compact; 0 leaves Devin's own setting alone. Nothing set is the
// default; THINKER_DEVIN_COMPACT_AT wins over the config; `off`, 0 or false is off.
export function devinCompactAt(home = thinkerHome(), env = process.env) {
  const raw = env.THINKER_DEVIN_COMPACT_AT ?? readMachineConfig(home).devin?.compactAt;
  if (raw == null || raw === '') return DEVIN_COMPACT_AT;
  if (raw === 'off' || raw === false) return 0;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const stateFile = home => path.join(home, 'state', 'devin-compaction.json');

// Writes the threshold into Devin's user config, or takes thinker's own value out again and restores what
// was there. A value thinker did not write is never touched. `merge` is clients.js:mergeJson (a commented
// config is left unchanged by it). Returns the line to show, or null when nothing changed.
export function setDevinCompaction(file, { home = thinkerHome(), at = devinCompactAt(home), merge, read = f => readJson(f) || {} } = {}) {
  const current = read(file).agent?.[DEVIN_COMPACT_KEY];
  const state = readJson(stateFile(home));
  if (at > 0) {
    if (current === at) {
      if (!state || state.wrote !== at) writeJson(stateFile(home), { wrote: at, prior: state?.prior ?? null, at: new Date().toISOString() });
      return null;
    }
    const prior = state && current === state.wrote ? state.prior : (current ?? null);
    merge(file, c => ({ ...c, agent: { ...(c.agent || {}), [DEVIN_COMPACT_KEY]: at } }));
    writeJson(stateFile(home), { wrote: at, prior, at: new Date().toISOString() });
    return `Devin: compacts the conversation at ${at} tokens (agent.${DEVIN_COMPACT_KEY} in config.json; devin: { compactAt: 0 } in thinker's config turns it off)`;
  }
  if (!state || current !== state.wrote) return null;
  merge(file, c => {
    const agent = { ...(c.agent || {}) };
    if (state.prior == null) delete agent[DEVIN_COMPACT_KEY]; else agent[DEVIN_COMPACT_KEY] = state.prior;
    const n = { ...c, agent };
    if (!Object.keys(agent).length) delete n.agent;
    return n;
  });
  try { fs.rmSync(stateFile(home), { force: true }); } catch {}
  return `Devin: compaction threshold back to ${state.prior == null ? 'Devin\'s own default' : state.prior}`;
}

// Devin CLI's session database (Devin Desktop's local agent writes the same one).
export const devinSessionsDb = (env = process.env) =>
  path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'devin', 'cli', 'sessions.db');

const SQL = "select node_id as node, json_extract(metadata,'$.num_tokens_preceding') as tokens, json_extract(metadata,'$.summarized_from') as summary"
  + " from message_nodes where session_id = ? and json_extract(chat_message,'$.role') = 'assistant'"
  + " and (json_extract(metadata,'$.num_tokens_preceding') is not null or json_extract(metadata,'$.summarized_from') is not null) order by node_id";
const norm = r => ({ node: Number(r.node), tokens: r.tokens == null ? null : Number(r.tokens), summary: r.summary != null });

// The session's assistant nodes in order: the context size each call carried, and the summaries between them.
// Read-only, through node:sqlite where Node has it (22.13+) and the sqlite3 command otherwise; nothing on either
// path gives [].
export async function contextNodes(session, { db = devinSessionsDb() } = {}) {
  if (!session || !fs.existsSync(db)) return [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const d = new DatabaseSync(db, { readOnly: true });
    try { return d.prepare(SQL).all(session).map(norm); } finally { d.close(); }
  } catch {}
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', db, SQL.replace('?', `'${String(session).replace(/'/g, "''")}'`)], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return (out.trim() ? JSON.parse(out) : []).map(norm);
  } catch { return []; }
}

// Each summary with the context size of the last call before it and of the first call after it; the
// difference is what every later call leaves out, which is the proxy's `cleared` figure.
export function compactionsOf(nodes) {
  const out = [];
  let before = null, pending = null;
  for (const n of nodes || []) {
    if (n.summary && n.tokens == null) { if (before != null) pending = { node: n.node, before }; continue; }
    if (n.tokens == null) continue;
    if (pending) { out.push({ ...pending, after: n.tokens, saved: Math.max(0, pending.before - n.tokens) }); pending = null; }
    before = n.tokens;
  }
  return out;
}

// What each call after a summary leaves out of its prompt: the latest summary's before minus after, for as
// long as that summary is the latest. The proxy's `cleared` is the same thing, reported by the API per request.
export function callSavings(nodes) {
  const out = [];
  let cur = null, before = null, pending = null;
  for (const n of nodes || []) {
    if (n.summary && n.tokens == null) { if (before != null) pending = { node: n.node, before }; continue; }
    if (n.tokens == null) continue;
    if (pending) { cur = { ...pending, after: n.tokens, saved: Math.max(0, pending.before - n.tokens) }; pending = null; }
    if (cur && cur.saved > 0) out.push({ node: n.node, saved: cur.saved, summary: cur.node });
    before = n.tokens;
  }
  return out;
}

const markerFile = (dir, session) => path.join(dir, '..', 'devin-compaction', `${session}.json`);

// At the end of a Devin turn: every compaction the session has had and nothing has logged yet becomes a
// `compaction` log row (before, after, saved), and every call since the last turn that a summary shortened
// becomes a compression record in the proxy's shape (compression.js:noteCompression), so the card, the
// end-of-turn notice and the report read it as they read a clear. Returns the newly logged compactions.
export async function recordDevinCompactions(store, { session, dir, client = 'devin', now = Date.now(), nodes = null } = {}) {
  if (!session || session === 'unknown' || !dir) return [];
  const all = nodes || await contextNodes(session);
  const list = compactionsOf(all);
  if (!list.length) return [];
  const marker = markerFile(dir, session);
  const seen = readJson(marker) || {};
  const fresh = list.filter(c => c.node > (seen.summary || 0) && c.saved > 0);
  for (const c of fresh) store.log({ op: 'compaction', client, session, node: c.node, before: c.before, after: c.after, saved: c.saved });
  const calls = callSavings(all).filter(c => c.node > (seen.call || 0));
  for (const c of calls) {
    try { noteCompression(dir, { op: 'compaction', session, at: new Date(now).toISOString(), cleared: c.saved, clearedUses: 0 }, { now }); } catch {}
  }
  writeJson(marker, { summary: Math.max(seen.summary || 0, ...list.map(c => c.node)), call: Math.max(seen.call || 0, ...calls.map(c => c.node)) });
  return fresh;
}
