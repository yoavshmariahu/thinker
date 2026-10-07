// Research policies only. Neither authorizes edits nor publishes findings.
export function route(answer, policy = 'v1') {
  const allowed = ['verify_existing', 'inspect_callers', 'investigate_remaining', 'finalize', 'manual_review'];
  if (!answer || !allowed.includes(answer.choice)) throw Error('Invalid action judgment');
  if (policy === 'v1') return answer.confidence >= 0.6 ? answer.choice : 'manual_review';
  if (policy === 'v2') return answer.choice;
  throw Error('Unknown research policy');
}

export function stoppingReason(action, roundsUsed, signature, seen) {
  if (['finalize', 'manual_review'].includes(action)) return action;
  if (roundsUsed >= 2) return 'budget_exhausted';
  if (seen.has(signature)) return 'stalled';
  return null;
}
