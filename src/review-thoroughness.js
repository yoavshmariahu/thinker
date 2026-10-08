// An audit of the review's second looks, not a claim that a second look establishes correctness.
// The `verify` strategy re-checks every error and warning with another model call; this record
// keeps what each check was shown and what it changed, so a person can judge whether the call
// added evidence. Until 2026-10-08 it also recorded the Jev step gates that chose the optional
// steps; those went with Jev (research/jev-sol-opus-ten: same catches, 86% more tokens).

export function startThoroughness({ dry = false } = {}) {
  return { version: 2, assessment: 'unassessed', dry, verifications: [] };
}

export function finishThoroughness(report, { dry = false } = {}) {
  const t = report.thoroughness;
  if (!t) return;
  const calls = t.verifications;
  t.verify = dry ? 'not-run' : !report.verified ? 'not-requested' : !calls.length ? 'no-eligible-findings' : calls.some(v => v.outcome === 'error') ? 'incomplete' : 'completed';
  t.summary = { calls: calls.length, retained: calls.filter(v => v.outcome === 'retained').length,
    dropped: calls.filter(v => v.outcome === 'dropped').length,
    severityChanged: calls.filter(v => v.outcome === 'retained' && v.before.severity !== v.after.severity).length,
    errors: calls.filter(v => v.outcome === 'error').length,
    tokens: calls.every(v => Number.isFinite(v.tokens)) ? calls.reduce((n, v) => n + v.tokens, 0) : null,
    // Calls may overlap: this is summed call duration, never review wall time.
    callDurationMs: calls.reduce((n, v) => n + v.elapsedMs, 0) };
}

const text = s => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/[<>&|`]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '|': '&#124;', '`': '&#96;' }[c]));
// Rendered only when a second look was made: a review that made none has nothing to audit.
export function renderThoroughness(t) {
  if (!t?.verifications?.length) return '';
  const s = t.summary || {};
  const L = ['### Review thoroughness', '',
    `Finding verification (${text(t.verify)}): ${s.calls} attempt${s.calls === 1 ? '' : 's'}; ${s.retained} retained, ${s.dropped} dropped, ${s.severityChanged} severity change${s.severityChanged === 1 ? '' : 's'}, ${s.errors} error${s.errors === 1 ? '' : 's'}${s.tokens === null ? '; token usage unknown' : `; ${s.tokens} tokens`}; ${s.callDurationMs} ms of summed call time.`];
  for (const v of t.verifications) {
    L.push('', `- ${text(v.before.file)}:${v.before.line || 0}: ${text(v.outcome)}${v.after ? ` (${text(v.before.severity)} → ${text(v.after.severity)})` : ''}. Original claim: ${text(v.before.message)}`);
    L.push(`  - Original evidence: ${text(v.before.evidence || 'None supplied.')}`);
    L.push(`  - ${v.outcome === 'error' ? 'Check failed' : 'Verifier explanation (model reading)'}: ${text(v.reason || 'No explanation returned.')}`);
  }
  L.push('', 'Added value: not yet adjudicated. A retained finding alone does not show that verification added evidence. Compare the original claim and evidence with the verifier explanation before counting it.');
  return L.join('\n');
}
