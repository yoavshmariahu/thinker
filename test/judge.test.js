import test from 'node:test';
import assert from 'node:assert/strict';
import { GRADE_SCHEMA, JUDGE_SYSTEM_PROMPT, srcOnly, computeGradeScores } from '../bench/judge-protocol.js';

test('judge protocol schema and prompt invariants', () => {
  assert.equal(GRADE_SCHEMA.type, 'object');
  assert.ok(GRADE_SCHEMA.properties.results);
  assert.ok(JUDGE_SYSTEM_PROMPT.includes('REPOSITORY CONTRACTS & DELEGATION'));
  assert.ok(JUDGE_SYSTEM_PROMPT.includes('UNCLEAR'));
  assert.ok(JUDGE_SYSTEM_PROMPT.includes('CODE EVIDENCE OVER AUTHOR CLAIMS'));
});

test('computeGradeScores calculates essential and strict pass accurately', () => {
  const criteria = [
    { id: 'c1', essential: true, calibrated: true },
    { id: 'c2', essential: true, calibrated: true },
    { id: 'c3', essential: false, calibrated: true },
    { id: 'c4', essential: false, calibrated: false } // ignored (uncalibrated)
  ];

  // All essential met
  const grade1 = computeGradeScores(criteria, [
    { id: 'c1', verdict: 'met' },
    { id: 'c2', verdict: 'met' },
    { id: 'c3', verdict: 'not_met' },
    { id: 'c4', verdict: 'met' }
  ]);
  assert.equal(grade1.essential, 1.0);
  assert.equal(grade1.all, 2 / 3);
  assert.equal(grade1.pass, true);

  // Essential criterion unclear -> fails pass
  const grade2 = computeGradeScores(criteria, [
    { id: 'c1', verdict: 'met' },
    { id: 'c2', verdict: 'unclear' },
    { id: 'c3', verdict: 'met' }
  ]);
  assert.equal(grade2.essential, 0.5);
  assert.equal(grade2.all, 2 / 3);
  assert.equal(grade2.pass, false);
});

test('srcOnly filters out test files and snapshot fixtures from diff', () => {
  const diff = `diff --git a/pkg/service/store.go b/pkg/service/store.go
--- a/pkg/service/store.go
+++ b/pkg/service/store.go
@@ -1,3 +1,4 @@
+func Delete() error { return nil }
diff --git a/pkg/service/store_test.go b/pkg/service/store_test.go
--- a/pkg/service/store_test.go
+++ b/pkg/service/store_test.go
@@ -1,3 +1,4 @@
+func TestDelete(t *testing.T) {}
`;
  const filtered = srcOnly(diff);
  assert.ok(filtered.includes('pkg/service/store.go'));
  assert.ok(!filtered.includes('store_test.go'));
});
