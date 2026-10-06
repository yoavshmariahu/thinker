// Jev (TypeSafe System One) as the serving reranker: one batched call scores every gated candidate
// against the request, and the selection happens in code. Opt-in; without a key the cross-encoder
// (dense.js) serves as before, so nothing here is required to run thinker.
//
// Measured on all 54 labelled ranking tasks, two runs (judge gpt-6-sol, the labels in
// bench/runs/ranking-lab-2026-10-04), against the cross-encoder default on the same 54:
//   two notes, floor 0.5: 0.96 of served notes useful, 40 of 70 important notes reached, 33 of 54 tasks
//   the cross-encoder default:  0.96 useful, 16 of 70 important notes reached, 23 of 54 tasks
// so 2.5x the important notes at the same precision, and neither serves anything on a task where no
// useful note exists. Both runs were identical on this arm. ~160 ms and ~10k tokens a prompt.
import fs from 'fs';
import os from 'os';
import path from 'path';

export const JEV_ENDPOINT = process.env.THINKER_JEV_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULTS = { enabled: 'auto', floor: 0.5, maxNotes: 2, k: 8, model: 'jev-latest', timeoutMs: 4000 };

export const thinkerHome = () => process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
// The key never goes in .thinker/config.json: that file is part of the repository. It lives in the
// machine's thinker home, readable by its owner alone, or in the environment.
export const keyFile = () => path.join(thinkerHome(), 'jev-key');

export function jevKey() {
  const e = process.env;
  const fromEnv = e.THINKER_JEV_KEY || e.JEV_API_KEY || e.TYPESAFE_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try { const k = fs.readFileSync(keyFile(), 'utf8').trim(); return k || null; } catch { return null; }
}

export function saveKey(key) {
  const dir = thinkerHome();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile(), String(key).trim() + '\n', { mode: 0o600 });
  try { fs.chmodSync(keyFile(), 0o600); } catch {}
  return keyFile();
}

export function forgetKey() { try { fs.unlinkSync(keyFile()); return true; } catch { return false; } }

// `enabled: 'auto'` (the default) means: on when a key is present, off otherwise. true forces it on and
// an absent key then surfaces as a jev-error and the cross-encoder serves; false turns it off outright.
export function jevConfig(store) {
  const c = store?.config?.().jev;
  const cfg = { ...JEV_DEFAULTS, ...(c === false ? { enabled: false } : c && typeof c === 'object' ? c : {}) };
  const e = process.env;
  if (e.THINKER_JEV === 'on') cfg.enabled = true; else if (e.THINKER_JEV === 'off') cfg.enabled = false;
  if (e.THINKER_JEV_FLOOR !== undefined && e.THINKER_JEV_FLOOR !== '') cfg.floor = Number(e.THINKER_JEV_FLOOR);
  if (e.THINKER_JEV_MAX) cfg.maxNotes = Number(e.THINKER_JEV_MAX);
  if (e.THINKER_JEV_K) cfg.k = Number(e.THINKER_JEV_K);
  if (e.THINKER_JEV_MODEL) cfg.model = e.THINKER_JEV_MODEL;
  if (e.THINKER_JEV_TIMEOUT) cfg.timeoutMs = Number(e.THINKER_JEV_TIMEOUT);
  cfg.key = cfg.key || jevKey();
  // A developer's key must never switch Jev on inside the test suite: a test run contacts no service
  // (AGENTS.md, "No telemetry from tests or benchmarks"), and before this guard `npm test` made live
  // calls and changed what orient served on any machine that had a key. An explicit `enabled: true`
  // or THINKER_JEV=on still wins, for a deliberate integration test.
  if (cfg.enabled === 'auto') cfg.enabled = !!cfg.key && !process.env.THINKER_TEST;
  return cfg;
}
export const jevEnabled = store => !!jevConfig(store).enabled;
export const jevReady = store => { const c = jevConfig(store); return !!(c.enabled && c.key); };

