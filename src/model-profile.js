// The model behaviour profile (2026-11-10, the owner's ask): what each model did when it ran a subtask here, kept
// beside the figures that say why one would be chosen over another. Per model and subagent type: how many runs,
// what a run cost and how many calls it made, how long it took, how often a call failed, and -- the part a price
// list cannot say -- what the parent did after the subagent returned: whether it read again the files the
// subagent had read, whether it had to edit after a read-only run, and whether the person corrected that exchange.
// A cheap model that sends the parent back to re-read everything saved nothing, which is the Factory's rework read
// at the one place a model choice shows up first.
//
// Everything here is read from what is already recorded: the subagent transcripts beside their parents
// (transcripts.js:subagentSessions, each with the parent's tool_use id in its meta), the parent transcript, the
// profile ledger's corrections, and the proxy log's routed rows (latency and errors per route). No model call. The
// recommendations are a rule over those figures (`recommend`), with the figures beside them so a person can
// disagree; they are applied by hand (`thinker models route`), never by the profile itself. Learning the routing
// over time is what this is the ledger for, and the first thing to learn is whether the figures move at all.
import fs from 'node:fs';
import path from 'node:path';
import { parseTranscript, subagentSessions } from './transcripts.js';
import { findRepoSessions } from './instruction-value.js';
import { listPrice } from './prices.js';
import { readLedger } from './profile.js';
import { diskCache, cacheKey, cachedByFiles } from './disk-cache.js';
import { proxyLogFile } from './proxy-service.js';
import { thinkerHome } from './update.js';
import { formatDollars } from './prices.js';
import { callCost, callTokens } from './factory.js';

export const MIN_RUNS = 5;          // a model's figures are read only past this many runs of one subagent type
export const WORSE_BY = 0.10;       // a candidate may be this much worse (absolute share) on re-reads, corrections or errors and still count as no worse
export const RULES_VERSION = 1;
const RUN_CACHE = diskCache('model-profile-run', RULES_VERSION), PARENT_CACHE = diskCache('model-profile-parent', RULES_VERSION);
export const profileFile = (home = thinkerHome()) => path.join(home, 'state', 'model-profile.json');

const READ_TOOLS = /^(Read|Grep|Glob|NotebookRead)$/, EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const pathOf = e => e?.input?.file_path || e?.input?.path || e?.input?.notebook_path || null;

// the parent, reduced to what a run needs: its tool calls by id with their call index and exchange, and its interrupts by exchange
export function parentIndex(p) {
  const tools = [], interrupts = [];
  let exchange = 0;
  for (const e of p.events || []) {
    if (e.t === 'prompt') { exchange++; continue; }
    if (e.t === 'interrupt') { interrupts.push(exchange); continue; }
    if (e.t === 'tool') tools.push({ id: e.id || null, name: e.name, ci: Number.isInteger(e.call) ? e.call : null, exchange, path: pathOf(e), error: !!e.error });
  }
  return { tools, interrupts };
}

// one subagent run, with the parent's follow-up in the same exchange
export function runOf(sub, parentIdx, { price = null, corrected = new Set(), toolUseId = null } = {}) {
  const calls = sub.calls || [], events = sub.events || [];
  const files = new Set(); let errors = 0;
  for (const e of events) if (e.t === 'tool') { if (READ_TOOLS.test(e.name) && pathOf(e)) files.add(pathOf(e)); if (e.error) errors++; }
  const ts = calls.map(c => c.t).filter(t => t > 0);
  const run = { model: sub.model || null, calls: calls.length, cost: price ? calls.reduce((a, c) => a + (callCost(c, price) || 0), 0) : null,
    tokens: calls.reduce((a, c) => a + callTokens(c), 0), out: calls.reduce((a, c) => a + (c.out || 0), 0), durationMs: ts.length ? Math.max(...ts) - Math.min(...ts) : 0, errors, files: files.size, follow: null };
  const launch = toolUseId && parentIdx ? parentIdx.tools.find(t => t.id === toolUseId) : null;
  if (launch && launch.ci != null) {
    const after = parentIdx.tools.filter(t => t.exchange === launch.exchange && t.ci != null && t.ci > launch.ci);
    const reReads = new Set(after.filter(t => READ_TOOLS.test(t.name) && t.path && files.has(t.path)).map(t => t.path));
    run.follow = { calls: new Set(after.map(t => t.ci)).size, reReads: reReads.size, edits: after.filter(t => EDIT_TOOLS.test(t.name)).length,
      corrected: corrected.has(launch.exchange) || parentIdx.interrupts.includes(launch.exchange), exchange: launch.exchange };
  }
  return run;
}

