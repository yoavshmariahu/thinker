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
import { estTokens } from './rank.js';
import { Store, logFile, adoptLocalLog, repoId } from './store.js';

const FILE_CAP = 6000;   // tokens one read of a large file returns (about 2000 lines)
const MAX_FILES = 5;

export function savingOf(repo, note) {
  let calls = 0, tokens = 0;
  for (const f of [...new Set((note?.deps || []).map(d => d.path).filter(Boolean))].slice(0, MAX_FILES)) {
    try { const st = fs.statSync(path.join(repo, f)); if (!st.isFile()) continue; calls++; tokens += Math.min(Math.ceil(st.size / 3.6), FILE_CAP); } catch {}
  }
  return { calls, tokens };
}

export function cacheHitSavings(repo, notes) {
  let calls = 0, tokens = 0;
  const seenFiles = new Set();
  for (const n of notes || []) {
    for (const f of [...new Set((n?.deps || []).map(d => d.path).filter(Boolean))].slice(0, MAX_FILES)) {
      if (seenFiles.has(f)) continue;
      seenFiles.add(f);
      try {
        const st = fs.statSync(path.join(repo, f));
        if (!st.isFile()) continue;
        calls++;
        tokens += Math.min(Math.ceil(st.size / 3.6), FILE_CAP);
      } catch {}
    }
  }
  if (!tokens && notes?.length) {
    tokens = notes.reduce((sum, n) => sum + Math.max(Math.ceil((n.body || '').length / 3.6) * 4, 300), 0);
  }
  return { calls, tokens };
}

