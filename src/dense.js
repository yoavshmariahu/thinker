// Dense retrieval, an experiment behind THINKER_DENSE=minilm (bench arm `hook-minilm`).
// Each note is embedded twice with a small sentence-embedding model (all-MiniLM-L6-v2, 23 MB, 384 dims):
// its question side (title, answers, phrasings) and its body side (pointers and body). A request is
// embedded once per call and scored 0.6 * cos(question) + 0.4 * cos(body). rank.js blends that with the
// lexical relevance and lets a note through the gate on cosine alone (rank.js:DENSE_FLOOR).
// Embeddings are cached by content digest in THINKER_DENSE_DIR (default ~/.thinker/dense), so staged
// copies of a noteset share one cache; `bench/dense-embed.js` fills it ahead of a run.
// The runtime (@huggingface/transformers, ONNX) is not a dependency of thinker: it is required lazily
// and must be installed beside this checkout for the arm to work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MODEL = 'Xenova/all-MiniLM-L6-v2';
export const denseMode = () => process.env.THINKER_DENSE || '';
export const denseEnabled = () => denseMode() === 'minilm';
const denseDir = () => process.env.THINKER_DENSE_DIR || path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'dense');
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

// Cross-encoder rerank, an experiment behind THINKER_CE=on (bench arm `hook-ce`): the request and each of the
// top CE_K lexically gated candidates are read together by a small cross-encoder (ms-marco-MiniLM-L-6-v2,
// 23 MB), which gives one relevance logit per pair. Candidates under CE_FLOOR are dropped, the rest reordered
// by logit. Measured offline on the bare request (2026-10-04, hook top 2): precision grafana-v3 0.28 → 0.41,
// posthog-v3 0.72 → 0.79, mitmproxy 0.48 → 0.73, with 6/11, 12/14 and 6/8 (from 7) tasks still hit; 40–220 ms
// a request for eight pairs. The 12-layer model separated worse; a cosine confirm on top added nothing.
export const CE_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2';
export const CE_K = Number(process.env.THINKER_CE_K) || 8;
export const CE_FLOOR = process.env.THINKER_CE_FLOOR !== undefined ? Number(process.env.THINKER_CE_FLOOR) : -3;
export const ceEnabled = () => process.env.THINKER_CE === 'on';
let ce = null;
async function loadCe() {
  if (ce) return ce;
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
  env.cacheDir = denseDir();
  const [tok, model] = await Promise.all([AutoTokenizer.from_pretrained(CE_MODEL), AutoModelForSequenceClassification.from_pretrained(CE_MODEL, { dtype: 'fp32' })]);
  ce = { tok, model };
  return ce;
}
export const ceText = n => `${n.title}. ${(n.answers || []).slice(0, 3).join(' ')} ${(n.body || '').slice(0, 500)}`;
export async function ceScores(query, notes) {
  const { tok, model } = await loadCe();
  const out = [];
  for (const n of notes) {
    const inp = tok([String(query).slice(0, 1500)], { text_pair: [ceText(n).slice(0, 1200)], padding: true, truncation: true, max_length: 512 });
    const r = await model(inp);
    out.push(Number(r.logits.data[0]));
  }
  return out;
}
// ranked: rank.js rows. Returns the rows the cross-encoder keeps, best first, each with `ce`.
export async function ceRerank(ranked, query, { k = CE_K, floor = CE_FLOOR } = {}) {
  const cands = ranked.slice(0, k);
  if (!cands.length) return cands;
  const sc = await ceScores(query, cands.map(r => r.note));
  return cands.map((r, i) => ({ ...r, ce: sc[i] })).filter(r => r.ce >= floor).sort((a, b) => b.ce - a.ce);
}
