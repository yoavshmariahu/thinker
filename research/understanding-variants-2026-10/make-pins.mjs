// pins-<cache>.json for the pinned arm: for each task, the cache's best note by the Sonnet judge (a 2, else a 1),
// keyed by the request exactly as the runner sends it (the fair task set's prompt without the bench framing).
//   node make-pins.mjs <cache name>
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const cache = process.argv[2];
const db = new DatabaseSync(process.env.HOME + '/.artemis/artemis.db', { readOnly: true });
const notes = new Map(db.prepare('SELECT id, data FROM cache_notes WHERE cache = ?').all(cache).map(r => { const n = JSON.parse(r.data); return [n.id, n]; }));
const labels = JSON.parse(fs.readFileSync(path.join(HERE, `labels-${cache}.json`), 'utf8'));
const tasks = JSON.parse(db.prepare('SELECT data FROM tasksets WHERE name = ?').get('mlflow-b2-fair').data).tasks;
const requestOf = p => /^Implement the following change/.test(p) && p.includes('\n\n') ? p.split('\n\n').slice(1).join('\n\n') : p;
const pins = {}, chosen = {};
for (const [task, rated] of Object.entries(labels)) {
  const best = Object.entries(rated).filter(([, v]) => v.rating > 0).sort((a, b) => b[1].rating - a[1].rating)[0];
  const t = tasks.find(x => x.id === task);
  if (!best || !t || !notes.has(best[0])) { chosen[task] = null; continue; }
  pins[requestOf(t.prompt).trim()] = [notes.get(best[0])];
  chosen[task] = { id: best[0], rating: best[1].rating };
}
fs.writeFileSync(path.join(HERE, `pins-${cache}.json`), JSON.stringify(pins));
console.log(JSON.stringify(chosen, null, 1));
