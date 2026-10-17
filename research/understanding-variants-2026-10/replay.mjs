// Each variant cache through the hook's ranking (../serving-understanding-2026-10/trace.mjs), scored on the Sonnet
// labels (judge.mjs): tasks with a 2-rated note in the cache at all, and tasks served one, on full requests and the
// hand-written one-line prompts, under today's rule (search text, floor 0, two notes) and the understanding pool
// (best of three texts, one note, served down to -4). One child process per variant: the tracer loads one cache.
//   node research/understanding-variants-2026-10/replay.mjs <cache name> [...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const TRACE = path.join(HERE, '..', 'serving-understanding-2026-10', 'trace.mjs');
const PROMPTS = path.join(HERE, '..', 'serving-understanding-2026-10', 'prompts.json');
const TMP = process.env.REPLAY_TMP || '/Users/yoavshmariahu/.claude/jobs/8ea0abd0/tmp/variants';
const TASKS = ['PR26270-hard', 'PR26267-hard', 'PR26291-hard', 'PR26269-hard', 'PR26307-hard', 'PR26442-hard', 'PR26327-hard', 'PR26300-hard'];

if (process.argv[2] === '--child') {
  const { BASE, evaluate } = await import(TRACE);
  const SHORT = JSON.parse(fs.readFileSync(PROMPTS, 'utf8'));
  // the fair requests (task set mlflow-b2-fair: five extended to state what their tests check)
  const fair = new DatabaseSync(process.env.HOME + '/.artemis/artemis.db', { readOnly: true });
  const T = JSON.parse(fair.prepare('SELECT data FROM tasksets WHERE name = ?').get('mlflow-b2-fair').data).tasks.filter(t => TASKS.includes(t.id));
  const res = {};
  for (const [form, q] of Object.entries({ full: r => r, 'one line': (r, t) => SHORT[t.id] || r }))
    for (const [rule, s] of Object.entries({ today: { views: 'search', floor: 0, maxNotes: 2 }, pool: { views: 'multi', floor: -4, maxNotes: 1 } })) {
      const r = await evaluate({ ...BASE, query: q, ceQuery: q, k: 8, ...s }, T);
      res[`${form} · ${rule}`] = { target: r.hit2, has2: r.has2, useful: r.useful, precision: r.precision };
    }
  console.log(JSON.stringify(res));
  process.exit(0);
}

const db = new DatabaseSync(process.env.HOME + '/.artemis/artemis.db', { readOnly: true });
const rows = [];
for (const cache of process.argv.slice(2)) {
  const dir = path.join(TMP, cache, 'notes');
  fs.rmSync(path.join(TMP, cache), { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  for (const r of db.prepare('SELECT id, data FROM cache_notes WHERE cache = ?').all(cache)) fs.writeFileSync(path.join(dir, r.id.endsWith('.json') ? r.id : r.id + '.json'), r.data);
  const judged = JSON.parse(fs.readFileSync(path.join(HERE, `labels-${cache}.json`), 'utf8'));
  const labels = Object.fromEntries(TASKS.map(t => [t, Object.fromEntries(Object.entries(judged[t] || {}).filter(([, v]) => v.rating > 0).map(([id, v]) => [id, v.rating]))]));
  const lf = path.join(TMP, cache, 'labels.json'); fs.writeFileSync(lf, JSON.stringify(labels));
  const out = execFileSync(process.execPath, [new URL(import.meta.url).pathname, '--child'], { env: { ...process.env, PROBE_NOTES: dir, PROBE_LABELS: lf }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });
  const res = JSON.parse(out.trim().split('\n').pop());
  const notes = fs.readdirSync(dir).length, with2 = TASKS.filter(t => Object.values(labels[t]).includes(2)).length;
  rows.push({ cache, notes, with2, res });
  console.log(`${cache.padEnd(28)} notes ${String(notes).padStart(4)} · tasks with a 2: ${with2}/8 · ` + Object.entries(res).map(([k, v]) => `${k}: ${v.target}/8`).join(' · '));
}
fs.writeFileSync(path.join(HERE, 'replay-results.json'), JSON.stringify(rows, null, 1));
