// Usage history: a summary of the machine's log (see store.js: logFile), the append-only record of what the
// sessions asked, what thinker's own model calls spent, and what each session cost, in every repository. The
// note servings, their assessments and the reading they were estimated to save left with the knowledge notes
// on 2026-11-08; what thinker saves is the clearing's, measured (compression.js, savings-ledger.js).
import fs from 'node:fs';
import { emptySpend, addSpend, formatTokens, normalizeModelUsage, relativeRate, weightedTokens, retiredPurpose } from './model-usage.js';
export { formatTokens };
import { logFile, adoptLocalLog, repoId } from './store.js';
import { compressionHeader, compressionSaving } from './compression.js';

// The context proxy's saving, said the way a cache hit was said (compression.js). Nothing until the clearing
// has had a few turns to pay for itself, and nothing at all where no clear happened: a notice describes what
// genuinely took place, never what a default might have done.
export function compressionNotice(state) {
  const s = compressionSaving(state);
  if (!s) return '';
  return `\u{1F5DC} thinker: ${compressionHeader(s, formatTokens)}`;
}

// One form for a session's id wherever it was written: as the agent gave it, as the name of
// the trace recorded for it, or as the name of its transcript file.
export function sessionKey(s) {
  s = String(s ?? '').replace(/\.jsonl?$/, '').replace(/^trace-/, '');
  const codex = s.match(/^rollout-.*?([0-9a-f]{8}-[0-9a-f-]{27,})$/);
  return (codex ? codex[1] : s).replace(/[^\w.-]/g, '_');
}

