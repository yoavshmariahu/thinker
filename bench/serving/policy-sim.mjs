// Serving policies over the 32 requests with the notes as they are (and with the mechanism
// phrasing), scored by the judge's labels. A policy: lexical gate on/off, how many lexical
// candidates the cross-encoder reads (k), the floor, and how many notes it may serve (max).
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SP = path.join(ROOT, 'bench', 'serving') + '/';
const { Store } = await import(path.join(ROOT, 'src/store.js'));
const { rank } = await import(path.join(ROOT, 'src/rank.js'));
const { ceScores } = await import(path.join(ROOT, 'src/dense.js'));
const labels = JSON.parse(fs.readFileSync(SP + 'relevance-labels.json', 'utf8'));
const PH = process.argv.slice(2).filter(a => a.endsWith('.json'));
const side = Object.fromEntries(PH.map(f => [f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(SP + f, 'utf8'))]));
const SETS = { first: { tasks: 'bench/tasks/mlflow-hard.json', clone: 'bench/repos/mlflow', notes: 'bench/notesets/mlflow-v1/notes' }, harder: { tasks: 'bench/tasks/mlflow-b2-hard.json', clone: 'bench/repos/mlflow-b2', notes: 'bench/notesets/mlflow-v2/notes' } };
const POLICIES = [
  { name: 'one note: gate on, k 8, floor 0, max 1', gate: true, k: 8, floor: 0, max: 1 },
  { name: 'shipped: gate on, k 8, floor 0, max 2', gate: true, k: 8, floor: 0, max: 2 },
  { name: 'gate off, k 8, max 2', gate: false, k: 8, floor: 0, max: 2 },
  { name: 'gate off, k 16, max 2', gate: false, k: 16, floor: 0, max: 2 },
  { name: 'gate off, k 16, max 3', gate: false, k: 16, floor: 0, max: 3 },
  { name: 'gate off, k 16, max 4', gate: false, k: 16, floor: 0, max: 4 },
  { name: 'gate off, k 16, floor 1, max 3', gate: false, k: 16, floor: 1, max: 3 },
];
// a sidecar phrasing replaces search (read by the cross-encoder) and says (read by the lexical stage)
const PHRASINGS = { shipped: n => n, ...Object.fromEntries(Object.entries(side).map(([k, m]) => [k, n => m[n.id] ? { ...n, search: m[n.id].search, ...(m[n.id].says?.length ? { says: m[n.id].says } : {}) } : n])) };
const res = {}; for (const p of POLICIES) for (const ph of Object.keys(PHRASINGS)) res[p.name + '|' + ph] = { reqUseful: 0, useful: 0, rated2: 0, useless: 0, unjudged: 0, nothing: 0, notes: 0 };
let nReq = 0;
for (const [setName, s] of Object.entries(SETS)) {
  if (process.env.ONLY && setName !== process.env.ONLY) continue;
  process.env.THINKER_NOTES_DIR = path.join(ROOT, s.notes);
  const notes = new Store(path.join(ROOT, s.clone), { readonly: true }).list();
  for (const t of JSON.parse(fs.readFileSync(path.join(ROOT, s.tasks), 'utf8')).tasks) {
    const L = setName === 'harder' && labels[t.id]?.set !== 'harder' ? labels[t.id + '#b2'] : labels[t.id]; if (!L) continue; nReq++;
    const req = t.prompt.split('\n\n').slice(1).join('\n\n');
    const cache = {}, ranks = {};
    for (const [ph, f] of Object.entries(PHRASINGS)) {
      const phNotes = notes.map(f);
      const gated = rank(phNotes, { query: req, mode: 'orient' }).map(r => r.note), open = rank(phNotes, { query: req, mode: 'orient', cover: { body: 0, question: 0, terms: 0 } }).map(r => r.note);
      ranks[ph] = { gated, open };
      const top16 = open.slice(0, 16); const sc = await ceScores(req, top16.map(f)); cache[ph] = new Map(top16.map((n, i) => [n.id, sc[i]]));
      const g8 = gated.slice(0, 8).filter(n => !cache[ph].has(n.id)); if (g8.length) { const s8 = await ceScores(req, g8.map(f)); g8.forEach((n, i) => cache[ph].set(n.id, s8[i])); }
    }
    for (const p of POLICIES) for (const ph of Object.keys(PHRASINGS)) {
      const cands = (p.gate ? ranks[ph].gated : ranks[ph].open).slice(0, p.k);
      const served = cands.map(n => ({ n, ce: cache[ph].get(n.id) })).filter(x => x.ce != null && x.ce >= p.floor).sort((a, b) => b.ce - a.ce).slice(0, p.max);
      const R = res[p.name + '|' + ph]; let useful = false;
      for (const x of served) { const r = L.ratings[x.n.id]?.rating; R.notes++; if (r == null) R.unjudged++; else if (r >= 1) { R.useful++; useful = true; if (r === 2) R.rated2++; } else R.useless++; }
      if (useful) R.reqUseful++; if (!served.length) R.nothing++;
    }
  }
}
console.log(`| policy | phrasing | requests with a useful note (of ${nReq}) | served nothing | useful notes served (rated 2) | rated-0 served | unjudged served | notes per request |\n|---|---|---:|---:|---:|---:|---:|---:|`);
for (const p of POLICIES) for (const ph of Object.keys(PHRASINGS)) { const R = res[p.name + '|' + ph]; console.log(`| ${p.name} | ${ph} | ${R.reqUseful} | ${R.nothing} | ${R.useful} (${R.rated2}) | ${R.useless} | ${R.unjudged} | ${(R.notes / nReq).toFixed(1)} |`); }
