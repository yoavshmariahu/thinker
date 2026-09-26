import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSymbol, hashDep, checkNote } from '../src/deps.js';
import { extractDeps, createNote, refresh } from '../src/ops.js';
import { Store } from '../src/store.js';
import { rank, pack, tokenize } from '../src/rank.js';

const PY = `import os\n\nclass Foo:\n    def bar(self, x):\n        return x + 1\n\n    def baz(self):\n        return 2\n\ndef bar():\n    return 0\n\n@decorator\ndef top():\n    pass\n`;
const JS = `export function foo(a) {\n  return a;\n}\nconst bar = (x) => {\n  return x;\n};\nexport class Baz {\n  qux() { return 1; }\n}\n`;

test('findSymbol python qualified and bare', () => {
  assert.deepEqual(findSymbol(PY, 'Foo.bar'), { start: 3, end: 5 });
  assert.deepEqual(findSymbol(PY, 'Foo.baz'), { start: 6, end: 8 });
  assert.equal(findSymbol(PY, 'bar').start, 3); // first definition
  assert.equal(findSymbol(PY, 'Nope.bar'), null);
  assert.equal(findSymbol(PY, 'top').start, 12); // includes decorator
});

test('findSymbol python multi-line signature and overloads', () => {
  const py = `import typing as t\nclass C:\n    @t.overload\n    def main(self, a: int) -> int: ...\n    @t.overload\n    def main(self, a: str) -> str: ...\n    def main(\n        self,\n        a,\n    ) -> t.Any:\n        x = (1,\n             2)\n        return x\n\n    def other(self):\n        pass\n`;
  const loc = findSymbol(py, 'C.main', 'indent');
  assert.equal(py.split('\n')[loc.start].trim(), 'def main(');
  assert.equal(py.split('\n')[loc.end - 1].trim(), 'return x');
});

test('findSymbol js', () => {
  assert.deepEqual(findSymbol(JS, 'foo'), { start: 0, end: 3 });
  assert.deepEqual(findSymbol(JS, 'bar'), { start: 3, end: 6 });
  assert.deepEqual(findSymbol(JS, 'Baz.qux'), { start: 7, end: 8 });
});

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.py'), PY);
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), JS);
  return dir;
}

test('symbol hash changes only when the symbol body changes', () => {
  const repo = tmpRepo();
  const h1 = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.bar' });
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY.replace('return 2', 'return 3'));
  const h2 = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.bar' });
  assert.equal(h1.hash, h2.hash);
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY.replace('return x + 1', 'return x + 2'));
  const h3 = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.bar' });
  assert.notEqual(h1.hash, h3.hash);
  const note = { deps: [h1] };
  assert.equal(checkNote(repo, note).changed[0].reason, 'symbol body changed');
  fs.unlinkSync(path.join(repo, 'src/a.py'));
  assert.equal(checkNote(repo, note).changed[0].reason, 'file removed');
});

test('extractDeps pulls pointers from body', () => {
  const repo = tmpRepo();
  const deps = extractDeps(repo, 'Calls `src/a.py:Foo.bar` then b.js:foo and `Baz.qux()`; ignores self.bar and ctx.params. Also `a.py:top`.', [{ path: 'src/b.js' }]);
  const keys = deps.map(d => `${d.path}:${d.symbol}`);
  assert.ok(keys.includes('src/a.py:Foo.bar'));
  assert.ok(keys.includes('src/b.js:foo'));
  assert.ok(keys.includes('src/b.js:Baz.qux'));
  assert.ok(keys.includes('src/a.py:top'));
  assert.ok(!keys.some(k => k.includes('self') || k.includes('ctx')));
});

test('createNote + refresh marks stale and recovers', () => {
  const repo = tmpRepo();
  const store = new Store(repo).init();
  const r = createNote(store, { title: 'Foo bar flow', kind: 'callpath', answers: ['how does foo bar'], body: 'src/a.py:Foo.bar returns x+1', deps: [{ path: 'src/a.py', symbol: 'Foo.bar' }] });
  assert.ok(r.note);
  assert.equal(refresh(store)[0].status, 'fresh');
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY.replace('return x + 1', 'return x - 1'));
  assert.equal(refresh(store)[0].status, 'stale');
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY);
  assert.equal(refresh(store)[0].status, 'fresh');
});

test('rank prefers matching notes and path affinity; pack respects budget', () => {
  const notes = [
    { id: 'a', title: 'How auth middleware validates tokens', kind: 'callpath', answers: ['where is auth checked'], body: 'x'.repeat(400), deps: [{ path: 'src/auth/mw.py' }], confidence: 0.9, status: 'fresh' },
    { id: 'b', title: 'How migrations run', kind: 'howto', answers: ['how to run migrations'], body: 'y'.repeat(400), deps: [{ path: 'db/migrate.py' }], confidence: 0.9, status: 'fresh' },
    { id: 'c', title: 'Token refresh gotcha', kind: 'gotcha', answers: ['token expiry'], body: 'z'.repeat(400), deps: [{ path: 'src/auth/refresh.py' }], confidence: 0.9, status: 'stale' },
  ];
  const ranked = rank(notes, { query: 'fix the auth token validation bug', file: 'src/auth/mw.py' });
  assert.equal(ranked[0].note.id, 'a');
  const packed = pack(ranked, 150);
  assert.ok(packed.tokens <= 150);
  assert.ok(packed.included.length >= 1);
  assert.deepEqual(tokenize('getUserById src/auth/mw.py'), ['get', 'user', 'id', 'src', 'auth', 'mw', 'py']);
});
