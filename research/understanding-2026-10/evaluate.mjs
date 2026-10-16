// Offline evaluation of an understanding noteset on a task set: (1) coverage: a Haiku judge rates the
// plausible candidates for each request (lexical top 20 with the gate off, and notes pointing into a
// directory the PR changed: the gold is used to find and judge, never to build), on the rubric of
// bench/serving/judge-relevance-BC.mjs; (2) serving: what the prompt hook would serve (lexical
// candidates, cross-encoder over the top 8, floor 0, two notes), scored by those ratings, with the
// cross-encoder reading the search text alone or the best of three views (search, searchInstances,
// body head; the bench/ce-views experiment), on the noteset alone or beside a PR-mined one.
// usage: node evaluate.mjs <tasks.json> <base checkout> <notes dir> <out labels.json> [--pr-notes dir --pr-labels file]
import fs from 'node:fs'; import path from 'node:path';
const [tasksFile, BASE, NOTES, OUT] = process.argv.slice(2).map(p => path.resolve(p));
const flag = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? path.resolve(process.argv[i + 1]) : null; };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { Store } = await import(path.join(ROOT, 'src/store.js'));
const { rank } = await import(path.join(ROOT, 'src/rank.js'));
const { ceScores } = await import(path.join(ROOT, 'src/dense.js'));
const { complete } = await import(path.join(ROOT, 'src/llm.js'));
const load = dir => { process.env.THINKER_NOTES_DIR = dir; return new Store(BASE, { readonly: true }).list(); };
const notes = load(NOTES), byId = new Map(notes.map(n => [n.id, n]));
const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')).tasks;
const req = t => /^Implement the following change/.test(t.prompt) ? t.prompt.split('\n\n').slice(1).join('\n\n') : t.prompt;
const isTest = p => /(^|\/)tests?\//.test(p);

const SCHEMA = { type: 'object', properties: { ratings: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, rating: { type: 'integer' }, why: { type: 'string' } }, required: ['id', 'rating'] } } }, required: ['ratings'] };
const SYSTEM = `You judge whether a cached note about a repository would help an engineer who has just received a task request. Rate each note:
2 = the note is about the mechanism the task changes (the same code path, invariant or convention the fix must touch or respect); reading it first would change what the engineer does.
1 = a useful map: it points at the right area or chokepoint (file, class, validation point) but is about a different change; it saves searching but says nothing about the fix.
0 = unrelated, or same file but nothing the engineer would use.
Be strict: a note that merely shares words with the request is 0. Return JSON {"ratings":[{"id","rating","why"}]} with one entry per note id.`;
const labels = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
await Promise.all(tasks.map(async t => {
  if (labels[t.id]) return;
  const gold = (t.goldFiles || []).filter(p => !isTest(p)), dirs = new Set(gold.map(p => path.dirname(p)));
  const cand = new Set(notes.filter(n => (n.deps || []).some(d => dirs.has(path.dirname(d.path || '')))).map(n => n.id));
  for (const r of rank(notes, { query: req(t), mode: 'orient', cover: { body: 0, question: 0, terms: 0 } }).slice(0, 20)) cand.add(r.note.id);
  const ids = [...cand], ratings = {};
  for (let i = 0; i < ids.length; i += 20) {
    const prompt = `TASK REQUEST (the gold change touched ${gold.join(', ')}; use that only to judge, the engineer does not know it):\n${req(t)}\n\nNOTES:\n` +
      ids.slice(i, i + 20).map(id => { const n = byId.get(id); return `--- id: ${id}\n[${n.kind}] ${n.title}\n${n.search || n.body.slice(0, 500)}\npointers: ${(n.deps || []).slice(0, 6).map(d => d.path + (d.symbol ? ':' + d.symbol : '')).join(', ')}`; }).join('\n');
    let r = null; for (let a = 0; a < 4 && !r; a++) { try { r = await complete({ system: SYSTEM, prompt, model: 'haiku', schema: SCHEMA, maxTokens: 6000, cache: false }); } catch {} }
    for (const x of r?.json?.ratings || []) if (byId.has(x.id)) ratings[x.id] = { rating: x.rating, why: x.why };
  }
  labels[t.id] = { candidates: ids.length, ratings };
  fs.writeFileSync(OUT, JSON.stringify(labels, null, 2));
}));

const U = new Set(notes.map(n => n.id));
const prNotes = flag('pr-notes') ? load(flag('pr-notes')) : [];
const prLabels = flag('pr-labels') ? JSON.parse(fs.readFileSync(flag('pr-labels'), 'utf8')) : {};
const rating = (t, id) => labels[t.id]?.ratings?.[id]?.rating ?? prLabels['harderBC:' + t.id]?.ratings?.[id]?.rating ?? null;
console.log('coverage (notes rated 2 / 1 among candidates):');
for (const t of tasks) { const rs = Object.values(labels[t.id].ratings).map(x => x.rating); console.log(`  ${t.id.slice(0, 7)}: ${rs.filter(r => r === 2).length} / ${rs.filter(r => r === 1).length} of ${labels[t.id].candidates}`); }

const views = { search: n => n.search, instances: n => n.searchInstances || n.search, body: n => String(n.body || '').slice(0, 900) };
async function serve(pool, t, vs) {
  const top = rank(pool, { query: req(t), mode: 'orient' }).slice(0, 8).map(r => r.note);
  if (!top.length) return [];
  const per = []; for (const v of vs) per.push(await ceScores(req(t), top.map(n => ({ ...n, search: views[v](n) }))));
  return top.map((n, i) => ({ n, ce: Math.max(...per.map(p => p[i])) })).filter(x => x.ce >= 0).sort((a, b) => b.ce - a.ce).slice(0, 2).map(x => x.n.id);
}
const has = t => Object.values(labels[t.id].ratings).some(x => x.rating >= 1);
for (const [name, pool] of [['understanding notes only', notes], ...(prNotes.length ? [['PR notes + understanding', [...prNotes, ...notes]], ['PR notes only', prNotes]] : [])]) {
  for (const [vn, vs] of [['search text', ['search']], ['best of three views', ['search', 'instances', 'body']]]) {
    let hit2 = 0, hit1 = 0, served = 0, useful = 0, ctrl = 0; const cells = [];
    for (const t of tasks) {
      const ids = await serve(pool, t, vs), rs = ids.map(id => rating(t, id));
      served += ids.length; useful += rs.filter(r => r >= 1).length;
      if (rs.includes(2)) hit2++; if (rs.some(r => r >= 1)) hit1++; if (!has(t)) ctrl += ids.length;
      cells.push(`${t.id.slice(4, 7)}:${ids.map((id, i) => (U.has(id) ? 'U' : 'P') + (rs[i] ?? '?')).join(',') || '-'}`);
    }
    console.log(`${name.padEnd(26)} ${vn.padEnd(20)} rated-2 served on ${hit2}/13, useful on ${hit1}/13, precision ${served ? (useful / served).toFixed(2) : '-'}, on tasks with nothing useful: ${ctrl} | ${cells.join(' ')}`);
  }
}
