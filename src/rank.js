// Retrieval: BM25 over note text + path affinity + kind/confidence priors,
// then greedy packing into a token budget.
import path from 'node:path';

// Words that say nothing about the subject. A request in prose is mostly these, and notes are
// written in prose too, so without the list two texts match on "why", "not" and "only".
const STOP = new Set(`the a an and or of to in on for with is are be by as at from this that it its into how what where when which do does can should we you i
 why not no but if so then than too also only even just still yet ever never always already again once
 was were been being am has have had having did done doing will would could shall may might must
 they them their there these those he she his her our your my me us who whom whose
 about above after before between through during under over out up down off across against within without via per
 any all some each every both either neither other another such same own more most less few many much
 here now very really quite rather instead because while until unless although though whether however
 need needs needed want wants wanted let lets see seen say says said`.split(/\s+/).filter(Boolean));

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

// says: how a user would put it, in the words of the product (ops.js:phraseNotes)
function qText(n) { return [n.title, (n.answers || []).join(' '), (n.tags || []).join(' '), (n.says || []).join(' ')].join(' '); }
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
  // weight of the query's terms that occur in the index at all: what a note could cover of it
  let mass = 0;
  for (const q of uniq) { const df = index.df.get(q); if (df) mass += Math.log(1 + (index.N - df + 0.5) / (df + 0.5)); }
  return { scores, matched, uniq: uniq.length, mass };
}

// Share of the request's term weight that a note must cover, with its body and pointers
// and with its question side (title/answers/tags). rel is relative to the best note, so the
// best of a poor lot scores near 1; these floors are absolute.
// THINKER_MIN_COVER=body,question,terms changes them; 0,0 turns them off.
export const MIN_COVER = { body: 0.10, question: 0.05, terms: 3 };

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

const KIND_PRIOR = { howto: 0.15, gotcha: 0.1, convention: 0.1, cochange: 0.1, callpath: 0.05, location: 0.05, rationale: 0.05, overview: 0.1, invariant: 0.1, fix: 0.1 };

