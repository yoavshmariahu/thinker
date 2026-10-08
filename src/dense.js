// Dense retrieval, an experiment behind THINKER_DENSE=minilm (bench arm `hook-minilm`).
// Each note is embedded twice with a small sentence-embedding model (all-MiniLM-L6-v2, 23 MB, 384 dims):
// its question side (title, answers, phrasings) and its body side (pointers and body). A request is
// embedded once per call and scored 0.6 * cos(question) + 0.4 * cos(body). rank.js blends that with the
// lexical relevance and lets a note through the gate on cosine alone (rank.js:DENSE_FLOOR).
// Embeddings are cached by content digest under the models directory (THINKER_MODELS_DIR, default ~/.thinker/models), so staged
// copies of a noteset share one cache; `bench/dense-embed.js` fills it ahead of a run.
// The runtime (@huggingface/transformers, ONNX) is a dependency of thinker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const denseMode = () => process.env.THINKER_DENSE || '';
export const denseEnabled = () => denseMode() === 'minilm';
// Where the models live: the cross-encoder the hooks rank with (fetched by the installer, `thinker update` and
// `thinker setup`; `thinker ranker fetch` by hand) and the bi-encoder of the experiment arm.
export const modelsDir = () => process.env.THINKER_MODELS_DIR || path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'models');
const denseDir = modelsDir;
const cacheFile = () => path.join(denseDir(), 'minilm.json');

export function noteTexts(n) {
  const q = [n.title, ...(n.answers || []), ...(n.says || [])].filter(Boolean).join('. ');
  const b = ((n.deps || []).map(d => d.path + (d.symbol ? ':' + d.symbol : '')).join(' ') + '\n' + (n.body || '')).slice(0, 2000);
  return { q, b };
}
export const digest = n => { const { q, b } = noteTexts(n); return createHash('sha1').update(q + '\u0000' + b).digest('hex').slice(0, 20); };

let embedder = null;
async function loadEmbedder() {
  if (embedder) return embedder;
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = denseDir();
  embedder = await pipeline('feature-extraction', MODEL, { dtype: 'fp32' });
  return embedder;
}
export async function embed(texts) {
  if (!texts.length) return [];
  const e = await loadEmbedder();
  const out = await e(texts, { pooling: 'mean', normalize: true });
  const d = out.dims[1];
  return texts.map((_, i) => Array.from(out.data.slice(i * d, (i + 1) * d)));
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function readCache() { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); } catch { return { model: MODEL, notes: {} }; } }
function writeCache(c) { fs.mkdirSync(denseDir(), { recursive: true }); fs.writeFileSync(cacheFile(), JSON.stringify(c)); }

// Embed the notes missing from the cache (all of them on the first call). Returns how many were added.
export async function buildDenseCache(notes, { out = () => {}, batch = 16 } = {}) {
  const cache = readCache();
  const todo = notes.filter(n => !cache.notes[digest(n)]);
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    const texts = slice.map(noteTexts);
    const qv = await embed(texts.map(t => t.q)), bv = await embed(texts.map(t => t.b));
    slice.forEach((n, k) => { cache.notes[digest(n)] = { q: qv[k], b: bv[k] }; });
    out(`${Math.min(i + batch, todo.length)}/${todo.length}`);
  }
  if (todo.length) writeCache(cache);
  return todo.length;
}

// Map note id -> dense score for one request; notes not in the cache are embedded now when they are
// few (a handful of new notes), else left out (score undefined), so a hook never embeds a whole cache.
export async function denseScores(notes, query, { maxEmbedNow = 25 } = {}) {
  const cache = readCache();
  const missing = notes.filter(n => !cache.notes[digest(n)]);
  if (missing.length && missing.length <= maxEmbedNow) await buildDenseCache(missing);
  const fresh = missing.length && missing.length <= maxEmbedNow ? readCache() : cache;
  const [qv] = await embed([String(query).slice(0, 2000)]);
  const scores = new Map();
  for (const n of notes) {
    const e = fresh.notes[digest(n)];
    if (e) scores.set(n.id, 0.6 * dot(qv, e.q) + 0.4 * dot(qv, e.b));
  }
  return scores;
}