export function normalizeClient(client, session = '') {
  if (client) {
    const c = String(client).toLowerCase();
    if (['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'pi', 'vscode', 'droid', 'qwen', 'kiro', 'cline', 'kilo', 'augment', 'goose', 'devin', 'mcp', 'cli'].includes(c)) return c;
    if (c.startsWith('cursor')) return 'cursor';
    if (c.startsWith('claude')) return 'claude';
    if (c.startsWith('codex')) return 'codex';
    if (c.startsWith('gemini') || c.startsWith('agy')) return 'gemini';
  }
  const s = String(session || '');
  if (/^rollout-/i.test(s)) return 'codex';
  return 'other';
}

// The log is parsed once a process for its size and mtime: the page's report over every repository summarized
// a dozen checkouts, and each one read and parsed the same 14 MB (a sixth of a second each, 2 s in all).
// What each reader asks for is kept beside it under the same stamp (`sorted`): the events of one repository, or of
// every one, in order. Until 2026-11-10 only the parse was kept and every call re-made 35,000 objects, filtered them
// and sorted them again -- a sixth of a second a call, and one report calls this five times over (report.js,
// context-view.js, delivery.js, profile-metric.js, savings-ledger.js), once per repository of `--refresh --all`:
// three of the fifteen seconds that run took here. The events are read, never written, so every caller shares one array.
//
// **Nothing is copied to answer a read** (2026-11-12). An event records the repository it happened in, so the two
// fields a reader needs -- `repo` and `origin` -- are put on the rows once, here, in the order they are read in; a
// reader then gets the rows themselves (`all`) or an array of references to the ones it asked for. Until then every
// (repository, all) pair spread all 35,000 events into 35,000 new objects: 51 MB of heap for this machine's 18 MB log,
// four of them held at once, re-made for each of eighteen repositories of an All repositories visit. The time was
// hidden by the cache below; the allocation was not, and it is what a page load costs on a machine already short of
// memory, which is when the person notices. A log whose rows do not all name a repository (`anonymous`) keeps the old
// path, since there the fields depend on which checkout is asking.
const parsed = new Map(); // file -> { stamp, rows, anonymous, sorted: Map(`${repo}\t${all}` -> events) }
const parse = f => {
  let stamp; try { const s = fs.statSync(f); stamp = `${s.size}\t${s.mtimeMs}`; } catch { return null; }
  let hit = parsed.get(f);
  if (!hit || hit.stamp !== stamp) {
    let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch {}
    const rows = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && e.t && e.op);
    rows.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
    let anonymous = false;
    for (const e of rows) { if (!e.repo) { anonymous = true; continue; } if (!e.origin) e.origin = repoId(e.repo); }
    hit = { stamp, rows, anonymous, sorted: new Map() };
    parsed.set(f, hit);
  }
  return hit;
};
// the events a reader asked for: `repo` fills in the checkout an event does not name, `all` keeps every repository's
// The last few asked for, not every one: a run over every repository on the machine asks for two of these a
// repository, and a copy of a 35,000-event log is tens of megabytes, so holding twenty would cost more than it saves.
const KEEP_SORTED = 4;
const logEvents = (f, repo, all) => {
  const hit = parse(f); if (!hit) return [];
  if (!hit.anonymous && all) return hit.rows; // in order, with their origins already on them
  const key = `${repo}\t${all}`, kept = hit.sorted.get(key);
  if (kept) { hit.sorted.delete(key); hit.sorted.set(key, kept); return kept; }
  const here = repoId(repo);
  const out = hit.anonymous
    ? hit.rows
      // which repository: the origin recorded with the event, else that of the checkout it names
      .map(e => { const r = e.repo || repo; return e.repo && e.origin ? e : { ...e, repo: r, origin: e.origin || repoId(r) }; })
      .filter(e => all || e.origin === here)
    : hit.rows.filter(e => e.origin === here);
  hit.sorted.set(key, out);
  for (const k of [...hit.sorted.keys()].slice(0, -KEEP_SORTED)) hit.sorted.delete(k);
  return out;
};

// The machine's log; what this repository logged locally before the log was shared is moved into it first.
export function readLog(store, { all = false } = {}) {
  adoptLocalLog(store);
  const main = logFile(store);
  return main ? logEvents(main, store.repo, all) : [];
}

// Every repository the machine's log has named, with its checkouts (clones, worktrees), over the whole
// log: the caches on the machine, as against summarize's repositories with an event in a window.
export function knownRepos(store, { all = false } = {}) {
  const repos = new Map();
  for (const e of readLog(store, { all })) {
    if (!repos.has(e.origin)) repos.set(e.origin, { repo: e.origin, checkouts: new Set() });
    if (e.repo) repos.get(e.origin).checkouts.add(e.repo);
  }
  return [...repos.values()].map(r => ({ ...r, checkouts: [...r.checkouts] }));
}

// A request is a prompt the hooks saw (`request`; `orient` on logs written before 2026-11-08). A session is one
// the Stop hook wrote a `session` row for, or that made a request under its id.
const REQUEST_OPS = new Set(['request', 'orient']);
export function summarize(store, { days, all = false, now = Date.now() } = {}) {
  const since = days ? new Date(now - days * 86400_000).toISOString() : '';
  const events = readLog(store, { all }).filter(e => e.t >= since && Date.parse(e.t) <= now);
  const u = {
    scope: all ? 'machine' : repoId(store.repo),
    from: events[0]?.t || null, to: events[events.length - 1]?.t || null, events: events.length,
    requests: 0, sessions: 0,
    spending: { ...emptySpend(), byPurpose: {}, byPhase: {}, byModel: {}, legacyRecords: 0,
      weighted: { units: 0, pricedCalls: 0, unpricedTokens: 0, unpricedCalls: 0, retiredTokens: 0 } },
    // the profile's reads of sessions (profile.js), and the compile that follows
    learned: { sessions: 0, observations: 0, compiles: 0 },
    distillationPerformance: { attempts: 0, succeeded: 0, failed: 0, durationMs: 0, durationSamples: 0, spending: emptySpend() },
    clients: {
      active: { claude: 0, codex: 0, cursor: 0, gemini: 0, mcp: 0, cli: 0, other: 0 },
      sessions: { claude: 0, codex: 0, cursor: 0, gemini: 0, mcp: 0, cli: 0, other: 0 },
    },
    repos: [],
  };
  // a repository is its origin; its checkouts (clones, worktrees) are counted together
  const repos = new Map();
  const per = (origin, checkout) => { if (!repos.has(origin)) repos.set(origin, { repo: origin, checkouts: new Set(), requests: 0, sessions: new Set(), spending: emptySpend() }); const r = repos.get(origin); if (checkout) r.checkouts.add(checkout); return r; };
  const sessions = new Map(); // origin|session → client
  for (const e of events) {
    const r = per(e.origin, e.repo);
    const d = u.distillationPerformance;
    if (e.op === 'distill-run' && !e.dry) {
      d.attempts++;
      if (e.failed) d.failed++; else d.succeeded++;
      if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0) { d.durationMs += e.durationMs; d.durationSamples++; }
    }
    if (!e.dry && !e.metered && e.op === 'model' && ['distill', 'profile-extract', 'profile-compile'].includes(e.purpose)) addSpend(d.spending, e);
    if (!e.metered && (e.op === 'model' || ['distill', 'mine-prs', 'verify', 'phrase', 'route'].includes(e.op))) {
      const purpose = e.purpose || e.op, phase = e.phase || 'legacy';
      const model = `${e.provider || 'unknown'}/${e.model || 'unknown'}`;
      addSpend(u.spending, e); addSpend(r.spending, e);
      for (const [group, key] of [['byPurpose', purpose], ['byPhase', phase], ['byModel', model]]) {
        u.spending[group][key] ||= emptySpend();
        addSpend(u.spending[group][key], e);
      }
      if (e.op !== 'model') u.spending.legacyRecords++;
      // the same call weighed against the agent's reading (relativeRate), leaving out removed features
      const w = u.spending.weighted, t = e.tokens && typeof e.tokens === 'object' ? e.tokens : normalizeModelUsage(e.provider, e.usage);
      if (retiredPurpose(purpose)) w.retiredTokens += t.totalTokens || 0;
      else {
        const rate = relativeRate(e.model);
        if (rate) { w.units += weightedTokens(t, rate); w.pricedCalls++; }
        else if (t.totalTokens) { w.unpricedTokens += t.totalTokens; w.unpricedCalls++; }
      }
    }
    if (e.op === 'profile') { u.learned.sessions++; u.learned.observations += e.observations || 0; }
    else if (e.op === 'profile-compile') u.learned.compiles++;
    const named = e.session && e.session !== 'unknown';
    if (REQUEST_OPS.has(e.op)) {
      const cl = normalizeClient(e.client, e.session);
      u.requests++; r.requests++;
      u.clients.active[cl] = (u.clients.active[cl] || 0) + 1;
      if (named) { const k = `${e.origin}|${sessionKey(e.session)}`; if (!sessions.has(k)) sessions.set(k, cl); r.sessions.add(k); }
    } else if (e.op === 'session' && named) {
      const k = `${e.origin}|${sessionKey(e.session)}`;
      if (!sessions.has(k)) sessions.set(k, normalizeClient(e.client, e.session));
      r.sessions.add(k);
    }
  }
  u.sessions = sessions.size;
  for (const cl of sessions.values()) u.clients.sessions[cl] = (u.clients.sessions[cl] || 0) + 1;
  if (!repos.size && !all) per(repoId(store.repo), store.repo);
  u.repos = [...repos.values()].map(r => ({ ...r, checkouts: [...r.checkouts], sessions: r.sessions.size })).sort((a, b) => b.requests - a.requests);
  // The spend in tokens of the agents' model: priced calls by their rate over the agents' input rate, the rest one for one.
  const w = u.spending.weighted;
  w.agentRate = 1;
  w.agentTokens = Math.round(w.units / w.agentRate + w.unpricedTokens);
  delete w.units;
  return u;
}

