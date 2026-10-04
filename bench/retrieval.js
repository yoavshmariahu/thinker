#!/usr/bin/env node
// Retrieval alone, without an agent: what the cache serves for each task's request, and how much
// of it rests on a file the merged fix changed. Seconds per task set, so a change to ranking can
// be tried before a benchmark is spent on it.
//   node bench/retrieval.js [set...] [--assets dir] [--verbose] [--json]
//   sets: grafana, mitmproxy, posthog (default: all that are present)
// Two requests per task: `hook` is the user's request as the prompt hook sees it (two notes);
// `agent` is a one-sentence summary, as an agent passes to the orient tool after the hook ran.
// Tune on one set and check on another: the floors in rank.js were fitted on posthog.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = n => { const i = argv.indexOf('--' + n); return i < 0 ? null : argv.splice(i, 1)[0]; };
const opt = n => { const i = argv.indexOf('--' + n); return i < 0 ? null : argv.splice(i, 2)[1]; };
// notesets and repos that are not checked in live in another checkout
const ASSETS = opt('assets') || process.env.BENCH_ASSETS || HERE;
const VERBOSE = !!flag('verbose'), JSON_OUT = !!flag('json');
const at = p => [path.join(ASSETS, p), path.join(HERE, p)].find(f => fs.existsSync(f));
const SETS = {
  grafana: ['tasks/grafana-hard.json', 'notesets/grafana-v1/notes'],
  grafana3: ['tasks/grafana-hard.json', 'notesets/grafana-v3/notes'],
  grafana3full: ['tasks/grafana.json', 'notesets/grafana-v3/notes'],
  mitmproxy: ['tasks/mitmproxy-hard.json', 'repos/mitmproxy/.thinker/notes'],
  posthog: ['tasks/posthog-hard.json', 'notesets/posthog-v2/notes'],
};

process.env.THINKER_LOG = 'off'; process.env.THINKER_NO_BG_VERIFY = '1';
const { orient, rememberTask } = await import('../src/ops.js');
const { rank } = await import('../src/rank.js');
const { denseScores } = await import('../src/dense.js');
const { Store } = await import('../src/store.js');

const isTest = f => /(test_|_test\.|\.test\.|\/tests?\/|__tests__|__snapshots__|\.ambr|\.snap|\.stories\.)/.test(f);
const request = t => t.prompt.split('\n\n').slice(1).join('\n\n') || t.prompt;
// what an agent writes into orient: the first sentence of the request, at most 25 words
const summary = t => request(t).split(/(?<=[.!?])\s/)[0].split(/\s+/).slice(0, 25).join(' ');

async function run(name) {
  const [tf, nd] = SETS[name].map(at);
  if (!tf || !nd) return null;
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-retrieval-'));
  fs.mkdirSync(path.join(repo, '.thinker'), { recursive: true });
  fs.cpSync(nd, path.join(repo, '.thinker', 'notes'), { recursive: true });
  const store = new Store(repo);
  const tasks = JSON.parse(fs.readFileSync(tf, 'utf8')).tasks;
  const out = { set: name, tasks: tasks.length, notes: store.list().length, hook: [], agent: [], order: [] };
  for (const t of tasks) {
    const gold = new Set((t.goldFiles || []).filter(f => !isTest(f)));
    const on = n => (n.deps || []).some(d => gold.has(d.path));
    const exists = store.list().some(on);
    // the order alone, with nothing gated: where the first note on a changed file stands, and the top 2
    if (exists) {
      const dense = process.env.THINKER_DENSE ? await denseScores(store.list(), t.prompt) : null; // dense.js, THINKER_DENSE=minilm
      const all = rank(store.list(), { query: t.prompt, mode: 'orient', cover: { body: 0, question: 0 }, dense });
      const first = all.findIndex(r => on(r.note));
      out.order.push({ task: t.id, first: first < 0 ? Infinity : first + 1, top2: all.slice(0, 2).filter(r => on(r.note)).length });
    }
    const session = `retrieval-${t.id}`;
    const h = await orient(store, { task: t.prompt, session, refreshFirst: false });
    rememberTask(store, session, t.prompt);
    const a = await orient(store, { task: summary(t), budget: 1000, maxNotes: 5, relFloor: 0.7, refreshFirst: false });
    for (const [mode, r] of [['hook', h], ['agent', a]]) {
      out[mode].push({ task: t.id, exists, served: r.included.map(n => n.id), on: r.included.filter(on).map(n => n.id), tokens: r.tokens });
      if (VERBOSE) console.log(`${name} ${mode.padEnd(5)} ${t.id.padEnd(16)} ${r.included.map(n => (on(n) ? '+' : '-') + n.id.slice(0, 44)).join('  ') || '(nothing)'}`);
    }
    // served counters would carry over to the next task
    for (const n of store.list()) if (n.servedIn?.length) { n.servedIn = []; store.put(n); }
  }
  fs.rmSync(repo, { recursive: true, force: true });
  return out;
}

const summarize = rows => {
  const served = rows.reduce((s, r) => s + r.served.length, 0), on = rows.reduce((s, r) => s + r.on.length, 0);
  const can = rows.filter(r => r.exists);
  return {
    served, on, precision: served ? on / served : NaN,
    // tasks that got at least one note on a changed file, of those for which the cache holds one
    hit: can.filter(r => r.on.length).length, can: can.length,
    offOnly: rows.filter(r => r.served.length && !r.on.length).length,
    nothing: rows.filter(r => !r.served.length).length,
    tokens: Math.round(rows.reduce((s, r) => s + (r.tokens || 0), 0) / rows.length),
  };
};

const names = argv.length ? argv : Object.keys(SETS);
const results = [];
for (const n of names) { if (!SETS[n]) { console.error(`unknown set ${n}`); continue; } const r = await run(n); if (r) results.push(r); else console.error(`${n}: tasks or notes not found (--assets <bench dir of the checkout that has them>)`); }
if (JSON_OUT) { console.log(JSON.stringify(results.map(r => ({ set: r.set, tasks: r.tasks, notes: r.notes, hook: summarize(r.hook), agent: summarize(r.agent) })), null, 1)); process.exit(0); }
if (VERBOSE) console.log();
console.log('order of the notes, nothing gated (tasks for which the cache holds a note on a changed file)');
console.log('set        tasks  first on target: mean 1/rank  in top 2  in top 5   on target among top 2');
for (const r of results) {
  const o = r.order, n = o.length || 1;
  console.log([r.set.padEnd(10), String(o.length).padStart(5), (o.reduce((s, x) => s + 1 / x.first, 0) / n).toFixed(2).padStart(28), `${o.filter(x => x.first <= 2).length}/${o.length}`.padStart(9), `${o.filter(x => x.first <= 5).length}/${o.length}`.padStart(9), (o.reduce((s, x) => s + x.top2, 0) / (2 * n)).toFixed(2).padStart(23)].join(' '));
}
console.log('\nwhat is served');
console.log('set        request  tasks  notes  served  on target  precision  tasks hit  off target only  nothing  tokens');
for (const r of results) for (const mode of ['hook', 'agent']) {
  const s = summarize(r[mode]);
  console.log([r.set.padEnd(10), mode.padEnd(7), String(r.tasks).padStart(5), String(r.notes).padStart(6), String(s.served).padStart(7), String(s.on).padStart(10), (isNaN(s.precision) ? '-' : s.precision.toFixed(2)).padStart(10), `${s.hit}/${s.can}`.padStart(10), String(s.offOnly).padStart(16), String(s.nothing).padStart(8), String(s.tokens).padStart(7)].join(' '));
}
