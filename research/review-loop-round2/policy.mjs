// Research-only deterministic reconciliation. No edits, publication, or merge authority.
export const ACTIONS = ['verify_existing', 'inspect_callers', 'investigate_remaining', 'finalize', 'manual_review'];
export function route(answers, state, policy) {
  const choice = (key, values) => {
    const value = answers?.[key]?.choice;
    if (!values.includes(value)) throw Error('Missing or invalid judgment: ' + key);
    return value;
  };
  const action = choice('next_action', ACTIONS);
  const support = choice('claim_support', ['supported','overclaimed','contradicted','insufficient']);
  const coverage = choice('coverage', ['accounted_for','gap','unknown']);
  const intent = choice('intent_status', ['settled','needs_human']);
  const unresolved = [];
  if (intent === 'needs_human') unresolved.push('Requirements need a human intent/precedence decision.');
  if (support !== 'supported') unresolved.push('Claim support: ' + support);
  if (coverage !== 'accounted_for') unresolved.push('Bounded coverage: ' + coverage);
  if (policy === 'v2') return {action, reason: 'Action preference only (unresolved judgments are observational).', unresolved};
  if (policy !== 'v3') throw Error('Unknown policy');
  if (intent === 'needs_human') return {action: 'manual_review', reason: 'Human intent takes precedence over action preference.', unresolved};
  if (action === 'manual_review') return {action, reason: 'Explicit manual-review selection.', unresolved};
  if (support !== 'supported') return {
    action: action === 'inspect_callers' ? action : state.findings.length ? 'verify_existing' : 'investigate_remaining',
    reason: 'Resolve or qualify unsupported claims before finalizing.', unresolved
  };
  if (coverage !== 'accounted_for') return {action: action === 'inspect_callers' ? action : 'investigate_remaining', reason: 'Investigate a bounded coverage concern before finalizing.', unresolved};
  return {action, reason: 'No blocking semantic judgment; use action preference.', unresolved};
}

export function stopReason(decision, roundsUsed, signature, seen) {
  if (['finalize','manual_review'].includes(decision.action)) return decision.action;
  if (roundsUsed >= 2) return 'incomplete_budget';
  if (seen.has(signature)) return 'incomplete_stalled';
  return null;
}