const num = n => Math.round(n).toLocaleString('en-US');

// The ISO week of a local date, as 2026-W42.
export function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  const y = x.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((x - Date.UTC(y, 0, 1)) / 86400_000 + 1) / 7)).padStart(2, '0')}`;
}

export function renderUsage(u, { days } = {}) {
  const machine = u.scope === 'machine';
  const where = machine ? 'on this machine' : `for ${u.scope.includes('/') && !u.scope.startsWith('/') ? u.scope : u.scope.split('/').pop()}`;
  if (!u.events) return `No usage recorded ${where}${days ? ` in the last ${days} days` : ''}. thinker records it as the hooks run${machine ? '' : '; `thinker usage` without --here shows every repository'}.`;
  const L = [];
  L.push(`thinker usage ${where}${machine ? `, ${num(u.repos.length)} ${u.repos.length === 1 ? 'repository' : 'repositories'}` : ''}, ${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}${days ? ` (last ${days} days)` : ''}`, '');
  L.push('Sessions');
  L.push(`  requests        ${num(u.requests)}${u.sessions ? `, in ${num(u.sessions)} sessions` : ''}`);
  const agents = Object.entries(u.clients.active).filter(([, n]) => n).map(([k, n]) => `${num(n)} ${k}`).join(', ');
  if (agents) L.push(`  agents          ${agents}`);
  L.push('', 'Learned');
  L.push(`  sessions read   ${num(u.learned.sessions)} into the profile: ${num(u.learned.observations)} observations, ${num(u.learned.compiles)} compiles`);
  const spending = u.spending;
  if (spending?.calls) {
    L.push('', 'Learning (reported usage)');
    const row = (label, s) => `  ${label.padEnd(18)} ${num(s.inputTokens)} input + ${num(s.outputTokens)} output; ${num(s.totalTokens)} total tokens; ${num(s.calls)} records`;
    L.push(row('total', spending));
    L.push('  By phase:');
    for (const [phase, s] of Object.entries(spending.byPhase)) L.push(row(phase === 'init' ? 'cache init' : phase === 'learning' ? 'ongoing learning' : phase === 'legacy' ? 'older records' : phase, s));
    L.push('  By operation (same spending):');
    for (const [purpose, s] of Object.entries(spending.byPurpose)) L.push(row('  ' + purpose, s));
    L.push(`  provider caching   ${num(spending.cacheReadTokens)} read, ${num(spending.cacheWriteTokens)} written (included in input)`);
    if (spending.unknownTokenCalls) L.push(`  missing usage      ${num(spending.unknownTokenCalls)} records without complete token totals`);
    if (spending.failed) L.push(`  failed attempts    ${num(spending.failed)} (reported spending included above)`);
    if (spending.legacyRecords) L.push('  history            older records omit tokens; totals are incomplete');
    L.push('  details            --json includes provider/model and per-repository spending');
  }
  L.push('', 'What the clearing saved is on the Report page and in thinker savings; the profile is thinker profile show.');
  if (machine) {
    const home = process.env.HOME || '';
    const name = r => home && r.startsWith(home + '/') ? '~' + r.slice(home.length) : r;
    const w = Math.min(48, Math.max(10, ...u.repos.map(r => name(r.repo).length)));
    L.push('', 'By repository', `  ${'repository'.padEnd(w)}  ${'requests'.padStart(8)}  ${'sessions'.padStart(8)}`);
    for (const r of u.repos.slice(0, 20)) L.push(`  ${name(r.repo).slice(-w).padEnd(w)}  ${num(r.requests).padStart(8)}  ${num(r.sessions).padStart(8)}`);
    if (u.repos.length > 20) L.push(`  and ${u.repos.length - 20} more`);
  }
  return L.join('\n');
}
