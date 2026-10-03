// Usage history: a summary of the machine's log (see store.js: logFile), the append-only
// record of what was served, learned, verified and mined in every repository, with an
// estimate of the exploration the served notes saved.
//
// The estimate counts only servings that the end-of-session assessment marked
// `confirmed` (the agent acted on the note and nothing contradicted it). For each,
// it takes one read per file the note rests on (at most 5) and the tokens those
// reads would have returned (each file capped at what one read returns). Searches
// to find the files, and the re-reading of earlier output on every later model
// call, are left out. It is an estimate of reading avoided, not a measurement.
import fs from 'node:fs';
import path from 'node:path';
import { emptySpend, addSpend } from './model-usage.js';
import { priceOf, readCost } from './prices.js';
import { estTokens } from './rank.js';
import { Store, logFile, adoptLocalLog, repoId } from './store.js';
import { sessionModel } from './transcripts.js';

const FILE_CAP = 6000;   // tokens one read of a large file returns (about 2000 lines)
const MAX_FILES = 5;
// Wall clock of one avoided read: the model turn that issues it and takes in the result.
// bench/RESULTS.md measured 2 to 4.5 seconds of wall clock per tool call (click: 15 s over
// 3.4 calls; PostHog: 1.1 min less over 31.6 fewer calls), so this too is an estimate.
export const SECONDS_PER_READ = 4;

// Deps that are not code a session would have read: the agents' own configuration, git's
// internals, thinker's own state, and build or run output. Every note must anchor to an
// existing file (ops.js:createNote), so a note about the permission classifier or about
// duplicate hooks anchors to .claude/settings.local.json for want of anywhere better. Nobody
// learns those rules by reading that file: what such a note saves is a wrong action, not a
// read. This estimate only counts reading, so it counts them as nothing rather than crediting
// a read no session would have made. The notes keep their anchors and are served as before.
const NOT_READING = /^(\.claude|\.codex|\.cursor|\.gemini|\.vscode|\.idea|\.git|\.thinker|node_modules|dist|coverage)\/|^\.mcp\.json$|^bench\/runs\/|\.log$/;
export const countsAsReading = f => !NOT_READING.test(String(f || ''));

export function savingOf(repo, note) {
  let calls = 0, tokens = 0;
  for (const f of [...new Set((note?.deps || []).map(d => d.path).filter(Boolean))].slice(0, MAX_FILES)) {
    if (!countsAsReading(f)) continue;
    try { const st = fs.statSync(path.join(repo, f)); if (!st.isFile()) continue; calls++; tokens += Math.min(Math.ceil(st.size / 3.6), FILE_CAP); } catch {}
  }
  return { calls, tokens };
}

export function cacheHitSavings(repo, notes) {
  let calls = 0, tokens = 0, uncounted = 0;
  const seenFiles = new Set();
  for (const n of notes || []) {
    for (const f of [...new Set((n?.deps || []).map(d => d.path).filter(Boolean))].slice(0, MAX_FILES)) {
      if (seenFiles.has(f)) continue;
      seenFiles.add(f);
      if (!countsAsReading(f)) { uncounted++; continue; }
      try {
        const st = fs.statSync(path.join(repo, f));
        if (!st.isFile()) continue;
        calls++;
        tokens += Math.min(Math.ceil(st.size / 3.6), FILE_CAP);
      } catch {}
    }
  }
  // A note whose files are not on disk still stands for at least one read. A note anchored
  // only to configuration stands for none, so the floor is not given to it: the answer is
  // nothing counted, not a guess from the note's own length.
  if (!tokens && !uncounted && notes?.length) {
    tokens = notes.reduce((sum, n) => sum + Math.max(Math.ceil((n.body || '').length / 3.6) * 4, 300), 0);
  }
  const seconds = Math.max(calls, tokens ? 1 : 0) * SECONDS_PER_READ;
  return { calls, tokens, uncounted, seconds };
}

