import { isTestMode } from './test-mode.js';
// Hourly telemetry for Thinker: collects high-level cache effectiveness and cache size metrics.
// Pseudonymous: no prompt text, note bodies, file paths, code symbols,
// or repository URLs are ever collected or transmitted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { thinkerHome, DAY_MS } from './update.js';
import { summarize, readLog, knownRepos, holdoutOf } from './usage.js';
import { Store, findRepoRoot } from './store.js';
import { deviceIdentity } from './device.js';
import { detectClients, inferWiring, USER_SCOPE_CLIENTS } from './clients.js';
import { detectHarnesses } from './harnesses.js';
import { deliveryMetrics } from './delivery-telemetry.js';
import { proxyReport } from './proxy.js';
import { serviceState, proxyLogFile, SERVICE_HOLDOUT } from './proxy-service.js';
import { readMachineConfig } from './repo-switch.js';
import { changeHistory } from './context-suggest.js';
import { historyEffects, promptAverageHere } from './report-snapshot.js';
import { mergePromptAverages } from './report.js';
import { partIdentity, publicToolName } from './part-describe.js';

export const HOUR_MS = 60 * 60 * 1000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TELEMETRY_ENDPOINT = 'https://khsky10r4l.execute-api.us-east-1.amazonaws.com/metrics';

