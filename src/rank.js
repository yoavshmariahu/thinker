// Retrieval: BM25 over note text + path affinity + kind/confidence priors,
// then greedy packing into a token budget.
import path from 'node:path';

const STOP = new Set('the a an and or of to in on for with is are be by as at from this that it its into how what where when which do does can should we you i'.split(' '));

export function tokenize(s) {
  const out = [];
  for (const raw of String(s).split(/[^A-Za-z0-9_./-]+/)) {
    if (!raw) continue;
    // split paths, snake_case, camelCase
    for (const part of raw.split(/[/._-]+/)) {
      for (const w of part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')) {
        const t = stem(w.toLowerCase());
        if (t.length > 1 && !STOP.has(t)) out.push(t);
      }
    }
  }
  return out;
}

function stem(w) {
  if (w.length <= 4) return w;
  for (const suf of ['ations', 'ation', 'ings', 'ing', 'ies', 'ed', 'es', 's', 'er']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  }
  return w;
}

function qText(n) { return [n.title, (n.answers || []).join(' '), (n.tags || []).join(' ')].join(' '); }
function bText(n) { return [(n.deps || []).map(d => `${d.path} ${d.symbol || ''}`).join(' '), n.body].join(' '); }

function index(notes, textOf) {
  const docs = notes.map(n => {
    const toks = tokenize(textOf(n));
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { note: n, tf, len: toks.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((s, d) => s + d.len, 0) / (docs.length || 1);
  return { docs, df, avg, N: docs.length };
}

export function buildIndex(notes) { return { q: index(notes, qText), b: index(notes, bText) }; }

export function bm25(index, qtoks, k1 = 1.4, b = 0.6) {
  const scores = new Map(), matched = new Map();
  const uniq = [...new Set(qtoks)];
  for (const d of index.docs) {
    let s = 0, m = 0;
    for (const q of uniq) {
      const f = d.tf.get(q); if (!f) continue;
      const idf = Math.log(1 + (index.N - index.df.get(q) + 0.5) / (index.df.get(q) + 0.5));
      if (index.df.get(q) <= Math.max(1, index.N * 0.4)) m++; // discriminative term
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / index.avg));
    }
    scores.set(d.note.id, s); matched.set(d.note.id, m);
  }
  return { scores, matched, uniq: uniq.length };
}

// path affinity: 1 if a dep is the current file, decaying by directory distance
function pathAffinity(note, file) {
  if (!file) return 0;
  let best = 0;
  const fdir = path.dirname(file);
  for (const d of note.deps || []) {
    if (d.path === file) return 1;
    const ddir = path.dirname(d.path);
    if (ddir === fdir) best = Math.max(best, 0.6);
    else if (ddir.startsWith(fdir + '/') || fdir.startsWith(ddir + '/')) best = Math.max(best, 0.3);
  }
  return best;
}

const KIND_PRIOR = { howto: 0.15, gotcha: 0.1, convention: 0.1, cochange: 0.1, callpath: 0.05, location: 0.05, rationale: 0.05, overview: 0.1 };

export function rank(notes, { query = '', file = '', mode = 'orient' } = {}) {
  const idx = buildIndex(notes);
  const qtoks = tokenize(query + ' ' + (file || ''));
  const Q = bm25(idx.q, qtoks), B = bm25(idx.b, qtoks);
  const maxQ = Math.max(1e-9, ...Q.scores.values()), maxB = Math.max(1e-9, ...B.scores.values());
  // absolute gate: the note's question side (title/answers/tags) must share
  // discriminative terms with the query, or the note must sit on the current file.
  const need = Q.uniq <= 3 ? 1 : 2;
  return notes.map(n => {
    const mq = Q.matched.get(n.id) || 0, mb = B.matched.get(n.id) || 0;
    const aff = pathAffinity(n, file);
    const passes = mq >= need || (mq >= 1 && mb >= 3) || aff > 0;
    const rel = passes ? 0.7 * (Q.scores.get(n.id) || 0) / maxQ + 0.3 * (B.scores.get(n.id) || 0) / maxB : 0;
    const prior = mode === 'orient' ? (KIND_PRIOR[n.kind] || 0) * 0.3 : 0;
    const conf = (n.confidence ?? 0.7);
    let score = rel + aff * 0.4 + prior + 0.05 * conf;
    if (n.status === 'stale') score *= 0.6;
    if (n.status === 'invalid') score = -1;
    return { note: n, score, rel, aff, matched: mq + mb };
  }).filter(r => process.env.THINKER_FORCE === '1' ? r.note.status !== 'invalid' : (r.score > 0 && (r.rel > 0 || r.aff > 0))).sort((a, b) => b.score - a.score);
}

export const estTokens = s => Math.ceil(String(s).length / 3.6);

export function renderNote(n, { full = true } = {}) {
  const flag = n.status === 'stale'
    ? `\n> ⚠ STALE: ${(n.stale?.changed || []).map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`).join(', ') || 'dependencies changed'} since this was verified. Confirm against the code before relying on it.`
    : '';
  const deps = (n.deps || []).map(d => `${d.path}${d.symbol ? ':' + d.symbol : ''}${d.line ? ':L' + d.line : ''}`).join(', ');
  const head = `### [${n.kind}] ${n.title}  (id: ${n.id}, confidence ${Math.round((n.confidence ?? 0.7) * 100)}%)`;
  if (!full) return `${head}${flag}\n${(n.body || '').split('\n')[0].slice(0, 200)}\n→ ${deps}`;
  const applies = n.applies ? `\nApplies: ${n.applies}` : '';
  return `${head}${flag}\n${n.body}${applies}\n→ pointers: ${deps}`;
}

// Greedy pack ranked notes into a token budget; returns {text, included, omitted}
export function pack(ranked, budget, { minRel = 0.05, force = process.env.THINKER_FORCE === '1' } = {}) {
  const parts = [], included = [], omitted = [];
  let used = 0;
  for (const r of ranked) {
    const n = r.note;
    if (!force && r.rel < minRel && r.aff === 0) { omitted.push(n); continue; }
    const text = renderNote(n);
    const t = estTokens(text);
    if (used + t <= budget) { parts.push(text); used += t; included.push(n); }
    else {
      const short = renderNote(n, { full: false });
      const ts = estTokens(short);
      if (used + ts <= budget) { parts.push(short); used += ts; included.push(n); }
      else omitted.push(n);
    }
  }
  return { text: parts.join('\n\n'), included, omitted, tokens: used };
}
