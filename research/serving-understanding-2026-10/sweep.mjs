// Cache hits for three forms of each request (the full bug report, its first sentence, a one-line prompt written by
// hand: prompts.json) across the serving settings of the understanding pool, scored on the hand labels: requests
// served anything (hits), served the target (a 2), served something useful, precision, and noise (served on the three
// requests no note covers). Local only: the lexical ranking and the cross-encoder on this machine, no agent session.
//   node research/serving-understanding-2026-10/sweep.mjs
import fs from 'node:fs';
import path from 'node:path';
import { BASE, evaluate } from './trace.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SHORT = JSON.parse(fs.readFileSync(path.join(HERE, 'prompts.json'), 'utf8'));
const UNCOVERED = ['PR26252-hard', 'PR26265-hard', 'PR26311-hard'];
const FORMS = {
  full: r => r,
  'first sentence': r => r.split(/(?<=[.!?])\s+/)[0],
  'one line': (r, t) => SHORT[t.id] || r,
};
const rows = [];
for (const [form, q] of Object.entries(FORMS)) {
  for (const views of ['search', 'multi']) for (const k of [4, 8, 16]) for (const queryTokens of [60, 120, 250]) for (const floor of [0, -2, -4, -6, -Infinity]) {
    const r = await evaluate({ ...BASE, query: q, ceQuery: q, views, k, queryTokens, floor, maxNotes: 1 });
    const noise = r.out.filter(o => UNCOVERED.includes(o.task) && o.served.length).length;
    rows.push({ form, views, k, queryTokens, floor, hits: r.out.filter(o => o.served.length).length, target: r.hit2, of2: r.has2, useful: r.useful, precision: r.precision, noise });
  }
}
fs.writeFileSync(path.join(HERE, 'sweep-results.json'), JSON.stringify(rows, null, 1));
const fmt = x => `${x.form.padEnd(15)} ${x.views.padEnd(6)} k${String(x.k).padEnd(3)} q${String(x.queryTokens).padEnd(4)} floor ${String(x.floor).padEnd(9)} hits ${String(x.hits).padStart(2)}/13  target ${x.target}/${x.of2}  useful ${x.useful}  precision ${x.precision == null ? '–' : x.precision.toFixed(2)}  noise ${x.noise}/3`;
for (const form of Object.keys(FORMS)) {
  const fr = rows.filter(x => x.form === form);
  console.log(`\n== ${form}: shipped-like (search, k8, q120, floor 0) and the pool (multi, k8, q120, floor -4)`);
  for (const x of fr.filter(x => x.k === 8 && x.queryTokens === 120 && ((x.views === 'search' && x.floor === 0) || (x.views === 'multi' && x.floor === -4)))) console.log(fmt(x));
  console.log(`   best by target, then fewer noise, then precision:`);
  for (const x of [...fr].sort((a, b) => b.target - a.target || a.noise - b.noise || (b.precision ?? 0) - (a.precision ?? 0)).slice(0, 4)) console.log(fmt(x));
}
