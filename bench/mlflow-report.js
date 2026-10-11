#!/usr/bin/env node
// Report for executable-oracle runs (bench/MEASUREMENT.md): per arm against nocache, paired by
// task and rep, with a bootstrap 90% interval over pairs. The external lines: attempts to a
// passing patch (with test runs before the first edit), tokens by class, wall time, pass rate
// on the change's own tests. The internal line: gold source files the patch touched.
//
//   node bench/mlflow-report.js <runs dir> [--json out.json]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dir = args[0];
const flag = k => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };
if (!dir) { console.error('usage: mlflow-report.js <runs dir>'); process.exit(1); }

const runs = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.json') || f === 'summary.json') continue;
  let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
  if (!j.task || !j.arm) continue;
  runs.push(j);
}
const passed = r => r.grade?.tests === 'pass';
const key = r => `${r.task}|${r.rep}`;
const base = new Map(runs.filter(r => r.arm === 'nocache').map(r => [key(r), r]));
const arms = [...new Set(runs.map(r => r.arm))].filter(a => a !== 'nocache');

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function boot(xs, seed = 1) {
  const v = xs.filter(Number.isFinite); if (!v.length) return null;
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const b = []; for (let i = 0; i < 2000; i++) { let t = 0; for (let k = 0; k < v.length; k++) t += v[Math.floor(rnd() * v.length)]; b.push(t / v.length); }
  b.sort((a, c) => a - c);
  return { n: v.length, mean: mean(v), lo: b[Math.floor(0.05 * b.length)], hi: b[Math.floor(0.95 * b.length)], lower: v.filter(x => x < 0).length };
}
const fmt = (st, f = x => x.toFixed(2)) => st ? `${f(st.mean)} [${f(st.lo)}, ${f(st.hi)}] n=${st.n}` : '';

// Attempts to correctness: edit-then-test cycles until the agent's own tests passed. A run that
// never ran a test after editing but passed the oracle made one blind attempt; a run that failed
// the oracle without ever reaching green counts at the cap (largest observed plus one). The share
// that self-tested at all is its own column.
const attempts = r => r.tools?.greenReached ? r.tools.attemptsToGreen : (passed(r) ? Math.max(1, r.tools?.testRunsAfterEdit || 0) : null);
const selfTested = r => (r.tools?.testRunsAfterEdit || 0) > 0;

console.log(`runs: ${runs.length}; nocache: ${base.size}; arms: ${arms.join(', ')}`);
console.log('\n| arm | pairs | pass rate (nocache → arm) | attempts to correctness, paired Δ | self-tested (nocache → arm) | test runs before first edit, Δ | calls before first edit, Δ | tool calls, Δ | tokens total, Δ | cost $, Δ | wall s, Δ | gold src files touched (nocache → arm) | note reached |');
console.log('|---|---:|---|---|---|---|---|---|---|---|---|---|---|');
const out = {};
for (const arm of arms) {
  const pairs = runs.filter(r => r.arm === arm && base.has(key(r)) && !r.is_error && !base.get(key(r)).is_error).map(r => ({ t: r, b: base.get(key(r)) }));
  if (!pairs.length) continue;
  const d = (f) => boot(pairs.map(({ t, b }) => { const x = f(t), y = f(b); return Number.isFinite(x) && Number.isFinite(y) ? x - y : NaN; }));
  const pr = (f) => `${(pairs.filter(({ b }) => f(b)).length / pairs.length * 100).toFixed(0)}% → ${(pairs.filter(({ t }) => f(t)).length / pairs.length * 100).toFixed(0)}%`;
  const cap = Math.max(1, ...pairs.flatMap(({ t, b }) => [attempts(t), attempts(b)]).filter(Number.isFinite)) + 1;
  const att = r => attempts(r) ?? cap;
  const gold = r => r.goldTouched ? r.goldTouched.touched / r.goldTouched.goldSrc : NaN;
  const tokens = r => (r.in_tokens || 0) + (r.out_tokens || 0);
  const row = {
    pairs: pairs.length, pass: pr(passed), attempts: d(att), neverGreen: pr(selfTested),
    testRunsBefore: d(r => r.tools?.testRunsBeforeEdit), callsBefore: d(r => r.tools?.callsBeforeFirstEdit), calls: d(r => r.tools?.calls),
    tokens: d(tokens), cost: d(r => r.cost), wall: d(r => r.wall_ms / 1000),
    goldTouched: `${(mean(pairs.map(({ b }) => gold(b)).filter(Number.isFinite)) * 100).toFixed(0)}% → ${(mean(pairs.map(({ t }) => gold(t)).filter(Number.isFinite)) * 100).toFixed(0)}%`,
    reached: `${pairs.filter(({ t }) => (t.tools?.injected || []).length || t.tools?.lateEvents).length}/${pairs.length}`,
  };
  out[arm] = row;
  console.log(`| ${arm} | ${row.pairs} | ${row.pass} | ${fmt(row.attempts)} | ${row.neverGreen} | ${fmt(row.testRunsBefore)} | ${fmt(row.callsBefore, x => x.toFixed(1))} | ${fmt(row.calls, x => x.toFixed(1))} | ${fmt(row.tokens, x => (x / 1e6).toFixed(2) + 'M')} | ${fmt(row.cost)} | ${fmt(row.wall, x => x.toFixed(0))} | ${row.goldTouched} | ${row.reached} |`);
}

console.log('\nPer run:');
console.log('| id | pass | attempts | own tests after edit | test runs before edit | calls before edit | calls | tokens | $ | wall s | gold touched | injected |');
console.log('|---|---|---:|---|---:|---:|---:|---:|---:|---:|---|---:|');
for (const r of runs.sort((a, b) => a.id.localeCompare(b.id))) {
  const g = r.goldTouched ? `${r.goldTouched.touched}/${r.goldTouched.goldSrc}` : '';
  const own = !selfTested(r) ? 'none' : r.tools.greenReached ? `green after ${r.tools.attemptsToGreen}` : `${r.tools.testRunsAfterEdit} runs, never green`;
  console.log(`| ${r.id} | ${passed(r) ? 'pass' : r.grade?.tests || '-'} | ${attempts(r) ?? 'cap'} | ${own} | ${r.tools?.testRunsBeforeEdit ?? ''} | ${r.tools?.callsBeforeFirstEdit ?? ''} | ${r.tools?.calls ?? ''} | ${(((r.in_tokens || 0) + (r.out_tokens || 0)) / 1e6).toFixed(2)}M | ${(r.cost || 0).toFixed(2)} | ${Math.round((r.wall_ms || 0) / 1000)} | ${g} | ${(r.tools?.injected || []).length} |`);
}
if (flag('json')) fs.writeFileSync(flag('json'), JSON.stringify({ arms: out, runs: runs.map(r => ({ ...r, diff: undefined, result: undefined })) }, null, 2));
