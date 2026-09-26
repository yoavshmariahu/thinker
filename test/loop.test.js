import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createNote, attest, linkNotes } from '../src/ops.js';
import { partners, renderCochange } from '../src/cochange.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-loop-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.py'), 'class Foo:\n    def bar(self):\n        return 1\n\n    def baz(self):\n        return 2\n');
  fs.writeFileSync(path.join(dir, 'src/b.py'), 'def qux():\n    return 3\n');
  return dir;
}

test('attest adjusts confidence, rewrites on contradiction, retires after repeated contradiction', () => {
  const store = new Store(repo()).init();
  const { note } = createNote(store, { title: 'Foo bar', kind: 'callpath', answers: ['foo bar'], body: 'src/a.py:Foo.bar returns 1', deps: [{ path: 'src/a.py', symbol: 'Foo.bar' }], confidence: 0.7 });
  attest(store, [{ id: note.id, verdict: 'confirmed', evidence: 'read it' }]);
  assert.equal(store.get(note.id).confidence, 0.75);
  attest(store, [{ id: note.id, verdict: 'contradicted', evidence: 'returns 2', correction: 'src/a.py:Foo.bar returns 2 after the refactor, see the body of the method for details.' }]);
  const n = store.get(note.id);
  assert.equal(n.confidence, 0.5);
  assert.ok(n.body.includes('returns 2'));
  assert.equal(n.history.length, 1);
  attest(store, [{ id: note.id, verdict: 'contradicted', evidence: 'x', correction: '' }]);
  assert.equal(store.get(note.id).status, 'invalid');
});

test('unused servings decay confidence only after several with no confirmation', () => {
  const store = new Store(repo()).init();
  const { note } = createNote(store, { title: 'Qux', kind: 'location', answers: ['qux'], body: 'src/b.py:qux', deps: [{ path: 'src/b.py', symbol: 'qux' }], confidence: 0.8 });
  for (let i = 0; i < 4; i++) attest(store, [{ id: note.id, verdict: 'unused' }]);
  assert.equal(store.get(note.id).confidence, 0.8);
  attest(store, [{ id: note.id, verdict: 'unused' }]);
  assert.equal(store.get(note.id).confidence, 0.77);
});

test('linkNotes links notes sharing a symbol dep, symmetrically', () => {
  const store = new Store(repo()).init();
  const a = createNote(store, { title: 'A', kind: 'callpath', answers: ['a'], body: 'src/a.py:Foo.bar', deps: [{ path: 'src/a.py', symbol: 'Foo.bar' }] }).note;
  const b = createNote(store, { title: 'B', kind: 'gotcha', answers: ['b'], body: 'src/a.py:Foo.bar again', deps: [{ path: 'src/a.py', symbol: 'Foo.bar' }] }).note;
  const c = createNote(store, { title: 'C', kind: 'howto', answers: ['c'], body: 'src/b.py:qux', deps: [{ path: 'src/b.py', symbol: 'qux' }] }).note;
  assert.deepEqual(store.get(b.id).related, [a.id]);
  assert.deepEqual(store.get(a.id).related, [b.id]);
  assert.deepEqual(store.get(c.id).related, []);
});

test('cochange partners and rendering', () => {
  const idx = { totals: { 'a.py': 10, 'b.py': 4 }, pairs: { 'a.py': { 'test_a.py': 8, 'b.py': 2 }, 'b.py': { 'a.py': 2 } } };
  assert.deepEqual(partners(idx, 'a.py').map(p => p.file), ['test_a.py']);
  assert.ok(renderCochange(idx, ['a.py']).includes('80%'));
  assert.equal(renderCochange(idx, ['zzz.py']), '');
});
