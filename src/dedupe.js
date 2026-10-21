// Notes that say the same thing in different words. saveNotes merges a new note into an existing
// one only when their title and answers share half their words (distill.js), so a fact mined from a
// pull request and the same fact saved from a session 43 minutes later stayed two notes (0.30 by that
// measure), took both of a turn's serving slots and counted one file's read once between them.
//
// A maintenance pass (maintain.js; on by default at the owner's decision on 2026-10-19, an exception
// to the rule that a change to what the cache holds waits for an experiment, AGENTS.md) finds such
// pairs cheaply and has a model settle each one:
// 1. Candidates, free: each note embedded locally (dense.js:embed, all-MiniLM-L6-v2) from its title
//    and search text; a pair is a candidate when the two rest on a file in common and their cosine
//    is at least `threshold`. On this repository's 337 notes on 2026-10-18 this took 4 seconds and
//    gave 21 pairs, 17 of them the same claim or two claims about one thing that disagree.
// 2. A judge, one model call a pair (llm.js:complete, the verify model; through the session in a
//    desktop app): `same` and `conflict` are merged into the older note, a conflict settled by the
//    current code of the files both rest on, the other archived as its duplicate; `distinct` is
//    remembered and not asked again until either note's text changes.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { complete } from './llm.js';
import { tokensOf } from './model-usage.js';
import { hashDep, symbolText } from './deps.js';
import { dropShadowedFileDeps } from './ops.js';
import { gitHead } from './store.js';

export const DEDUPE_DEFAULTS = { threshold: 0.75, perRun: 3 };

// The pass runs where maintenance's config says `dedupe: true` (off by default since 2026-10-21); THINKER_DEDUPE=on|off overrides the config.
export function dedupeOn(cfg, env = process.env) {
  if (/^(off|0|false)$/i.test(env.THINKER_DEDUPE || '')) return false;
  return /^(on|1|true)$/i.test(env.THINKER_DEDUPE || '') || cfg.dedupe === true;
}

const eligible = n => !n.archived && n.status !== 'invalid' && n.status !== 'broken' && n.kind !== 'skill' && n.kind !== 'behavior';
export const embedText = n => `${n.title}. ${n.search || (n.answers || []).join('. ')}`;
const textKey = n => createHash('sha1').update(embedText(n) + '\u0000' + (n.body || '')).digest('hex').slice(0, 16);
const pairKey = (a, b) => [a.id, b.id].sort().join('|');
const pairText = (a, b) => [a, b].sort((x, y) => x.id.localeCompare(y.id)).map(textKey).join(':');
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const filesOf = n => new Set((n.deps || []).map(d => d.path));

const stateFile = store => path.join(store.dir, 'state', 'dedupe.json');
function readState(store) { try { return JSON.parse(fs.readFileSync(stateFile(store), 'utf8')); } catch { return { vectors: {}, judged: {} }; } }
function writeState(store, s) { fs.mkdirSync(path.dirname(stateFile(store)), { recursive: true }); fs.writeFileSync(stateFile(store), JSON.stringify(s)); }

// Candidate pairs, most similar first: a file in common and a cosine of at least `threshold`, leaving
// out pairs already judged distinct for their present text. Vectors are kept by text, so a run
// embeds only the notes that are new or changed.
export async function duplicateCandidates(store, { threshold = DEDUPE_DEFAULTS.threshold, embedFn, state = readState(store) } = {}) {
  const notes = store.list().filter(eligible);
  const vectors = {};
  const need = notes.filter(n => !(state.vectors[n.id]?.key === textKey(n)));
  const embed = embedFn || (await import('./dense.js')).embed;
  for (let k = 0; k < need.length; k += 32) {
    const batch = need.slice(k, k + 32);
    const out = await embed(batch.map(embedText));
    batch.forEach((n, i) => { state.vectors[n.id] = { key: textKey(n), v: out[i] }; });
  }
  for (const n of notes) vectors[n.id] = state.vectors[n.id].v;
  for (const id of Object.keys(state.vectors)) if (!vectors[id]) delete state.vectors[id];
  const files = new Map(notes.map(n => [n.id, filesOf(n)]));
  const pairs = [];
  for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) {
    const a = notes[i], b = notes[j];
    if (![...files.get(a.id)].some(f => files.get(b.id).has(f))) continue;
    const cos = dot(vectors[a.id], vectors[b.id]);
    if (cos < threshold) continue;
    if (state.judged[pairKey(a, b)] === pairText(a, b)) continue;
    pairs.push({ a, b, cos });
  }
  return pairs.sort((x, y) => y.cos - x.cos);
}

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['same', 'conflict', 'distinct'] },
    reason: { type: 'string', description: 'one sentence' },
    title: { type: 'string', description: 'same or conflict: the merged note\'s title' },
    body: { type: 'string', description: 'same or conflict: the merged body, 3-12 lines with path:Symbol pointers, keeping every true claim of both and, for a conflict, only the claim the current code bears out' },
  },
  required: ['verdict', 'reason'],
};
const JUDGE_SYSTEM = 'You compare two cached notes about one codebase that rest on a file in common. Answer same when they state the same fact, rule or path (the wording may differ); conflict when they are about the same thing but claim different things; distinct when each says something the other does not need (related is not the same). For same or conflict, write the one note that replaces both: every true claim of either, nothing twice, as short as the longer note, with path:Symbol pointers; for a conflict keep only what the current code shown bears out. Answer with the JSON alone.';

