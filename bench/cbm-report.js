#!/usr/bin/env node
// Summary of thinker vs codebase-memory-mcp comparison runs (bench/cbm-compare.js): per-arm means and a
// per-task table, from the records and judge files in one or more run directories. No model calls.
//
//   node bench/cbm-report.js bench/runs/click-thinker-vs-cbm [bench/runs/click-thinker-vs-cbm-v2:thinker=thinker-v2,both=both-v2] [--exclude id,id]
//
// A directory may rename its arms (dir:arm=label,…) so two versions of thinker sit in one table; --exclude takes
// run ids, or dir/id when the same id exists in several directories.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const exclude = new Set((args.includes('--exclude') ? args[args.indexOf('--exclude') + 1] : '').split(',').filter(Boolean));
const dirs = args.filter(a => !a.startsWith('--') && a !== (args[args.indexOf('--exclude') + 1] || null));
const rows = [];
for (const spec of dirs) {
  const [dir, renames] = spec.split(':');
  const map = Object.fromEntries((renames || '').split(',').filter(Boolean).map(kv => kv.split('=')));
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.judge.json') || f === 'protocol.json' || f === 'summary.json') continue;
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (exclude.has(r.id) || exclude.has(`${path.basename(dir)}/${r.id}`)) continue; // --exclude id or dir/id
    const jf = path.join(dir, f.replace(/\.json$/, '.judge.json'));
    const judge = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : null;
    const u = r.usage || {};
    rows.push({ dir, task: r.task, arm: map[r.arm] || r.arm, wall: r.wall_ms / 1000, turns: r.turns, calls: r.tools.calls, mcp: r.arm === 'cbm' ? r.tools.cbmCalls : r.tools.thinkerCalls, reads: r.tools.filesRead, greps: r.tools.greps, bash: r.tools.bash,
      inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outTok: u.output_tokens || 0, cost: r.cost_usd || 0, must: r.must ? r.must.hit / r.must.total : null, score: judge?.score ?? null, judgeModel: judge?.model, byTool: r.tools.byTool });
  }
}
const arms = [...new Set(rows.map(r => r.arm))];
const mean = (a, k) => a.length ? a.reduce((s, r) => s + (r[k] ?? 0), 0) / a.length : NaN;
const se = (a, k) => { const m = mean(a, k); return a.length > 1 ? Math.sqrt(a.reduce((s, r) => s + ((r[k] ?? 0) - m) ** 2, 0) / (a.length * (a.length - 1))) : 0; };
const f = (x, d = 1) => isNaN(x) ? '-' : x.toFixed(d);
console.log('arm'.padEnd(12), 'n'.padStart(3), 'wall_s'.padStart(7), 'turns'.padStart(6), 'calls'.padStart(6), 'mcp'.padStart(5), 'reads'.padStart(6), 'greps'.padStart(6), 'in_ktok'.padStart(8), 'out_tok'.padStart(8), 'cost_$'.padStart(7), 'must'.padStart(5), 'score'.padStart(12), 'pass'.padStart(5));
for (const arm of arms) {
  const a = rows.filter(r => r.arm === arm), g = a.filter(r => r.score !== null);
  console.log(arm.padEnd(12), String(a.length).padStart(3), f(mean(a, 'wall')).padStart(7), f(mean(a, 'turns')).padStart(6), f(mean(a, 'calls')).padStart(6), f(mean(a, 'mcp')).padStart(5), f(mean(a, 'reads')).padStart(6), f(mean(a, 'greps')).padStart(6), f(mean(a, 'inTok') / 1000, 0).padStart(8), f(mean(a, 'outTok'), 0).padStart(8), f(mean(a, 'cost'), 3).padStart(7), f(mean(a, 'must'), 2).padStart(5), (g.length ? `${f(mean(g, 'score'), 2)} ±${f(se(g, 'score'), 2)}` : '-').padStart(12), (g.length ? `${g.filter(r => r.score >= 1).length}/${g.length}` : '-').padStart(5));
}
console.log('\nper task (score / calls / cost):');
const tasks = [...new Set(rows.map(r => r.task))];
console.log('task'.padEnd(22), ...arms.map(a => a.padStart(22)));
for (const t of tasks) console.log(t.padEnd(22), ...arms.map(a => { const r = rows.find(x => x.task === t && x.arm === a); return (r ? `${r.score ?? '?'} / ${r.calls} / $${r.cost.toFixed(2)}` : '-').padStart(22); }));
console.log('\ntools used per arm (mean calls per run):');
for (const arm of arms) {
  const a = rows.filter(r => r.arm === arm); const tot = {};
  for (const r of a) for (const [k, v] of Object.entries(r.byTool || {})) tot[k] = (tot[k] || 0) + v;
  console.log(arm.padEnd(12), Object.entries(tot).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k.replace('mcp__codebase-memory-mcp__', 'cbm:').replace('mcp__thinker__', 'thinker:')}=${(v / a.length).toFixed(1)}`).join('  '));
}
const judges = [...new Set(rows.map(r => r.judgeModel).filter(Boolean))]; if (judges.length) console.log(`\njudge: ${judges.join(', ')}`);
