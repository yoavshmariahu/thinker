// The cross-encoder the harness recall ranks with (harness.js:recallCard): the request and each of the top `k`
// lexically gated candidates are read together by a small cross-encoder (ms-marco-MiniLM-L-6-v2, 23 MB), which
// gives one relevance logit per pair; candidates under the floor are dropped, the rest reordered by logit. The
// runtime (@huggingface/transformers, ONNX) is a dependency of thinker; the model is fetched into `modelsDir` at
// install (`thinker ranker fetch` by hand). Until 2026-11-08 this also ranked the knowledge notes; the dense
// bi-encoder experiment and the note-specific views went with them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where the models live
export const modelsDir = () => process.env.THINKER_MODELS_DIR || path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'models');

export const CE_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
// Defaults chosen on 54 labeled tasks (research/bench-history/RESULTS.md, "Ranking: labels"): floor 0 and the
// request cut to its first 120 tokens, so the candidate text stays inside the 512-token pair.
export const CE_DEFAULTS = { floor: 0, maxNotes: 2, k: 8, queryTokens: 120, fallbackFloor: null };
// `work` within `ms`: { value } when it settles in time, { timedOut: true } when it does not. The work is not
// stopped (an ONNX inference in flight cannot be), only no longer waited for: a hook that got this answer writes
// its output and exits (commands/hooks.js), which ends the inference with the process.
export function withDeadline(work, ms) {
  if (!(ms > 0)) return Promise.resolve({ timedOut: true });
  if (!Number.isFinite(ms)) return Promise.resolve(work).then(value => ({ value }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    Promise.resolve(work).then(value => { clearTimeout(timer); resolve({ value }); }, e => { clearTimeout(timer); reject(e); });
  });
}
let ce = null;
async function loadCe() {
  if (ce) return ce;
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
  env.cacheDir = modelsDir();
  const [tok, model] = await Promise.all([AutoTokenizer.from_pretrained(CE_MODEL), AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { dtype: 'fp32' })]);
  ce = { tok, model };
  return ce;
}
// Is the ranker usable here: the runtime resolves, the model files are in the models directory.
export async function rankerStatus() {
  const dir = path.join(modelsDir(), ...CE_MODEL.split('/'));
  const model = fs.existsSync(path.join(dir, 'onnx', 'model.onnx')) && fs.existsSync(path.join(dir, 'tokenizer.json'));
  let runtime = true, error = null;
  try { await import('@huggingface/transformers'); } catch (e) { runtime = false; error = String(e.message).split('\n')[0].slice(0, 160); }
  return { runtime, model, dir: modelsDir(), modelName: CE_MODEL, error };
}
// Fetch the model (a few seconds, ~23 MB) and load it once, so the first hook does not pay the download.
export async function fetchRanker() {
  await loadCe();
  return rankerStatus();
}
// what the cross-encoder reads for a candidate: its search text, else its title, first answers and the head of its body
export const ceText = n => n.search ? `${n.title}. ${n.search}` : `${n.title}. ${(n.answers || []).slice(0, 3).join(' ')} ${(n.body || '').slice(0, 500)}`;
export async function ceScores(query, notes, { queryTokens = CE_DEFAULTS.queryTokens } = {}) {
  const { tok, model } = await loadCe();
  // the request cut to its first tokens: a long request would otherwise push the note text out of the pair
  let q = String(query).slice(0, 2000);
  if (queryTokens > 0) { const ids = tok.encode(q, { add_special_tokens: false }); if (ids.length > queryTokens) q = tok.decode(ids.slice(0, queryTokens), { skip_special_tokens: true }); }
  const out = [];
  for (const n of notes) {
    const inp = tok([q], { text_pair: [ceText(n).slice(0, 1200)], padding: true, truncation: true, max_length: 512 });
    const r = await model(inp);
    out.push(Number(r.logits.data[0]));
  }
  return out;
}
// ranked: rank.js rows. Returns the rows the cross-encoder keeps, best first, each with `ce`.
export async function ceRerank(ranked, query, { k = CE_DEFAULTS.k, floor = CE_DEFAULTS.floor, maxNotes = CE_DEFAULTS.maxNotes, queryTokens = CE_DEFAULTS.queryTokens, fallbackFloor = CE_DEFAULTS.fallbackFloor } = {}) {
  const cands = ranked.slice(0, k);
  if (!cands.length) return cands;
  const sc = await ceScores(query, cands.map(r => r.note), { queryTokens });
  return selectByScore(cands.map((r, i) => ({ ...r, ce: sc[i] })), { floor, maxNotes, fallbackFloor });
}
// The selection alone (testable without the model): those at or above the floor, best first, at most maxNotes;
// none there, the single best if it reaches fallbackFloor, marked `fallback`.
export function selectByScore(scored, { floor = CE_DEFAULTS.floor, maxNotes = CE_DEFAULTS.maxNotes, fallbackFloor = CE_DEFAULTS.fallbackFloor } = {}) {
  const kept = scored.filter(r => r.ce >= floor).sort((a, b) => b.ce - a.ce).slice(0, maxNotes > 0 ? maxNotes : undefined);
  if (kept.length || fallbackFloor == null || !scored.length) return kept;
  const best = scored.reduce((a, b) => (b.ce > a.ce ? b : a));
  return best.ce >= fallbackFloor ? [{ ...best, fallback: true }] : [];
}
