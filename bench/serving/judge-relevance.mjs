// Ground truth for the serving assessment: a Haiku judge rates every plausible candidate note for
// each mlflow request (2 = about the mechanism the task changes, 1 = a useful map of the area, 0 =
// unrelated). Candidates: notes pointing at a gold file, notes in a gold directory, and the lexical
// top 20 with the gate off. Output: scratchpad/relevance-labels.json.
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const OUT = path.join(ROOT, 'bench', 'serving', 'relevance-labels.json');
const { Store } = await import(path.join(ROOT, 'src/store.js'));
const { rank } = await import(path.join(ROOT, 'src/rank.js'));
const { complete } = await import(path.join(ROOT, 'src/llm.js'));
const isTest = p => /^tests\//.test(p);
const SETS = [
  { set: 'first', tasks: 'bench/tasks/mlflow-hard.json', clone: 'bench/repos/mlflow', notes: 'bench/notesets/mlflow-v1/notes' },
  { set: 'harder', tasks: 'bench/tasks/mlflow-b2-hard.json', clone: 'bench/repos/mlflow-b2', notes: 'bench/notesets/mlflow-v2/notes' },
];
const SCHEMA = { type: 'object', properties: { ratings: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, rating: { type: 'integer' }, why: { type: 'string' } }, required: ['id', 'rating'] } } }, required: ['ratings'] };
const SYSTEM = `You judge whether a cached note about a repository would help an engineer who has just received a task request. Rate each note:
2 = the note is about the mechanism the task changes (the same code path, invariant or convention the fix must touch or respect); reading it first would change what the engineer does.
1 = a useful map: it points at the right area or chokepoint (file, class, validation point) but is about a different change; it saves searching but says nothing about the fix.
0 = unrelated, or same file but nothing the engineer would use.
Be strict: a note that merely shares words with the request is 0. Return JSON {"ratings":[{"id","rating","why"}]} with one entry per note id.`;
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
let cost = 0;
for (const s of SETS) {
  process.env.THINKER_NOTES_DIR = path.join(ROOT, s.notes);
  const notes = new Store(path.join(ROOT, s.clone), { readonly: true }).list();
  const byId = new Map(notes.map(n => [n.id, n]));
  for (const t of JSON.parse(fs.readFileSync(path.join(ROOT, s.tasks), 'utf8')).tasks) {
    const key = (s.set === "harder" && out[t.id] && out[t.id].set === "first") ? t.id + "#b2" : t.id;
    if (out[key]) continue;
    const req = t.prompt.split('\n\n').slice(1).join('\n\n');
    const gold = (t.goldFiles || []).filter(p => !isTest(p)); const dirs = new Set(gold.map(p => path.dirname(p)));
    const cand = new Set();
    for (const n of notes) if ((n.deps || []).some(d => gold.includes(d.path) || dirs.has(path.dirname(d.path || '')))) cand.add(n.id);
    for (const r of rank(notes, { query: req, mode: 'orient', cover: { body: 0, question: 0, terms: 0 } }).slice(0, 20)) cand.add(r.note.id);
    const ids = [...cand].slice(0, 60);
    const prompt = `TASK REQUEST (the gold change touched ${gold.join(', ')}; use that only to judge, the engineer does not know it):\n${req}\n\nNOTES:\n` +
      ids.map(id => { const n = byId.get(id); return `--- id: ${id}\n[${n.kind}] ${n.title}\n${n.search || (n.body || '').slice(0, 500)}\npointers: ${(n.deps || []).slice(0, 6).map(d => d.path + (d.symbol ? ':' + d.symbol : '')).join(', ')}`; }).join('\n');
    const r = await complete({ system: SYSTEM, prompt, model: 'haiku', schema: SCHEMA, maxTokens: 6000, cache: false });
    cost += r.cost || 0;
    out[key] = { set: s.set, gold, candidates: ids.length, ratings: Object.fromEntries((r.json?.ratings || []).map(x => [x.id, { rating: x.rating, why: x.why }])) };
    const rs = Object.values(out[key].ratings).map(x => x.rating);
    console.log(`${t.id}: ${ids.length} candidates → ${rs.filter(x => x === 2).length} rated 2, ${rs.filter(x => x === 1).length} rated 1 (${r.provider}${r.cost != null ? ', $' + r.cost.toFixed(3) : ''})`);
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  }
}
console.log('judge cost $' + cost.toFixed(2));