// What a request tells the agent not to do is not what it is about: "do not run the test suite"
// would otherwise bring up the notes on running tests. Only instructions: "it never updates" and
// "launches without the check" describe the fault.
export const subject = q => String(q).replace(/\b(?:do not|don't|dont|no need to)\b[^.;:\n]*/gi, ' ');

export function rank(notes, { query = '', file = '', mode = 'orient', loose = false } = {}) {
  const idx = buildIndex(notes);
  const qtoks = tokenize(subject(query) + ' ' + (file || ''));
  const Q = bm25(idx.q, qtoks), B = bm25(idx.b, qtoks);
  const maxQ = Math.max(1e-9, ...Q.scores.values()), maxB = Math.max(1e-9, ...B.scores.values());
  // absolute gate: the note's question side (title/answers/tags) must share
  // discriminative terms with the query, or the note must sit on the current file.
  const need = Q.uniq <= 3 ? 1 : 2;
  const [floorB = MIN_COVER.body, floorQ = MIN_COVER.question, terms = MIN_COVER.terms] = (process.env.THINKER_MIN_COVER || '').split(',').filter(Boolean).map(Number);
  // a short query has little weight to cover, and two shared words are a large share of it:
  // the body must then hold the weight of about `terms` of its words
  const short = floorB > 0 && Q.uniq > 3 ? Math.min(0.6, terms / Q.uniq) : 0;
  const minB = Math.max(floorB, short), minQ = floorQ;
  return notes.map(n => {
    const mq = Q.matched.get(n.id) || 0, mb = B.matched.get(n.id) || 0;
    const aff = pathAffinity(n, file);
    const cover = (B.scores.get(n.id) || 0) / Math.max(1e-9, B.mass), coverQ = (Q.scores.get(n.id) || 0) / Math.max(1e-9, Q.mass);
    const passes = loose ? (mq + mb) >= 1 || aff > 0 : (((mq >= need || (mq >= 1 && mb >= 3)) && cover >= minB && coverQ >= minQ) || aff > 0);
    const rel = passes ? 0.7 * (Q.scores.get(n.id) || 0) / maxQ + 0.3 * (B.scores.get(n.id) || 0) / maxB : 0;
    const prior = mode === 'orient' ? (KIND_PRIOR[n.kind] || 0) * 0.3 : 0;
    const conf = (n.confidence ?? 0.7);
    let score = rel + aff * 0.4 + prior + 0.05 * conf;
    if (n.status === 'stale') score *= 0.6;
    if (n.status === 'invalid') score = -1;
    return { note: n, score, rel, aff, cover, coverQ, matched: mq + mb };
  }).filter(r => process.env.THINKER_FORCE === '1' ? r.note.status !== 'invalid' : (r.score > 0 && (r.rel > 0 || r.aff > 0))).sort((a, b) => b.score - a.score);
}

export const estTokens = s => Math.ceil(String(s).length / 3.6);

// A pointer: path:Symbol:L12, with the blast radius when it was counted (codegraph.js:fanout) and
// not switched off (THINKER_FANOUT=off): `path:Sym:L12 [6 call sites in 3 files]`.
export function renderPointer(d) {
  const f = d.fanout && process.env.THINKER_FANOUT !== 'off' ? ` [${renderFanout(d.fanout)}]` : '';
  return `${d.path}${d.symbol ? ':' + d.symbol : ''}${d.line ? ':L' + d.line : ''}${f}`;
}
export const renderFanout = f => f.files === 0 ? 'no references' : `${f.sites || f.refs} ${f.sites ? 'call site' : 'reference'}${(f.sites || f.refs) === 1 ? '' : 's'} in ${f.files} file${f.files === 1 ? '' : 's'}`;

// Pointers-only rendering: where to look, without prose that could be read as the whole picture.
export function renderPointers(n) {
  const deps = [...(n.deps || []).filter(d => d.symbol), ...(n.deps || []).filter(d => !d.symbol)].slice(0, Number(process.env.THINKER_MAX_POINTERS) || 6).map(renderPointer).join(', ');
  const stale = n.status === 'stale' ? ' (STALE: confirm)' : '';
  return `- [${n.kind}] ${n.title}${stale}  (id: ${n.id}, confidence ${Math.round((n.confidence ?? 0.7) * 100)}%)\n  → ${deps}`;
}

export function renderNote(n, { full = true } = {}) {
  const flag = n.status === 'stale'
    ? `\n> ⚠ STALE: ${(n.stale?.changed || []).map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`).join(', ') || 'dependencies changed'} since this was verified. Confirm against the code before relying on it.`
    : '';
  const maxPtr = Number(process.env.THINKER_MAX_POINTERS) || 6;
  const all = (n.deps || []);
  // symbol-level pointers first: they are the precise ones
  const shown = [...all.filter(d => d.symbol), ...all.filter(d => !d.symbol)].slice(0, maxPtr);
  const deps = shown.map(renderPointer).join(', ') + (all.length > shown.length ? ` (+${all.length - shown.length} more)` : '');
  const head = `### [${n.kind}] ${n.title}  (id: ${n.id}, confidence ${Math.round((n.confidence ?? 0.7) * 100)}%)`;
  if (!full) return `${head}${flag}\n${(n.body || '').split('\n')[0].slice(0, 200)}\n→ ${deps}`;
  const applies = n.applies ? `\nApplies: ${n.applies}` : '';
  return `${head}${flag}\n${n.body}${applies}\n→ pointers: ${deps}`;
}

// Greedy pack ranked notes into a token budget; returns {text, included, omitted}
export function pack(ranked, budget, { minRel = 0.05, force = process.env.THINKER_FORCE === '1', pointers = false } = {}) {
  const parts = [], included = [], omitted = [];
  let used = 0;
  for (const r of ranked) {
    const n = r.note;
    if (!force && r.rel < minRel && r.aff === 0) { omitted.push(n); continue; }
    const text = pointers ? renderPointers(n) : renderNote(n);
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
