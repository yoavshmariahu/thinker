// Loop-to-done evals (codex-run.js --loop): one solver session keeps working, resumed with a
// checker's feedback, until every acceptance criterion decided up front is met or a limit is hit.
// The PR's own tests still grade the end and are never shown to the solver or the checker.
// This module holds the pure pieces, so the runner stays a thin driver and the rules are tested.

export const LOOP_DEFAULTS = { iterations: 4, iterationMin: 10, sessionMin: 30, tokenCap: null };

export function loopLimits(flags = {}) {
  const num = (v, d) => (v == null || v === true || v === '' ? d : Number(v));
  const l = {
    iterations: num(flags.iterations, LOOP_DEFAULTS.iterations),
    iterationMin: num(flags['iteration-min'], LOOP_DEFAULTS.iterationMin),
    sessionMin: num(flags['session-min'], LOOP_DEFAULTS.sessionMin),
    tokenCap: num(flags['token-cap'], LOOP_DEFAULTS.tokenCap),
  };
  for (const [k, v] of Object.entries(l)) if (v != null && !(Number.isFinite(v) && v > 0)) throw new Error(`--loop: ${k} must be a positive number`);
  return l;
}

// A task's acceptance criteria, as the task file holds them: [{ id, criterion, check?, command?, essential? }].
// Written from the request and the base code only, never from the gold diff or tests (bench/AGENTS.md).
export function acceptanceOf(task) {
  const a = Array.isArray(task?.acceptance) ? task.acceptance : [];
  return a.filter(c => c && c.id && c.criterion).map(c => ({ ...c, essential: c.essential !== false }));
}

// Appended to the request in every arm, so the solver knows what "done" means from the start.
export function criteriaBlock(acceptance) {
  return `\n\nACCEPTANCE CRITERIA. When you stop, a separate checker verifies each of these against your working tree; if any is not met you will be told which and asked to continue:\n` +
    acceptance.map(c => `- ${c.id}: ${c.criterion}${c.command ? ` (checked with: ${c.command})` : ''}`).join('\n');
}

export const CHECKER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['results'],
  properties: { results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'met', 'evidence'], properties: { id: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } } } } },
};

export function checkerPrompt(request, acceptance) {
  return `You check whether a code change in this working tree meets its acceptance criteria. You did not write it. ` +
    `Inspect the change (git diff, git status) and the code, and run whatever helps you decide: the commands given, tests, scripts. ` +
    `Judge each criterion on what you observe, not on comments or the author's claims. Do not edit files to make a criterion pass.\n\n` +
    `REQUEST THE CHANGE ANSWERS:\n${request}\n\nCRITERIA:\n` +
    acceptance.map(c => `- ${c.id}${c.essential ? ' (essential)' : ''}: ${c.criterion}${c.command ? `\n  command: ${c.command}` : ''}`).join('\n') +
    `\n\nReturn JSON {"results":[{"id","met","evidence"}]} with one entry per criterion; evidence is what you ran or read and what it showed, in a few lines.`;
}

// The checker's answer against the criteria: a criterion it did not report is not met. Done means every
// essential criterion met; the harness decides it, not the checker.
export function verdict(acceptance, results) {
  const by = new Map((Array.isArray(results) ? results : []).filter(r => r && r.id).map(r => [String(r.id), r]));
  const out = acceptance.map(c => {
    const r = by.get(String(c.id));
    return { id: c.id, essential: c.essential, met: r?.met === true, evidence: r ? String(r.evidence || '') : 'not reported by the checker' };
  });
  return { results: out, done: out.every(r => r.met || !r.essential) };
}

// What the solver is told between iterations: the unmet criteria and the checker's evidence, no fix.
export function feedback(acceptance, v) {
  const unmet = v.results.filter(r => !r.met);
  const text = new Map(acceptance.map(c => [c.id, c.criterion]));
  return `A checker reviewed your working tree against the acceptance criteria. Not met yet:\n` +
    unmet.map(r => `- ${r.id}${r.essential ? '' : ' (optional)'}: ${text.get(r.id)}\n  checker's evidence: ${r.evidence.slice(0, 1500)}`).join('\n') +
    `\n\nContinue until every criterion is met, then summarize what you changed.`;
}

// `codex exec resume` reports the thread's cumulative usage on each turn (verified on codex-cli 0.162.1:
// 15.6k → 32.2k → 48.8k over three resumed turns), so an iteration's own usage is the difference.
export function usageDelta(prev, total) {
  const d = k => Math.max(0, (total?.[k] || 0) - (prev?.[k] || 0));
  return { input_tokens: d('input_tokens'), cached_input_tokens: d('cached_input_tokens'), output_tokens: d('output_tokens') };
}

// Why the loop stops after iteration n, or null to go on. A limit hit is an outcome (not done within
// the budget), not an invalid session.
export function stopReason({ done, n, limits, elapsedMs, solverInTokens, timedOut }) {
  if (done) return 'done';
  if (timedOut) return 'iteration_timeout';
  if (elapsedMs >= limits.sessionMin * 60_000) return 'session_timeout';
  if (limits.tokenCap != null && solverInTokens >= limits.tokenCap) return 'token_cap';
  if (n >= limits.iterations) return 'max_iterations';
  return null;
}
