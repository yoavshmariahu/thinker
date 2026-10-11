#!/usr/bin/env node
// Re-analysis of the paired runs already under bench/runs: every (dir, task, rep) with a
// `nocache` arm and a cache arm, split by whether a note actually reached the agent, so the
// effect of a serving is read apart from how often one happens (bench/MEASUREMENT.md,
// Measurement 2). No model calls.
//
//   node bench/reanalysis.js [--runs dir] [--inventory] [--json out.json] [--md out.md]
//
// Spend is in dollars (the cost rules in bench/MEASUREMENT.md): a Claude run's own reported
// cost; Codex and Gemini runs priced at list from their token classes where the classes are
// recorded, otherwise left unpriced (calls still count). Runs the harness audits found invalid
// are excluded by name below, and listed in the output.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = k => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };
const RUNS = flag('runs') || path.join(HERE, 'runs');

// Treatment arms: a cache reached the agent through the hook, the tools, or both.
const TREATMENT = new Set(['cache', 'hook', 'full', 'hook-ce', 'hook-bm25', 'rerank', 'late', 'all', 'late+nudge', 'pointers', 'router+late', 'hook-minilm']);
const CONTROL = new Set(['irrelevant', 'prompt']);  // notes that cannot bear on the task, or guidance text alone: the instruction effect
const BASELINE = 'nocache';

// Excluded by name, with the reason the audits gave.
const EXCLUDED_DIRS = {
  'grafana-gemini-3.8-smoke-leaked': 'the clone still held the merged fix (grafana-bench-setup)',
  'invalid': 'marked invalid when run (shared worktree)',
  'mitm-live': 'recall: the task re-run with notes from its own earlier run',
  'sanity-check-live': 'live arm sanity check, not a pair',
  'posthog-codex-before-after': 'version comparison, no nocache arm',
  'posthog-codex-before-after-2': 'version comparison, no nocache arm',
  'cleanup-preserved-2026-10-06': 'preserved outputs of stopped runs',
  'click-adv': 'adversarial-notes study: the hook arm was served wrong notes on purpose',
};
// Codex runs before the cached-token fix: in_tokens double-counted cached input (codex-gpt6-sol-bench).
// Calls are kept; spend is not priced.
const UNPRICED_DIRS = new Set(['posthog-codex-gpt6-sol', 'posthog-codex-gpt6-sol-trace', 'posthog-codex-gpt56']);
// Claude runs that ended at the harness turn cap are not a measurement of the arm (thinker-bench-findings).
const TURN_CAP = 60;

// List prices, dollars per million tokens: fresh input, cache read, output. Anthropic list
// 2026-10-06; vendors' pages for the rest (bench/MEASUREMENT.md). Claude runs carry their own cost.
const PRICE = {
  'gpt-6-astra': { in: 10, cached: 1, out: 50 },
  'gpt-6-sol': { in: 4, cached: 0.4, out: 20 },
  'gemini-3.8-flash-high': { in: 0.75, cached: 0.075, out: 3.75 },
};

function readRuns() {
  const runs = [];
  for (const dir of fs.readdirSync(RUNS)) {
    const full = path.join(RUNS, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith('.json') || f.includes('.judge') || f === 'summary.json') continue;
      let j; try { j = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')); } catch { continue; }
      if (!j || typeof j !== 'object' || !j.task || !j.arm || j.rep === undefined) continue;
      runs.push({ dir, file: f, ...normalize(j) });
    }
  }
  return runs;
}

function normalize(j) {
  const t = j.tools || {};
  const injected = (t.injected || []).length;
  const hookServed = Math.max(injected, t.cache?.hookServed || 0);
  const lateServed = t.cache?.lateServed || 0;
  const thinkerCalls = t.thinkerCalls || 0;
  const u = j.usage || {};
  const tokens = {
    fresh: j.cached_tokens != null ? j.in_tokens - j.cached_tokens : u.input_tokens ?? (j.in_tokens ?? null),
    cached: j.cached_tokens ?? u.cache_read_tokens ?? null,
    out: u.output_tokens != null ? u.output_tokens + (u.thinking_tokens || 0) : j.out_tokens ?? null,
    inputAll: j.in_tokens ?? (u.input_tokens != null ? u.input_tokens + (u.cache_read_tokens || 0) : null),
  };
  return {
    id: j.id, task: j.task, arm: j.arm, rep: j.rep, model: j.model === 'auto' ? 'auto (cursor)' : j.model || 'unknown', area: j.area,
    turns: j.turns ?? null, wallMs: j.wall_ms ?? null, calls: t.calls ?? null,
    served: hookServed + lateServed, hookServed, lateServed, thinkerCalls,
    reached: hookServed + lateServed > 0,
    // The Gemini harness and the early Codex one did not record what the hook served per run.
    recorded: Array.isArray(t.injected) || !!t.cache,
    isError: !!j.is_error, cost: typeof j.cost === 'number' ? j.cost : null, tokens,
    correctness: correctnessOf(j.grade),
  };
}

