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
import os from 'node:os';
import path from 'node:path';
import { isTestMode } from './test-mode.js';
import { emptySpend, addSpend, formatTokens } from './model-usage.js';
export { formatTokens };
import { estTokens } from './rank.js';
import { Store, logFile, adoptLocalLog, repoId } from './store.js';
import { sessionModel } from './transcripts.js';

const FILE_CAP = 6000;   // tokens one read of a large file returns (about 2000 lines)
const MAX_FILES = 5;
// Wall clock of one avoided read: the model turn that issues it and takes in the result.
// research/bench-history/RESULTS.md measured 2 to 4.5 seconds of wall clock per tool call (click: 15 s over
// 3.4 calls; PostHog: 1.1 min less over 31.6 fewer calls), so this too is an estimate.
export const SECONDS_PER_READ = 4;

// Deps that are not code a session would have read: the agents' own configuration, git's
// internals, thinker's own state, and build or run output. Every note must anchor to an
// existing file (ops.js:createNote), so a note about the permission classifier or about
// duplicate hooks anchors to .claude/settings.local.json for want of anywhere better. Nobody
// learns those rules by reading that file: what such a note saves is a wrong action, not a
// read. This estimate only counts reading, so it counts them as nothing rather than crediting
// a read no session would have made. The notes keep their anchors and are served as before.
const NOT_READING = /^(\.claude|\.codex|\.cursor|\.gemini|\.pi|\.windsurf|\.devin|\.opencode|\.vscode|\.idea|\.git|\.thinker|node_modules|dist|coverage)\/|^\.github\/(hooks|instructions)\/|^\.mcp\.json$|^bench\/runs\/|\.log$/;
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
    if (['claude', 'codex', 'cursor', 'gemini', 'copilot', 'windsurf', 'opencode', 'pi', 'mcp', 'cli'].includes(c)) return c;
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
    // how often a `still_valid` verdict was wrong, as far as the log can tell: the note was contradicted,
    // corrected or reported not useful before its next verification (flaggedAfterPass), or it was
    // passed while such a report stood since its last one (passedWhileFlagged)
    verifyChecks: { flaggedAfterPass: 0, passedWhileFlagged: 0 },
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
      // requests served nothing, by why (ops.js:EMPTY_REASONS; `unrecorded` for requests logged before the reasons were), and how many of
      // them were a prompt of three words or fewer ("what", "ok go"), which no cache answers
      emptyReasons: {},
      emptyShortPrompts: 0,
    },
    saved: { calls: 0, tokens: 0, servings: 0, byModel: {} },
    holdout: null,
    repos: [], top: [],
  };
  // a repository is its origin; its checkouts (clones, worktrees) are counted together
  const repos = new Map();      // origin → its line in the summary
  const per = (origin, checkout) => { if (!repos.has(origin)) repos.set(origin, { repo: origin, checkouts: new Set(), requests: 0, served: 0, learned: 0, calls: 0, tokens: 0, spending: emptySpend() }); const r = repos.get(origin); if (checkout) r.checkouts.add(checkout); return r; };
  const sessions = new Map();   // origin|session → { origin, named, client, model, injected, notes: Map(note id → [calls, tokens]) }
  const verdicts = new Map();   // origin|session → Map(note id → verdict)
  const count = new Map();
  const lastVerify = new Map(); // origin|note id → { verdict, flagged, counted } since its last verification
  const flag = (origin, id) => {
    const k = `${origin}|${id}`, v = lastVerify.get(k) || { verdict: null, flagged: false, counted: false };
    if (v.verdict === 'still_valid' && !v.counted) { u.verifyChecks.flaggedAfterPass++; v.counted = true; }
    v.flagged = true; lastVerify.set(k, v);
  };
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
    if (!e.dry && !e.metered && ((e.op === 'model' && e.purpose === 'distill') || e.op === 'distill')) addSpend(d.spending, e);
    if (!e.metered && (e.op === 'model' || ['distill', 'mine-prs', 'verify', 'phrase', 'route'].includes(e.op))) {
      const purpose = e.purpose || e.op, phase = e.phase || 'legacy';
      const model = `${e.provider || 'unknown'}/${e.model || 'unknown'}`;
      addSpend(u.spending, e); addSpend(r.spending, e);
      for (const [group, key] of [['byPurpose', purpose], ['byPhase', phase], ['byModel', model]]) {
        u.spending[group][key] ||= emptySpend();
        addSpend(u.spending[group][key], e);
      }
      if (e.op !== 'model') u.spending.legacyRecords++;
    }
    if (e.op === 'distill') {
      u.distillation.runs++;
      if (!(e.saved || []).length) u.distillation.noNewNotes++;
      if (!(e.saved || []).length && !(e.merged || []).length) u.distillation.noChanges++;
    }
    if (e.op === 'session') continue;   // what a session cost: read by holdoutOf
    if (e.op === 'orient' || e.op === 'late' || e.op === 'lookup') {
      const cl = normalizeClient(e.client, e.session);
      const ids = e.served || [];
      if (e.op !== 'late') {
        u.requests++;
        r.requests++;
        u.clients.active[cl] = (u.clients.active[cl] || 0) + 1;
        if (ids.length) u.answered++;
        else {
          const why = typeof e.empty === 'string' ? e.empty : e.empty === true ? 'too-few-notes' : e.holdout ? 'held-out' : 'unrecorded';
          u.retrieval.emptyReasons[why] = (u.retrieval.emptyReasons[why] || 0) + 1;
          if (e.op === 'orient' && String(e.task || '').trim().split(/\s+/).filter(Boolean).length <= 3) u.retrieval.emptyShortPrompts++;
        }
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
      for (const a of e.applied || []) { verdicts.get(key).set(a.id, a.verdict); if (a.verdict === 'contradicted') flag(e.origin, a.id); }
      // the model the session ran on; the servings were logged before the assessment named it
      if (e.model && sessions.has(key)) sessions.get(key).model = e.model;
    } else if (e.op === 'distill') { for (const id of e.contradicted || []) flag(e.origin, id); u.learned.sessions++; u.learned.notes += (e.saved || []).length; u.learned.merged += (e.merged || []).length; r.learned += (e.saved || []).length; }
    else if (e.op === 'mine-prs') { u.learned.prs += e.prs || 0; u.learned.prNotes += e.saved || 0; r.learned += e.saved || 0; }
    else if (e.op === 'verify') {
      if (e.verdict in u.verified) u.verified[e.verdict]++;
      const k = `${e.origin}|${e.id}`;
      if (e.verdict === 'still_valid' && lastVerify.get(k)?.flagged) u.verifyChecks.passedWhileFlagged++;
      lastVerify.set(k, { verdict: e.verdict, flagged: false, counted: false });
    }
    else if (e.op === 'feedback') { u.feedback[e.useful ? 'useful' : 'notUseful']++; if (!e.useful || e.corrected) flag(e.origin, e.id); }
    else if (e.op === 'outcome' && !e.positive) u.corrections++;
  }
  u.holdout = holdoutOf(events);
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
    for (const [id, est] of x.notes) {
      distinct.add(`${x.origin}|${id}`);
      const v = verdicts.get(key)?.get(id);
      if (v === 'confirmed') {
        u.assessed.confirmed++; u.saved.servings++; u.saved.calls += est[0] || 0; u.saved.tokens += est[1] || 0; const r = per(x.origin); r.calls += est[0] || 0; r.tokens += est[1] || 0;
        // by the model the session ran on, where the assessment or its transcript named it
        const m = u.saved.byModel[x.model || 'unknown'] ||= { servings: 0, tokens: 0 };
        m.servings++; m.tokens += est[1] || 0;
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
  // Keep the old serving-only net for consumers; expose the full token comparison separately.
  u.saved.netAfterSpend = u.saved.net - u.spending.totalTokens;
  u.saved.spendComplete = u.spending.calls > 0 && u.spending.unknownTokenCalls === 0 && u.spending.legacyRecords === 0;
  u.unreadable = [...unreadable];
  u.top = [...count.values()].sort((a, b) => b.n - a.n).slice(0, 5).map(c => ({ id: c.id, repo: c.origin, served: c.n, title: storeOf(c.repo).get(c.id)?.title || '(removed)' }));
  return u;
}

const num = n => Math.round(n).toLocaleString('en-US');

// The holdout comparison: turns served notes (by the hooks, or by the agent's own orient and lookup)
// against turns the notes were held back from (ops.js:beginTurn), on what each turn cost by the
// session's transcript. The stop hook writes a
// `session` line after every turn with the session's cost so far and the turn's number; a turn's
// cost is its line minus the line of the turn before (turn 1: from nothing). A turn is measured
// only when both lines exist: a stop hook that did not run (an interrupted turn, no transcript)
// leaves that turn and the next unmeasured rather than charging two turns to one. Turns where
// nothing would have been served are on neither side; they tell nothing about the notes.
// The statistic is the cost per turn as a ratio of sums (the side's summed cost over its measured
// turns): a median per turn lands on the one-line follow-ups that cost the same either way, and
// sums pool across machines where medians cannot (telemetry.js:holdoutMetrics sends `sums` and
// `measured`). `saved` is what the served turns would have cost at the held-out rate, minus what
// they did: (held-out per turn − served per turn) × served turns. A turn followed by a
// correction-shaped prompt (ops.js:looksLikeCorrection, the `outcome` line carries its turn) is
// counted per side, since fewer corrections is a saving per-turn costs cannot see. With fewer
// than MIN_HOLDOUT turns on a side the numbers are shown as too few to compare. It is a
// measurement of this machine's own work, not an estimate.
export const MIN_HOLDOUT = 20;
const HOLDOUT_FIELDS = ['toolCalls', 'turns', 'inputTokens', 'outputTokens'];
// The comparison over a set of log events: summarize's window, or telemetry's own 30 days.
export function holdoutOf(events) {
  const lines = new Map();   // origin|session → turn → the last `session` line written after it
  const turns = new Map();   // origin|session → turn → { served, withheld, holdout, corrected }
  const at = (m, k) => { if (!m.has(k)) m.set(k, new Map()); return m.get(k); };
  for (const e of events) {
    if (!e.session || e.session === 'unknown' || !(e.turn >= 1)) continue;
    const k = `${e.origin}|${sessionKey(e.session)}`;
    if (e.op === 'session') at(lines, k).set(e.turn, e);
    else if (e.op === 'orient' || e.op === 'late' || e.op === 'lookup') {
      const t = at(turns, k), x = t.get(e.turn) || { served: 0, withheld: 0, holdout: false, corrected: false };
      if (e.holdout) { x.holdout = true; x.withheld += (e.withheld || []).length; } else x.served += (e.served || []).length;
      t.set(e.turn, x);
    } else if (e.op === 'outcome' && !e.positive) {
      const t = at(turns, k), x = t.get(e.turn);
      if (x) x.corrected = true;
    }
  }
  return holdoutSummary(lines, turns);
}
export function holdoutSummary(lines, turns) {
  const side = () => ({ prompts: 0, sessions: new Set(), corrected: 0, toolCalls: [], turns: [], inputTokens: [], outputTokens: [] });
  const groups = { served: side(), heldOut: side() }, byModel = {}, byClientModel = {};
  let noNotes = 0, unmeasured = 0;
  for (const [k, ts] of turns) {
    const ls = lines.get(k) || new Map();
    for (const [n, x] of ts) {
      const g = x.holdout ? (x.withheld ? 'heldOut' : null) : (x.served ? 'served' : null);
      if (!g) { noNotes++; continue; }
      const cur = ls.get(n), prev = n === 1 ? {} : ls.get(n - 1);
      if (!cur || !prev) { unmeasured++; continue; }
      const m = byModel[cur.model || 'unknown'] ||= { served: side(), heldOut: side() };
      // harness and model together: the cache can help one agent on a model and not another
      const cm = byClientModel[`${normalizeClient(cur.client, cur.session)}|${cur.model || 'unknown'}`] ||= { served: side(), heldOut: side() };
      for (const t of [groups[g], m[g], cm[g]]) {
        t.prompts++; t.sessions.add(k); if (x.corrected) t.corrected++;
        for (const f of HOLDOUT_FIELDS) {
          const a = cur[f], b = n === 1 ? 0 : prev[f];
          t[f].push(Number.isFinite(a) && Number.isFinite(b) && a >= b ? a - b : null);
        }
      }
    }
  }
  const total = (t, f) => Object.fromEntries(HOLDOUT_FIELDS.map(k => [k, f(t[k].filter(Number.isFinite))]));
  const fold = t => {
    const sums = total(t, a => a.reduce((n, x) => n + x, 0)), measured = total(t, a => a.length);
    const perPrompt = Object.fromEntries(HOLDOUT_FIELDS.map(f => [f, measured[f] ? sums[f] / measured[f] : null]));
    return { prompts: t.prompts, sessions: t.sessions.size, corrected: t.corrected, sums, measured, perPrompt };
  };
  const out = { served: fold(groups.served), heldOut: fold(groups.heldOut), sessions: new Set([...groups.served.sessions, ...groups.heldOut.sessions]).size, noNotes, unmeasured, byModel: {}, byClientModel: {} };
  for (const [m, g] of Object.entries(byModel)) out.byModel[m] = { served: fold(g.served), heldOut: fold(g.heldOut) };
  for (const [m, g] of Object.entries(byClientModel)) out.byClientModel[m] = { served: fold(g.served), heldOut: fold(g.heldOut) };
  out.enough = out.served.prompts >= MIN_HOLDOUT && out.heldOut.prompts >= MIN_HOLDOUT;
  const delta = (a, b) => a != null && b != null && b > 0 ? Math.round((a - b) / b * 100) : null;
  out.deltaPct = { toolCalls: delta(out.served.perPrompt.toolCalls, out.heldOut.perPrompt.toolCalls), inputTokens: delta(out.served.perPrompt.inputTokens, out.heldOut.perPrompt.inputTokens) };
  // what the served turns would have cost at the held-out rate, less what they cost
  const saved = f => out.served.perPrompt[f] != null && out.heldOut.perPrompt[f] != null ? Math.round((out.heldOut.perPrompt[f] - out.served.perPrompt[f]) * out.served.measured[f]) : null;
  out.saved = { toolCalls: saved('toolCalls'), inputTokens: saved('inputTokens') };
  return out;
}
export function renderHoldout(h) {
  if (!h || (!h.served.prompts && !h.heldOut.prompts)) return [];
  const L = ['', 'Holdout (prompts the hooks served nothing, to measure what the notes do)'];
  L.push(`  prompts         ${num(h.served.prompts)} served notes, ${num(h.heldOut.prompts)} held out with notes withheld, in ${num(h.sessions)} sessions${h.noNotes ? `; ${num(h.noNotes)} had none to serve either way` : ''}${h.unmeasured ? `; ${num(h.unmeasured)} not measured (no transcript at the end of the turn)` : ''}`);
  const pct = d => d == null ? '' : ` (${d > 0 ? '+' : ''}${d}% with notes)`;
  const v = (x, f = num) => x == null ? '?' : f(x);
  const one = x => x == null ? '?' : (Math.round(x * 10) / 10).toLocaleString('en-US');
  if (!h.enough) { L.push(`  too few to compare yet: at least ${MIN_HOLDOUT} prompts on each side; per prompt so far: tool calls ${one(h.served.perPrompt.toolCalls)} vs ${one(h.heldOut.perPrompt.toolCalls)}, input tokens ${v(h.served.perPrompt.inputTokens, formatTokens)} vs ${v(h.heldOut.perPrompt.inputTokens, formatTokens)}`); return L; }
  L.push(`  tool calls      ${one(h.served.perPrompt.toolCalls)} per prompt served vs ${one(h.heldOut.perPrompt.toolCalls)} held out${pct(h.deltaPct.toolCalls)}`);
  L.push(`  input tokens    ${v(h.served.perPrompt.inputTokens, formatTokens)} per prompt served vs ${v(h.heldOut.perPrompt.inputTokens, formatTokens)} held out${pct(h.deltaPct.inputTokens)}`);
  if (h.saved.inputTokens != null) L.push(`  saved           about ${formatTokens(Math.abs(h.saved.inputTokens))} input tokens ${h.saved.inputTokens >= 0 ? 'less' : 'more'} across the ${num(h.served.measured.inputTokens)} served prompts than at the held-out cost per prompt`);
  const rate = s => s.prompts ? `${Math.round(100 * s.corrected / s.prompts)}%` : '?';
  L.push(`  corrections     ${rate(h.served)} of served prompts were followed by a correction, ${rate(h.heldOut)} of held-out`);
  const models = Object.entries(h.byModel).filter(([, g]) => g.served.prompts && g.heldOut.prompts).sort((a, b) => (b[1].served.prompts + b[1].heldOut.prompts) - (a[1].served.prompts + a[1].heldOut.prompts));
  for (const [m, g] of models) L.push(`  ${m.padEnd(15)} ${num(g.served.prompts)} vs ${num(g.heldOut.prompts)} prompts; tool calls ${one(g.served.perPrompt.toolCalls)} vs ${one(g.heldOut.perPrompt.toolCalls)}, input tokens ${v(g.served.perPrompt.inputTokens, formatTokens)} vs ${v(g.heldOut.perPrompt.inputTokens, formatTokens)}`);
  L.push('  per prompt: a turn\'s cost by its transcript, summed over the side and divided by its measured prompts; prompts with nothing to serve are on neither side');
  return L;
}

// Once a week, at the first stop of the week, the stop hook tells the user what the notes saved:
// the holdout comparison over the last 30 days of the machine's log, every repository (the user
// is the unit, and a week of one person's work rarely clears the floor). One line, in tokens:
// the saving, the two costs per prompt and the counts behind it, so it can be checked at a
// glance; a negative saving reads "more" with the same numbers. Nothing under the floor: a
// line about not having a number yet is noise every week. The week last reported is a marker
// under thinker's home, so one line serves every repository and agent on the machine; it is
// written only when a line was shown, so the first week past the floor is reported as soon as
// it is reached. Shown where the stop hook can speak to the user (clients.js:stopOutput).
export const WEEKLY_WINDOW_DAYS = 30;
export function weeklyLine(h) {
  if (!h?.enough || h.saved?.inputTokens == null) return '';
  const s = h.saved.inputTokens, a = h.served.perPrompt, b = h.heldOut.perPrompt, d = h.deltaPct.inputTokens;
  const calls = a.toolCalls != null && b.toolCalls != null ? `; tool calls ${Math.round(a.toolCalls)} vs ${Math.round(b.toolCalls)}` : '';
  return `🧠 thinker, last ${WEEKLY_WINDOW_DAYS} days: about ${formatTokens(Math.abs(s))} ${s >= 0 ? 'fewer' : 'more'} input tokens across ${num(h.served.measured.inputTokens)} prompts with notes (${formatTokens(a.inputTokens)} per prompt vs ${formatTokens(b.inputTokens)} on ${num(h.heldOut.measured.inputTokens)} held out${d != null ? `, ${d > 0 ? '+' : ''}${d}%` : ''}${calls}).`;
}
// The ISO week of a local date, as 2026-W42.
export function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  const y = x.getUTCFullYear();
  return `${y}-W${String(Math.ceil(((x - Date.UTC(y, 0, 1)) / 86400_000 + 1) / 7)).padStart(2, '0')}`;
}
// the suite must not write under the developer's home unless it names a THINKER_HOME of its own
const weeklyHome = () => isTestMode() && !process.env.THINKER_HOME ? null : process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
export function weeklyNotice(store, { now = Date.now(), home = weeklyHome() } = {}) {
  if (!home) return '';
  const week = isoWeek(new Date(now)), marker = path.join(home, 'state', 'weekly-notice.json');
  try { if (JSON.parse(fs.readFileSync(marker, 'utf8')).week === week) return ''; } catch {}
  const since = new Date(now - WEEKLY_WINDOW_DAYS * 86400_000).toISOString();
  let line = '';
  try { line = weeklyLine(holdoutOf(readLog(store, { all: true }).filter(e => e.t >= since))); } catch { return ''; }
  if (!line) return '';
  try { fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, JSON.stringify({ week, t: new Date(now).toISOString() })); } catch {}
  return line;
}
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
  if (u.verifyChecks.flaggedAfterPass || u.verifyChecks.passedWhileFlagged) L.push(`  doubted passes  ${num(u.verifyChecks.flaggedAfterPass)} passed notes later contradicted or corrected; ${num(u.verifyChecks.passedWhileFlagged)} passed while a contradiction stood`);
  const spending = u.spending;
  if (spending?.calls) {
    L.push('', 'Cache build and maintenance (reported usage)');
    const row = (label, s) => `  ${label.padEnd(18)} ${num(s.inputTokens)} input + ${num(s.outputTokens)} output; ${num(s.totalTokens)} total tokens; ${num(s.calls)} records`;
    L.push(row('total', spending));
    L.push('  By phase:');
    for (const [phase, s] of Object.entries(spending.byPhase)) L.push(row(phase === 'init' ? 'cache init' : phase === 'learning' ? 'ongoing learning' : phase === 'legacy' ? 'older records' : phase, s));
    L.push('  By operation (same spending):');
    for (const [purpose, s] of Object.entries(spending.byPurpose)) L.push(row('  ' + purpose, s));
    L.push(`  provider caching   ${num(spending.cacheReadTokens)} read, ${num(spending.cacheWriteTokens)} written (included in input, distinct from thinker savings)`);
    if (spending.unknownTokenCalls) L.push(`  missing usage      ${num(spending.unknownTokenCalls)} records without complete token totals`);
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
    const models = Object.entries(u.saved.byModel).filter(([m]) => m !== 'unknown').sort((a, b) => b[1].tokens - a[1].tokens);
    if (models.length) L.push(`  by model        ${models.map(([m, x]) => `${num(x.tokens)} tokens on ${m} (${num(x.servings)} servings)`).join(', ')}${u.saved.byModel.unknown ? `; ${num(u.saved.byModel.unknown.servings)} servings in sessions that named no model` : ''}`);
  }
  if (spending?.calls) {
    L.push(`  after cache work  ${num(u.saved.netAfterSpend)} tokens = estimated reading avoided − notes added − ${num(spending.totalTokens)} reported build/maintenance tokens`);
    L.push(`                  ${u.saved.spendComplete ? 'Reported tokens only' : 'Partial accounting; unreported spending is not subtracted'}. Tokens of different models, and cached input, are counted alike;`);
    L.push(`                  an avoided read is also not re-sent on every later turn, which this leaves out.`);
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
