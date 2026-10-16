// Where each target note is lost on its way to the prompt hook, for the mlflow harder set and the
// understanding cache: the lexical gate and rank (src/rank.js), the cross-encoder's top k and its
// score on each of the three texts (src/dense.js), the floor, the two slots. `variant` changes one
// stage at a time; every variant is scored on the hand labels (labels.json).
//   node research/serving-understanding-2026-10/trace.mjs [variant ...] [--detail]
import fs from 'node:fs';
import path from 'node:path';
import { rank, estTokens } from '../../src/rank.js';
import { ceScores, ceText } from '../../src/dense.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const BENCH = process.env.BENCH || '/Users/yoavshmariahu/src/thinker/bench';
// PROBE_NOTES / PROBE_LABELS: another cache and its labels (bench/serving's {"set:task": {ratings: {id: {rating}}}} form too)
const NOTES = process.env.PROBE_NOTES || path.join(BENCH, 'caches/mlflow-b2-astra-understanding-200/notes');
const TASKS = JSON.parse(fs.readFileSync(path.join(BENCH, 'runs/mlflow-b2-astra-served5/tasks.json'), 'utf8')).tasks;
const LABELS = (() => {
  const raw = JSON.parse(fs.readFileSync(process.env.PROBE_LABELS || path.join(HERE, 'labels.json'), 'utf8'));
  if (!Object.values(raw).some(v => v && v.ratings)) return raw;
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.split(':').pop(), Object.fromEntries(Object.entries(v.ratings).filter(([, r]) => r.rating > 0).map(([id, r]) => [id, r.rating]))]));
})();
const notes = fs.readdirSync(NOTES).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(NOTES, f), 'utf8')));
// what the runner hands the hook (bench/codex-run.js:requestOf): the request without the bench preamble
const requestOf = p => /^Implement the following change/.test(p) ? (p.split('\n\n').slice(1).join('\n\n') || p) : p;
const label = (task, id) => Object.entries(LABELS[task] || {}).find(([k]) => id.startsWith(k))?.[1] || 0;

// the shipped serving path as the understanding arm ran it: k 8, floor 0, two notes, views multi
export const BASE = { k: 8, floor: 0, maxNotes: 2, queryTokens: 120, views: 'multi', query: r => r, gate: 'orient', textViews: null };

// another cross-encoder than the shipped one (cfg.model, a Hugging Face id with ONNX weights), loaded into
// MODELS_DIR so the product's models directory is left alone
const MODELS_DIR = process.env.PROBE_MODELS || '/Users/yoavshmariahu/.claude/jobs/8ea0abd0/tmp/models';
const loaded = new Map();
async function otherScore(model, query, text, queryTokens) {
  if (!loaded.has(model)) {
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
    env.cacheDir = MODELS_DIR;
    const [tok, m] = await Promise.all([AutoTokenizer.from_pretrained(model), AutoModelForSequenceClassification.from_pretrained(model, { dtype: process.env.PROBE_DTYPE || 'fp32' })]);
    loaded.set(model, { tok, m });
  }
  const { tok, m } = loaded.get(model);
  let q = String(query).slice(0, 4000);
  if (queryTokens > 0) { const ids = tok.encode(q, { add_special_tokens: false }); if (ids.length > queryTokens) q = tok.decode(ids.slice(0, queryTokens), { skip_special_tokens: true }); }
  const inp = tok([q], { text_pair: [ceText(text).slice(0, 1200)], padding: true, truncation: true, max_length: 512 });
  const r = await m(inp);
  return Number(r.logits.data[0]);
}
const mappedBy = new Map();
const mapped = cfg => { if (!mappedBy.has(cfg.mapNote)) mappedBy.set(cfg.mapNote, notes.map(cfg.mapNote)); return mappedBy.get(cfg.mapNote); };
const memo = new Map();
async function score(query, n, view, queryTokens, model = null) {
  const key = `${model}\u0000${queryTokens}\u0000${view}\u0000${n.id}\u0000${query}`;
  if (!memo.has(key)) {
    const text = view === 'search' ? n : view === 'inst' ? (n.searchInstances ? { ...n, search: n.searchInstances } : n)
      : view === 'answers' ? { ...n, search: (n.answers || []).join(' ') } : view === 'applies' ? { ...n, search: String(n.applies || '') }
      : view === 'title' ? { ...n, search: ' ' } : { ...n, search: String(n.body || '').slice(0, 900) };
    memo.set(key, model ? await otherScore(model, query, text, queryTokens) : (await ceScores(query, [text], { queryTokens }))[0]);
  }
  return memo.get(key);
}
const VIEWS = { search: ['search'], multi: ['search', 'inst', 'body'], inst: ['inst'], body: ['body'], 'search+inst': ['search', 'inst'],
  answers: ['answers'], applies: ['applies'], title: ['title'], 'multi+answers': ['search', 'inst', 'body', 'answers'], 'answers+applies': ['answers', 'applies'] };

