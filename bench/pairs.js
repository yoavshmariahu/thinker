#!/usr/bin/env node
// Arms of one run side by side, per task: tool calls, input tokens and correctness are
// shown apart, since they can move in opposite directions. Means over the seeds of a task,
// with the spread between seeds, so a difference can be held against it.
//   node bench/pairs.js <run tag> [base arm] [other arm]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [tag, A = 'nocache', B = 'full'] = process.argv.slice(2);
if (!tag) { console.error('usage: node bench/pairs.js <run tag> [base arm] [other arm]'); process.exit(1); }
const dir = path.join(HERE, 'runs', tag);
const runs = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter(r => !r.error && r.tools);

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const sd = a => a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)) : NaN;
const METRICS = [
  ['calls', r => r.tools.calls, x => x.toFixed(1)],
  ['in_ktok', r => r.in_tokens / 1000, x => x.toFixed(0)],
  // what was not read from the prompt cache; Codex counts cached tokens inside input_tokens
  ['fresh_ktok', r => typeof r.cached_tokens === 'number' ? (r.in_tokens - r.cached_tokens) / 1000 : NaN, x => x.toFixed(0)],
  ['out_ktok', r => r.out_tokens / 1000, x => x.toFixed(1)],
  ['wall_s', r => r.wall_ms / 1000, x => x.toFixed(0)],
  ['essential', r => r.grade?.criteria?.essential ?? NaN, x => x.toFixed(2)],
];
const cell = (rs, [, get, fmt]) => { const v = rs.map(get).filter(x => !isNaN(x)); return v.length ? `${fmt(mean(v))}${v.length > 1 ? ' ±' + fmt(sd(v)) : ''}` : '-'; };

const tasks = [...new Set(runs.map(r => r.task))].sort();
const paired = [];
console.log(`${tag}: ${A} -> ${B}\n`);
console.log(['task'.padEnd(16), 'n'.padEnd(5), ...METRICS.map(m => m[0].padEnd(26)), 'notes served'].join(' '));
for (const t of tasks) {
  const a = runs.filter(r => r.task === t && r.arm === A), b = runs.filter(r => r.task === t && r.arm === B);
  if (a.length && b.length) paired.push({ t, a, b });
  const served = mean(b.map(r => (r.tools.injected || []).length));
  console.log([t.padEnd(16), `${a.length}/${b.length}`.padEnd(5), ...METRICS.map(m => `${cell(a, m)} -> ${cell(b, m)}`.padEnd(26)), isNaN(served) ? '-' : served.toFixed(1)].join(' '));
}
// each task counts once, whatever its number of seeds
console.log(`\nover ${paired.length} tasks with both arms (mean of task means; ± is the standard error of the per-task difference)`);
for (const m of METRICS) {
  const rows = paired.map(p => [mean(p.a.map(m[1]).filter(x => !isNaN(x))), mean(p.b.map(m[1]).filter(x => !isNaN(x)))]).filter(([x, y]) => !isNaN(x) && !isNaN(y));
  if (!rows.length) { console.log(`${m[0].padEnd(11)} -`); continue; }
  const d = rows.map(([x, y]) => y - x), ma = mean(rows.map(r => r[0])), mb = mean(rows.map(r => r[1]));
  const up = rows.filter(([x, y]) => y > x).length;
  console.log(`${m[0].padEnd(11)} ${m[2](ma)} -> ${m[2](mb)}  (${mb >= ma ? '+' : ''}${(100 * (mb - ma) / ma).toFixed(0)}%, diff ${m[2](mean(d))} ±${rows.length > 1 ? m[2](sd(d) / Math.sqrt(rows.length)) : '-'}, higher in ${up}/${rows.length}, n=${rows.length})`);
}
const missing = tasks.filter(t => !paired.some(p => p.t === t));
if (missing.length) console.log(`\nwithout both arms: ${missing.join(', ')}`);
const ungraded = runs.filter(r => [A, B].includes(r.arm) && !r.grade?.criteria).map(r => r.id);
if (ungraded.length) console.log(`not graded: ${ungraded.join(', ')}`);
