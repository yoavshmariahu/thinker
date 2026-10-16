// An experiment is one run directory: a set of PRs (tasks) in one repository, run with the cache
// off and with it on, to answer one question about a behavior or a model. Its definition lives in
// bench/runs/<tag>/experiment.json beside the results, so it is versioned with them; runs from
// before the app have none and get one inferred from their arms until somebody writes it.
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE_ARMS } from './normalize.js';
import { bootstrap, mean, median, METRICS } from './stats.js';

export const META_FILE = 'experiment.json';
export const KINDS = ['behavior', 'model'];
// the arm that is "the cache on", when an experiment does not say: the product's own wiring first
const ON_ARMS = ['cache', 'hook', 'full', 'thinker', 'after', 'live', 'rerank', 'prompt'];

export function readMeta(benchDir, dir) {
  try { return JSON.parse(fs.readFileSync(path.join(benchDir, 'runs', dir, META_FILE), 'utf8')); } catch { return null; }
}

// The stored definition, or one inferred from the arms present. `defined` says which.
export function resolveMeta(stored, arms) {
  const off = stored?.off && arms.includes(stored.off) ? stored.off : BASELINE_ARMS.find(a => arms.includes(a)) || null;
  const on = stored?.on && arms.includes(stored.on) ? stored.on : ON_ARMS.find(a => arms.includes(a) && a !== off) || arms.find(a => a !== off) || null;
  return {
    defined: Boolean(stored),
    name: stored?.name || null, question: stored?.question || null,
    kind: KINDS.includes(stored?.kind) ? stored.kind : null,
    off, on, others: arms.filter(a => a !== off && a !== on),
    created_at: stored?.created_at || null, launched: stored?.launched || null, modules: stored?.modules || null,
  };
}

const TEXT = /^[^\u0000-\u001f]{0,300}$/;
export function writeMeta(benchDir, dir, input, arms) {
  const runDir = path.join(benchDir, 'runs', dir);
  if (!path.resolve(runDir).startsWith(path.resolve(benchDir, 'runs') + path.sep) || !fs.existsSync(runDir)) throw new Error('no such experiment');
  const prev = readMeta(benchDir, dir) || {};
  const m = { ...prev };
  for (const k of ['name', 'question']) if (input[k] != null) { if (!TEXT.test(String(input[k]))) throw new Error(`${k} is too long or has control characters`); m[k] = String(input[k]).trim(); }
  if (input.kind != null) { if (!KINDS.includes(input.kind)) throw new Error('kind is behavior or model'); m.kind = input.kind; }
  for (const k of ['off', 'on']) if (input[k] != null) { if (arms && !arms.includes(input[k])) throw new Error(`${input[k]} is not an arm of this experiment`); m[k] = input[k]; }
  if (m.off && m.off === m.on) throw new Error('cache off and cache on must be different arms');
  m.created_at ||= Date.now();
  fs.writeFileSync(path.join(runDir, META_FILE), JSON.stringify(m, null, 2) + '\n');
  return m;
}

// One side of the comparison: what the arm achieved over its valid results.
function side(rs) {
  const ok = rs.filter(r => !r.invalid), graded = ok.filter(r => r.pass != null);
  return {
    n: rs.length, valid: ok.length, graded: graded.length, passed: graded.filter(r => r.pass).length,
    pass_rate: graded.length ? graded.filter(r => r.pass).length / graded.length : null,
    score: mean(ok.map(r => r.score)),
    in_tokens: median(ok.map(r => r.in_tokens)), fresh_in: median(ok.map(r => r.fresh_in)), cache_read: median(ok.map(r => r.cache_read)),
    out_tokens: median(ok.map(r => r.out_tokens)), tool_calls: median(ok.map(r => r.tool_calls)), wall_ms: median(ok.map(r => r.wall_ms)),
    cost: median(ok.map(r => r.cost)), cost_total: ok.reduce((s, r) => s + (r.cost || 0), 0),
    served: ok.filter(r => r.served).length,
    done: mean(ok.map(r => r.done)), iterations: median(ok.map(r => r.iterations)), false_done: mean(ok.map(r => r.false_done)),
  };
}

