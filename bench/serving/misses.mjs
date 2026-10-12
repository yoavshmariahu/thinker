// For every note the judge rated useful (2 = same mechanism, 1 = map), where does serving lose it?
// lexical rank with the gate on and off, cross-encoder score, served or not; plus its source PR.
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const LABELS = path.join(ROOT, 'bench', 'serving', 'relevance-labels.json');
const { Store } = await import(path.join(ROOT, 'src/store.js'));
const { rank } = await import(path.join(ROOT, 'src/rank.js'));
const { ceScores, ceText } = await import(path.join(ROOT, 'src/dense.js'));
const labels = JSON.parse(fs.readFileSync(LABELS, 'utf8')); const s2 = JSON.parse(fs.readFileSync(LABELS.replace('relevance-labels', 'search2'), 'utf8'));
const SETS = { first: { tasks: 'bench/tasks/mlflow-hard.json', clone: 'bench/repos/mlflow', notes: 'bench/notesets/mlflow-v1/notes' }, harder: { tasks: 'bench/tasks/mlflow-b2-hard.json', clone: 'bench/repos/mlflow-b2', notes: 'bench/notesets/mlflow-v2/notes' } };
const stores = {};
const tally = { 2: { n: 0, served: 0, gated: 0, outsideTop8: 0, belowFloor: 0 }, 1: { n: 0, served: 0, gated: 0, outsideTop8: 0, belowFloor: 0 } };
const rows = [];
for (const [key, L] of Object.entries(labels)) {
  const tid = key.replace(/#b2$/, ""); const s = SETS[L.set];
  if (!stores[L.set]) { process.env.THINKER_NOTES_DIR = path.join(ROOT, s.notes); stores[L.set] = { notes: new Store(path.join(ROOT, s.clone), { readonly: true }).list(), tasks: JSON.parse(fs.readFileSync(path.join(ROOT, s.tasks), 'utf8')).tasks }; }
  const { notes, tasks } = stores[L.set];
  const t = tasks.find(x => x.id === tid); const req = t.prompt.split('\n\n').slice(1).join('\n\n');
  const useful = Object.entries(L.ratings).filter(([, r]) => r.rating >= 1);
  if (!useful.length) continue;
  const gated = rank(notes, { query: req, mode: 'orient' }); const open = rank(notes, { query: req, mode: 'orient', cover: { body: 0, question: 0, terms: 0 } });
  const top = gated.slice(0, 8); const ce = await ceScores(req, top.map(r => r.note));
  const served = top.map((r, i) => ({ id: r.note.id, ce: ce[i] })).filter(x => x.ce >= 0).sort((a, b) => b.ce - a.ce).slice(0, 2).map(x => x.id);
  for (const [id, r] of useful) {
    const n = notes.find(x => x.id === id); if (!n) continue;
    const gi = gated.findIndex(x => x.note.id === id), oi = open.findIndex(x => x.note.id === id);
    const c = (await ceScores(req, [n]))[0]; const c2 = s2[id] ? (await ceScores(req, [{ ...n, search: s2[id].search }]))[0] : NaN;
    const T = tally[r.rating]; T.n++;
    let where; if (served.includes(id)) { where = 'served'; T.served++; } else if (gi < 0) { where = 'lexical gate drops it'; T.gated++; } else if (gi >= 8) { where = `lexical rank ${gi + 1}, outside top 8`; T.outsideTop8++; } else { where = `in top 8, CE ${c.toFixed(2)} below floor`; T.belowFloor++; }
    rows.push({ tid, rating: r.rating, id, title: n.title, source: n.source?.ref || '', gateRank: gi < 0 ? '-' : gi + 1, openRank: oi < 0 ? '-' : oi + 1, cover: oi >= 0 ? open[oi].cover.toFixed(2) : '-', ce: c.toFixed(2), ce2: c2.toFixed(2), where, why: r.why || '' });
  }
}
console.log('| task | rating | note | source PR | lexical rank (gate on / off) | cover | CE shipped | CE mechanism | outcome |\n|---|---:|---|---|---|---:|---:|---|');
for (const r of rows.sort((a, b) => b.rating - a.rating || a.tid.localeCompare(b.tid))) console.log(`| ${r.tid} | ${r.rating} | ${r.title.slice(0, 70)} | ${r.source} | ${r.gateRank} / ${r.openRank} | ${r.cover} | ${r.ce} | ${r.ce2} | ${r.where} |`);
for (const k of [2, 1]) { const T = tally[k]; console.log(`\nrated ${k}: ${T.n} notes; served ${T.served}; lexical gate drops ${T.gated}; outside top 8 ${T.outsideTop8}; in top 8 but below CE floor ${T.belowFloor}`); }
fs.writeFileSync(LABELS.replace('relevance-labels', 'misses'), JSON.stringify(rows, null, 1));