const MAX_CODE = 30000;
// One model call: the two notes and the current code of the files they share.
export async function judgePair(store, a, b, { model, completeFn = complete } = {}) {
  const shared = (a.deps || []).filter(d => filesOf(b).has(d.path));
  const code = [...new Map([...shared, ...(b.deps || []).filter(d => filesOf(a).has(d.path))].map(d => [`${d.path}|${d.symbol || ''}`, d])).values()]
    .map(d => `--- ${d.path}${d.symbol ? ' :: ' + d.symbol : ''} ---\n${symbolText(store.repo, d, 120) ?? '(missing)'}`).join('\n\n').slice(0, MAX_CODE);
  const show = (tag, n) => `NOTE ${tag} (kind=${n.kind}) "${n.title}"\n${n.body}`;
  const prompt = `${show('A', a)}\n\n${show('B', b)}\n\nCURRENT CODE OF THE FILES BOTH REST ON:\n${code || '(none)'}`;
  const res = await completeFn({ system: JUDGE_SYSTEM, prompt, model: model || store.config().verifyModel || 'haiku', accounting: { store, purpose: 'dedupe' }, schema: JUDGE_SCHEMA, maxTokens: 1500 });
  return { ...(res.json || {}), tokens: tokensOf(res), cost: res.cost };
}

// Fold `drop` into `keep` (the older note keeps its id, servings and assessments): the judge's title
// and body, both notes' answers and deps; `drop` is archived as its duplicate (reversible with
// `thinker archive --restore`).
export function mergeNotes(store, keep, drop, { title, body, reason, verdict }) {
  const now = new Date().toISOString();
  const deps = dropShadowedFileDeps([...new Map([...(keep.deps || []), ...(drop.deps || [])].map(d => [`${d.path}|${d.symbol || ''}`, d])).values()]
    .map(d => { try { return hashDep(store.repo, d); } catch { return d; } }).filter(d => !d.missing));
  const merged = {
    ...keep, title: title?.trim() || keep.title, body: body.trim(), deps,
    answers: [...new Set([...(keep.answers || []), ...(drop.answers || [])])],
    status: 'fresh', verified: now, verifiedCommit: gitHead(store.repo),
    history: [...(keep.history || []), { at: now, reason: `${verdict === 'conflict' ? 'settled a conflict with' : 'merged'} ${drop.id}: ${reason || ''}`.trim(), prevBody: keep.body }].slice(-5),
  };
  delete merged.stale; delete merged.says; delete merged.search; delete merged.saysFor; // phrased again for the new text
  store.put(merged);
  store.put({ ...drop, archived: { at: now, reason: `duplicate of ${keep.id}` } });
  return merged;
}

const older = (a, b) => (Date.parse(a.created || '') || Infinity) <= (Date.parse(b.created || '') || Infinity) ? [a, b] : [b, a];

// One maintenance run of the pass: up to `perRun` candidates judged, the merges made. `afford` stops
// it at the daily cap; `dry` lists the candidates and calls nothing.
export async function dedupeNotes(store, { perRun = DEDUPE_DEFAULTS.perRun, threshold = DEDUPE_DEFAULTS.threshold, dry = false, afford = () => true, embedFn, judgeFn = judgePair } = {}) {
  const r = { candidates: 0, judged: 0, merged: [], distinct: 0, tokens: 0, errors: 0 };
  const state = readState(store);
  const pairs = await duplicateCandidates(store, { threshold, embedFn, state });
  r.candidates = pairs.length;
  const gone = new Set();
  for (const { a, b, cos } of pairs) {
    if (r.judged >= perRun) break;
    if (gone.has(a.id) || gone.has(b.id)) continue; // a note merged this run is judged again next run, with its new text
    if (!afford()) { r.capped = true; break; }
    if (dry) { r.judged++; continue; }
    try {
      const v = await judgeFn(store, a, b);
      r.judged++; r.tokens += v.tokens || 0;
      if ((v.verdict === 'same' || v.verdict === 'conflict') && v.body?.trim()) {
        const [keep, drop] = older(a, b);
        mergeNotes(store, keep, drop, v);
        gone.add(keep.id); gone.add(drop.id);
        r.merged.push({ keep: keep.id, drop: drop.id, verdict: v.verdict });
        store.log({ op: 'dedupe', keep: keep.id, drop: drop.id, verdict: v.verdict, cos: +cos.toFixed(3), cost: v.cost, metered: true });
      } else {
        state.judged[pairKey(a, b)] = pairText(a, b);
        r.distinct++;
        store.log({ op: 'dedupe', a: a.id, b: b.id, verdict: v.verdict || 'distinct', cos: +cos.toFixed(3), cost: v.cost, metered: true });
      }
    } catch { r.errors++; }
  }
  if (!dry) writeState(store, state);
  return r;
}
