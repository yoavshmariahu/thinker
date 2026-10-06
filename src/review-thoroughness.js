// An audit of review effort, not a claim that additional effort establishes correctness.
import { GATES, changeRecord } from './gates.js';

export function startThoroughness(g, requested, effective, change, symbols, { dry = false, baseline = false } = {}) {
  const selected = { worth_reviewing: g?.source === 'jev' ? g.gates.worth_reviewing.run : true,
    callers: !!effective.callers, chunks: (effective.chunks || 1) > 1,
    verify: !!effective.verify, tests: g?.source === 'jev' && g.gates.tests.run || false };
  return { version: 1, assessment: 'unassessed', gateSource: dry ? 'dry-run' : baseline ? 'baseline' : g?.source || 'default',
    gateInput: g?.source === 'jev' ? changeRecord(change, symbols) : null,
    decisions: Object.entries(GATES).map(([step, policy]) => {
      const key = step === 'chunks' ? 'chunks' : policy.strategy;
      const explicit = key && requested[key] !== undefined;
      return { step, source: dry ? 'dry-run' : explicit ? 'caller' : baseline ? 'baseline' : g?.source === 'jev' ? 'jev' : g?.source === 'error' ? 'fallback' : 'default',
        score: g?.gates?.[step]?.p ?? null, threshold: policy.act,
        recommended: g?.source === 'jev' ? g.gates[step].run : null,
        selected: selected[step], status: dry ? 'not-run' : 'pending',
        question: policy.instructions, criterion: policy.criteria.true,
        // Jev provides a score, not a case-specific explanation. Never invent one from the score.
        caseReason: null };
    }), verifications: [] };
}

export function finishThoroughness(report, { dry = false, callers = '' } = {}) {
  const t = report.thoroughness;
  if (!t) return;
  for (const d of t.decisions) {
    if (dry) { d.status = 'not-run'; continue; }
    if (d.step === 'tests') { d.status = d.selected ? 'recommended-only' : 'not-recommended'; continue; }
    if (d.step === 'worth_reviewing') { d.status = report.verdicts.length ? 'assessed' : report.errors.length ? 'failed' : d.selected ? 'no-assessment' : 'skipped'; continue; }
    if (!d.selected) { d.status = 'skipped'; continue; }
    if (d.step === 'callers') d.status = callers ? 'context-collected' : 'no-context-found';
    if (d.step === 'chunks') d.status = report.chunks > 1 ? 'split-prepared' : 'not-needed';
    if (d.step === 'verify') d.status = !t.verifications.length ? 'no-eligible-findings' : t.verifications.some(v => v.outcome === 'error') ? 'incomplete' : 'completed';
  }
  const calls = t.verifications;
  t.summary = { calls: calls.length, retained: calls.filter(v => v.outcome === 'retained').length,
    dropped: calls.filter(v => v.outcome === 'dropped').length,
    severityChanged: calls.filter(v => v.outcome === 'retained' && v.before.severity !== v.after.severity).length,
    errors: calls.filter(v => v.outcome === 'error').length,
    tokens: calls.every(v => Number.isFinite(v.tokens)) ? calls.reduce((n, v) => n + v.tokens, 0) : null,
    // Calls may overlap: this is summed call duration, never review wall time.
    callDurationMs: calls.reduce((n, v) => n + v.elapsedMs, 0) };
}

const text = s => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/[<>&|`]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '|': '&#124;', '`': '&#96;' }[c]));
const names = { worth_reviewing: 'Code assessment', callers: 'Caller context', chunks: 'Split review', verify: 'Verify findings', tests: 'Run tests' };
export function renderThoroughness(t) {
  if (!t) return '';
  const L = ['### Review thoroughness', '', '| Decision | What happened | Basis |', '|---|---|---|'];
  for (const d of t.decisions) {
    const basis = d.source === 'caller' ? 'Explicit caller setting' : d.source === 'fallback' ? 'Jev unavailable; configured/default setting retained' : d.source === 'baseline' ? 'Baseline configuration; Jev not evaluated' : d.source === 'dry-run' ? 'Dry run; no model execution' : d.source === 'default' ? 'Default configuration; Jev not evaluated' : 'Jev';
    const score = d.score === null ? '' : `; score ${d.score}, threshold ${d.threshold}; recommended ${d.recommended ? 'yes' : 'no'}`;
    const question = d.score === null ? '' : `. Gate question: ${d.question.replaceAll('`the_change.changed_lines`', 'the changed lines').replaceAll('`the_change`', 'this change')}`;
    L.push(`| ${names[d.step] || text(d.step)} | ${text(d.status)} | ${text(basis + score + question)} |`);
  }
  L.push('', 'Scores reflect the gate policy, not a case-specific justification. Test recommendations do not establish execution. Skipped steps have not been checked for missed findings.');
  if (t.summary) {
    const s = t.summary;
    L.push('', `Finding verification: ${s.calls} attempt${s.calls === 1 ? '' : 's'}; ${s.retained} retained, ${s.dropped} dropped, ${s.severityChanged} severity changes, ${s.errors} errors${s.tokens === null ? '; tokens unknown' : `; ${s.tokens} tokens`}.`);
  }
  for (const v of t.verifications) {
    L.push('', `- ${text(v.before.file)}:${v.before.line || 0}: ${text(v.outcome)}${v.after ? ` (${text(v.before.severity)} → ${text(v.after.severity)})` : ''}. Original claim: ${text(v.before.message)}`);
    L.push(`  - Original evidence: ${text(v.before.evidence || 'None supplied.')}`);
    L.push(`  - ${v.outcome === 'error' ? 'Check failed' : 'Verifier explanation (model reading)'}: ${text(v.reason || 'No explanation returned.')}`);
  }
  if (t.verifications.length) L.push('', 'Added value: not yet adjudicated. A retained finding alone does not show that verification added evidence. Compare the original claim and evidence with the verifier explanation and saved code context.');
  return L.join('\n');
}