// One number in [0, 1] when the grade allows it: criteria scores, pass flags, must-hit ratios.
// Calibrated acceptance criteria (share of essential criteria met) first: the earlier
// reference-similarity `score` penalized valid alternative fixes (thinker-bench-findings).
function correctnessOf(g) {
  if (!g || typeof g !== 'object') return null;
  const frac = x => x > 1 ? x / 100 : x;
  const c = g.criteria && typeof g.criteria === 'object' && !Array.isArray(g.criteria) ? g.criteria : null;
  if (c && typeof c.essential === 'number') return frac(c.essential);
  if (typeof g.essential === 'number') return frac(g.essential);
  if (c && typeof c.pass === 'boolean') return c.pass ? 1 : 0;
  if (typeof g.pass === 'boolean') return g.pass ? 1 : 0;
  if (typeof g.score === 'number') return g.score;
  if (typeof g.mustHit === 'number' && g.mustTotal) return g.mustHit / g.mustTotal;
  return null;
}

function price(run) {
  if (run.cost != null) return run.cost;
  if (UNPRICED_DIRS.has(run.dir)) return null;
  const p = PRICE[run.model];
  const { fresh, cached, out } = run.tokens;
  if (!p || fresh == null || out == null) return null;
  return (fresh * p.in + (cached || 0) * p.cached + out * p.out) / 1e6;
}

function pairs(runs) {
  const by = new Map();
  for (const r of runs) {
    if (EXCLUDED_DIRS[r.dir]) continue;
    const k = `${r.dir}|${r.task}|${r.rep}`;
    const g = by.get(k) || { dir: r.dir, task: r.task, rep: r.rep, baseline: null, treatments: [], controls: [] };
    if (r.arm === BASELINE) g.baseline = r;
    else if (TREATMENT.has(r.arm)) g.treatments.push(r);
    else if (CONTROL.has(r.arm)) g.controls.push(r);
    by.set(k, g);
  }
  const out = [], dropped = [];
  for (const g of by.values()) {
    if (!g.baseline) continue;
    for (const t of [...g.treatments, ...g.controls]) {
      const b = g.baseline;
      const reason = t.isError || b.isError ? 'is_error' : (b.cost != null && (t.turns >= TURN_CAP || b.turns >= TURN_CAP)) ? 'turn cap' : null;
      if (reason) { dropped.push({ dir: g.dir, task: g.task, rep: g.rep, arm: t.arm, reason }); continue; }
      out.push({ dir: g.dir, task: g.task, rep: g.rep, model: t.model, arm: t.arm, control: CONTROL.has(t.arm),
        reached: t.reached, recorded: t.recorded, served: t.served, asked: t.thinkerCalls > 0,
        side: t.reached ? 'note reached the agent' : t.recorded ? 'nothing reached' : 'serving not recorded',
        dCalls: t.calls != null && b.calls != null ? t.calls - b.calls : null, bCalls: b.calls,
        dSpend: price(t) != null && price(b) != null ? price(t) - price(b) : null, bSpend: price(b),
        dWall: t.wallMs != null && b.wallMs != null ? (t.wallMs - b.wallMs) / 1000 : null,
        dCorrect: t.correctness != null && b.correctness != null ? t.correctness - b.correctness : null });
    }
  }
  return { pairs: out, dropped };
}

// Paired mean difference with a bootstrap 90% interval over pairs.
function summarize(xs, { seed = 1 } = {}) {
  const v = xs.filter(Number.isFinite);
  if (!v.length) return null;
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  let s = seed; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const boots = [];
  for (let i = 0; i < 2000; i++) { const b = []; for (let k = 0; k < v.length; k++) b.push(v[Math.floor(rnd() * v.length)]); boots.push(mean(b)); }
  boots.sort((a, b) => a - b);
  return { n: v.length, mean: mean(v), lo: boots[Math.floor(0.05 * boots.length)], hi: boots[Math.floor(0.95 * boots.length)], lower: v.filter(x => x < 0).length };
}

