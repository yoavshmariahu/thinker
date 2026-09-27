import fs from 'node:fs';
const rows = fs.readdirSync('bench/runs/posthog-fable').filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(fs.readFileSync('bench/runs/posthog-fable/' + f, 'utf8'))).filter(r => r.turns > 1);
const m = (a, k) => a.length ? a.reduce((s, r) => s + (k(r) || 0), 0) / a.length : NaN;
const se = (a, k) => { const mu = m(a, k); return Math.sqrt(m(a, r => (k(r) - mu) ** 2) / a.length); };
const name = { nocache: 'no cache', hook: 'cache' };
// pairs: same task and seed with both arms finished
const pairs = []; for (const r of rows.filter(r => r.arm === 'nocache')) { const c = rows.find(x => x.arm === 'hook' && x.task === r.task && x.rep === r.rep); if (c) pairs.push([r, c]); }
console.log(`fable: ${rows.length} runs, ${pairs.length} complete pairs (task × seed)`);
console.log('arm        n  calls  in_Mtok  $/run   min  essential-met  strict');
for (const [i, arm] of [[0, 'nocache'], [1, 'hook']]) { const rs = pairs.map(p => p[i]); const g = rs.filter(r => r.grade?.criteria);
  console.log(name[arm].padEnd(9), String(rs.length).padStart(2), m(rs, r => r.tools.calls).toFixed(1).padStart(6), (m(rs, r => r.in_tokens) / 1e6).toFixed(2).padStart(8), m(rs, r => r.cost).toFixed(2).padStart(6), (m(rs, r => r.wall_ms) / 60000).toFixed(1).padStart(5), g.length ? (m(g, r => r.grade.criteria.essential).toFixed(2) + ' ±' + se(g, r => r.grade.criteria.essential).toFixed(2)).padStart(14) : '      -', g.filter(r => r.grade.criteria.pass).length + '/' + g.length); }
const gp = pairs.filter(p => p[0].grade?.criteria && p[1].grade?.criteria);
const d = (k) => { const x = pairs.map(p => k(p[1]) - k(p[0])); const mu = x.reduce((s, v) => s + v, 0) / x.length; const s = Math.sqrt(x.reduce((t, v) => t + (v - mu) ** 2, 0) / x.length / x.length); return [mu, s]; };
const pct = k => (100 * (m(pairs.map(p => p[1]), k) / m(pairs.map(p => p[0]), k) - 1)).toFixed(0) + '%';
console.log(`paired change with cache: calls ${pct(r => r.tools.calls)}, input tokens ${pct(r => r.in_tokens)}, cost ${pct(r => r.cost)}, time ${pct(r => r.wall_ms)}`);
const [dc, sc] = d(r => r.cost); console.log(`paired Δcost per run: ${dc.toFixed(2)} ±${sc.toFixed(2)};  cheaper with cache in ${pairs.filter(p => p[1].cost < p[0].cost).length}/${pairs.length} pairs`);
if (gp.length) { const x = gp.map(p => p[1].grade.criteria.essential - p[0].grade.criteria.essential); const mu = x.reduce((s, v) => s + v, 0) / x.length; const s = Math.sqrt(x.reduce((t, v) => t + (v - mu) ** 2, 0) / x.length / x.length); console.log(`paired Δessential: ${mu >= 0 ? '+' : ''}${mu.toFixed(2)} ±${s.toFixed(2)};  better ${x.filter(v => v > 0.01).length}, same ${x.filter(v => Math.abs(v) <= 0.01).length}, worse ${x.filter(v => v < -0.01).length}`); }
console.log('\ntask      seed  no cache: calls $ ess   |  cache: calls $ ess  notes');
for (const [a, b] of pairs.sort((x, y) => x[0].task.localeCompare(y[0].task) || x[0].rep - y[0].rep)) console.log(a.task.replace('-hard', '').padEnd(10), a.rep, String(a.tools.calls).padStart(9), a.cost.toFixed(2).padStart(6), (a.grade?.criteria?.essential ?? NaN).toFixed(2).padStart(5), '  |', String(b.tools.calls).padStart(6), b.cost.toFixed(2).padStart(6), (b.grade?.criteria?.essential ?? NaN).toFixed(2).padStart(5), String(b.tools.injected.length).padStart(4));
