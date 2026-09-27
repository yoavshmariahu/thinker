import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { summarize, renderUsage, savingOf } from '../src/usage.js';

test('usage summarizes the log and counts a saving only for notes a session acted on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-usage-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'x'.repeat(3600));
  fs.writeFileSync(path.join(dir, 'b.js'), 'x'.repeat(360000));
  const store = new Store(dir).init();
  const note = (id, deps) => store.put({ id, kind: 'location', title: id, body: 'body', deps: deps.map(p => ({ path: p })) });
  note('n1', ['a.js', 'b.js', 'gone.js']); note('n2', ['a.js']); note('n3', ['a.js']);
  assert.deepEqual(savingOf(dir, store.get('n1')), { calls: 2, tokens: 1000 + 6000 });

  assert.match(renderUsage(summarize(store), { repo: 'r', notes: 3 }), /No usage recorded/);
  store.log({ op: 'orient', session: 's1', task: 't', served: ['n1', 'n2'], tokens: 500, est: [[2, 7000], [1, 1000]] });
  store.log({ op: 'late', session: 's1', files: ['a.js'], served: ['n3'], tokens: 100, est: [[1, 1000]] });
  store.log({ op: 'orient', session: 's1', task: 't2', served: ['n1'], tokens: 300, est: [[2, 7000]] });   // same note, same session: counted once
  store.log({ op: 'orient', task: 'nothing found', served: [] });
  store.log({ op: 'lookup', query: 'q', served: ['n2'] });                                                  // older line: no estimate recorded
  store.log({ op: 'attest', session: 's1', applied: [{ id: 'n1', verdict: 'confirmed' }, { id: 'n2', verdict: 'unused' }] });
  store.log({ op: 'distill', transcript: 'x', saved: ['n4'], merged: ['n1'], cost: 0.05 });
  store.log({ op: 'mine-prs', slug: 'o/r', prs: 3, saved: 2, cost: 0.2 });
  store.log({ op: 'verify', id: 'n1', verdict: 'still_valid', cost: 0.01 });

  const u = summarize(store);
  assert.equal(u.requests, 4); assert.equal(u.answered, 3); assert.equal(u.sessions, 1);
  assert.deepEqual(u.servings, { prompt: 3, file: 1, lookup: 1 });
  assert.deepEqual(u.assessed, { confirmed: 1, contradicted: 0, unused: 1, pending: 2 });
  assert.deepEqual({ calls: u.saved.calls, tokens: u.saved.tokens, servings: u.saved.servings }, { calls: 2, tokens: 7000, servings: 1 });
  assert.deepEqual(u.learned, { sessions: 1, notes: 1, merged: 1, prs: 3, prNotes: 2 });
  assert.equal(u.spent, 0.26);
  assert.equal(u.top[0].id, 'n1');
  const text = renderUsage(u, { repo: 'r', notes: 3 });
  assert.match(text, /about 2 reads avoided/);
  assert.match(text, /An estimate, not a measurement/);
});