export function formatTokens(n) {
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(n)}`;
}

export const PUNCHLINES = [
  'your context window thanks you! 🚀',
  'cache to the rescue! 🪄',
  'earlier sessions doing the heavy lifting 🏋️',
  'bypassed the file-hunting grind ✨',
  'smooth sailing ahead ⛵',
  'fast-forward engaged ⏩',
];

export function cacheHitNotice(repo, notes, { style = 'compact', seed = 0 } = {}) {
  const hits = (notes || []).length;
  if (!hits) return '';
  const { tokens } = cacheHitSavings(repo, notes);
  const hitStr = hits === 1 ? 'cache hit' : 'cache hits';
  const tokStr = formatTokens(tokens);
  if (style === 'creative') {
    let hash = 0;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
    const punchline = PUNCHLINES[hash % PUNCHLINES.length];
    const tokPart = tokens > 0 ? `Saved ~${tokStr} tokens` : 'Saved exploration tokens';
    return `✨ thinker: ${hits} ${hitStr}! ${tokPart} — ${punchline}`;
  }
  const tokPart = tokens > 0 ? ` (~${tokStr} tokens saved)` : '';
  return `🧠 thinker: ${hits} ${hitStr}${tokPart}`;
}


// One form for a session's id wherever it was written: as the agent gave it, as the name of
// the trace recorded for it, or (in older assessments) as the name of its transcript file.
export function sessionKey(s) {
  s = String(s ?? '').replace(/\.jsonl?$/, '').replace(/^trace-/, '');
  const codex = s.match(/^rollout-.*?([0-9a-f]{8}-[0-9a-f-]{27,})$/);
  return (codex ? codex[1] : s).replace(/[^\w.-]/g, '_');
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
  const stores = new Map([[store.repo, store]]);
  const storeOf = repo => { if (!stores.has(repo)) stores.set(repo, new Store(repo)); return stores.get(repo); };
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
    spent: 0, saved: { calls: 0, tokens: 0, servings: 0 }, repos: [], top: [],
  };
  // a repository is its origin; its checkouts (clones, worktrees) are counted together
  const repos = new Map();      // origin → its line in the summary
  const per = (origin, checkout) => { if (!repos.has(origin)) repos.set(origin, { repo: origin, checkouts: new Set(), requests: 0, served: 0, learned: 0, calls: 0, tokens: 0, spending: emptySpend() }); const r = repos.get(origin); if (checkout) r.checkouts.add(checkout); return r; };
  const sessions = new Map();   // origin|session → { origin, notes: Map(note id → [calls, tokens]) }
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
    if (e.op === 'orient' || e.op === 'late' || e.op === 'lookup') {
      const ids = e.served || [];
      if (e.op !== 'late') { u.requests++; r.requests++; if (ids.length) u.answered++; }
      if (!ids.length) continue;
      u.servings[e.op === 'orient' ? 'prompt' : e.op === 'late' ? 'file' : 'lookup'] += ids.length; r.served += ids.length;
      // lines written before the estimate was recorded: the note's text and files as they are now
      u.tokensServed += typeof e.tokens === 'number' ? e.tokens : ids.reduce((n, id) => n + estTokens(s.get(id)?.body || ''), 0);
      const named = e.session && e.session !== 'unknown';
      const key = `${e.origin}|${named ? sessionKey(e.session) : `?${anon++}`}`;
      if (!sessions.has(key)) sessions.set(key, { origin: e.origin, named, notes: new Map() });
      ids.forEach((id, i) => {
        const k = `${e.origin}|${id}`; count.set(k, { origin: e.origin, repo: e.repo, id, n: (count.get(k)?.n || 0) + 1 });
        if (!sessions.get(key).notes.has(id)) sessions.get(key).notes.set(id, e.est?.[i] || Object.values(savingOf(e.repo, s.get(id))));
      });
    } else if (e.op === 'attest') {
      const key = `${e.origin}|${sessionKey(e.session)}`;
      if (!verdicts.has(key)) verdicts.set(key, new Map());
      for (const a of e.applied || []) verdicts.get(key).set(a.id, a.verdict);
    } else if (e.op === 'distill') { u.learned.sessions++; u.learned.notes += (e.saved || []).length; u.learned.merged += (e.merged || []).length; r.learned += (e.saved || []).length; }
    else if (e.op === 'mine-prs') { u.learned.prs += e.prs || 0; u.learned.prNotes += e.saved || 0; r.learned += e.saved || 0; }
    else if (e.op === 'verify') { if (e.verdict in u.verified) u.verified[e.verdict]++; }
    else if (e.op === 'feedback') u.feedback[e.useful ? 'useful' : 'notUseful']++;
    else if (e.op === 'outcome' && !e.positive) u.corrections++;
  }
  u.sessions = [...sessions.values()].filter(x => x.named).length;
  const distinct = new Set();
  for (const [key, x] of sessions) for (const [id, est] of x.notes) {
    distinct.add(`${x.origin}|${id}`);
    const v = verdicts.get(key)?.get(id);
    if (v === 'confirmed') { u.assessed.confirmed++; u.saved.servings++; u.saved.calls += est[0] || 0; u.saved.tokens += est[1] || 0; const r = per(x.origin); r.calls += est[0] || 0; r.tokens += est[1] || 0; }
    else if (v === 'contradicted') u.assessed.contradicted++;
    else if (v) u.assessed.unused++;
    else u.assessed.pending++;
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
  u.top = [...count.values()].sort((a, b) => b.n - a.n).slice(0, 5).map(c => ({ id: c.id, repo: c.origin, served: c.n, title: storeOf(c.repo).get(c.id)?.title || '(removed)' }));
  return u;
}

const num = n => Math.round(n).toLocaleString('en-US');
export function renderUsage(u, { days } = {}) {
  const machine = u.scope === 'machine';
  const where = machine ? 'on this machine' : `for ${path.isAbsolute(u.scope) ? path.basename(u.scope) : u.scope}`;
  if (!u.events) return `No usage recorded ${where}${days ? ` in the last ${days} days` : ''}. thinker records it as notes are served${machine ? '' : '; `thinker usage` without --here shows every repository'}.`;
  const L = [];
  const servings = u.servings.prompt + u.servings.file + u.servings.lookup;
  const assessed = u.assessed.confirmed + u.assessed.contradicted + u.assessed.unused;
  L.push(`thinker usage ${where}${machine ? `, ${num(u.repos.length)} ${u.repos.length === 1 ? 'repository' : 'repositories'}` : ''}, ${u.from.slice(0, 10)} to ${u.to.slice(0, 10)}${days ? ` (last ${days} days)` : ''}`, '');
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
    if (spending.failed) L.push(`  failed attempts    ${num(spending.failed)} (reported spending included above)`);
    if (spending.legacyRecords) L.push('  history            older records omit tokens and setup exploration; totals are incomplete');
    if (u.distillation.runs) L.push(`  distillation yield ${num(u.distillation.noNewNotes)}/${num(u.distillation.runs)} runs added no new notes; ${num(u.distillation.noChanges)} also made no merges (may still assess existing notes)`);
    L.push('  details            --json includes provider/model and per-repository spending');
  }
  L.push('', 'Estimated saving');
  if (!u.saved.servings) L.push(`  none counted yet: only notes a session is seen to act on are counted, and none has been assessed so far`);
  else {
    L.push(`  tool calls      about ${num(u.saved.calls)} reads avoided`);
    L.push(`  tokens          about ${num(u.saved.tokens)} of file reading avoided; ${num(Math.abs(u.saved.net))} ${u.saved.net >= 0 ? 'more than' : 'less than'} the ${num(u.tokensServed)} the notes added`);
    L.push(`  basis           ${num(u.saved.servings)} servings the agent acted on: one read per file a note rests on (at most ${MAX_FILES}),`);
    L.push(`                  at the file's size (at most ${num(FILE_CAP)} tokens). Searches and re-read context are not counted. An estimate, not a measurement.`);
  }
  if (spending?.calls) {
    L.push(`  after cache work  ${num(u.saved.netAfterSpend)} tokens = estimated reading avoided − notes added − ${num(spending.totalTokens)} reported build/maintenance tokens`);
    L.push(`                  ${u.saved.spendComplete ? 'Reported tokens only' : 'Partial accounting; unreported spending is not subtracted'}. Token balance is not dollar ROI; models and cached input have different prices.`);
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