function cell(stat, base, fmt = x => x.toFixed(2)) {
  if (!stat) return '';
  const rel = base ? ` (${Math.round(stat.mean / base * 100)}%)` : '';
  return `${fmt(stat.mean)}${rel} [${fmt(stat.lo)}, ${fmt(stat.hi)}], n=${stat.n}, lower in ${stat.lower}`;
}

const repoOf = dir => dir.replace(/^mitmproxy/, 'mitm').split('-')[0];
function report(P, keyOf = p => p.control ? `${p.model} | control: ${p.arm}` : p.model) {
  const groups = {};
  for (const p of P.pairs) {
    const key = keyOf(p);
    const g = groups[key] ||= {};
    (g[p.side] ||= []).push(p);
  }
  const rows = [], json = {};
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  for (const [key, g] of Object.entries(groups).sort()) {
    for (const side of ['note reached the agent', 'nothing reached', 'serving not recorded']) {
      const ps = g[side] || [];
      if (!ps.length) continue;
      const bCalls = mean(ps.map(p => p.bCalls).filter(Number.isFinite));
      const bSpend = mean(ps.filter(p => p.dSpend != null).map(p => p.bSpend));
      const calls = summarize(ps.map(p => p.dCalls)), spend = summarize(ps.map(p => p.dSpend)), wall = summarize(ps.map(p => p.dWall)), corr = summarize(ps.map(p => p.dCorrect));
      json[`${key} | ${side}`] = { pairs: ps.length, baselineCalls: bCalls, baselineSpend: bSpend, calls, spend, wall, correctness: corr, dirs: [...new Set(ps.map(p => p.dir))] };
      rows.push(`| ${key} | ${side} | ${ps.length} | ${cell(calls, bCalls, x => x.toFixed(1))} | ${cell(spend, bSpend, x => '$' + x.toFixed(2))} | ${cell(wall, null, x => x.toFixed(0) + 's')} | ${cell(corr, null, x => (x >= 0 ? '+' : '') + x.toFixed(2))} |`);
    }
  }
  const md = [
    '| model | pairs where | n | Δ tool calls (vs baseline mean) [90% CI], pairs lower | Δ spend | Δ wall | Δ correctness |',
    '|---|---|---:|---|---|---|---|',
    ...rows,
  ].join('\n');
  return { md, json };
}

const runs = readRuns();
if (flag('inventory')) {
  const inv = {};
  for (const r of runs) { const k = `${r.dir} | ${r.model} | ${r.arm}`; inv[k] = (inv[k] || 0) + 1; }
  for (const [k, n] of Object.entries(inv).sort()) console.log(k.padEnd(70), n);
  process.exit(0);
}
const P = pairs(runs);
const { md, json } = report(P);
const byRepo = report({ pairs: P.pairs.filter(p => !p.control) }, p => repoOf(p.dir));
const coverage = {};
for (const p of P.pairs.filter(p => !p.control)) { const c = coverage[p.model] ||= { pairs: 0, recorded: 0, reached: 0, asked: 0 }; c.pairs++; if (p.recorded) c.recorded++; if (p.reached) c.reached++; if (p.asked) c.asked++; }
const covMd = ['| model | pairs | serving recorded | a note reached the agent | agent called a thinker tool |', '|---|---:|---:|---:|---:|',
  ...Object.entries(coverage).sort().map(([m, c]) => `| ${m} | ${c.pairs} | ${c.recorded} | ${c.reached}${c.recorded ? ` (${Math.round(c.reached / c.recorded * 100)}% of recorded)` : ''} | ${c.asked} |`)].join('\n');
const excluded = [
  ...Object.entries(EXCLUDED_DIRS).map(([d, why]) => `- \`${d}\`: ${why}`),
  ...[...UNPRICED_DIRS].map(d => `- \`${d}\`: calls counted, spend not priced (cached input double-counted in in_tokens)`),
  `- ${P.dropped.length} pairs dropped: ${Object.entries(P.dropped.reduce((a, d) => (a[d.reason] = (a[d.reason] || 0) + 1, a), {})).map(([r, n]) => `${n} ${r}`).join(', ')}`,
];
const out = `### Coverage\n\n${covMd}\n\n### Effect by model, split by whether a note reached the agent\n\n${md}\n\n### Effect by repository, all models\n\n${byRepo.md}\n\n### Excluded\n\n${excluded.join('\n')}\n`;
console.log(out);
if (flag('json')) fs.writeFileSync(flag('json'), JSON.stringify({ coverage, groups: json, pairs: P.pairs, dropped: P.dropped }, null, 2));
if (flag('md')) fs.writeFileSync(flag('md'), out);
