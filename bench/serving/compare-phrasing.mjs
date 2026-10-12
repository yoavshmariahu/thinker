// Shipped phrasing against the mechanism-first phrasing, same ranker (CE floor 0, two notes, lexical
// top 8 with the gate off), over the 32 requests, scored by the judge's labels. A served note the
// judge never saw is listed so a second judge pass can rate it.
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SP = path.join(ROOT, 'bench', 'serving') + '/';
const { Store } = await import(path.join(ROOT, 'src/store.js'));
const { rank } = await import(path.join(ROOT, 'src/rank.js'));
const { ceScores } = await import(path.join(ROOT, 'src/dense.js'));
const labels = JSON.parse(fs.readFileSync(SP + 'relevance-labels.json', 'utf8'));
const s2 = JSON.parse(fs.readFileSync(SP + 'search2.json', 'utf8'));
const extra = fs.existsSync(SP + 'relevance-labels-extra.json') ? JSON.parse(fs.readFileSync(SP + 'relevance-labels-extra.json', 'utf8')) : {};
const SETS = { first: { tasks: 'bench/tasks/mlflow-hard.json', clone: 'bench/repos/mlflow', notes: 'bench/notesets/mlflow-v1/notes' }, harder: { tasks: 'bench/tasks/mlflow-b2-hard.json', clone: 'bench/repos/mlflow-b2', notes: 'bench/notesets/mlflow-v2/notes' } };
const K = 8, MAX = 2, FLOOR = 0;
const variants = { shipped: n => n, mechanism: n => s2[n.id] ? { ...n, search: s2[n.id].search } : n };
const tally = Object.fromEntries(Object.keys(variants).map(v => [v, { served2: 0, served1: 0, served0: 0, unjudged: 0, reqWithUseful: 0, reqWithNothing: 0 }]));
const unjudged = {};
const rows = [];
for (const [setName, s] of Object.entries(SETS)) {
  process.env.THINKER_NOTES_DIR = path.join(ROOT, s.notes);
  const notes = new Store(path.join(ROOT, s.clone), { readonly: true }).list();
  for (const t of JSON.parse(fs.readFileSync(path.join(ROOT, s.tasks), 'utf8')).tasks) {
    const L = setName === "harder" && labels[t.id]?.set !== "harder" ? labels[t.id + "#b2"] : labels[t.id]; if (!L) continue;
    const req = t.prompt.split('\n\n').slice(1).join('\n\n');
    const top = rank(notes, { query: req, mode: 'orient', cover: { body: 0, question: 0, terms: 0 } }).slice(0, K).map(r => r.note);
    const row = { task: t.id };
    for (const [v, f] of Object.entries(variants)) {
      const sc = await ceScores(req, top.map(f));
      const served = top.map((n, i) => ({ n, ce: sc[i] })).filter(x => x.ce >= FLOOR).sort((a, b) => b.ce - a.ce).slice(0, MAX);
      const T = tally[v]; let useful = false;
      row[v] = served.map(x => { const r = L.ratings[x.n.id]?.rating ?? extra[t.id]?.[x.n.id]?.rating; if (r == null) { T.unjudged++; (unjudged[t.id] = unjudged[t.id] || []).push(x.n.id); } else if (r === 2) { T.served2++; useful = true; } else if (r === 1) { T.served1++; useful = true; } else T.served0++; return `${r == null ? '?' : r}:${x.ce.toFixed(1)}`; }).join(', ') || 'nothing';
      if (useful) T.reqWithUseful++; if (!served.length) T.reqWithNothing++;
    }
    rows.push(row);
  }
}
console.log('| task | shipped (rating:CE) | mechanism (rating:CE) |\n|---|---|---|');
for (const r of rows) console.log(`| ${r.task} | ${r.shipped} | ${r.mechanism} |`);
console.log('\n| phrasing | served notes rated 2 | rated 1 | rated 0 | unjudged | requests with a useful note | requests served nothing |\n|---|---:|---:|---:|---:|---:|---:|');
for (const [v, T] of Object.entries(tally)) console.log(`| ${v} | ${T.served2} | ${T.served1} | ${T.served0} | ${T.unjudged} | ${T.reqWithUseful} of ${rows.length} | ${T.reqWithNothing} |`);
fs.writeFileSync(SP + 'unjudged.json', JSON.stringify(unjudged, null, 1));
console.log(`\n${Object.values(unjudged).flat().length} served notes still need a rating (scratchpad/unjudged.json)`);
