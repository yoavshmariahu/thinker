// Read-only diagnostic of existing local logs, not a benchmark or a savings measurement.
// Usage: THINKER_TEST=1 node research/cache-hit-sizing/audit.mjs REPO LOG UNTIL_ISO [DAYS]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sessionKey, savingOf, MAX_FILES, countsAsReading } from '../../src/usage.js';

if (process.env.THINKER_TEST !== '1') throw new Error('Run with THINKER_TEST=1');
const [repoArg, log, until, days = '30'] = process.argv.slice(2);
if (!repoArg || !log || !Number.isFinite(Date.parse(until)) || !(Number(days) > 0)) throw new Error('Expected REPO LOG UNTIL_ISO [DAYS]');
const repo = path.resolve(repoArg), end = Date.parse(until), start = end - Number(days) * 864e5;
const raw = fs.readFileSync(log, 'utf8');
const all = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// Explicit checkout selects its logged origin, then includes that origin's other worktrees.
const origins = new Set(all.filter(e => e.repo === repo && e.origin).map(e => e.origin));
if (origins.size !== 1) throw new Error('Expected exactly one logged origin for REPO');
const origin = [...origins][0];
const events = all.filter(e => e.origin === origin && Date.parse(e.t) >= start && Date.parse(e.t) < end).sort((a, b) => a.t.localeCompare(b.t));
const describe = a => {
  const xs = a.filter(Number.isFinite).sort((a, b) => a - b), n = xs.length;
  return { n, sum: xs.reduce((s, x) => s + x, 0), mean: n ? xs.reduce((s, x) => s + x, 0) / n : null,
    median: n ? (xs[Math.floor((n - 1) / 2)] + xs[Math.floor(n / 2)]) / 2 : null };
};
const notes = new Map();
for (const dir of ['.thinker/notes', '.thinker/local/notes']) {
  const folder = path.join(repo, dir);
  if (!fs.existsSync(folder)) continue;
  for (const f of fs.readdirSync(folder).filter(f => f.endsWith('.json')).sort()) {
    const n = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')); notes.set(n.id, n);
  }
}
const sessions = new Map(), verdicts = new Map(), allEst = [];
for (const e of events) {
  const key = sessionKey(e.session);
  if (e.op === 'attest') {
    if (!verdicts.has(key)) verdicts.set(key, new Map());
    for (const a of e.applied || []) verdicts.get(key).set(a.id, a.verdict);
  }
  if (!['orient', 'lookup', 'late'].includes(e.op)) continue;
  for (const est of e.est || []) if (est[1] > 0) allEst.push(est[1]);
  if (!key || key === 'unknown') continue;
  if (!sessions.has(key)) sessions.set(key, new Map());
  (e.served || []).forEach((id, i) => { if (!sessions.get(key).has(id)) sessions.get(key).set(id, { id, est: e.est?.[i], t: e.t }); });
}
const confirmed = [], pending = [], sources = {}, matched = [];
for (const [session, ns] of sessions) for (const r of ns.values()) {
  const v = verdicts.get(session)?.get(r.id);
  if (!v) pending.push(r);
  if (v !== 'confirmed') continue;
  const n = notes.get(r.id), source = n?.source?.type || 'missing-current-note';
  sources[source] = (sources[source] || 0) + 1;
  confirmed.push({ ...r, session, note: n });
  // Only provenance preceding the serving; never infer a historical note from later learning.
  const d = events.filter(e => e.op === 'distill' && e.t < r.t && [...(e.saved || []), ...(e.merged || [])].includes(r.id)).at(-1);
  if (d && d.traceChars > 0) matched.push({ r, d, tokens: d.traceChars / 3.6 / ((d.saved || []).length + (d.merged || []).length) });
}
const distills = events.filter(e => e.op === 'distill' && e.traceChars > 0);
const yielding = distills.filter(e => (e.saved || []).length + (e.merged || []).length > 0);
const modes = {};
for (const e of distills) {
  const mode = e.learningMode || 'unrecorded';
  const r = modes[mode] ||= { calls: 0, near12000Chars: 0 };
  r.calls++; if (e.traceChars >= 11000 && e.traceChars <= 12000) r.near12000Chars++;
}
// Current files are a separate diagnostic, never a replacement for logged historical estimates.
let currentSum = 0, currentUnion = 0, overlapSessions = 0;
for (const sid of new Set(confirmed.map(x => x.session))) {
  const ns = confirmed.filter(x => x.session === sid && x.note).map(x => x.note);
  const paths = ns.flatMap(n => [...new Set((n.deps || []).map(d => d.path).filter(Boolean))].slice(0, MAX_FILES)).filter(countsAsReading);
  if (new Set(paths).size < paths.length) overlapSessions++;
  currentSum += ns.reduce((a, n) => a + savingOf(repo, n).tokens, 0);
  for (const p of new Set(paths)) currentUnion += savingOf(repo, { deps: [{ path: p }] }).tokens;
}
// Read already-kept estimates without refreshing them or writing any production state.
const cacheFile = path.join(repo, '.thinker/state/tool-outputs.json');
const cacheRaw = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : '{}';
const cache = JSON.parse(cacheRaw);
const readers = new Set(['Read', 'Bash:sed', 'Bash:cat', 'Bash:head', 'Bash:tail', 'Bash:grep', 'Bash:rg', 'Grep', 'Glob']);
const cohort = ids => {
  const groups = {};
  for (const [id, r] of Object.entries(cache)) {
    if (r.v !== 13 || r.mtime < start || r.mtime >= end || (ids && !ids.has(sessionKey(id)))) continue;
    const g = groups[r.model || 'unknown'] ||= { sessions: 0, calls: 0, rawTokens: 0, modeledCarriedTokens: 0 };
    g.sessions++;
    for (const [k, x] of Object.entries(r.by || {})) if (readers.has(k.replace(/@(moderate|high)$/, ''))) {
      g.calls += x.calls; g.rawTokens += x.tokens; g.modeledCarriedTokens += x.input;
    }
  }
  for (const g of Object.values(groups)) {
    g.meanResultTokens = g.calls ? g.rawTokens / g.calls : null;
    g.modeledCarry = g.rawTokens ? g.modeledCarriedTokens / g.rawTokens : null;
  }
  return groups;
};
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const productSourceSha256 = Object.fromEntries(['usage.js', 'tool-outputs.js', 'distill.js', 'learning-evidence.js'].map(f => [f, hash(fs.readFileSync(new URL('../../src/' + f, import.meta.url)))]));
console.log(JSON.stringify({ origin, since: new Date(start).toISOString(), until, productSourceSha256,
  logSha256: hash(raw), toolCacheSha256: hash(cacheRaw), notesSha256: hash(JSON.stringify([...notes])),
  allPositiveServingEstimates: describe(allEst), namedDistinctSessionNotes: [...sessions.values()].reduce((a, n) => a + n.size, 0),
  pendingSessionNotes: pending.length, confirmedSessionNotes: confirmed.length,
  confirmedMissingLoggedEstimate: confirmed.filter(x => !x.est).length,
  confirmedLoggedTokens: describe(confirmed.filter(x => x.est).map(x => x.est[1])),
  confirmedLoggedFiles: describe(confirmed.filter(x => x.est).map(x => x.est[0])), sources,
  distillation: { calls: distills.length, yieldingCalls: yielding.length, modes,
    traceSharePerYieldingCall: describe(yielding.map(e => e.traceChars / 3.6 / ((e.saved || []).length + (e.merged || []).length))),
    confirmedWithEarlierDistillation: matched.length, matchedTraceShare: describe(matched.map(x => x.tokens)),
    matchedLoggedEstimate: describe(matched.filter(x => x.r.est).map(x => x.r.est[1])) },
  currentFileOverlapDiagnostic: { overlapSessions, perNoteTokens: currentSum, unionTokensPerSession: currentUnion },
  allCachedSessionsByModel: cohort(null), confirmedCachedSessionsByModel: cohort(new Set(confirmed.map(x => x.session))),
}, null, 2));
