import test from 'node:test';
import assert from 'node:assert/strict';
import { startThoroughness, finishThoroughness, renderThoroughness } from '../src/review-thoroughness.js';

const call = (outcome, before, after = null) => ({ before: { file: 'a.js', line: 3, severity: 'error', message: 'claim', evidence: 'ev', ...before }, outcome, after, reason: 'because', tokens: 5, elapsedMs: 7 });

test('a review that made no second look renders no thoroughness section', () => {
  const a = startThoroughness({});
  finishThoroughness({ thoroughness: a, verified: undefined });
  assert.equal(a.verify, 'not-requested');
  assert.equal(a.summary.calls, 0);
  assert.equal(renderThoroughness(a), '');
  const d = startThoroughness({ dry: true });
  finishThoroughness({ thoroughness: d }, { dry: true });
  assert.equal(d.verify, 'not-run');
});

test('verification calls are summed and rendered with their before and after evidence', () => {
  const a = startThoroughness({});
  a.verifications.push(call('retained', {}, { severity: 'warning' }), call('dropped', { line: 9 }), call('error', { line: 12, tokens: null }));
  a.verifications[2].tokens = null;
  finishThoroughness({ thoroughness: a, verified: { kept: 1, dropped: [] } });
  assert.equal(a.verify, 'incomplete');
  assert.deepEqual([a.summary.calls, a.summary.retained, a.summary.dropped, a.summary.severityChanged, a.summary.errors], [3, 1, 1, 1, 1]);
  assert.equal(a.summary.tokens, null, 'a failed call has unknown usage, never zero');
  const body = renderThoroughness(a);
  assert.match(body, /Review thoroughness/);
  assert.match(body, /a\.js:3: retained \(error → warning\)/);
  assert.match(body, /Check failed: because/);
  assert.match(body, /Added value: not yet adjudicated/);
  assert.equal(a.assessment, 'unassessed');
});
