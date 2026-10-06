import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deferLearning, safeLearningAssessments } from '../src/learning-pending.js';

test('session contradictions are reviewable and repeated discovery does not duplicate or mutate notes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-pending-'));
  try {
    const note = { id: 'rule', kind: 'rule', body: 'Never retry charges without an idempotency key.' };
    const behavior = { id: 'human', kind: 'behavior', body: 'Keep the human requirement.' };
    const store = { dir, get: id => ({ rule: note, human: behavior })[id] };
    const assessment = { id: 'rule', verdict: 'contradicted', correction: 'Always retry charges.' };
    const { accepted, deferred } = safeLearningAssessments(store, [assessment, { id: 'human', verdict: 'unused' }, { id: 'rule', verdict: 'confirmed' }]);
    assert.deepEqual(accepted, [{ id: 'rule', verdict: 'confirmed' }]);
    assert.equal(deferred.length, 1);
    const options = { source: { type: 'agent', ref: 'session-a' }, evidenceRef: '/recorded/session.jsonl' };
    const first = deferLearning(store, deferred, options);
    assert.deepEqual(deferLearning(store, deferred, options), first);
    assert.equal(fs.readdirSync(path.dirname(first[0])).length, 1);
    const saved = JSON.parse(fs.readFileSync(first[0], 'utf8'));
    assert.equal(saved.assessment.correction, assessment.correction);
    assert.equal(saved.evidenceRef, options.evidenceRef);
    assert.equal(note.body, saved.existing.body);
    const shown = { ...note };
    note.body = 'A concurrent session changed this rule.';
    assert.deepEqual(safeLearningAssessments(store, [{ id: 'rule', verdict: 'confirmed' }], [shown]), { accepted: [], deferred: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
