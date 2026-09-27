// Combined table for PostHog symptom-task arms, graded by calibrated acceptance criteria.
import fs from 'node:fs';
const sets = [['posthog-hard', 'v1', 'sonnet'], ['posthog-sym-v1', 'v1', 'sonnet'], ['posthog-sym-v2', 'v2', 'sonnet'], ['posthog-opus', 'v2', 'opus'], ['posthog-haiku', 'v2', 'haiku']];
const m = (a, k) => a.reduce((s, r) => s + (k(r) || 0), 0) / a.length;
const se = (a, k) => { const mu = m(a, k); return Math.sqrt(m(a, r => (k(r) - mu) ** 2) / a.length); };
const rowsAll = [];
for (const [tag, ns, model] of sets) {
  const d = `bench/runs/${tag}/`; if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) { if (!f.endsWith('.json') || f === 'summary.json') continue; const r = JSON.parse(fs.readFileSync(d + f, 'utf8')); if (r.turns > 1 && r.grade?.criteria) rowsAll.push({ ...r, ns: ['nocache', 'prompt'].includes(r.arm) ? '-' : r.arm === 'irrelevant' ? 'other' : ns, model }); }
}
const base = {}; // per model, per task: no-notes mean of essential fraction
for (const r of rowsAll.filter(r => r.arm === 'nocache' || r.arm === 'prompt')) (base[r.model + r.task] ||= []).push(r.grade.criteria.essential);
const b = r => { const a = base[r.model + r.task]; return a ? a.reduce((s, x) => s + x, 0) / a.length : NaN; };
console.log('model   arm            notes   n  calls  in_ktok  $/run  essential-met   strict-pass  Δ vs same task no-notes   old judge');
const keys = [...new Set(rowsAll.map(r => `${r.model}|${r.arm}|${r.ns}`))];
for (const k of keys) {
  const [model, arm, ns] = k.split('|'); const rs = rowsAll.filter(r => r.model === model && r.arm === arm && r.ns === ns);
  const withBase = rs.filter(r => !isNaN(b(r)));
  const label = arm === 'hook' ? 'early-full' : arm;
  console.log(`${model.padEnd(7)} ${label.padEnd(14)} ${ns.padEnd(6)} ${String(rs.length).padStart(2)}  ${m(rs, r => r.tools.calls).toFixed(1).padStart(5)}  ${(m(rs, r => r.in_tokens) / 1000).toFixed(0).padStart(7)}  ${m(rs, r => r.cost).toFixed(2).padStart(5)}  ${m(rs, r => r.grade.criteria.essential).toFixed(2)} ±${se(rs, r => r.grade.criteria.essential).toFixed(2)}     ${(100 * m(rs, r => r.grade.criteria.pass ? 1 : 0)).toFixed(0).padStart(3)}%        ${withBase.length && !['nocache', 'prompt'].includes(arm) ? ((m(withBase, r => r.grade.criteria.essential - b(r)) >= 0 ? '+' : '') + m(withBase, r => r.grade.criteria.essential - b(r)).toFixed(2) + ' ±' + se(withBase, r => r.grade.criteria.essential - b(r)).toFixed(2)) : '     -    '}              ${m(rs, r => r.grade.score).toFixed(2)}`);
}
