// One benchmark record (bench/run.js, codex-run.js, gemini-run.js) → one flat result row.
// The runners grew their fields over several months; every variant seen under bench/runs is
// mapped here so the rest of the app reads one shape.

// Arms that are the "without the cache" side of a pair, in the order a run's baseline is chosen.
export const BASELINE_ARMS = ['nocache', 'before', 'control', 'baseline', 'none'];

// Run directories that bench/runs keeps for diagnosis only (.gitignore, research audits).
const INVALID_DIRS = [/^invalid(\/|$)/, /^empty-notes$/, /^efficiency-simple$/, /contaminated/];

const MAX_TURNS = 60;  // run.js --max-turns default: a session that hit it was cut off, not finished

const LIMIT_TEXT = /session limit|usage limit|rate limit|limit reached|hit your usage/i;

// The outcome a result is judged by, strongest evidence first: the PR's own tests, a criteria
// judge (essential criteria met), then the patch judge's 0 / 0.5 / 1 score.
export function outcome(rec, sidecar) {
  const g = rec.grade || {};
  if (g.tests === 'pass' || g.tests === 'fail') return { pass: g.tests === 'pass', source: 'tests', judge: null };
  if (rec.tests && typeof rec.tests === 'object' && typeof rec.tests.pass === 'boolean') return { pass: rec.tests.pass, source: 'tests', judge: null };
  const crit = g.criteria && typeof g.criteria.pass === 'boolean' ? g.criteria
    : typeof g.pass === 'boolean' ? g
    : sidecar && typeof sidecar.pass === 'boolean' ? sidecar : null;
  if (crit) {
    // criteria.js writes the judge on the grade; grades without one came from its default, sonnet.
    // criteriaBy holds the earlier judges' grades, not the current one.
    const judge = crit.judge || crit.model || (crit === sidecar ? sidecar.model : null) || 'sonnet (default)';
    return { pass: crit.pass, source: 'criteria', judge, essential: crit.essential ?? null, all: crit.all ?? null };
  }
  if (typeof g.score === 'number') {
    // orientation tasks (click) are scored on a continuous scale; only change tasks have a pass
    const change = rec.diff != null || g.mustTotal != null && Array.isArray(g.touched);
    return { pass: change ? g.score >= 1 : null, source: change ? 'patch-judge' : 'answer-judge', judge: g.judge || 'sonnet (default)' };
  }
  return { pass: null, source: null, judge: null };
}

export function invalidReason(rec, dir) {
  if (INVALID_DIRS.some(r => r.test(dir))) return 'diagnosis-only directory';
  if (rec.error && LIMIT_TEXT.test(String(rec.error))) return 'usage limit';
  if (rec.error) return 'runner error: ' + String(rec.error).slice(0, 120);
  if (rec.leak && rec.leak.length) return 'answer-key leak: saw ' + rec.leak.join(', ');
  if (rec.is_error) return 'agent session ended in error';
  if (!rec.turns && !rec.num_turns && !rec.usage) return 'no turns recorded';
  if ((rec.turns || 0) <= 1 && LIMIT_TEXT.test(rec.result || '')) return 'usage limit';
  if (rec.timed_out) return 'timed out';
  if ((rec.turns || 0) >= MAX_TURNS && !rec.usage) return `hit the ${MAX_TURNS}-turn cap`;
  if (rec.grade && rec.grade.error && !rec.grade.tests) return 'grading failed: ' + String(rec.grade.error).slice(0, 120);
  return null;
}

export function tokens(rec) {
  if (rec.usage && typeof rec.usage === 'object' && rec.in_tokens == null) {
    const u = rec.usage;
    const fresh = u.input_tokens || 0, read = u.cache_read_tokens || u.cached_input_tokens || 0;
    return { in: fresh + read, fresh, cacheRead: read, cacheWrite: 0, out: (u.output_tokens || 0) + (u.thinking_tokens || 0) };
  }
  const read = rec.cache_read_tokens ?? null, write = rec.cache_write_tokens ?? null;
  return { in: rec.in_tokens ?? null, fresh: rec.fresh_in_tokens ?? null, cacheRead: read, cacheWrite: write, out: rec.out_tokens ?? null };
}

export function normalize(rec, { dir, file, mtime, sidecar = null, repo = null }) {
  const o = outcome(rec, sidecar);
  const t = tokens(rec);
  const tools = rec.tools || {};
  const injected = Array.isArray(tools.injected) ? tools.injected.length : 0;
  const thinkerCalls = tools.thinkerCalls || 0;
  return {
    id: `${dir}/${rec.id || file.replace(/\.json$/, '')}`,
    run: dir, task: String(rec.task ?? ''), area: rec.area || null, arm: String(rec.arm), rep: Number(rec.rep) || 0,
    repo, model: rec.model || null, effort: rec.effort || null,
    actual_models: Array.isArray(rec.actualModels) ? rec.actualModels.join(',') : null,
    turns: rec.turns ?? rec.num_turns ?? null,
    wall_ms: rec.wall_ms ?? (rec.wall_sec ? Number(rec.wall_sec) * 1000 : null),
    cost: rec.cost ?? rec.cost_usd ?? null,
    in_tokens: t.in, fresh_in: t.fresh, cache_read: t.cacheRead, cache_write: t.cacheWrite, out_tokens: t.out,
    tool_calls: tools.calls ?? null, files_read: typeof tools.filesRead === 'number' ? tools.filesRead : null,
    calls_before_edit: tools.callsBeforeFirstEdit ?? null,
    thinker_calls: thinkerCalls, injected,
    // served: the cache arm put at least one note in front of the agent
    served: injected > 0 || thinkerCalls > 0 ? 1 : 0,
    pass: o.pass == null ? null : o.pass ? 1 : 0,
    score: typeof rec.grade?.score === 'number' ? rec.grade.score : (o.all ?? null),
    outcome_source: o.source, judge: o.judge,
    invalid: invalidReason(rec, dir),
    mtime,
    file,
  };
}
