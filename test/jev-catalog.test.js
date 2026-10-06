import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL, batches, catalogCard, catalogRequest, relationRequest, readScores, readRelations } from '../bench/jev-eval/catalog.mjs';

const note = (id, extra = {}) => ({ id, title: `Rule ${id}`, kind: 'rule', body: 'Run migrations before starting the server. Never run them in read-only replicas.', deps: [], ...extra });

test('catalog batching retains every note and never clips a late negative constraint', () => {
  const notes = Array.from({ length: 100 }, (_, i) => note(`n-${i}`));
  const groups = batches(notes, 'search', 500);
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flat().map(n => n.id), notes.map(n => n.id));
  assert.match(catalogCard(notes[99]).description, /Never run them in read-only replicas/);
  assert.throws(() => batches([note('large', { body: 'x'.repeat(600) })], 'body', 500), /exceeds/);
});

test('summary selection can use a description but reconciliation must use the complete note', () => {
  const n = note('a', { search: 'Database initialization.', applies: 'Primary nodes only.' });
  const catalog = catalogRequest('Replica migration', [n], 'search');
  assert.equal(catalog.state.notes[0].description, n.search);
  const relation = relationRequest('Replicas now run migrations', [n]);
  assert.equal(relation.state.notes[0].body, n.body);
  assert.equal(relation.state.notes[0].applies, n.applies);
  assert.equal(relation.state.notes[0].search, undefined);
  assert.equal(relation.questions.n0.type, 'choice');
});

test('a model mismatch or partial response invalidates the experiment rather than selecting a partial set', () => {
  const notes = [note('a'), note('b')];
  assert.throws(() => readScores({ model: 'different-model', answers: {} }, notes), /invalid comparison/);
  assert.throws(() => readScores({ model: MODEL, answers: { n0: { noul: 0.9 } } }, notes), /invalid catalog score/);
  for (const p of [-1, 1.1, '0.8', null]) assert.throws(() => readScores({ model: MODEL, answers: { n0: { noul: p } } }, [notes[0]]), /invalid catalog score/);
});

test('relationship parsing rejects invented labels and malformed probability distributions', () => {
  const n = note('a');
  const a = { choice: 'extends', confidence: 0.8, probabilities: { covered: 0.1, extends: 0.8, contradicts: 0.05, unrelated: 0.05 } };
  assert.equal(readRelations({ model: MODEL, answers: { n0: a } }, [n])[0].relation, 'extends');
  assert.throws(() => readRelations({ model: MODEL, answers: { n0: { ...a, choice: 'delete' } } }, [n]), /invalid relation/);
  assert.throws(() => readRelations({ model: MODEL, answers: { n0: { ...a, probabilities: { ...a.probabilities, covered: 1 } } } }, [n]), /probabilities/);
});
