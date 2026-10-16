// Standardized acceptance-criteria judge protocol, schema, and decision rules.

export const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'not_met', 'unclear'] },
          evidence: { type: 'string' }
        },
        required: ['id', 'verdict', 'evidence']
      }
    }
  },
  required: ['results']
};

export const JUDGE_SYSTEM_PROMPT = `You evaluate code patches against acceptance criteria. For each criterion, determine whether the code after the patch exhibits the required observable behaviour: 'met', 'not_met', or 'unclear'.

DECISION RULES & PROTOCOL:
1. ANY VALID DESIGN COUNTS: Do not require a particular file, layer, variable name, or implementation strategy. Any code structure that delivers the observable behaviour is valid.
2. REPOSITORY CONTRACTS & DELEGATION: If the patch delegates to an existing helper, repository method, or standard library function (e.g. resolveName, getByID, IsNotFound) whose definition is not fully shown in the context, assume the existing helper satisfies its established contract unless visible code contradicts it. Do NOT return 'unclear' merely because a referenced pre-existing function's body is outside the diff window.
3. UNCHANGED SURROUNDING CODE COUNTS: Behaviour provided by unchanged surrounding code counts as 'met' when a criterion asks that existing functionality continues to work.
4. 'UNCLEAR' IS A STRICT LAST RESORT: Reserve 'unclear' ONLY for cases where the logical execution path is fundamentally unknowable from code structure alone (e.g. unconstrained dynamic reflection or missing new functions created by the patch). Never use 'unclear' as a substitute for checking standard error propagation or helper delegation.
5. CODE EVIDENCE OVER AUTHOR CLAIMS: The author's conversational summary is an unverified claim. A correct patch must not be penalized because the author omitted mentioning it in their summary; conversely, claims in the summary cannot override missing or flawed code.
6. QUOTE DECISIVE CODE: For each verdict, quote the specific lines of code that demonstrate your conclusion.`;

export const srcOnly = d => (d || '').split(/^(?=diff --git )/m).filter(c => !/^diff --git a\/\S*(test_|_test\.|\.test\.|\/tests?\/|__tests__|__snapshots__|\.ambr|\.snap)/.test(c)).join('');

export function computeGradeScores(criteria, results) {
  const by = Object.fromEntries(results.map(x => [x.id, x.verdict]));
  const usable = criteria.filter(c => c.calibrated !== false);
  const ess = usable.filter(c => c.essential);
  const frac = cs => cs.length ? cs.filter(c => by[c.id] === 'met').length / cs.length : 1;
  return {
    essential: frac(ess),
    all: frac(usable),
    pass: ess.every(c => by[c.id] === 'met'),
    results
  };
}

// The answer to a question about a codebase (bench/tasks/click.json), graded against the expert reference.
// One call: 1.0 every key fact and nothing contradicting, 0.5 main point right with specifics missing or one
// detail wrong, 0 otherwise. The grade names the model that graded it, so numbers only compare across the same
// judge (bench/run.js at the run, bench/regrade.js after it).
export const ANSWER_JUDGE_SCHEMA = { type: 'object', properties: { score: { type: 'number' }, missing: { type: 'array', items: { type: 'string' } }, wrong: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['score', 'missing', 'wrong', 'reason'] };
export const ANSWER_JUDGE_SYSTEM = 'You grade a coding agent\'s answer about a codebase against a reference answer written by an expert. Score 1.0 if every key fact in the reference is present and nothing in the answer contradicts the reference or the code; 0.5 if the main point is right but important specifics are missing or one detail is wrong; 0 if the answer is wrong, evasive, or contradicts the reference on the main point. List missing key facts and wrong claims. Extra correct detail is fine and not penalized. Do not penalize wording, ordering, or formatting.';
export async function judgeAnswer(task, answer, { model = 'sonnet', completeFn } = {}) {
  const complete = completeFn || (await import('../src/llm.js')).complete;
  const must = task.must || [];
  const mustHit = must.filter(m => new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(answer || ''));
  const res = await complete({ model, system: ANSWER_JUDGE_SYSTEM, prompt: `TASK:\n${task.prompt}\n\nREFERENCE ANSWER:\n${task.gold}\n\nAGENT ANSWER:\n${answer || ''}`, schema: ANSWER_JUDGE_SCHEMA });
  return { ...res.json, mustHit: mustHit.length, mustTotal: must.length, judge: model };
}
