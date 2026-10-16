// Statistics, following bench/MEASUREMENT.md: paired and repeated, fail closed (invalid results
// excluded and listed), a 90% bootstrap interval on every paired difference, the grader named on
// every outcome. The cache-off / cache-on comparison itself is in experiment.js.
import { BASELINE_ARMS } from './normalize.js';

export function median(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
export function mean(xs) {
  const v = xs.filter(x => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// Seeded so a page reload shows the same interval for the same data.
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export function bootstrap(diffs, { iters = 2000, level = 0.9, seed = 7 } = {}) {
  const v = diffs.filter(x => x != null && Number.isFinite(x));
  if (v.length < 2) return { mean: v.length ? v[0] : null, lo: null, hi: null, n: v.length };
  const r = rng(seed), means = new Float64Array(iters);
  for (let i = 0; i < iters; i++) { let s = 0; for (let j = 0; j < v.length; j++) s += v[Math.floor(r() * v.length)]; means[i] = s / v.length; }
  means.sort();
  const a = (1 - level) / 2;
  return { mean: mean(v), lo: means[Math.floor(a * iters)], hi: means[Math.min(iters - 1, Math.floor((1 - a) * iters))], n: v.length };
}

export const METRICS = [
  { key: 'pass', label: 'Pass rate', unit: 'share', better: 'up' },
  { key: 'in_tokens', label: 'Input tokens', unit: 'tokens', better: 'down' },
  { key: 'out_tokens', label: 'Output tokens', unit: 'tokens', better: 'down' },
  { key: 'tool_calls', label: 'Tool calls', unit: 'count', better: 'down' },
  { key: 'wall_ms', label: 'Wall time', unit: 'ms', better: 'down' },
  { key: 'cost', label: 'Spend (recorded)', unit: 'usd', better: 'down' },
];

export function baselineArm(arms) {
  return BASELINE_ARMS.find(a => arms.includes(a)) || null;
}

export function armSummary(rows) {
  const by = new Map();
  for (const r of rows) { if (!by.has(r.arm)) by.set(r.arm, []); by.get(r.arm).push(r); }
  return [...by.entries()].map(([arm, rs]) => {
    const ok = rs.filter(r => !r.invalid);
    const graded = ok.filter(r => r.pass != null);
    return {
      arm, n: rs.length, valid: ok.length, invalid: rs.length - ok.length,
      graded: graded.length, passed: graded.filter(r => r.pass).length,
      pass_rate: graded.length ? graded.filter(r => r.pass).length / graded.length : null,
      score: mean(ok.map(r => r.score)),
      in_tokens: median(ok.map(r => r.in_tokens)), out_tokens: median(ok.map(r => r.out_tokens)),
      fresh_in: median(ok.map(r => r.fresh_in)), cache_read: median(ok.map(r => r.cache_read)),
      tool_calls: median(ok.map(r => r.tool_calls)), wall_ms: median(ok.map(r => r.wall_ms)),
      turns: median(ok.map(r => r.turns)),
      cost_total: ok.reduce((s, r) => s + (r.cost || 0), 0), cost: median(ok.map(r => r.cost)),
      served_share: ok.length ? ok.filter(r => r.served).length / ok.length : null,
      graders: [...new Set(graded.map(r => r.outcome_source + (r.judge ? ` · ${r.judge}` : '')))],
    };
  }).sort((a, b) => order(a.arm) - order(b.arm) || a.arm.localeCompare(b.arm));
}
// the baseline arm first, then the others by name
function order(arm) { const i = BASELINE_ARMS.indexOf(arm); return i < 0 ? BASELINE_ARMS.length : i; }