export function isTestTelemetryBlocked(endpoint, env = process.env) {
  if (!isTestMode(env) && !env.NODE_TEST_CONTEXT) return false;
  try {
    const url = new URL(endpoint);
    return !['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return true; }
}

export function isTelemetryEnabled({ home = thinkerHome(), store } = {}) {
  const envVal = (process.env.THINKER_TELEMETRY || '').toLowerCase();
  if (envVal === 'off' || envVal === '0' || envVal === 'false') return false;
  if (process.env.THINKER_NO_TELEMETRY === '1') return false;
  if (process.env.THINKER_NO_LEARN === '1') return false;

  // Check repo-level config if store provided
  if (store) {
    try {
      const cfg = store.config();
      if (cfg && cfg.telemetry === false) return false;
    } catch {}
  }

  // Check global install config
  try {
    const installJson = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'));
    if (installJson.telemetry === false) return false;
  } catch {}

  return true;
}

export function getTelemetryEndpoint({ home = thinkerHome() } = {}) {
  if (process.env.THINKER_TELEMETRY_URL) return process.env.THINKER_TELEMETRY_URL.trim();
  try {
    const installJson = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8'));
    if (installJson.telemetryUrl) return installJson.telemetryUrl.trim();
  } catch {}
  return DEFAULT_TELEMETRY_ENDPOINT;
}

export function getInstallId(home = thinkerHome()) {
  const idFile = path.join(home, 'state', 'install-id');
  try {
    if (fs.existsSync(idFile)) {
      const id = fs.readFileSync(idFile, 'utf8').trim();
      if (id) return id;
    }
  } catch {}

  const newId = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    fs.writeFileSync(idFile, newId + '\n');
  } catch {}
  return newId;
}

// Notes on the machine now, in every checkout the machine's log has ever named (usage.js:knownRepos), not
// only those with an event in the report's day: until 2026-10-17 the repositories came from the day's
// events, so a machine with caches and a quiet day reported 0 notes, and up-to-date devices read as
// installed and never used. Requests keep the daily window; the notes count does not.
export function computeCacheMetrics(store, { home = thinkerHome(), all = true } = {}) {
  const repos = knownRepos(store, { all });
  const kinds = {};
  const statuses = { fresh: 0, stale: 0, invalid: 0 };
  const sources = {};
  const confidenceBuckets = { high: 0, medium: 0, low: 0 };
  let totalDeps = 0;
  let symbolDeps = 0;
  let totalBytes = 0;
  let totalNotes = 0;
  // repositories with a cache on the machine now: the log also names checkouts long gone (486 temporary
  // directories of test runs before 2026-10-04 on one machine, which reported 538 repositories)
  let repositoriesCount = 0;
  const coveredCheckouts = new Set();

  const recordNote = n => {
    const k = n.kind || 'other';
    kinds[k] = (kinds[k] || 0) + 1;
    const bodyBytes = Buffer.byteLength(n.body || '', 'utf8');
    const titleBytes = Buffer.byteLength(n.title || '', 'utf8');
    totalBytes += bodyBytes + titleBytes;

    const st = n.status || 'fresh';
    statuses[st] = (statuses[st] || 0) + 1;

    const src = n.source?.type || 'unknown';
    sources[src] = (sources[src] || 0) + 1;

    const conf = typeof n.confidence === 'number' ? n.confidence : 0.8;
    if (conf >= 0.8) confidenceBuckets.high++;
    else if (conf >= 0.5) confidenceBuckets.medium++;
    else confidenceBuckets.low++;

    for (const d of n.deps || []) {
      totalDeps++;
      if (d.symbol) symbolDeps++;
    }
  };

  // Aggregate across all repositories on the machine; a repository's notes are those of the checkout
  // holding the most (a worktree often has none of its own), as in usage.js:summarize. Only that checkout's
  // notes are recorded: until 2026-10-19 every checkout's were, so a device with 317 notes and a score of
  // old worktrees, whose copies no maintenance refreshes, reported 7,291 notes by status, 3,220 of them stale.
  for (const r of repos) {
    let most = [], cached = false;
    for (const checkout of r.checkouts) {
      coveredCheckouts.add(path.resolve(checkout));
      try {
        const s = new Store(checkout, { readonly: true });
        if (!s.exists()) continue;
        cached = true;
        const notes = s.list();
        if (notes.length > most.length) most = notes;
      } catch {}
    }
    for (const n of most) recordNote(n);
    totalNotes += most.length;
    if (cached) repositoriesCount++;
  }

  // If local store has notes and wasn't covered in summary.repos
  if (store?.exists() && (!coveredCheckouts.size || !coveredCheckouts.has(path.resolve(store.repo)))) {
    try {
      const notes = store.list();
      if (notes.length > 0) {
        if (!coveredCheckouts.has(path.resolve(store.repo))) {
          repositoriesCount++;
          totalNotes += notes.length;
        }
        for (const n of notes) recordNote(n);
      } else if (!repositoriesCount) {
        repositoriesCount = 1;
      }
    } catch {}
  }

  return {
    totalNotes,
    totalBytes,
    repositoriesCount,
    kinds,
    statuses,
    sources,
    confidenceBuckets,
    symbolDepRatio: totalDeps > 0 ? Math.round((symbolDeps / totalDeps) * 1000) / 1000 : 0,
  };
}

// The holdout comparison (usage.js:holdoutOf) over the last 30 days, as sums and prompt counts per
// side, so that per-prompt averages can be pooled across installations (a mean of sums over counts;
// medians cannot be combined). Schema 2 (2026-10-12): the unit is the prompt (turn), not the session;
// `prompts` and `corrected` per side replace `sessions`. Numbers and model names only. A repository that opted out of telemetry is
// left out even when another repository triggers the upload.
export const HOLDOUT_WINDOW_DAYS = 30;

// Re-verification over the last 30 days: the verdicts, and a lower bound on wrong `still_valid`
// ones (usage.js, verifyChecks). A pass is doubted when the note is contradicted, corrected or
// reported not useful before its next verification, which can be days later: the one-day usage
// window of the report would miss most of them. Counts only, no note ids.
export function verificationMetrics(store, { all = true } = {}) {
  const u = summarize(store, { days: HOLDOUT_WINDOW_DAYS, all });
  return {
    schemaVersion: 1, windowDays: HOLDOUT_WINDOW_DAYS,
    stillValid: u.verified.still_valid || 0, updated: u.verified.update || 0, retired: u.verified.invalid || 0,
    passFlaggedLater: u.verifyChecks.flaggedAfterPass, passWhileFlagged: u.verifyChecks.passedWhileFlagged,
  };
}
// Coverage suggestions over the last 30 days (coverage.js): the questions maintenance queued and the prompt hook
// put to the person, how they answered (build, none, never, unanswered), the directories offered and chosen, the
// builds started or not started (no signed-in agent), and the whole-directory understanding runs: files read,
// notes saved, calls failed. Counts only, no directory names.
export function coverageMetrics(store, { all = true, now = Date.now() } = {}) {
  const since = new Date(now - HOLDOUT_WINDOW_DAYS * DAY_MS).toISOString();
  const m = { schemaVersion: 1, windowDays: HOLDOUT_WINDOW_DAYS, suggestions: 0, offers: 0, directoriesOffered: 0, answeredBuild: 0, answeredNone: 0, answeredNever: 0, unanswered: 0, directoriesChosen: 0,
    buildsStarted: 0, buildsNotStarted: 0, tokensEstimated: 0, wholeRuns: 0, wholeFiles: 0, wholeNotes: 0, wholeCallsFailed: 0 };
  for (const e of readLog(store, { all }).filter(e => e.t >= since)) {
    if (e.op === 'coverage-suggest') m.suggestions++;
    else if (e.op === 'coverage-offer') { m.offers++; m.directoriesOffered += e.dirs || 0; }
    else if (e.op === 'coverage-answer') {
      const k = { build: 'answeredBuild', none: 'answeredNone', never: 'answeredNever', unanswered: 'unanswered' }[e.choice];
      if (k) m[k]++;
      m.directoriesChosen += e.chosen || 0;
    }
    else if (e.op === 'coverage-build') { if (e.started) { m.buildsStarted++; m.tokensEstimated += e.tokens || 0; } else m.buildsNotStarted++; }
    else if (e.op === 'understand' && e.whole) { m.wholeRuns++; m.wholeFiles += e.files || 0; m.wholeNotes += e.saved || 0; m.wholeCallsFailed += e.failed || 0; }
  }
  return m;
}
export function holdoutMetrics(store, { all = true, now = Date.now() } = {}) {
  const since = new Date(now - HOLDOUT_WINDOW_DAYS * DAY_MS).toISOString();
  const events = readLog(store, { all }).filter(e => e.t >= since);
  const off = new Set(), seen = new Set();   // by origin: one opted-out checkout excludes its repository
  for (const e of events) {
    if (seen.has(e.repo)) continue;
    seen.add(e.repo);
    try { if ((e.repo === store.repo ? store : new Store(e.repo, { readonly: true })).config().telemetry === false) off.add(e.origin); } catch {}
  }
  const h = holdoutOf(events.filter(e => !off.has(e.origin)));
  const side = t => ({ prompts: t.prompts, sessions: t.sessions, corrected: t.corrected, sums: t.sums, measured: t.measured });
  const pair = g => ({ served: side(g.served), heldOut: side(g.heldOut) });
  return {
    schemaVersion: 2, unit: 'prompt', windowDays: HOLDOUT_WINDOW_DAYS,
    ...pair(h), noNotes: h.noNotes, unmeasured: h.unmeasured,
    byModel: Object.fromEntries(Object.entries(h.byModel).map(([m, g]) => [m, pair(g)])),
    // keyed `client|model` (usage.js:normalizeClient), the dashboard splits it into harness and model
    byClientModel: Object.fromEntries(Object.entries(h.byClientModel).map(([m, g]) => [m, pair(g)])),
  };
}

// Whether the agents on this machine run thinker at all, for a device with caches and no cache request
// (2026-10-16: three such devices, and nothing said whether their agents were wired or simply unused): each
// installed agent's machine-wide wiring (hooks, MCP, and whether the copy its entries run is still there)
// and how many of its sessions changed in the last 7 days, from the agent's own session files (a count,
// nothing of their content).
const SESSION_DIRS = {
  claude: h => [path.join(h, '.claude', 'projects')],
  codex: h => [path.join(h, '.codex', 'sessions')],
  cursor: h => [path.join(h, '.cursor', 'projects')],
};
function recentSessions(client, { home = os.homedir(), days = 7, max = 5000 } = {}) {
  const roots = SESSION_DIRS[client]?.(home); if (!roots) return null;
  const since = Date.now() - days * DAY_MS;
  let n = 0, seen = 0;
  // Claude Code: projects/<dir>/<session>.jsonl; Codex: sessions/YYYY/MM/DD/<rollout>.jsonl; Cursor:
  // projects/<dir>/agent-transcripts/<session>/
  const walk = (dir, depth) => {
    let names = []; try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (++seen > max) return;
      const f = path.join(dir, e.name);
      if (client === 'cursor' && depth === 1) { if (e.name === 'agent-transcripts') walk(f, 2); continue; }
      if (client === 'cursor' && depth === 2) { try { if (fs.statSync(f).mtimeMs >= since) n++; } catch {} continue; }
      // Codex files a session under the day it started: an older day's folder is skipped
      if (e.isDirectory()) { if (depth < (client === 'codex' ? 3 : 1)) { try { if (client !== 'codex' || depth < 2 || fs.statSync(f).mtimeMs >= since) walk(f, depth + 1); } catch {} } continue; }
      if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(f).mtimeMs >= since) n++; } catch {} }
    }
  };
  for (const r of roots) walk(r, 0);
  return n;
}
export function wiringHealth({ home, detected = detectClients({ fallback: false }) } = {}) {
  const out = {};
  for (const client of detected.filter(c => USER_SCOPE_CLIENTS.includes(c))) {
    let w = null; try { w = inferWiring(null, client, { scope: 'user' }); } catch {}
    out[client] = {
      hooks: !!w?.hooks, mcp: !!w?.mcp,
      // entries whose copy of thinker is gone run nothing
      live: !!w && w.scripts.length > 0 && w.scripts.every(sc => fs.existsSync(sc)),
      sessions7d: recentSessions(client, { home }),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Token spend: the proxy, the actions people take to cut what a prompt costs, and what those
// actions measured as saved. The Metabase "Token spend" dashboard reads these three blocks from
// reports.raw_json (scripts/spend-dashboard.mjs). Counts, tokens and published model ids only: the
// one place a part's own name may be sent is part-describe.js:partIdentity, which names the agent's
// built-in tools and the common shell commands and nothing else -- never a section title, file
// name, skill name, MCP server name or repository.
export const SPEND_WINDOW_DAYS = 30;
const PROXY_LOG_MAX = 8 * 1024 * 1024;   // a day of heavy use is ~50 KB; the tail is enough for 30 days

// The proxy's own records (proxy-service.js:proxyLogFile), newest PROXY_LOG_MAX bytes.
function readProxyRows(file) {
  let text = '';
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - PROXY_LOG_MAX);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    if (start) text = text.slice(text.indexOf('\n') + 1);
  } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// what a request cost at the rates the sides are compared on (proxy.js:proxyReport billedInput)
const billed = r => Math.round((r.input || 0) + 0.1 * (r.read || 0) + 2 * (r.write || 0));

// The context proxy over the last 30 days: whether the service is on and running here, and the two sides the
// service itself runs (proxy.js:proxyReport) -- requests whose old tool results the API was asked to clear
// against the holdout share that passed through untouched, which is the proxy's own before and after. Plus the
// errors by code, the retries, and the same two sides per model. Model ids are the provider's published names.
export function proxyMetrics({ home = thinkerHome(), now = Date.now(), env = process.env } = {}) {
  const since = new Date(now - SPEND_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = readProxyRows(proxyLogFile(home, env)).filter(r => !r.at || r.at >= since);
  const state = serviceState(home);
  let cfg = {}; try { cfg = (readMachineConfig(home) || {}).proxy || {}; } catch {}
  const errors = { total: 0, retried: 0, byCode: {} };
  const byModel = {};
  const notes = { requests: 0, served: 0, replayed: 0 };
  for (const r of rows) {
    if (r.op === 'proxy-error') {
      errors.total++; if (r.retried) errors.retried++;
      const code = String(r.code || 'unknown'); errors.byCode[code] = (errors.byCode[code] || 0) + 1;
      continue;
    }
    if (r.op !== 'proxy') continue;
    if (r.notes != null) { notes.requests++; notes.served += r.notes || 0; notes.replayed += r.notesReplayed || 0; }
    const side = r.protocol === 'responses' ? 'responses' : r.injected ? 'clearing' : r.reason === 'holdout' ? 'holdout' : 'other';
    const m = byModel[r.model || 'unknown'] ||= {};
    const s = m[side] ||= { requests: 0, billedInput: 0, cleared: 0 };
    s.requests++; s.billedInput += billed(r); s.cleared += r.cleared || 0;
  }
  return {
    schemaVersion: 1, windowDays: SPEND_WINDOW_DAYS,
    service: {
      on: state.enabled === true, running: alive(state.pid), since: state.since || null, off: state.off || null,
      holdout: cfg.holdout == null ? SERVICE_HOLDOUT : Number(cfg.holdout) || 0,
      keep: cfg.keep ?? null, trigger: cfg.trigger ?? null,
    },
    sides: proxyReport(rows, { since }),
    byModel, errors, notes,
  };
}

// Which side of a decision's life it ended on, for the kind x outcome matrix. A pull request is named by its
// state on GitHub (context-suggest.js:refreshPrStates), since a change nobody merged saved nothing.
export function decisionOutcome(e) {
  if (e.revertedAt) return 'reverted';
  if (e.job?.state === 'failed') return 'failed';
  if (e.job?.state === 'running') return 'running';
  if (e.pr) return e.pr.state === 'merged' ? 'pr-merged' : e.pr.state === 'closed' ? 'pr-rejected' : 'pr-open';
  if (e.decision === 'dismissed') return 'dismissed';
  return 'applied';
}

// Every decision taken on Find Savings, over every repository the machine's log names, each with what it
// measured as saved (report-snapshot.js:historyEffects, read over the report kept in the repository: no
// transcript is read and no model is called here). A repository whose config says `telemetry: false` is left
// out, as in holdoutMetrics. Worktrees of one repository share a cache and a report, and a decision reached
// through two checkouts is one decision: they are deduplicated by id.
function collectDecisions(store, { all = true, now = Date.now() } = {}) {
  const entries = [], averages = [];
  let repositories = 0, withDecisions = 0, withReport = 0;
  for (const r of knownRepos(store, { all })) {
    const seen = new Set(), mine = [];
    let optedOut = false, average = null, read = false;
    for (const checkout of r.checkouts) {
      let s;
      try { s = store && path.resolve(store.repo || '') === path.resolve(checkout) ? store : new Store(checkout, { readonly: true }); } catch { continue; }
      try { if (!s.exists()) continue; } catch { continue; }
      try { if (s.config()?.telemetry === false) { optedOut = true; break; } } catch {}
      read = true;
      let history = [];
      // no `git merge-base` per entry from a background report: whether a merged change is pulled in some
      // checkout is the page's business, not telemetry's
      try { history = changeHistory(s, { now, git: () => null }); } catch { history = []; }
      if (history.length) {
        let measured = history;
        try { measured = historyEffects(s, history, { now }); } catch { measured = history; }
        for (const e of measured) {
          const id = e.id || `${e.at}:${e.key}`;
          if (seen.has(id)) continue;
          seen.add(id); mine.push(e);
        }
      }
      if (!average) { try { average = promptAverageHere(s, { now }); } catch {} }
    }
    if (optedOut || !read) continue;
    repositories++;
    if (mine.length) withDecisions++;
    if (average) { withReport++; averages.push(average); }
    entries.push(...mine);
  }
  return { entries, averages, repositories, withDecisions, withReport };
}

const bump = (map, key, add) => { if (!map.has(key)) map.set(key, {}); const row = map.get(key); for (const [k, v] of Object.entries(add)) row[k] = (row[k] || 0) + v; return row; };

// The two blocks built from one walk of the repositories: `actions` (what was suggested, offered and decided,
// from the machine's log and the decisions themselves) and `savings` (what the decisions measured). Split so
// the dashboard can read the funnel without the effects, which are null on a machine whose report was made by
// other code.
export function spendMetrics(store, { all = true, now = Date.now() } = {}) {
  const since = new Date(now - SPEND_WINDOW_DAYS * DAY_MS).toISOString();
  const a = {
    schemaVersion: 1, windowDays: SPEND_WINDOW_DAYS,
    suggested: 0, suggestedTokens: 0, offers: 0, offersInPage: 0, offeredTokens: 0,
    approvals: 0, approvedChanges: 0, approvedTokens: 0, approvalsReviewed: 0, approvalsAsPr: 0,
    dismissals: 0, dismissedChanges: 0, reverts: 0, revertedPrs: 0,
    jobsStarted: 0, jobsRetried: 0, jobsFailed: 0, sectionEdits: 0, sectionPrs: 0,
    harnessOffers: 0, harnessOfferedSources: 0, harnessOfferedTokens: 0,
    harnessAnswers: {}, harnessSwitchedOff: 0, harnessUndos: 0, harnessUndoneSources: 0,
    // what the output compression (diet.js) actually cut, in characters, as it records them (~4 to a token);
    // `byKind` is its own vocabulary (cap, read, search, test), `byTool` only the tools it names publicly
    compression: { calls: 0, charsBefore: 0, charsAfter: 0, charsSaved: 0, byKind: {}, byTool: {} },
    settings: { harnessEnabled: null, builtinTools: null, outputTools: null },
  };
  for (const e of readLog(store, { all }).filter(e => e.t >= since)) {
    switch (e.op) {
      case 'context-suggest': a.suggested += e.changes || 0; a.suggestedTokens += e.saving || 0; break;
      case 'context-offer': a.offers++; a.offeredTokens += e.saving || 0; if (e.ui) a.offersInPage++; break;
      case 'context-approve':
        a.approvals++; a.approvedChanges += e.changes || 0; a.approvedTokens += e.saving || 0;
        if (e.reviewed) a.approvalsReviewed++;
        if (e.pr) a.approvalsAsPr++;
        break;
      case 'context-dismiss': a.dismissals++; a.dismissedChanges += e.changes || 0; break;
      case 'context-revert': a.reverts++; if (e.kind === 'pr') a.revertedPrs++; break;
      case 'context-job':
        if (e.state === 'started') a.jobsStarted++;
        else if (e.state === 'retried') a.jobsRetried++;
        else if (e.state === 'failed') a.jobsFailed++;
        break;
      case 'instruction-edit': a.sectionEdits++; break;
      case 'instruction-pr': a.sectionPrs++; break;
      case 'harness-offer': a.harnessOffers++; a.harnessOfferedSources += e.sources || 0; a.harnessOfferedTokens += e.tokens || 0; break;
      case 'harness-answer': {
        const choice = String(e.choice || 'unknown');
        a.harnessAnswers[choice] = (a.harnessAnswers[choice] || 0) + 1;
        a.harnessSwitchedOff += e.switched || 0;
        break;
      }
      case 'harness-undo': a.harnessUndos++; a.harnessUndoneSources += e.sources || 0; break;
      case 'harness-settings': a.settings.harnessEnabled = e.enabled ?? a.settings.harnessEnabled; a.settings.builtinTools = e.builtinTools ?? a.settings.builtinTools; break;
      // `tools` names the compressed tools (an MCP server among them): only how many, at which level
      case 'diet-settings': a.settings.outputTools = e.tools && typeof e.tools === 'object'
        ? Object.values(e.tools).reduce((m, level) => ({ ...m, [String(level)]: (m[String(level)] || 0) + 1 }), {})
        : a.settings.outputTools; break;
      case 'diet': {
        const c = a.compression, cut = Math.max(0, (e.before || 0) - (e.after || 0));
        c.calls++; c.charsBefore += e.before || 0; c.charsAfter += e.after || 0; c.charsSaved += cut;
        const kind = String(e.kind || 'unknown');
        const k = c.byKind[kind] ||= { calls: 0, charsSaved: 0 };
        k.calls++; k.charsSaved += cut;
        const name = publicToolName(e.tool);
        if (name) { const t = c.byTool[name] ||= { calls: 0, charsSaved: 0 }; t.calls++; t.charsSaved += cut; }
        break;
      }
      default: break;
    }
  }

  const { entries, averages, repositories, withDecisions, withReport } = collectDecisions(store, { all, now });
  const recent = entries.filter(e => (e.at || '') >= since).sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  const matrix = new Map(), named = new Map(), effects = new Map();
  const rows = [];
  let measured = 0;
  for (const e of recent) {
    const { group, name } = partIdentity({ kind: e.kind, key: e.key, what: e.what });
    const outcome = decisionOutcome(e);
    const before = e.tokens?.before ?? null, after = e.tokens?.after ?? null;
    bump(matrix, `${group}\u0000${outcome}`, { decisions: 1, savingTokens: e.saving || 0, tokensBefore: before || 0, tokensAfter: after || 0, tokensKnown: before == null ? 0 : 1 });
    if (name) bump(named, `${group}\u0000${name}\u0000${outcome}`, { decisions: 1 });
    const x = e.effect;
    if (x) {
      measured++;
      bump(effects, group, {
        measured: 1,
        beforeTokens: x.before.total, beforePrompts: x.before.prompts,
        afterTokens: x.after.total, afterPrompts: x.after.prompts,
        savedTokens: x.window, wholeBeforeTokens: (x.whole?.before || 0) * x.after.prompts,
        few: x.few ? 1 : 0,
      });
    }
    if (rows.length < 50) rows.push({
      at: e.at, group, name, act: e.act || null, outcome,
      tokensBefore: before, tokensAfter: after, savingClaimed: e.saving ?? null, days: e.days ?? null,
      effect: x ? {
        perPromptBefore: x.before.perPrompt, perPromptAfter: x.after.perPrompt, delta: x.delta,
        share: x.share == null ? null : Math.round(x.share * 10000) / 10000,
        promptsBefore: x.before.prompts, promptsAfter: x.after.prompts,
        sessionsBefore: x.before.sessions, sessionsAfter: x.after.sessions,
        wholeBefore: x.whole?.before ?? null, wholeAfter: x.whole?.after ?? null,
        savedSince: x.window, few: Boolean(x.few),
      } : null,
    });
  }
  const list = (map, keys) => [...map.entries()].map(([k, v]) => ({ ...Object.fromEntries(k.split('\u0000').map((part, i) => [keys[i], part])), ...v }));
  a.decisions = list(matrix, ['group', 'outcome']);
  a.builtinParts = list(named, ['group', 'name', 'outcome']);

  return {
    actions: a,
    savings: {
      schemaVersion: 1, windowDays: SPEND_WINDOW_DAYS,
      decisions: recent.length, measured, unmeasured: recent.length - measured,
      byGroup: [...effects.entries()].map(([group, v]) => ({ group, ...v })),
      rows,
      promptAverage: mergePromptAverages(averages),
      repositories: { total: repositories, withDecisions, withReport },
    },
  };
}

export function buildTelemetryPayload(store, { home = thinkerHome(), days = 1, all = true, event = 'hourly' } = {}) {
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8'));
    version = pkg.version || 'unknown';
  } catch {}

  const u = summarize(store, { days, all });
  const cacheSize = computeCacheMetrics(store, { home, all });
  const d = u.distillationPerformance, spend = d.spending;
  const cls = u.clients || {};
  const ret = u.retrieval || {};

  const totalAssessed = (u.assessed.confirmed || 0) + (u.assessed.contradicted || 0) + (u.assessed.unused || 0);
  const confirmationRate = totalAssessed > 0
    ? Math.round(((u.assessed.confirmed || 0) / totalAssessed) * 1000) / 1000
    : 0;

  const hitRate = u.requests > 0
    ? Math.round(((u.answered || 0) / u.requests) * 1000) / 1000
    : 0;

  const device = deviceIdentity({ home });
  const tokenSpend = spendMetrics(store, { all });
  return {
    installId: getInstallId(home),
    deviceId: device.id,
    deviceSource: device.source,
    event,
    version,
    platform: process.platform,
    timestamp: new Date().toISOString(),
    periodHours: (days || 1) * 24,

    cacheSize,

    // 30-day outcome snapshots, regardless of the usage snapshot periodHours.
    delivery: deliveryMetrics(store, { all }),

    // Prompts served notes against prompts held out, 30 days (holdoutMetrics).
    holdout: holdoutMetrics(store, { all }),

    // Re-verification verdicts and the passes later doubted, 30 days (verificationMetrics).
    verification: verificationMetrics(store, { all }),

    // coverage suggestions asked, answered and built, 30 days (coverageMetrics)
    coverage: coverageMetrics(store, { all }),

    // the context proxy, 30 days: the service here, the clearing side against the holdout side, by model (proxyMetrics)
    proxy: proxyMetrics({ home }),

    // what was suggested, offered and decided on Find Savings, 30 days, and what each decision measured as
    // saved over the report kept in its repository (spendMetrics). The Token spend dashboard reads both.
    actions: tokenSpend.actions,
    savings: tokenSpend.savings,

    // Explicit coverage keeps old logs and unsupported provider costs unknown.
    // SQL dashboards read this versioned block from reports.raw_json.
    distillation: {
      schemaVersion: 1,
      attempts: d.attempts, succeeded: d.succeeded, failed: d.failed,
      durationMs: d.durationMs, durationSamples: d.durationSamples,
      legacySuccessfulRuns: Math.max(0, u.distillation.runs - d.succeeded),
      noNewNotes: u.distillation.noNewNotes, noChanges: u.distillation.noChanges,
      modelCalls: spend.calls, modelFailedCalls: spend.failed,
      reportedCostUsd: spend.calls > 0 && spend.calls === spend.unknownCostCalls ? null : spend.reportedCost,
      costKnownCalls: spend.calls - spend.unknownCostCalls, costUnknownCalls: spend.unknownCostCalls,
      reportedTokens: spend.calls > 0 && spend.calls === spend.unknownTokenCalls ? null : spend.totalTokens,
      tokenKnownCalls: spend.calls - spend.unknownTokenCalls, tokenUnknownCalls: spend.unknownTokenCalls,
    },

    clients: {
      schemaVersion: 1,
      // the supported agents found, none when none is (the `claude` fallback is for setting up, not for reporting)
      detected: detectClients({ fallback: false }),
      // every coding agent found, supported or not, with the days since it was last used (harnesses.js)
      harnesses: detectHarnesses(),
      wiring: wiringHealth(),
      activeRequests: cls.active || {},
      servings: cls.servings || {},
      sessions: cls.sessions || {},
    },

    retrieval: {
      schemaVersion: 1,
      requestsTotal: u.requests,
      requestsAnswered: u.answered,
      hitRate,
      emptyRequests: Math.max(0, u.requests - u.answered),
      staleNotesServed: ret.staleServed || 0,
      freshNotesServed: ret.freshServed || 0,
      staleServingRate: ret.staleRate || 0,
      guardTriggeredCount: ret.guardTriggered || 0,
      guardUncoveredTerms: ret.guardUncoveredTerms || 0,
      durationMs: ret.durationMs || 0,
      durationSamples: ret.durationSamples || 0,
      averageDurationMs: (ret.durationSamples || 0) > 0
        ? Math.round(ret.durationMs / ret.durationSamples)
        : null,
      servedByKind: ret.servedByKind || {},
      // why the empty requests were empty; too-few-notes: the cache was not asked at all (ops.js:EMPTY_REASONS)
      emptyReasons: ret.emptyReasons || {},
      emptyShortPrompts: ret.emptyShortPrompts || 0,
    },

    effectiveness: {
      requestsTotal: u.requests,
      requestsAnswered: u.answered,
      hitRate,
      servings: {
        prompt: u.servings.prompt,
        file: u.servings.file,
        lookup: u.servings.lookup,
      },
      tokensServed: u.tokensServed,
      assessed: {
        confirmed: u.assessed.confirmed,
        contradicted: u.assessed.contradicted,
        unused: u.assessed.unused,
        pending: u.assessed.pending,
        confirmationRate,
      },
      estimatedSavings: {
        callsAvoided: u.saved.calls,
        tokensAvoided: u.saved.tokens,
        netTokensSaved: u.saved.net,
      },
      feedback: {
        useful: u.feedback.useful,
        notUseful: u.feedback.notUseful,
        corrections: u.corrections,
      },
      lifecycle: {
        sessionsDistilled: u.learned.sessions,
        newNotes: u.learned.notes,
        notesMerged: u.learned.merged,
        prsMined: u.learned.prs,
        staleVerified: (u.verified.still_valid || 0) + (u.verified.update || 0) + (u.verified.invalid || 0),
      },
    },
  };
}

export async function sendTelemetry({
  home = thinkerHome(),
  store = new Store(findRepoRoot()),
  endpoint = getTelemetryEndpoint({ home }),
  fetchFn = globalThis.fetch,
  force = false,
  dryRun = false,
  event = 'hourly',
  intervalMs = HOUR_MS,
} = {}) {
  if (!isTelemetryEnabled({ home, store })) {
    return { sent: false, reason: 'disabled' };
  }
  if (!dryRun && fetchFn === globalThis.fetch && isTestTelemetryBlocked(endpoint)) {
    return { sent: false, reason: 'test_environment' };
  }

  const stampFile = path.join(home, 'state', 'telemetry.last');
  if (!force) {
    try {
      const st = fs.statSync(stampFile);
      const minInterval = Math.max(0, intervalMs - 60_000);
      if (Date.now() - st.mtimeMs < minInterval) {
        return {
          sent: false,
          reason: intervalMs >= DAY_MS ? 'already_sent_today' : 'already_sent_recently',
          lastSent: new Date(st.mtimeMs).toISOString(),
        };
      }
    } catch {}
  }

  const payload = buildTelemetryPayload(store, { home, days: 1, all: true, event });

  if (dryRun) {
    return { sent: true, dryRun: true, endpoint, payload };
  }

  try {
    const res = await fetchFn(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'thinker-cli',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { sent: false, status: res.status, error: `HTTP ${res.status}` };
    }

    let result = {};
    try { result = await res.json(); } catch {}

    try {
      fs.mkdirSync(path.dirname(stampFile), { recursive: true });
      fs.writeFileSync(stampFile, new Date().toISOString() + '\n');
    } catch {}

    return { sent: true, status: res.status, key: result.key, payload };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// The reason someone gives when uninstalling, sent only when they typed one. It goes to the endpoint the
// website's contact form uses (`/messages`, next to `/metrics`) with the version, platform and install id, nothing else.
export function messagesEndpoint(endpoint) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/[^/]*$/, 'messages');
  return url.toString();
}

export async function sendUninstallFeedback(message, {
  home = thinkerHome(),
  endpoint = messagesEndpoint(getTelemetryEndpoint({ home })),
  fetchFn = globalThis.fetch,
} = {}) {
  const text = String(message || '').trim().slice(0, 4000);
  if (!text) return { sent: false, reason: 'empty' };
  if (fetchFn === globalThis.fetch && isTestTelemetryBlocked(endpoint)) return { sent: false, reason: 'test_environment' };
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')).version || 'unknown'; } catch {}
  const body = { id: crypto.randomUUID(), message: `${text}\n\n(thinker ${version}, install ${getInstallId(home)}, ${process.platform})`, page: '/cli/uninstall' };
  try {
    const res = await fetchFn(endpoint, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'thinker-cli' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    return res.ok ? { sent: true, status: res.status } : { sent: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// After an update the new copy reports once, right away, so that what it detects reaches the dashboard
// the same day on every install, with or without a working hourly job (2026-10-17: the harness detection
// reached the installs that had never made a request this way). Disabled telemetry, test mode and a
// background send's own child stay silent. Returns whether a send was started.
export function sendTelemetryAfterUpdate({ cliPath, home = thinkerHome(), spawnFn = spawn, env = process.env, testMode = isTestMode() } = {}) {
  if (!cliPath || !fs.existsSync(cliPath)) return false;
  if (testMode || !isTelemetryEnabled({ home })) return false;
  if (isTestTelemetryBlocked(getTelemetryEndpoint({ home }), env)) return false;
  if (env.THINKER_IN_LLM || env.THINKER_BACKGROUND_TELEMETRY) return false;
  try {
    const child = spawnFn(process.execPath, [cliPath, 'telemetry', '--background', '--force', '--event', 'update', '--quiet'],
      { detached: true, stdio: 'ignore', env: { ...env, THINKER_BACKGROUND_TELEMETRY: '1' } });
    child?.unref?.();
    return true;
  } catch { return false; }
}

export function maybeSendTelemetryInBackground({
  home = thinkerHome(),
  cliPath = path.join(HERE, 'cli.js'),
  store,
  force = false,
  event = 'hourly',
  intervalMs = HOUR_MS,
} = {}) {
  if (isTestMode() || !isTelemetryEnabled({ home, store })) return;
  if (isTestTelemetryBlocked(getTelemetryEndpoint({ home }))) return;
  if (process.env.THINKER_IN_LLM) return;
  if (process.env.THINKER_BACKGROUND_UPDATE || process.env.THINKER_BACKGROUND_TELEMETRY) return;

  const stateDir = path.join(home, 'state');
  const stampFile = path.join(stateDir, 'telemetry.last');

  if (!force) {
    try {
      const st = fs.statSync(stampFile);
      const minInterval = Math.max(0, intervalMs - 60_000);
      if (Date.now() - st.mtimeMs < minInterval) return;
    } catch {}
  }

  try {
    const args = ['telemetry', '--background', '--quiet'];
    if (store?.repo) args.push('--repo', store.repo);
    if (force) args.push('--force');
    if (event) args.push('--event', event);
    const child = spawn(process.execPath, [cliPath, ...args], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, THINKER_BACKGROUND_TELEMETRY: '1' },
    });
    child.unref();
  } catch {}
}

export const maybeSendDailyTelemetryInBackground = maybeSendTelemetryInBackground;

export function getTelemetryLaunchAgentPath(customPath) {
  return customPath || path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.thinker.telemetry.plist');
}

export function isTelemetryScheduled(home = thinkerHome(), opts = {}) {
  const run = opts.run || execFileSync;
  const platform = opts.platform || process.platform;
  if (platform === 'darwin') {
    const plist = opts.plistPath || getTelemetryLaunchAgentPath();
    if (!fs.existsSync(plist)) return false;
    if (opts.checkFileOnly) return true;
    try { return run('launchctl', ['list'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).includes('com.thinker.telemetry'); }
    catch { return false; }
  } else if (platform === 'linux') {
    try {
      const crontab = run('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (crontab.split('\n').some(isTelemetryCron)) return true;
    } catch {}
    try {
      run('systemctl', ['--user', 'is-active', '--quiet', 'thinker-telemetry.timer'], { stdio: 'pipe', timeout: 5000 });
      return true;
    } catch { return false; }
  }
  return false;
}

const isTelemetryCron = line => !line.trimStart().startsWith('#') &&
  (line.endsWith('# thinker-telemetry') || (line.includes('thinker') && line.includes('telemetry --send')));

const telemetryUnitDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
function scheduleSystemdTelemetry({ home, command, run, unitDir = telemetryUnitDir() }) {
  try {
    run('systemctl', ['--user', 'show-environment'], { stdio: 'pipe', timeout: 5000 });
  } catch {
    throw new Error('crontab is not installed and a systemd user manager is unavailable');
  }
  fs.mkdirSync(unitDir, { recursive: true });
  // systemd expands % specifiers and $ variables even inside ExecStart arguments.
  const arg = s => '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
  const service = path.join(unitDir, 'thinker-telemetry.service');
  const timer = path.join(unitDir, 'thinker-telemetry.timer');
  fs.writeFileSync(service, `[Unit]\nDescription=Thinker telemetry\n[Service]\nType=oneshot\nExecStart=/bin/sh -c ${arg(command)}\n`);
  fs.writeFileSync(timer, '[Unit]\nDescription=Hourly Thinker telemetry\n[Timer]\nOnCalendar=hourly\nPersistent=true\n[Install]\nWantedBy=timers.target\n');
  run('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe', timeout: 5000 });
  run('systemctl', ['--user', 'enable', '--now', 'thinker-telemetry.timer'], { stdio: 'pipe', timeout: 5000 });
  return { type: 'systemd', path: timer };
}

export function scheduleTelemetry(opts = {}) {
  const home = opts.home || thinkerHome();
  const binPath = opts.binPath || path.join(home, 'bin', 'thinker');
  const nodeBinDir = path.dirname(process.execPath);
  const run = opts.run || execFileSync;
  const platform = opts.platform || process.platform;
  const quote = s => "'" + String(s).replaceAll("'", "'\"'\"'") + "'";
  const xml = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const command = `THINKER_HOME=${quote(home)} PATH=${quote(nodeBinDir)}:$PATH:/usr/local/bin:/opt/homebrew/bin ${opts.cliPath ? `${quote(process.execPath)} ${quote(opts.cliPath)}` : quote(binPath)} telemetry --send --quiet`;

  if (platform === 'darwin') {
    const plistPath = opts.plistPath || getTelemetryLaunchAgentPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });

    if (!opts.skipLaunchctl) {
      try { run('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
    }

    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.thinker.telemetry</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>${xml(command)}</string>
    </array>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>StandardErrorPath</key>
    <string>${xml(path.join(home, 'telemetry.err'))}</string>
    <key>StandardOutPath</key>
    <string>${xml(path.join(home, 'telemetry.out'))}</string>
</dict>
</plist>
`;
    fs.writeFileSync(plistPath, plistContent);

    if (!opts.skipLaunchctl) {
      try {
        const uid = process.getuid ? process.getuid() : 501;
        run('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
      } catch {
        try {
          run('launchctl', ['load', plistPath], { stdio: 'ignore' });
        } catch (e) {
          throw new Error(`Failed to register LaunchAgent: ${e.message}`);
        }
      }
    }
    return { type: 'launchd', path: plistPath };
  } else if (platform === 'linux') {
    let crontab = '';
    try {
      crontab = run('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      if (e.code === 'ENOENT') return scheduleSystemdTelemetry({ home, command, run, unitDir: opts.unitDir });
      // `crontab -l` exits 1 when there is no table yet. Do not overwrite a
      // table we failed to read for any other reason.
      if (e.status !== 1) throw e;
    }

    const line = `0 * * * * ${command.replaceAll('%', '\\%')} # thinker-telemetry`;
    if (!crontab.includes(line)) {
      const kept = crontab.split('\n').filter(l => !isTelemetryCron(l)).join('\n').trimEnd();
      const newCrontab = (kept ? kept + '\n' : '') + line + '\n';
      run('crontab', ['-'], { input: newCrontab, encoding: 'utf8' });
    }
    return { type: 'cron', line };
  }

  throw new Error(`OS scheduler not supported on platform: ${platform}`);
}

export function unscheduleTelemetry(opts = {}) {
  const run = opts.run || execFileSync;
  const platform = opts.platform || process.platform;

  if (platform === 'darwin') {
    const plistPath = opts.plistPath || getTelemetryLaunchAgentPath();
    if (fs.existsSync(plistPath)) {
      if (!opts.skipLaunchctl) {
        try {
          const uid = process.getuid ? process.getuid() : 501;
          run('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' });
        } catch {
          try { run('launchctl', ['unload', plistPath], { stdio: 'ignore' }); } catch {}
        }
      }
      try { fs.rmSync(plistPath, { force: true }); } catch {}
      return { unscheduled: true, type: 'launchd' };
    }
    return { unscheduled: false, type: 'launchd' };
  } else if (platform === 'linux') {
    let unscheduled = false;
    const unitDir = opts.unitDir || telemetryUnitDir();
    const timer = path.join(unitDir, 'thinker-telemetry.timer');
    if (fs.existsSync(timer)) {
      run('systemctl', ['--user', 'disable', '--now', 'thinker-telemetry.timer'], { stdio: 'pipe', timeout: 5000 });
      for (const f of ['thinker-telemetry.timer', 'thinker-telemetry.service']) fs.rmSync(path.join(unitDir, f), { force: true });
      run('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe', timeout: 5000 });
      unscheduled = true;
    }
    let crontab = '';
    try { crontab = run('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { if (e.code !== 'ENOENT' && e.status !== 1) throw e; }
    const lines = crontab.split('\n');
    if (lines.some(isTelemetryCron)) {
      const filtered = lines.filter(l => !isTelemetryCron(l)).join('\n').trim();
      if (filtered) run('crontab', ['-'], { input: filtered + '\n', encoding: 'utf8' });
      else run('crontab', ['-r'], { stdio: 'ignore' });
      unscheduled = true;
    }
    return { unscheduled };
  }
  return { unscheduled: false };
}
