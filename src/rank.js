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
 need needs needed want wants wanted let lets see seen say says said
 ok okay yes yeah yep no nope good great fine sure thanks thank please hi hello hey`.split(/\s+/).filter(Boolean));

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

// A conservative stemmer: plural, -ing, -ed and -ation are folded, nothing else. The suffix list
// it replaces cut "notes" to "not" (a stop word, so the cache's own noun vanished from every
// query) and split status/statuses, share/shared and worktree/worktrees into different terms.
export function stem(w) {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';          // entries -> entry
  if (/(?:ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);                     // hashes -> hash, classes -> class
  if (w.endsWith('s') && !/(?:ss|us|is)$/.test(w)) w = w.slice(0, -1);         // notes -> note, status stays
  if (w.length <= 4) return w;
  for (const suf of ['ation', 'ing', 'ed']) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      const r = w.slice(0, -suf.length);
      if (/([bdfgklmnprtv])\1$/.test(r)) return r.slice(0, -1);                  // running -> run
      if (r.endsWith('i')) return r.slice(0, -1) + 'y';                           // verified -> verify
      return r;
    }
  }
  return w.endsWith('e') ? w.slice(0, -1) : w;                                  // verify/verifie, cache/cached share a stem
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
  const scores = new Map(), matched = new Map(), held = new Map();
  const uniq = [...new Set(qtoks)];
  for (const d of index.docs) {
    let s = 0, m = 0, h = 0;
    for (const q of uniq) {
      const f = d.tf.get(q); if (!f) continue;
      h++;
      const idf = Math.log(1 + (index.N - index.df.get(q) + 0.5) / (index.df.get(q) + 0.5));
      if (index.df.get(q) <= Math.max(1, index.N * 0.4)) m++; // discriminative term
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / index.avg));
    }
    scores.set(d.note.id, s); matched.set(d.note.id, m); held.set(d.note.id, h);
  }
  // weight of the query's terms that occur in the index at all: what a note could cover of it
  let mass = 0;
  for (const q of uniq) { const df = index.df.get(q); if (df) mass += Math.log(1 + (index.N - df + 0.5) / (df + 0.5)); }
  return { scores, matched, held, uniq: uniq.length, mass };
}

// Share of the request's term weight that a note must cover, with its body and pointers
// and with its question side (title/answers/tags). rel is relative to the best note, so the
// best of a poor lot scores near 1; these floors are absolute.
// THINKER_MIN_COVER=body,question,terms changes them; 0,0 turns them off.
// agentBody: the body floor when the agent calls `orient` itself (up to five notes, a one-sentence
// request): on the offline sets (bench/retrieval.js) the hook's 0.20 let through most of grafana's
// off-target servings (precision 0.12); 0.30 took it to 0.17 and mitmproxy's 0.56 to 0.64 with no
// task losing its on-target note, posthog unchanged at 0.80; 0.35 cost posthog a task.
// distinct: different discriminative words a long request must share with a note answered on one
// question-side word (see `terms` in rank).
export const MIN_COVER = { body: 0.20, question: 0.05, terms: 3, agentBody: 0.30, distinct: 4 };

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

const KIND_PRIOR = { howto: 0.15, gotcha: 0.1, convention: 0.1, cochange: 0, callpath: 0.05, location: 0.05, rationale: 0.05, overview: 0.1, invariant: 0.1, fix: 0.1, behavior: 0.12 };

// What a request tells the agent not to do is not what it is about: "do not run the test suite"
// would otherwise bring up the notes on running tests. Only instructions: "it never updates" and
// "launches without the check" describe the fault.
export const subject = q => String(q).replace(/\b(?:do not|don't|dont|no need to)\b[^.;:\n]*/gi, ' ');

export function rank(notes, { query = '', file = '', mode = 'orient', loose = false, minBody } = {}) {
  const idx = buildIndex(notes);
  const qtoks = tokenize(subject(query) + ' ' + (file || ''));
  const qset = new Set(qtoks);
  const Q = bm25(idx.q, qtoks), B = bm25(idx.b, qtoks);
  const maxQ = Math.max(1e-9, ...Q.scores.values()), maxB = Math.max(1e-9, ...B.scores.values());
  // absolute gate: the note's question side (title/answers/tags) must share
  // discriminative terms with the query, or the note must sit on the current file.
  // a request of two or three content words must share two of them with the note's question side
  // (one of them discriminative): "run the tests" is answered by notes on running tests, not by
  // every note that mentions a test. A longer request shares two discriminative terms, or one and
  // three in the body.
  const short = Q.uniq <= 3;
  const [floorB = minBody ?? MIN_COVER.body, floorQ = MIN_COVER.question, terms = MIN_COVER.terms] = (process.env.THINKER_MIN_COVER || '').split(',').filter(Boolean).map(Number);
  // a short query has little weight to cover, and two shared words are a large share of it:
  // the body must then hold the weight of about `terms` of its words
  const shortFloor = floorB > 0 && Q.uniq > 3 ? Math.min(0.6, terms / Q.uniq) : 0;
  const minB = Math.max(floorB, shortFloor), minQ = floorQ;
  // A request of one content word has no subject to cover: "status?", "merged?", "ok good. pushed?",
  // "yeah just run it" are turns of a conversation, not tasks, and any note holding the word would
  // cover all of it. Orientation then serves nothing but a note on the current file; a lookup is
  // asked for by name and is answered as before.
  const subjectless = mode === 'orient' && !loose && floorB > 0 && Q.uniq < 2;
  const docQ = new Map(idx.q.docs.map(d => [d.note.id, d.tf])), docB = new Map(idx.b.docs.map(d => [d.note.id, d.tf]));
  const discriminative = t => Math.min(idx.b.df.get(t) || Infinity, idx.q.df.get(t) || Infinity) <= Math.max(1, idx.b.N * 0.4);
  const qset0 = [...new Set(qtoks)];
  // different discriminative words of the request the note holds, on either side
  const distinct = n => qset0.filter(t => (docQ.get(n.id)?.has(t) || docB.get(n.id)?.has(t)) && discriminative(t)).length;
  return notes.map(n => {
    const mq = Q.matched.get(n.id) || 0, mb = B.matched.get(n.id) || 0;
    const aff = pathAffinity(n, file);
    // a co-change rule is for the moment its files are edited (ops.js:lateNotes); at orientation it is
    // served only when the request names one of its files or symbols, or it is about the current file
    const ccNamed = n.kind !== 'cochange' || mode !== 'orient' || aff > 0 || (n.deps || []).some(d => tokenize(`${path.basename(d.path)} ${d.symbol || ''}`).some(t => t.length >= 3 && qset.has(t)));
    const cover = (B.scores.get(n.id) || 0) / Math.max(1e-9, B.mass), coverQ = (Q.scores.get(n.id) || 0) / Math.max(1e-9, Q.mass);
    // one word in the title and three in the body may be the same word counted twice: "hit" in a note
    // titled "Cache hit notice" and in its body, with "claude" and "usage", let it through for "change
    // how long we wait before retrying when claude -p hits a usage limit". Four different words are asked.
    const terms = short ? mq >= 1 && (Q.held.get(n.id) || 0) >= Math.min(2, Q.uniq) : mq >= 2 || (mq >= 1 && mb >= 3 && distinct(n) >= MIN_COVER.distinct);
    const passes = ccNamed && (loose ? (mq + mb) >= 1 || aff > 0 : ((!subjectless && terms && cover >= minB && coverQ >= minQ) || aff > 0));
    const rel = passes ? 0.7 * (Q.scores.get(n.id) || 0) / maxQ + 0.3 * (B.scores.get(n.id) || 0) / maxB : 0;
    const prior = mode === 'orient' ? (KIND_PRIOR[n.kind] || 0) * 0.3 : 0;
    const conf = (n.confidence ?? 0.7);
    // what sessions did with the note when it was served (ops.js:attest), smoothed towards an even
    // chance: a note acted on each time it was served rises by up to 0.1, one never acted on sinks as much
    const a = n.attest || {}, acted = ((a.confirmed || 0) + 1) / ((a.confirmed || 0) + (a.unused || 0) + 2);
    let score = rel + aff * 0.4 + prior + 0.05 * conf + 0.2 * (acted - 0.5);
    if (n.status === 'stale') score *= 0.6;
    if (n.status === 'invalid' || n.archived) score = -1; // archived: kept for review, drilldown and lookup by id (ops.js:archiveNotes)
    return { note: n, score, rel, aff, cover, coverQ, matched: mq + mb };
  }).filter(r => process.env.THINKER_FORCE === '1' ? r.note.status !== 'invalid' && !r.note.archived : (r.score > 0 && (r.rel > 0 || r.aff > 0))).sort((a, b) => b.score - a.score);
}

export const estTokens = s => Math.ceil(String(s).length / 3.6);

// A pointer: path:Symbol:L12, with the blast radius when it was counted (codegraph.js:fanout) and
// not switched off (THINKER_FANOUT=off): `path:Sym:L12 [6 call sites in 3 files]`.
export function renderPointer(d) {
  const f = d.fanout && process.env.THINKER_FANOUT !== 'off' ? ` [${renderFanout(d.fanout)}]` : '';
  return `${d.path}${d.symbol ? ':' + d.symbol : ''}${d.line ? ':L' + d.line : ''}${f}`;
}
export const renderFanout = f => f.files === 0 ? 'no references' : `${f.sites || f.refs} ${f.callers ? 'caller' : f.sites ? 'call site' : 'reference'}${(f.sites || f.refs) === 1 ? '' : 's'} in ${f.files} file${f.files === 1 ? '' : 's'}`;

// Pointers-only rendering: where to look, without prose that could be read as the whole picture.
export function renderPointers(n) {
  const deps = [...(n.deps || []).filter(d => d.symbol), ...(n.deps || []).filter(d => !d.symbol)].slice(0, Number(process.env.THINKER_MAX_POINTERS) || 6).map(renderPointer).join(', ');
  const stale = n.status === 'stale' ? ' (STALE: confirm)' : n.status === 'violated' ? ' (VIOLATED by the code)' : '';
  return `- [${n.kind}] ${n.title}${stale}  (id: ${n.id}, confidence ${Math.round((n.confidence ?? 0.7) * 100)}%)\n  → ${deps}`;
}

export function renderNote(n, { full = true } = {}) {
  const flag = n.status === 'stale'
    ? `\n> ⚠ STALE: ${(n.stale?.changed || []).map(c => `${c.path}${c.symbol ? ':' + c.symbol : ''} (${c.reason})`).join(', ') || 'dependencies changed'} since this was verified. Confirm against the code before relying on it.`
    : n.status === 'violated'
    ? `\n> ⚠ VIOLATED: the code no longer upholds this ${n.mutability || 'mutable'} behavior${n.violated?.commit ? ` since commit ${String(n.violated.commit).slice(0, 10)}` : ''}${n.violated?.reason ? `: ${n.violated.reason}` : ''}. ${n.mutability === 'fixed' ? 'Restore it; a fixed behavior is not revised.' : 'Restore it, or revise the behavior note on purpose.'}`
    : '';
  const maxPtr = Number(process.env.THINKER_MAX_POINTERS) || 6;
  const all = (n.deps || []);
  // symbol-level pointers first: they are the precise ones
  const shown = [...all.filter(d => d.symbol), ...all.filter(d => !d.symbol)].slice(0, maxPtr);
  const deps = shown.map(renderPointer).join(', ') + (all.length > shown.length ? ` (+${all.length - shown.length} more)` : '');
  const head = `### [${n.kind}${n.kind === 'behavior' ? `, ${n.mutability || 'mutable'}` : ''}] ${n.title}  (id: ${n.id}, confidence ${Math.round((n.confidence ?? 0.7) * 100)}%)`;
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