// Jev reads named fields, not prose: a note goes over as a record whose parts it can be pointed at by name.
// Measured against one prose blob of the same note: same recall, false positives 8 -> 5.
export function noteRecord(n, i) {
  return {
    index: i,
    kind: n.kind,
    title: n.title,
    answers_the_questions: (n.answers || []).slice(0, 5),
    claim: (n.body || '').split('\n').filter(Boolean).slice(0, 6).join(' ').slice(0, 900),
    code_it_points_at: (n.deps || []).map(d => (d.symbol ? `${d.path}:${d.symbol}` : d.path)).slice(0, 6),
    freshness: n.status === 'stale' ? 'stale' : 'fresh',
  };
}

export const RELEVANCE_CRITERIA = {
  true: 'The note states something the developer must know or do to carry out this specific request: where to make the change, a rule the change must respect, or the command to run.',
  false: 'The note is about a neighbouring topic. It may share words with the request but does not bear on carrying it out.',
};

// `subject` names the thing the notes are judged against in the state, and `question` writes the
// per-note instruction. Serving judges notes against a request; review judges them against a change
// (review.js:narrowRelated). Everything else is shared.
export function buildRequest(query, notes, { model = JEV_DEFAULTS.model, subject = 'developer_request', criteria = RELEVANCE_CRITERIA, question = null } = {}) {
  const ask = question || (i => ({
    request: query,
    question: `Would the note at \`candidate_notes[${i}]\` help a developer carry out \`request\`? Weigh its \`claim\` and \`answers_the_questions\`; \`code_it_points_at\` tells you which code it governs.`,
  }));
  const questions = {};
  notes.forEach((n, i) => { questions[`rel${i}`] = { type: 'noul', instructions: ask(i), criteria }; });
  return { model, state: { [subject]: query, candidate_notes: notes.map(noteRecord) }, questions };
}

// One probability per candidate, in the order given. Throws on any transport or API failure so the
// caller falls back to the cross-encoder; a hook must never fail because a network call did.
export async function jevScores(query, notes, cfg = {}) {
  const { key = jevKey(), model = JEV_DEFAULTS.model, timeoutMs = JEV_DEFAULTS.timeoutMs, fetchImpl = fetch, subject, criteria, question } = cfg;
  if (!key) throw new Error('no jev key');
  if (!notes.length) return [];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildRequest(query, notes, { model, subject, criteria, question })),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`jev ${res.status}`);
    const j = await res.json();
    if (!j || !j.answers) throw new Error('jev: no answers');
    return notes.map((_, i) => {
      const a = j.answers[`rel${i}`];
      if (!a || typeof a.noul !== 'number') throw new Error(`jev: missing rel${i}`);
      return a.noul;
    });
  } finally { clearTimeout(timer); }
}

// Those at or above the floor, best first, at most maxNotes. Unlike the cross-encoder there is no
// fallback below the floor: a Noul near 0 is the model saying the note does not bear on the request,
// and on the labelled tasks serving nothing was right on every task that had nothing useful.
export function selectByJev(scored, { floor = JEV_DEFAULTS.floor, maxNotes = JEV_DEFAULTS.maxNotes } = {}) {
  return scored.filter(r => r.jev >= floor).sort((a, b) => b.jev - a.jev).slice(0, maxNotes > 0 ? maxNotes : undefined);
}

// `onScores` sees every candidate's score, selected or not. Serving logs the best few through it: with the
// selection alone a turn that served nothing is indistinguishable from one where the best note just missed
// the floor, and the floor cannot be tuned from that.
export async function jevRerank(ranked, query, cfg = {}) {
  const { k = JEV_DEFAULTS.k, floor = JEV_DEFAULTS.floor, maxNotes = JEV_DEFAULTS.maxNotes, onScores } = cfg;
  const cands = ranked.slice(0, k);
  if (!cands.length) return cands;
  const sc = await jevScores(query, cands.map(r => r.note), cfg);
  const scored = cands.map((r, i) => ({ ...r, jev: sc[i] }));
  if (onScores) onScores(scored);
  return selectByJev(scored, { floor, maxNotes });
}

// What `thinker ranker` and setup report.
export function jevStatus(store) {
  const cfg = jevConfig(store);
  return { enabled: !!cfg.enabled, key: !!cfg.key, source: process.env.THINKER_JEV_KEY || process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY ? 'environment' : cfg.key ? keyFile() : null, model: cfg.model, floor: cfg.floor, maxNotes: cfg.maxNotes };
}
