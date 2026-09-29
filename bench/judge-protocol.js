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