export function formatTokens(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n)}`;
}

export function formatSeconds(s) {
  if (s >= 60) return `${(s / 60).toFixed(1).replace(/\.0$/, '')}min`;
  return `${Math.round(s)}s`;
}

// What the user sees at the end of a turn: everything served in it, at the prompt and
// while the agent read and edited files. Nothing is known yet about whether the agent acted
// on them, so the notice describes the notes and does not say "saved"; in a week on this
// repository about 30% of servings were acted on. What was saved is counted after the
// session is assessed (summarize, `thinker usage`). The prompt hook says nothing: a line at
// every prompt was noise.
export function turnNotice(repo, notes) {
  const hits = (notes || []).length;
  if (!hits) return '';
  const { calls, tokens } = cacheHitSavings(repo, notes);
  const noun = `${hits} ${hits === 1 ? 'note' : 'notes'} this turn`;
  // Notes that rest only on configuration point at no code to read: say how many there were
  // and stop, rather than print `~0 tokens of code` or a figure the note's length invented.
  if (!tokens) return `🧠 thinker: ${noun}`;
  const files = calls ? `${calls} ${calls === 1 ? 'file' : 'files'}, ` : '';
  return `🧠 thinker: ${noun} (pointing at ${files}~${formatTokens(tokens)} tokens of code)`;
}


// One form for a session's id wherever it was written: as the agent gave it, as the name of
// the trace recorded for it, or (in older assessments) as the name of its transcript file.
export function sessionKey(s) {
  s = String(s ?? '').replace(/\.jsonl?$/, '').replace(/^trace-/, '');
  const codex = s.match(/^rollout-.*?([0-9a-f]{8}-[0-9a-f-]{27,})$/);
  return (codex ? codex[1] : s).replace(/[^\w.-]/g, '_');
}

export function normalizeClient(client, session = '') {
  if (client) {
    const c = String(client).toLowerCase();
    if (['claude', 'codex', 'cursor', 'gemini', 'mcp', 'cli'].includes(c)) return c;
    if (c.startsWith('cursor')) return 'cursor';
    if (c.startsWith('claude')) return 'claude';
    if (c.startsWith('codex')) return 'codex';
    if (c.startsWith('gemini') || c.startsWith('agy')) return 'gemini';
  }
  const s = String(session || '');
  if (/^rollout-/i.test(s)) return 'codex';
  return 'other';
}

// fields added to a serving's log line
export const servedFields = (store, notes, text) => ({ tokens: estTokens(text || ''), est: notes.map(n => { const s = savingOf(store.repo, n); return [s.calls, s.tokens]; }) });

const parse = (f, repo) => {
  let raw = ''; try { raw = fs.readFileSync(f, 'utf8'); } catch {}
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && e.t && e.op).map(e => e.repo ? e : { ...e, repo })
    // which repository: the origin recorded with the event, else that of the checkout it names
    .map(e => ({ ...e, origin: e.origin || repoId(e.repo) }));
};

// The machine's log; what this repository logged locally before the log was shared is moved into it first.
export function readLog(store, { all = false } = {}) {
  adoptLocalLog(store);
  const main = logFile(store);
  const events = main ? parse(main, store.repo) : [];
  const here = repoId(store.repo);
  return events.filter(e => all || e.origin === here).sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
}

export function summarize(store, { days, all = false } = {}) {
  const since = days ? new Date(Date.now() - days * 86400_000).toISOString() : '';
  const events = readLog(store, { all }).filter(e => e.t >= since);
  // The machine's log spans every checkout thinker has run in: some are gone, some moved, and a
  // benchmark arm may point .thinker/notes at a noteset through a symlink, which the store refuses
  // to read. A summary of 400 repositories must not die for one of them, so a checkout that cannot
  // be read answers "no notes" and is counted (`unreadable`) instead of throwing.
  const unreadable = new Set();
  const safeStore = s => ({
    repo: s.repo,
    get(id) { try { return s.get(id); } catch { unreadable.add(s.repo); return null; } },
    list() { try { return s.list(); } catch { unreadable.add(s.repo); return []; } },
  });
  const stores = new Map([[store.repo, safeStore(store)]]);
  const storeOf = repo => {
    if (!stores.has(repo)) {
      let s = null;
      try { s = new Store(repo, { readonly: true }); } catch { unreadable.add(repo); }
      stores.set(repo, s ? safeStore(s) : { repo, get: () => null, list: () => [] });
    }
    return stores.get(repo);
  };
  const u = {
    scope: all ? 'machine' : repoId(store.repo),
    from: events[0]?.t || null, to: events[events.length - 1]?.t || null, events: events.length,
    requests: 0, answered: 0, sessions: 0,
    servings: { prompt: 0, file: 0, lookup: 0 }, notesServed: 0, notes: 0, tokensServed: 0,
    assessed: { confirmed: 0, contradicted: 0, unused: 0, pending: 0 },
    learned: { sessions: 0, notes: 0, merged: 0, prs: 0, prNotes: 0 },
    verified: { still_valid: 0, update: 0, invalid: 0 },
    feedback: { useful: 0, notUseful: 0 }, corrections: 0,
    spending: { ...emptySpend(), byPurpose: {}, byPhase: {}, byModel: {}, legacyRecords: 0 },
    distillation: { runs: 0, noNewNotes: 0, noChanges: 0 },
    distillationPerformance: { attempts: 0, succeeded: 0, failed: 0, durationMs: 0, durationSamples: 0, spending: emptySpend() },
    clients: {
      active: { claude: 0, codex: 0, cursor: 0, gemini: 0, mcp: 0, cli: 0, other: 0 },
      servings: { claude: 0, codex: 0, cursor: 0, gemini: 0, mcp: 0, cli: 0, other: 0 },
      sessions: { claude: 0, codex: 0, cursor: 0, gemini: 0, mcp: 0, cli: 0, other: 0 },
    },
    retrieval: {
      staleServed: 0,
      freshServed: 0,
      staleRate: 0,
      guardTriggered: 0,
      guardUncoveredTerms: 0,
      durationMs: 0,
      durationSamples: 0,
      servedByKind: {},
    },
    spent: 0, saved: { calls: 0, tokens: 0, servings: 0, usd: 0, pricedServings: 0, unpricedServings: 0, unpricedTokens: 0, byModel: {} },
    injected: { usd: 0, pricedTokens: 0, unpricedTokens: 0 },
    holdout: null,
    repos: [], top: [],
  };
  const sessionLines = new Map();  // origin|session → the last `session` line (what the session cost)
  const servedIn = new Map();      // origin|session → { served, withheld, holdout }
  const config = store.config();
  const price = m => priceOf(m, { config });
  // a repository is its origin; its checkouts (clones, worktrees) are counted together
  const repos = new Map();      // origin → its line in the summary
  const per = (origin, checkout) => { if (!repos.has(origin)) repos.set(origin, { repo: origin, checkouts: new Set(), requests: 0, served: 0, learned: 0, calls: 0, tokens: 0, spending: emptySpend() }); const r = repos.get(origin); if (checkout) r.checkouts.add(checkout); return r; };
  const sessions = new Map();   // origin|session → { origin, named, client, model, injected, notes: Map(note id → [calls, tokens]) }
  const verdicts = new Map();   // origin|session → Map(note id → verdict)
  const count = new Map();
  let anon = 0;
  for (const e of events) {
    const r = per(e.origin, e.repo), s = storeOf(e.repo);
    const d = u.distillationPerformance;
    if (e.op === 'distill-run' && !e.dry) {
      d.attempts++;
      if (e.failed) d.failed++; else d.succeeded++;
      if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0) {
        d.durationMs += e.durationMs; d.durationSamples++;
      }
    }
    const p = e.op === 'model' || e.model ? price(e.model) : null;
    if (!e.dry && !e.metered && ((e.op === 'model' && e.purpose === 'distill') || e.op === 'distill')) addSpend(d.spending, e, p);
    if (!e.metered && (e.op === 'model' || ['distill', 'mine-prs', 'verify', 'phrase', 'route'].includes(e.op))) {
      const purpose = e.purpose || e.op, phase = e.phase || 'legacy';
      const model = `${e.provider || 'unknown'}/${e.model || 'unknown'}`;
      addSpend(u.spending, e, p); addSpend(r.spending, e, p);
      for (const [group, key] of [['byPurpose', purpose], ['byPhase', phase], ['byModel', model]]) {
        u.spending[group][key] ||= emptySpend();
        addSpend(u.spending[group][key], e, p);
      }
      if (e.op !== 'model') u.spending.legacyRecords++;
    }
    if (e.op === 'distill') {
      u.distillation.runs++;
      if (!(e.saved || []).length) u.distillation.noNewNotes++;
      if (!(e.saved || []).length && !(e.merged || []).length) u.distillation.noChanges++;
    }
    if (e.op === 'session' && e.session && e.session !== 'unknown') { sessionLines.set(`${e.origin}|${sessionKey(e.session)}`, e); continue; }
    if (e.op === 'orient' || e.op === 'late' || e.op === 'lookup') {
      const cl = normalizeClient(e.client, e.session);
      const ids = e.served || [];
      if (e.op !== 'lookup' && e.session && e.session !== 'unknown') {
        const k = `${e.origin}|${sessionKey(e.session)}`, x = servedIn.get(k) || { served: 0, withheld: 0, holdout: false };
        if (e.holdout) { x.holdout = true; x.withheld += (e.withheld || []).length; } else x.served += ids.length;
        servedIn.set(k, x);
      }
      if (e.op !== 'late') {
        u.requests++;
        r.requests++;
        u.clients.active[cl] = (u.clients.active[cl] || 0) + 1;
        if (ids.length) u.answered++;
      }
      if (typeof e.durationMs === 'number' && Number.isFinite(e.durationMs) && e.durationMs >= 0) {
        u.retrieval.durationMs += e.durationMs;
        u.retrieval.durationSamples++;
      }
      if (e.op === 'orient' && Array.isArray(e.uncovered) && e.uncovered.length > 0) {
        u.retrieval.guardTriggered++;
        u.retrieval.guardUncoveredTerms += e.uncovered.length;
      }
      if (!ids.length) continue;
      u.servings[e.op === 'orient' ? 'prompt' : e.op === 'late' ? 'file' : 'lookup'] += ids.length;
      r.served += ids.length;
      u.clients.servings[cl] = (u.clients.servings[cl] || 0) + ids.length;

      const staleCount = Array.isArray(e.stale) ? e.stale.length : 0;
      u.retrieval.staleServed += staleCount;
      u.retrieval.freshServed += Math.max(0, ids.length - staleCount);

      for (const id of ids) {
        const k = s.get(id)?.kind || 'other';
        u.retrieval.servedByKind[k] = (u.retrieval.servedByKind[k] || 0) + 1;
      }

      // lines written before the estimate was recorded: the note's text and files as they are now
      const injected = typeof e.tokens === 'number' ? e.tokens : ids.reduce((n, id) => n + estTokens(s.get(id)?.body || ''), 0);
      u.tokensServed += injected;
      const named = e.session && e.session !== 'unknown';
      const key = `${e.origin}|${named ? sessionKey(e.session) : `?${anon++}`}`;
      if (!sessions.has(key)) sessions.set(key, { origin: e.origin, repo: e.repo, session: named ? e.session : null, named, client: cl, model: null, injected: 0, notes: new Map() });
      sessions.get(key).injected += injected;
      ids.forEach((id, i) => {
        const k = `${e.origin}|${id}`; count.set(k, { origin: e.origin, repo: e.repo, id, n: (count.get(k)?.n || 0) + 1 });
        if (!sessions.get(key).notes.has(id)) sessions.get(key).notes.set(id, e.est?.[i] || Object.values(savingOf(e.repo, s.get(id))));
      });
    } else if (e.op === 'attest') {
      const key = `${e.origin}|${sessionKey(e.session)}`;
      if (!verdicts.has(key)) verdicts.set(key, new Map());
      for (const a of e.applied || []) verdicts.get(key).set(a.id, a.verdict);
      // the model the session ran on; the servings were logged before the assessment named it
      if (e.model && sessions.has(key)) sessions.get(key).model = e.model;
    } else if (e.op === 'distill') { u.learned.sessions++; u.learned.notes += (e.saved || []).length; u.learned.merged += (e.merged || []).length; r.learned += (e.saved || []).length; }
    else if (e.op === 'mine-prs') { u.learned.prs += e.prs || 0; u.learned.prNotes += e.saved || 0; r.learned += e.saved || 0; }
    else if (e.op === 'verify') { if (e.verdict in u.verified) u.verified[e.verdict]++; }
    else if (e.op === 'feedback') u.feedback[e.useful ? 'useful' : 'notUseful']++;
    else if (e.op === 'outcome' && !e.positive) u.corrections++;
  }
  u.holdout = holdoutSummary(sessionLines, servedIn);
  const namedSessions = [...sessions.values()].filter(x => x.named);
  u.sessions = namedSessions.length;
  for (const x of namedSessions) {
    const cl = x.client || 'other';
    u.clients.sessions[cl] = (u.clients.sessions[cl] || 0) + 1;
  }
  const totalServed = u.servings.prompt + u.servings.file + u.servings.lookup;
  u.retrieval.staleRate = totalServed > 0
    ? Math.round((u.retrieval.staleServed / totalServed) * 1000) / 1000
    : 0;
  const distinct = new Set();
  for (const [key, x] of sessions) {
    // assessed before the model was recorded: the transcript, when it is still there, names it
    if (!x.model && x.session && [...x.notes.keys()].some(id => verdicts.get(key)?.get(id) === 'confirmed')) x.model = sessionModel(x.repo, x.session);
    const p = price(x.model);
    const inj = readCost(x.injected, p);
    if (inj === null) u.injected.unpricedTokens += x.injected; else { u.injected.usd += inj; u.injected.pricedTokens += x.injected; }
    for (const [id, est] of x.notes) {
      distinct.add(`${x.origin}|${id}`);
      const v = verdicts.get(key)?.get(id);
      if (v === 'confirmed') {
        u.assessed.confirmed++; u.saved.servings++; u.saved.calls += est[0] || 0; u.saved.tokens += est[1] || 0; const r = per(x.origin); r.calls += est[0] || 0; r.tokens += est[1] || 0;
        const usd = readCost(est[1] || 0, p);
        if (usd === null) { u.saved.unpricedServings++; u.saved.unpricedTokens += est[1] || 0; }
        else {
          u.saved.usd += usd; u.saved.pricedServings++;
          const m = u.saved.byModel[x.model] ||= { servings: 0, tokens: 0, usd: 0 };
          m.servings++; m.tokens += est[1] || 0; m.usd += usd;
        }
      }
      else if (v === 'contradicted') u.assessed.contradicted++;
      else if (v) u.assessed.unused++;
      else u.assessed.pending++;
    }
  }
  u.notesServed = distinct.size;
  if (!repos.size && !all) per(repoId(store.repo), store.repo);
  // notes now: in the checkout of the repository that holds the most (a worktree often has none of its own)
  const notesOf = r => Math.max(0, ...[...r.checkouts].map(c => storeOf(c).list().length));
  u.repos = [...repos.values()].map(r => ({ ...r, checkouts: [...r.checkouts], notes: notesOf(r) })).sort((a, b) => b.served - a.served || b.requests - a.requests);
  u.notes = u.repos.reduce((n, r) => n + r.notes, 0);
  u.saved.net = u.saved.tokens - u.tokensServed;
  u.spent = Math.round(u.spending.reportedCost * 100) / 100;
  // Keep the old serving-only net for consumers; expose the full token comparison separately.
  u.saved.netAfterSpend = u.saved.net - u.spending.totalTokens;
  u.saved.spendComplete = u.spending.calls > 0 && u.spending.unknownTokenCalls === 0 && u.spending.legacyRecords === 0;
  // the same balance in dollars, over what could be priced on each side
  u.spending.cost = u.spending.reportedCost + u.spending.estimatedCost;
  u.saved.netUsd = u.saved.usd - u.injected.usd - u.spending.cost;
  u.saved.pricingComplete = !u.saved.unpricedServings && !u.injected.unpricedTokens && !u.spending.unpricedCalls;
  u.unreadable = [...unreadable];
  u.top = [...count.values()].sort((a, b) => b.n - a.n).slice(0, 5).map(c => ({ id: c.id, repo: c.origin, served: c.n, title: storeOf(c.repo).get(c.id)?.title || '(removed)' }));
  return u;
}

const num = n => Math.round(n).toLocaleString('en-US');

// The holdout comparison: sessions the hooks served notes against sessions they held notes back
// from (ops.js:holdoutSession), on what each cost by its own transcript (the `session` line the
// stop hook writes: tool calls, model turns, input tokens). Sessions where nothing would have been
// served are left out of both sides; they tell nothing about the notes. Medians, since a few long
// sessions dominate a mean. With fewer than MIN_HOLDOUT sessions on a side the numbers are shown
// as too few to compare. It is a measurement of this machine's own work, not an estimate.
export const MIN_HOLDOUT = 5;
const median = xs => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
export function holdoutSummary(sessionLines, servedIn) {
  const side = () => ({ sessions: 0, toolCalls: [], inputTokens: [], turns: [] });
  const groups = { served: side(), heldOut: side() }, byModel = {};
  let noNotes = 0, unmeasured = 0;
  for (const [k, x] of servedIn) {
    const g = x.holdout ? (x.withheld ? 'heldOut' : null) : (x.served ? 'served' : null);
    if (!g) { noNotes++; continue; }
    const line = sessionLines.get(k);
    if (!line) { unmeasured++; continue; }
    const m = byModel[line.model || 'unknown'] ||= { served: side(), heldOut: side() };
    for (const t of [groups[g], m[g]]) { t.sessions++; t.toolCalls.push(line.toolCalls); t.inputTokens.push(line.inputTokens); t.turns.push(line.turns); }
  }
  const fold = t => ({ sessions: t.sessions, toolCalls: median(t.toolCalls), inputTokens: median(t.inputTokens), turns: median(t.turns) });
  const out = { served: fold(groups.served), heldOut: fold(groups.heldOut), noNotes, unmeasured, byModel: {} };
  for (const [m, g] of Object.entries(byModel)) out.byModel[m] = { served: fold(g.served), heldOut: fold(g.heldOut) };
  out.enough = out.served.sessions >= MIN_HOLDOUT && out.heldOut.sessions >= MIN_HOLDOUT;
  const delta = (a, b) => a != null && b != null && b > 0 ? Math.round((a - b) / b * 100) : null;
  out.deltaPct = { toolCalls: delta(out.served.toolCalls, out.heldOut.toolCalls), inputTokens: delta(out.served.inputTokens, out.heldOut.inputTokens) };
  return out;
}
export function renderHoldout(h) {
  if (!h || (!h.served.sessions && !h.heldOut.sessions)) return [];
  const L = ['', 'Holdout (sessions the hooks served nothing, to measure what the notes do)'];
  L.push(`  sessions        ${num(h.served.sessions)} served notes, ${num(h.heldOut.sessions)} held out with notes withheld${h.noNotes ? `; ${num(h.noNotes)} had none to serve either way` : ''}${h.unmeasured ? `; ${num(h.unmeasured)} not measured (no transcript at the end of the turn)` : ''}`);
  const pct = d => d == null ? '' : ` (${d > 0 ? '+' : ''}${d}% with notes)`;
  const v = (x, f = num) => x == null ? '?' : f(x);
  if (!h.enough) { L.push(`  too few to compare yet: at least ${MIN_HOLDOUT} sessions on each side; medians so far: tool calls ${v(h.served.toolCalls)} vs ${v(h.heldOut.toolCalls)}, input tokens ${v(h.served.inputTokens, formatTokens)} vs ${v(h.heldOut.inputTokens, formatTokens)}`); return L; }
  L.push(`  tool calls      median ${v(h.served.toolCalls)} served vs ${v(h.heldOut.toolCalls)} held out${pct(h.deltaPct.toolCalls)}`);
  L.push(`  input tokens    median ${v(h.served.inputTokens, formatTokens)} served vs ${v(h.heldOut.inputTokens, formatTokens)} held out${pct(h.deltaPct.inputTokens)}`);
  const models = Object.entries(h.byModel).filter(([, g]) => g.served.sessions && g.heldOut.sessions).sort((a, b) => (b[1].served.sessions + b[1].heldOut.sessions) - (a[1].served.sessions + a[1].heldOut.sessions));
  for (const [m, g] of models) L.push(`  ${m.padEnd(15)} ${num(g.served.sessions)} vs ${num(g.heldOut.sessions)} sessions; tool calls ${v(g.served.toolCalls)} vs ${v(g.heldOut.toolCalls)}, input tokens ${v(g.served.inputTokens, formatTokens)} vs ${v(g.heldOut.inputTokens, formatTokens)}`);
  L.push('  medians over whole sessions, by their transcripts; sessions with nothing to serve are on neither side');
  return L;
}
const usd = n => `${n < 0 ? '−' : ''}$${Math.abs(n) >= 100 ? Math.round(Math.abs(n)).toLocaleString('en-US') : Math.abs(n).toFixed(2)}`;
export function renderUsage(u, { days } = {}) {
  const machine = u.scope === 'machine';
  const where = machine ? 'on this machine' : `for ${path.isAbsolute(u.scope) ? path.basename(u.scope) : u.scope}`;
  if (!u.events) return `No usage recorded ${where}${days ? ` in the last ${days} days` : ''}. thinker records it as notes are served${machine ? '' : '; `thinker usage` without --here shows every repository'}.`;
  const L = [];
  const servings = u.servings.prompt + u.servings.file + u.servings.lookup;
  const assessed = u.assessed.confirmed + u.assessed.contradicted + u.assessed.unused;
  L.push(`thinker usage ${where}${machine ? `, ${num(u.repos.length)} ${u.repos.length === 1 ? 'repository' : 'repositories'}` : ''}, ${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}${days ? ` (last ${days} days)` : ''}`, '');
  // a checkout the store will not read (gone, moved, or a benchmark arm's symlinked notes) counts no notes
  if (u.unreadable?.length) L.push(`  (${num(u.unreadable.length)} ${u.unreadable.length === 1 ? 'checkout' : 'checkouts'} could not be read; their notes are not counted)`, '');
  L.push('Served');
  L.push(`  requests        ${num(u.requests)}, ${num(u.answered)} answered with notes${u.sessions ? `, in ${num(u.sessions)} sessions` : ''}`);
  L.push(`  notes served    ${num(servings)} (${num(u.servings.prompt)} with the request, ${num(u.servings.file)} on opening a file, ${num(u.servings.lookup)} by lookup); ${num(u.notesServed)} different notes, ${num(u.notes)} in the cache now`);
  L.push(`  tokens added    ${num(u.tokensServed)}`);
  L.push('', 'What the sessions showed');
  L.push(`  acted on        ${num(u.assessed.confirmed)}${assessed ? ` of ${num(assessed)} assessed` : ''}`);
  L.push(`  not used        ${num(u.assessed.unused)}`);
  L.push(`  contradicted    ${num(u.assessed.contradicted)} (corrected from the session)`);
  L.push(`  not assessed    ${num(u.assessed.pending)} (no session id, session not distilled yet, or learning off)`);
  if (u.corrections || u.feedback.useful || u.feedback.notUseful) L.push(`  feedback        ${num(u.feedback.useful)} useful, ${num(u.feedback.notUseful)} not useful, ${num(u.corrections)} follow-up corrections`);
  L.push('', 'Learned');
  L.push(`  sessions        ${num(u.learned.sessions)} distilled: ${num(u.learned.notes)} new notes, ${num(u.learned.merged)} merged into existing ones`);
  L.push(`  pull requests   ${num(u.learned.prs)} mined: ${num(u.learned.prNotes)} notes`);
  L.push(`  re-verified     ${num(u.verified.still_valid + u.verified.update + u.verified.invalid)} stale notes: ${num(u.verified.still_valid)} still valid, ${num(u.verified.update)} rewritten, ${num(u.verified.invalid)} retired`);
  L.push(`  model cost      $${u.spent.toFixed(2)} where the agent reported it`);
  const spending = u.spending;
  if (spending?.calls) {
    L.push('', 'Cache build and maintenance (reported usage)');
    const row = (label, s) => `  ${label.padEnd(18)} ${num(s.inputTokens)} input + ${num(s.outputTokens)} output; ${num(s.totalTokens)} total tokens; $${s.reportedCost.toFixed(3)} reported; ${num(s.calls)} records`;
    L.push(row('total', spending), '  By phase:');
    for (const [phase, s] of Object.entries(spending.byPhase)) L.push(row(phase === 'init' ? 'cache init' : phase === 'learning' ? 'ongoing learning' : phase === 'legacy' ? 'older records' : phase, s));
    L.push('  By operation (same spending):');
    for (const [purpose, s] of Object.entries(spending.byPurpose)) L.push(row('  ' + purpose, s));
    L.push(`  provider caching   ${num(spending.cacheReadTokens)} read, ${num(spending.cacheWriteTokens)} written (included in input, distinct from thinker savings)`);
    L.push(`  missing usage      ${num(spending.unknownTokenCalls)} records without complete token totals; ${num(spending.unknownCostCalls)} without dollar cost`);
    if (spending.unknownCostCalls) L.push(`  priced from tokens ${usd(spending.estimatedCost)} for the ${num(spending.unknownCostCalls - spending.unpricedCalls)} unreported records on a model with a known price (prices.js); ${num(spending.unpricedCalls)} records cannot be priced${spending.unpricedCalls ? ' (no tokens, or a model with no price: THINKER_HOME/prices.json or `prices` in .thinker/config.json)' : ''}`);
    if (spending.failed) L.push(`  failed attempts    ${num(spending.failed)} (reported spending included above)`);
    if (spending.legacyRecords) L.push('  history            older records omit tokens and setup exploration; totals are incomplete');
    if (u.distillation.runs) L.push(`  distillation yield ${num(u.distillation.noNewNotes)}/${num(u.distillation.runs)} runs added no new notes; ${num(u.distillation.noChanges)} also made no merges (may still assess existing notes)`);
    L.push('  details            --json includes provider/model and per-repository spending');
  }
  L.push(...renderHoldout(u.holdout));
  L.push('', 'Estimated saving');
  if (!u.saved.servings) L.push(`  none counted yet: only notes a session is seen to act on are counted, and none has been assessed so far`);
  else {
    L.push(`  tool calls      about ${num(u.saved.calls)} reads avoided`);
    L.push(`  tokens          about ${num(u.saved.tokens)} of file reading avoided; ${num(Math.abs(u.saved.net))} ${u.saved.net >= 0 ? 'more than' : 'less than'} the ${num(u.tokensServed)} the notes added`);
    L.push(`  basis           ${num(u.saved.servings)} servings the agent acted on: one read per file a note rests on (at most ${MAX_FILES}),`);
    L.push(`                  at the file's size (at most ${num(FILE_CAP)} tokens). Searches and re-read context are not counted. An estimate, not a measurement.`);
    const models = Object.entries(u.saved.byModel).sort((a, b) => b[1].usd - a[1].usd);
    if (models.length) {
      L.push(`  in dollars      ${usd(u.saved.usd)} at the input price of the model each session ran on: ${models.map(([m, x]) => `${usd(x.usd)} on ${m} (${num(x.servings)} servings)`).join(', ')}`);
      if (u.saved.unpricedServings) L.push(`                  ${num(u.saved.unpricedServings)} servings (${num(u.saved.unpricedTokens)} tokens) not priced: the session's model is not known or has no price`);
    } else L.push(`  in dollars      not priced: no assessed session named its model (sessions assessed before this was recorded, or an agent whose transcript does not name it)`);
  }
  if (spending?.calls) {
    L.push(`  after cache work  ${num(u.saved.netAfterSpend)} tokens = estimated reading avoided − notes added − ${num(spending.totalTokens)} reported build/maintenance tokens`);
    L.push(`                  ${u.saved.spendComplete ? 'Reported tokens only' : 'Partial accounting; unreported spending is not subtracted'}. Token balance is not dollar ROI; models and cached input have different prices.`);
    if (u.saved.pricedServings || u.injected.pricedTokens) {
      L.push(`  in dollars      ${usd(u.saved.netUsd)} = ${usd(u.saved.usd)} reading avoided − ${usd(u.injected.usd)} notes injected − ${usd(spending.cost)} model work (${usd(spending.reportedCost)} reported + ${usd(spending.estimatedCost)} priced from tokens)`);
      const gaps = [];
      if (u.saved.unpricedServings) gaps.push(`${num(u.saved.unpricedServings)} confirmed servings`);
      if (u.injected.unpricedTokens) gaps.push(`${num(u.injected.unpricedTokens)} injected tokens`);
      if (spending.unpricedCalls) gaps.push(`${num(spending.unpricedCalls)} model records`);
      L.push(`                  ${gaps.length ? `Not in this balance, for lack of a model or a price: ${gaps.join(', ')}` : 'Every side priced'}. The reading avoided is the estimate above, at input price; it leaves out that an avoided read is not re-sent on every later turn.`);
    }
  }
  if (machine) {
    const home = process.env.HOME || '';
    const name = r => home && r.startsWith(home + path.sep) ? '~' + r.slice(home.length) : r;
    const w = Math.min(48, Math.max(10, ...u.repos.map(r => name(r.repo).length)));
    L.push('', 'By repository', `  ${'repository'.padEnd(w)}  ${'notes'.padStart(6)}  ${'requests'.padStart(8)}  ${'served'.padStart(6)}  ${'learned'.padStart(7)}  ${'calls saved'.padStart(11)}  ${'tokens saved'.padStart(12)}`);
    for (const r of u.repos.slice(0, 20)) L.push(`  ${name(r.repo).slice(-w).padEnd(w)}  ${num(r.notes).padStart(6)}  ${num(r.requests).padStart(8)}  ${num(r.served).padStart(6)}  ${num(r.learned).padStart(7)}  ${num(r.calls).padStart(11)}  ${num(r.tokens).padStart(12)}`);
    if (u.repos.length > 20) L.push(`  and ${u.repos.length - 20} more`);
  }
  if (u.top.length) { L.push('', 'Most served'); for (const t of u.top) L.push(`  ${String(t.served).padStart(4)}  ${t.title.slice(0, 80)}${machine ? `  (${path.basename(t.repo)})` : ''}`); }
  return L.join('\n');
}