// Cross-encoder rerank, the hooks' ranking (bench arm `hook-ce`): the request and each of the top `k` lexically
// gated candidates are read together by a small cross-encoder (ms-marco-MiniLM-L-6-v2, 23 MB), which gives one
// relevance logit per pair. Candidates under the floor are dropped, the rest reordered by logit. The runtime
// (@huggingface/transformers, ONNX) is a dependency of thinker; the model is fetched into `modelsDir` at install. Measured offline on the bare request (2026-10-04, hook top 2): precision grafana-v3 0.28 → 0.41,
// posthog-v3 0.72 → 0.79, mitmproxy 0.48 → 0.73, with 6/11, 12/14 and 6/8 (from 7) tasks still hit; 40–220 ms
// a request for eight pairs. The 12-layer model separated worse; a cosine confirm on top added nothing.
export const CE_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
// Defaults chosen on 54 labeled tasks (bench/RESULTS.md, "Ranking: labels"): floor 0 and one note gave a useful
// note 94% of the time and an important one 88%, serving nothing when nothing fit; the request cut to its first
// 120 tokens kept the note text inside the 512-token pair and took tasks hit from 16 to 21 of 54 at the same
// precision. `ce` in .thinker/config.json adjusts them ({ enabled, floor, maxNotes, k, queryTokens }), the
// THINKER_CE* variables override the config, and the user chose floor 0 / one note knowing recall is the price.
// fallbackFloor: when nothing clears `floor`, the single best candidate is still served if it scores at least this
// (null: never). On the 54 labeled tasks it took tasks hit from 19 to 23 at precision 0.96 (from 1.00), and on
// posthog PR106936 it would have served the note that carried the criterion the agent missed (scored −0.93).
// Off by default since 2026-10-08: serving is held to what the cross-encoder is confident of, since no measured
// efficiency gain pays for a note below the floor (the Click canary of 2026-10-07 was costlier with the cache).
export const CE_DEFAULTS = { enabled: true, floor: 0, maxNotes: 1, k: 8, queryTokens: 120, fallbackFloor: null };
export function ceConfig(store) {
  const c = store?.config?.().ce; const cfg = { ...CE_DEFAULTS, ...(c === false ? { enabled: false } : c && typeof c === 'object' ? c : {}) };
  const e = process.env;
  if (e.THINKER_CE === 'on') cfg.enabled = true; else if (e.THINKER_CE === 'off') cfg.enabled = false;
  if (e.THINKER_CE_FLOOR !== undefined && e.THINKER_CE_FLOOR !== '') cfg.floor = Number(e.THINKER_CE_FLOOR);
  if (e.THINKER_CE_MAX) cfg.maxNotes = Number(e.THINKER_CE_MAX);
  if (e.THINKER_CE_K) cfg.k = Number(e.THINKER_CE_K);
  if (e.THINKER_CE_QUERY_TOKENS) cfg.queryTokens = Number(e.THINKER_CE_QUERY_TOKENS);
  if (e.THINKER_CE_FALLBACK !== undefined && e.THINKER_CE_FALLBACK !== '') cfg.fallbackFloor = /^(off|none|false)$/i.test(e.THINKER_CE_FALLBACK) ? null : Number(e.THINKER_CE_FALLBACK);
  if (cfg.fallbackFloor === false) cfg.fallbackFloor = null;
  return cfg;
}
export const ceEnabled = store => ceConfig(store).enabled;
let ce = null;
async function loadCe() {
  if (ce) return ce;
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
  env.cacheDir = denseDir();
  const [tok, model] = await Promise.all([AutoTokenizer.from_pretrained(CE_MODEL), AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { dtype: 'fp32' })]);
  ce = { tok, model };
  return ce;
}
// what the cross-encoder reads for a note: the search text written at phrasing time (ops.js:phraseNotes), else
// the title, first answers and the head of the body
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
