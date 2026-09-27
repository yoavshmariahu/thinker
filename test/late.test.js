import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createNote, lateNotes, completenessNudge, orient } from '../src/ops.js';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-late-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.py'), 'def launch():\n    pass\n\ndef can_edit():\n    return True\n');
  fs.writeFileSync(path.join(dir, 'src/b.py'), 'def other():\n    pass\n');
  const store = new Store(dir).init();
  const inv = createNote(store, { title: 'Launch must check can_edit', kind: 'invariant', answers: ['launch eligibility'], body: 'src/a.py:launch must call src/a.py:can_edit first', deps: [{ path: 'src/a.py', symbol: 'launch' }] }).note;
  const cp = createNote(store, { title: 'Launch call path', kind: 'callpath', answers: ['how launch works'], body: 'src/a.py:launch is called from the API', deps: [{ path: 'src/a.py', symbol: 'launch' }] }).note;
  return { dir, store, inv, cp };
}

test('late notes: file-keyed, rules first, once per session', () => {
  const { dir, store, inv, cp } = setup();
  const r1 = lateNotes(store, { session: 's1', files: [path.join(dir, 'src/a.py')], perEvent: 1 });
  assert.deepEqual(r1.included.map(n => n.id), [inv.id]);
  const r2 = lateNotes(store, { session: 's1', files: ['src/a.py'], perEvent: 1 });
  assert.deepEqual(r2.included.map(n => n.id), [cp.id]);
  assert.equal(lateNotes(store, { session: 's1', files: ['src/a.py'] }).included.length, 0);
  assert.equal(lateNotes(store, { session: 's1', files: ['src/b.py'] }).included.length, 0);
  assert.equal(lateNotes(store, { session: 's2', files: ['src/a.py'] }).included.length, 2);
});

test('completeness nudge: co-change partner not touched and unseen rule, once', () => {
  const { store } = setup();
  const cc = { totals: { 'src/a.py': 10 }, pairs: { 'src/a.py': { 'src/b.py': 8 } } };
  const n = completenessNudge(store, { session: 's9', changed: ['src/a.py'], cochange: cc });
  assert.ok(n.text.includes('src/b.py'));
  assert.ok(n.text.includes('Launch must check can_edit'));
  assert.equal(completenessNudge(store, { session: 's9', changed: ['src/a.py'], cochange: cc }).text, '');
  assert.equal(completenessNudge(store, { session: 's10', changed: ['src/a.py', 'src/b.py'], cochange: { totals: {}, pairs: {} } }).text.includes('src/b.py'), false);
});

test('early modes: pointers omit prose, none injects nothing', async () => {
  const { store } = setup();
  const p = await orient(store, { task: 'launch eligibility check', early: 'pointers' });
  assert.ok(p.text.includes('src/a.py:launch') && !p.text.includes('must call'));
  const n = await orient(store, { task: 'launch eligibility check', early: 'none' });
  assert.equal(n.included.length, 0);
});
