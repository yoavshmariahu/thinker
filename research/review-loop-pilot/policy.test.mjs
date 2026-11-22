import test from 'node:test';
import assert from 'node:assert/strict';
import {route, stoppingReason} from './policy.mjs';

test('ambiguous harmless actions need not imply a human-intent blocker', () => {
  const a = {choice: 'verify_existing', confidence: 0.27};
  assert.equal(route(a, 'v1'), 'manual_review');
  assert.equal(route(a, 'v2'), 'verify_existing');
});
test('unknown actions cannot enter the controller', () => {
  assert.throws(() => route({choice: 'edit_source', confidence: 1}, 'v2'));
});
test('different hypotheses cannot reset the action ceiling', () => {
  for (const action of ['verify_existing','inspect_callers','investigate_remaining']) {
    assert.equal(stoppingReason(action, 2, 'new-evidence-signature', new Set()), 'budget_exhausted');
  }
});
test('an unchanged action and evidence cannot loop', () => {
  assert.equal(stoppingReason('verify_existing', 1, 'same', new Set(['same'])), 'stalled');
  assert.equal(stoppingReason('verify_existing', 1, 'changed', new Set(['same'])), null);
});
test('finalizing a report does not mean a defect is resolved', () => {
  assert.equal(stoppingReason('manual_review', 0, '', new Set()), 'manual_review');
  assert.equal(stoppingReason('finalize', 2, '', new Set()), 'finalize');
});