const group = () => ({ runs: 0, priced: 0, cost: 0, tokens: 0, out: 0, calls: 0, durationMs: 0, errors: 0, files: 0, followed: 0, followCalls: 0, reReads: 0, edits: 0, corrected: 0 });
const addRun = (g, r) => {
  g.runs++; g.calls += r.calls; g.tokens += r.tokens; g.out += r.out; g.durationMs += r.durationMs; g.errors += r.errors; g.files += r.files;
  if (r.cost != null) { g.priced++; g.cost += r.cost; }
  if (r.follow) { g.followed++; g.followCalls += r.follow.calls; g.reReads += r.follow.reReads; g.edits += r.follow.edits; if (r.follow.corrected) g.corrected++; }
};
// the figures a group is read on
export const figures = g => ({
  costPerRun: g.priced ? g.cost / g.priced : null, callsPerRun: g.runs ? g.calls / g.runs : null, tokensPerRun: g.runs ? g.tokens / g.runs : null,
  secondsPerRun: g.runs ? g.durationMs / g.runs / 1000 : null, errorShare: g.calls ? g.errors / g.calls : null,
  reReadShare: g.files ? g.reReads / g.files : null, correctedShare: g.followed ? g.corrected / g.followed : null, editShare: g.followed ? g.edits / g.followed : null,
});