const KEY = r => `${r.task}#${r.rep}`;
const delta = (pairs, k) => bootstrap(pairs.map(({ off, on }) => (off[k] == null || on[k] == null ? null : on[k] - off[k])));
const block = pairs => Object.fromEntries(METRICS.map(m => [m.key, delta(pairs, m.key)]));

// The comparison over (PR, rep) pairs where both sides are valid: each side's summary, the paired
// differences on − off (all pairs, and the pairs where the cache arm was served a note), and per PR.
export function compare(rows, off, on, taskInfo = new Map()) {
  const offRows = rows.filter(r => r.arm === off), onRows = rows.filter(r => r.arm === on);
  const offBy = new Map(offRows.filter(r => !r.invalid).map(r => [KEY(r), r]));
  const pairs = onRows.filter(r => !r.invalid && offBy.has(KEY(r))).map(r => ({ on: r, off: offBy.get(KEY(r)) }));
  const served = pairs.filter(p => p.on.served);
  const tasks = [...new Set([...offRows, ...onRows].map(r => r.task))].sort();
  const prs = tasks.map(task => {
    const o = offRows.filter(r => r.task === task), n = onRows.filter(r => r.task === task);
    const so = side(o), sn = side(n);
    const tp = pairs.filter(p => p.on.task === task);
    const change = so.pass_rate == null || sn.pass_rate == null ? null : sn.pass_rate > so.pass_rate ? 'gained' : sn.pass_rate < so.pass_rate ? 'lost' : so.pass_rate === 1 ? 'both pass' : so.pass_rate === 0 ? 'both fail' : 'same';
    const cell = r => ({ id: r.id, rep: r.rep, pass: r.pass, score: r.score, invalid: r.invalid, in_tokens: r.in_tokens, tool_calls: r.tool_calls, wall_ms: r.wall_ms, served: r.served, injected: r.injected });
    return {
      task, title: taskInfo.get(task)?.title || null, pr: taskInfo.get(task)?.pr || null,
      off: { ...so, results: o.sort((a, b) => a.rep - b.rep).map(cell) }, on: { ...sn, results: n.sort((a, b) => a.rep - b.rep).map(cell) },
      change,
      d_in_tokens: mean(tp.map(p => (p.on.in_tokens ?? NaN) - (p.off.in_tokens ?? NaN))),
      d_tool_calls: mean(tp.map(p => (p.on.tool_calls ?? NaN) - (p.off.tool_calls ?? NaN))),
      d_wall_ms: mean(tp.map(p => (p.on.wall_ms ?? NaN) - (p.off.wall_ms ?? NaN))),
    };
  });
  const graders = [...new Set([...offRows, ...onRows].filter(r => !r.invalid && r.pass != null).map(r => r.outcome_source + (r.judge ? ` · ${r.judge}` : '')))];
  // both columns are over the paired sessions, so they describe the same set as the difference
  return {
    off, on, offSide: side(pairs.map(p => p.off)), onSide: side(pairs.map(p => p.on)),
    pairs: pairs.length, served: served.length,
    unpaired: { off: offRows.filter(r => !r.invalid).length - pairs.length, on: onRows.filter(r => !r.invalid).length - pairs.length },
    delta: block(pairs), deltaServed: block(served),
    servedOffSide: side(served.map(p => p.off)), servedOnSide: side(served.map(p => p.on)),
    counts: {
      gained: prs.filter(p => p.change === 'gained').length, lost: prs.filter(p => p.change === 'lost').length,
      bothPass: prs.filter(p => p.change === 'both pass').length, bothFail: prs.filter(p => p.change === 'both fail').length,
    },
    prs, graders,
  };
}

export function verdict(d, better) {
  if (!d || d.mean == null) return 'none';
  if (d.lo == null) return 'too few pairs';
  if (d.lo <= 0 && d.hi >= 0) return 'no clear difference';
  return (better === 'up') === (d.mean > 0) ? 'better' : 'worse';
}
