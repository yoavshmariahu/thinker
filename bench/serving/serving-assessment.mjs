// Serving assessment: for each benchmark request, does a note that points at the gold source
// files exist in the cache (coverage), where does the lexical ranker put it, what does the
// cross-encoder score it, and what gets served at floor 0 with two notes.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { Store } = await import(path.join(ROOT, 'src/store.js'));
const { rank } = await import(path.join(ROOT, 'src/rank.js'));
const { ceScores } = await import(path.join(ROOT, 'src/dense.js'));

const isTest = p => /^tests\//.test(p);
const SETS = [
  { name: 'first set (v1, 19 tasks)', tasks: 'bench/tasks/mlflow-hard.json', clone: 'bench/repos/mlflow', notes: 'bench/notesets/mlflow-v1/notes' },
  { name: 'harder set (v2, 13 tasks)', tasks: 'bench/tasks/mlflow-b2-hard.json', clone: 'bench/repos/mlflow-b2', notes: 'bench/notesets/mlflow-v2/notes' },
];
const K = 8, FLOOR = 0, MAX = 2;

for (const set of SETS) {
  process.env.THINKER_NOTES_DIR = path.join(ROOT, set.notes);
  const store = new Store(path.join(ROOT, set.clone), { readonly: true });
  const notes = store.list();
  const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, set.tasks), 'utf8')).tasks;
  const tally = { none: 0, dirOnly: 0, outsideTop8: 0, belowFloor: 0, served: 0, servedWrong: 0 };
  console.log(`\n## ${set.name}: ${notes.length} notes\n`);
  console.log('| task | gold src files | notes pointing at a gold file | best lexical rank | in top 8 | CE of best gold note in top 8 | served (CE ≥ 0, ≤ 2) | verdict |');
  console.log('|---|---:|---:|---:|---|---:|---|---|');
  for (const t of tasks) {
    const req = t.prompt.split('\n\n').slice(1).join('\n\n');
    const gold = (t.goldFiles || []).filter(p => !isTest(p));
    const goldDirs = new Set(gold.map(p => path.dirname(p)));
    const points = n => (n.deps || []).some(d => gold.includes(d.path));
    const nearby = n => (n.deps || []).some(d => goldDirs.has(path.dirname(d.path || '')));
    const pointing = notes.filter(points);
    const ranked = rank(notes, { query: req, mode: 'orient' });
    const bestRank = ranked.findIndex(r => points(r.note));
    const top = ranked.slice(0, K);
    const ce = await ceScores(req, top.map(r => r.note));
    const scored = top.map((r, i) => ({ id: r.note.id, ce: ce[i], gold: points(r.note), near: nearby(r.note) }));
    const served = scored.filter(s => s.ce >= FLOOR).sort((a, b) => b.ce - a.ce).slice(0, MAX);
    const bestGoldTop = scored.filter(s => s.gold).sort((a, b) => b.ce - a.ce)[0];
    let verdict;
    if (!pointing.length) { verdict = notes.some(nearby) ? 'coverage: only same-directory notes' : 'coverage: nothing near'; tally[notes.some(nearby) ? 'dirOnly' : 'none']++; }
    else if (bestRank < 0 || bestRank >= K) { verdict = bestRank < 0 ? 'lexical ranker drops it' : 'lexical rank misses it'; tally.outsideTop8++; }
    else if (!served.some(s => s.gold)) { verdict = `floor drops it (CE ${bestGoldTop.ce.toFixed(2)})`; tally.belowFloor++; if (served.length) tally.servedWrong++; }
    else { verdict = 'served'; tally.served++; }
    const servedTxt = served.map(s => `${s.gold ? 'GOLD' : s.near ? 'near' : 'other'} ${s.ce.toFixed(2)}`).join(', ') || 'nothing';
    console.log(`| ${t.id} | ${gold.length} | ${pointing.length} | ${bestRank < 0 ? '-' : bestRank + 1} | ${bestRank >= 0 && bestRank < K ? 'yes' : 'no'} | ${bestGoldTop ? bestGoldTop.ce.toFixed(2) : '-'} | ${servedTxt} | ${verdict} |`);
  }
  console.log(`\ncoverage gap: ${tally.none + tally.dirOnly} (${tally.dirOnly} with same-directory notes only); lexical miss: ${tally.outsideTop8}; floor drops a gold-pointing note: ${tally.belowFloor} (${tally.servedWrong} of those served something else); served a gold-pointing note: ${tally.served}`);
}