export async function trace(task, cfg = BASE) {
  const request = requestOf(task.prompt);
  const q = cfg.query(request, task);
  // cfg.mapNote: a note as a variant indexes it (more of its own text on the question side, say), ranked as it is
  const pool = cfg.mapNote ? mapped(cfg) : notes;
  const rows = cfg.gate === 'all'
    ? rank(pool, { query: q, mode: 'orient', loose: true })
    : rank(pool, { query: q, mode: 'orient' });
  const ranked = rows.filter(r => r.score > 0 && (cfg.gate === 'all' || r.rel > 0 || r.aff > 0)).sort((a, b) => b.score - a.score);
  const cands = ranked.slice(0, cfg.k);
  const ceQuery = cfg.ceQuery ? cfg.ceQuery(request, task) : q;
  const scored = [];
  for (const r of cands) {
    const per = {};
    for (const v of VIEWS[cfg.views]) per[v] = await score(ceQuery, r.note, v, cfg.queryTokens, cfg.model);
    scored.push({ id: r.note.id, kind: r.note.kind, ce: Math.max(...Object.values(per)), per, lexRank: ranked.indexOf(r) + 1 });
  }
  let served = scored.filter(s => s.ce >= cfg.floor).sort((a, b) => b.ce - a.ce);
  if (cfg.prefer) served = cfg.prefer(served);
  served = served.slice(0, cfg.maxNotes);
  // where each labelled note stands
  const targets = Object.keys(LABELS[task.id] || {}).filter(k => !k.startsWith('_')).map(k => {
    const n = notes.find(x => x.id.startsWith(k));
    const lexIdx = ranked.findIndex(r => r.note.id === n.id);
    const row = rows.find(r => r.note.id === n.id);
    const s = scored.find(x => x.id === n.id);
    const stage = served.some(x => x.id === n.id) ? 'served' : lexIdx < 0 ? 'gate' : lexIdx >= cfg.k ? `lexical rank ${lexIdx + 1}` : s.ce < cfg.floor ? `ce ${s.ce.toFixed(1)} < floor` : 'outranked';
    return { id: n.id, rating: label(task.id, n.id), stage, lexRank: lexIdx < 0 ? null : lexIdx + 1, matched: row?.matched, cover: row && Number(row.cover.toFixed(2)), ce: s?.ce, per: s?.per };
  });
  return { task: task.id, served: served.map(s => ({ id: s.id, rating: label(task.id, s.id), ce: s.ce, lexRank: s.lexRank })), targets, candidates: scored.length };
}

// The score of a configuration over the labelled tasks: tasks served a 2, tasks served something useful,
// precision of what was served, and tasks served nothing.
export async function evaluate(cfg, tasks = TASKS.filter(t => LABELS[t.id])) {
  const out = [];
  for (const t of tasks) out.push(await trace(t, cfg));
  const servedN = out.reduce((s, o) => s + o.served.length, 0);
  return {
    out,
    hit2: out.filter(o => o.served.some(s => s.rating === 2)).length,
    has2: out.filter(o => o.targets.some(x => x.rating === 2)).length,
    useful: out.filter(o => o.served.some(s => s.rating >= 1)).length,
    precision: servedN ? out.reduce((s, o) => s + o.served.filter(x => x.rating >= 1).length, 0) / servedN : null,
    empty: out.filter(o => !o.served.length).length,
    tasks: out.length,
  };
}

export const show = (name, r) => console.log(`${name.padEnd(28)} rated-2 served ${r.hit2}/${r.has2} · useful served ${r.useful}/${r.tasks} · precision ${r.precision?.toFixed(2)} · nothing served ${r.empty}`);

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const r = await evaluate(BASE);
  show('shipped (multi, k8, floor 0)', r);
  if (process.argv.includes('--detail')) for (const o of r.out) {
    console.log(`\n${o.task}  served: ${o.served.map(s => `${s.id.slice(0, 34)}(${s.rating}, ce ${s.ce.toFixed(1)}, lex ${s.lexRank})`).join(' | ') || '—'}`);
    for (const x of o.targets) console.log(`   target ${x.rating} ${x.id.slice(0, 40).padEnd(41)} ${x.stage.padEnd(16)} lex ${x.lexRank ?? '-'} matched ${x.matched} cover ${x.cover}${x.per ? ' ce ' + Object.entries(x.per).map(([v, s]) => `${v} ${s.toFixed(1)}`).join(' ') : ''}`);
  }
}