function correctedBySession(store, { days, now }) {
  const by = new Map();
  let rows = []; try { rows = readLedger(store, { days, now }); } catch { return by; }
  for (const r of rows) if (['corrected', 'redirected'].includes(r.outcome) && r.session && Number.isInteger(r.turn)) { if (!by.has(r.session)) by.set(r.session, new Set()); by.get(r.session).add(r.turn); }
  return by;
}
const metaOf = sub => { try { return JSON.parse(fs.readFileSync(sub.file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { return {}; } };

// the subagent runs of this repository's sessions, grouped by model and type
export function measureRuns(store, { days = 30, now = Date.now(), sessions, onSession } = {}) {
  sessions ??= findRepoSessions(store.repo, days);
  const from = now - days * 86400_000;
  const parents = new Map(sessions.map(s => [s.session, s]));
  const config = (() => { try { return store.config(); } catch { return {}; } })();
  const corrected = correctedBySession(store, { days, now });
  const groups = {}, byRun = [];
  for (const sub of subagentSessions(sessions)) {
    if (sub.mtime < from) continue;
    const parent = parents.get(sub.parent);
    let r;
    try {
      r = cachedByFiles(RUN_CACHE, cacheKey('model-profile-run', String(RULES_VERSION), sub.file, parent?.file || '', String(parent?.since || ''), [...(corrected.get(sub.parent) || [])].join(',')), [sub.file, ...(parent?.file ? [parent.file] : [])], () => {
        const p = parseTranscript(sub.file);
        if (!p.calls?.length) return null;
        const idx = parent?.file ? cachedByFiles(PARENT_CACHE, cacheKey('model-profile-parent', String(RULES_VERSION), parent.file, String(parent.since || '')), [parent.file], () => parentIndex(parseTranscript(parent.file, { since: parent.since || 0 }))) : null;
        const meta = metaOf(sub);
        return { ...runOf(p, idx, { price: listPrice(p.model, { config }), corrected: corrected.get(sub.parent) || new Set(), toolUseId: meta.toolUseId || null }), type: sub.type || meta.agentType || 'unknown', at: sub.mtime, session: sub.parent };
      });
    } catch { r = null; }
    onSession?.(sub);
    if (!r) continue;
    const key = `${r.model || 'unknown'}|${r.type}`;
    groups[key] ||= { model: r.model || 'unknown', type: r.type, ...group() };
    addRun(groups[key], r);
    byRun.push(r);
  }
  return { groups, runs: byRun.length };
}

// what the proxy log says per route over the window: calls, errors, the median time to the first byte, tokens
export function routeFigures({ logFile = proxyLogFile(), days = 30, now = Date.now() } = {}) {
  const out = {};
  let text = ''; try { text = fs.readFileSync(logFile, 'utf8'); } catch { return out; }
  const since = new Date(now - days * 86400_000).toISOString();
  const lat = {};
  for (const line of text.split('\n')) {
    if (!line.includes('"route"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.op !== 'proxy' || !r.route || !r.at || r.at < since) continue;
    const g = out[r.route] ||= { route: r.route, provider: r.provider, model: r.routedModel, format: r.format, calls: 0, errors: 0, input: 0, read: 0, out: 0, firstByteMs: null };
    g.calls++; if (!(r.status >= 200 && r.status < 300) || r.truncated) g.errors++;
    g.input += r.input || 0; g.read += r.read || 0; g.out += r.out || 0;
    if (Number.isFinite(r.firstByteMs)) (lat[r.route] ||= []).push(r.firstByteMs);
  }
  for (const [route, xs] of Object.entries(lat)) { xs.sort((a, b) => a - b); out[route].firstByteMs = xs[Math.floor(xs.length / 2)]; }
  return out;
}

// What the figures say, type by type: the model with the most runs is the baseline, and a model with at least
// MIN_RUNS runs that costs less a run and is no worse by WORSE_BY on re-reads, corrections and errors is the
// recommendation; the cheapest such wins. A model still under MIN_RUNS is named with how many runs it needs.
export function recommend(groups, { minRuns = MIN_RUNS, worseBy = WORSE_BY } = {}) {
  const byType = {};
  for (const g of Object.values(groups)) (byType[g.type] ||= []).push(g);
  const out = [];
  for (const [type, gs] of Object.entries(byType)) {
    const ready = gs.filter(g => g.runs >= minRuns && g.priced > 0).sort((a, b) => b.runs - a.runs);
    const waiting = gs.filter(g => g.runs < minRuns).map(g => ({ model: g.model, runs: g.runs, need: minRuns - g.runs }));
    if (ready.length < 2) { out.push({ type, verdict: 'too-early', baseline: ready[0]?.model || null, waiting, why: ready.length ? [`only ${ready[0].model} has ${minRuns}+ priced runs as ${type}`] : [`no model has ${minRuns}+ priced runs as ${type}`] }); continue; }
    const base = ready[0], bf = figures(base);
    const noWorse = (a, b) => a == null || b == null || a <= b + worseBy;
    const candidates = ready.slice(1).map(g => ({ g, f: figures(g) }))
      .filter(({ f }) => f.costPerRun != null && bf.costPerRun != null && f.costPerRun < bf.costPerRun && noWorse(f.reReadShare, bf.reReadShare) && noWorse(f.correctedShare, bf.correctedShare) && noWorse(f.errorShare, bf.errorShare))
      .sort((a, b) => a.f.costPerRun - b.f.costPerRun);
    const pct = v => v == null ? '–' : `${Math.round(v * 100)}%`;
    const line = (g, f) => `${g.model}: ${formatDollars(f.costPerRun)} a run over ${g.runs} runs, parent re-read ${pct(f.reReadShare)} of its files, corrected ${pct(f.correctedShare)}, calls failed ${pct(f.errorShare)}`;
    if (!candidates.length) { out.push({ type, verdict: 'keep', baseline: base.model, waiting, why: [line(base, bf), ...ready.slice(1).map(g => `${line(g, figures(g))}: not cheaper, or worse by more than ${Math.round(worseBy * 100)} points`)] }); continue; }
    const { g, f } = candidates[0];
    out.push({ type, verdict: 'switch', baseline: base.model, recommend: g.model, saving: bf.costPerRun - f.costPerRun, waiting, why: [line(g, f), `against ${line(base, bf)}`] });
  }
  return out;
}

// --- the kept profile ----------------------------------------------------------------------------------------------------

export function readProfile(home = thinkerHome()) {
  try { return JSON.parse(fs.readFileSync(profileFile(home), 'utf8')); } catch { return { version: RULES_VERSION, repos: {}, routes: {} }; }
}
// measure this repository and fold it into the machine's profile, which keeps every repository's groups by repository
export function refreshProfile(store, { home = thinkerHome(), days = 30, now = Date.now(), logFile, onSession } = {}) {
  const m = measureRuns(store, { days, now, onSession });
  const prof = readProfile(home);
  prof.version = RULES_VERSION;
  prof.repos ||= {}; prof.repos[store.repo] = { at: new Date(now).toISOString(), days, runs: m.runs, groups: m.groups };
  prof.routes = routeFigures({ ...(logFile ? { logFile } : {}), days, now });
  prof.at = new Date(now).toISOString();
  fs.mkdirSync(path.dirname(profileFile(home)), { recursive: true });
  const tmp = `${profileFile(home)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prof, null, 2) + '\n'); fs.renameSync(tmp, profileFile(home));
  return prof;
}
// every repository's groups added up by model and type
export function mergedGroups(prof) {
  const out = {};
  for (const r of Object.values(prof.repos || {})) for (const [k, g] of Object.entries(r.groups || {})) {
    const o = out[k] ||= { model: g.model, type: g.type, ...group() };
    for (const f of Object.keys(group())) o[f] += g[f] || 0;
  }
  return out;
}
export function profileView(prof, { repo = null } = {}) {
  const groups = repo ? (prof.repos?.[repo]?.groups || {}) : mergedGroups(prof);
  return { at: prof.at || null, repos: Object.keys(prof.repos || {}).length, groups: Object.values(groups).map(g => ({ ...g, ...figures(g) })).sort((a, b) => a.type.localeCompare(b.type) || b.runs - a.runs), routes: Object.values(prof.routes || {}), recommendations: recommend(groups) };
}
export function renderProfile(v) {
  const out = [];
  const pct = x => x == null ? '–' : `${Math.round(x * 100)}%`, n = x => x == null ? '–' : x >= 100 ? String(Math.round(x)) : x.toFixed(1);
  if (!v.groups.length) return ['No subagent runs measured yet. A run is a Claude Code subagent (Explore, general-purpose, one written by thinker models assign) in a session of this repository; the profile fills as they happen.'];
  out.push(`Models as subagents${v.repos > 1 ? ` · ${v.repos} repositories` : ''}${v.at ? ` · measured ${v.at.slice(0, 16).replace('T', ' ')}` : ''}`);
  out.push('  type              model                              runs   $/run  calls  s/run  re-read  edits  corrected  failed');
  for (const g of v.groups) out.push(`  ${g.type.slice(0, 17).padEnd(17)} ${g.model.slice(0, 34).padEnd(34)} ${String(g.runs).padStart(5)} ${(g.costPerRun == null ? '–' : formatDollars(g.costPerRun)).padStart(7)} ${n(g.callsPerRun).padStart(6)} ${n(g.secondsPerRun).padStart(6)} ${pct(g.reReadShare).padStart(8)} ${pct(g.editShare).padStart(6)} ${pct(g.correctedShare).padStart(10)} ${pct(g.errorShare).padStart(7)}`);
  out.push('  re-read: of the files the subagent read, the share the parent read again in the same exchange; edits: runs the parent edited after; corrected: runs whose exchange the person corrected or interrupted; failed: of the subagent\'s calls.');
  if (v.routes.length) {
    out.push('', 'Routes through the proxy');
    for (const r of v.routes) out.push(`  ${r.route.padEnd(28)} ${(r.provider + '/' + r.model).slice(0, 40).padEnd(40)} ${String(r.calls).padStart(5)} calls  ${r.errors} failed  first byte ${r.firstByteMs == null ? '–' : `${(r.firstByteMs / 1000).toFixed(1)}s`}  in ${Math.round((r.input + r.read) / 1000)}k out ${Math.round(r.out / 1000)}k`);
  }
  out.push('', 'What the figures say');
  for (const r of v.recommendations) {
    const head = r.verdict === 'switch' ? `${r.type}: route to ${r.recommend} (saves ${formatDollars(r.saving)} a run against ${r.baseline})` : r.verdict === 'keep' ? `${r.type}: keep ${r.baseline}` : `${r.type}: too early`;
    out.push(`  ${head}`);
    for (const w of r.why) out.push(`    ${w}`);
    for (const w of r.waiting) out.push(`    ${w.model}: ${w.runs} runs, ${w.need} more before it is read`);
  }
  return out;
}
