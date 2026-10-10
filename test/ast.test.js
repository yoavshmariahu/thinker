// Symbol boundaries by tree-sitter. The parser is not a dependency; these tests run when it is
// installed (THINKER_AST_DIR, ~/.thinker/ast or the package's node_modules) and are skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initAst, astStatus, astReady, astFindSymbol, definitions, grammarOf, resetAst, astDirs, AST_PACKAGES } from '../src/ast.js';
import { findSymbol, locateSymbol, hashDep, checkNote, symbolBlock } from '../src/deps.js';
import { setDiskCache } from '../src/disk-cache.js';
import { Store } from '../src/store.js';
import { createNote, refresh } from '../src/ops.js';

const PY = `import typing as t\n\nclass Foo:\n    @t.overload\n    def bar(self, x: int) -> int: ...\n    @t.overload\n    def bar(self, x: str) -> str: ...\n    @decorated\n    def bar(self, x):\n        return (x +\n                1)\n\n    def baz(self):\n        return 2\n\n\ndef bar():\n    return run(\n        0)\n\ndef run(x):\n    return x\n`;
const TS = `import { a } from './a';\n\nexport interface Shape { area(): number; }\n\nexport abstract class Base<T> {\n  protected items: T[] = [];\n  abstract area(): number;\n  add = (t: T): void => {\n    this.items.push(t);\n  };\n}\n\nexport class Square extends Base<number> {\n  constructor(private side: number) { super(); }\n  area(): number {\n    return this.side ** 2;\n  }\n}\n\nexport const make = (n: number): Square => {\n  return new Square(n);\n};\n\nexport type Pair = [number, number];\nexport enum Kind { A, B }\nfunction helper(x: number) {\n  return x;\n}\nconst obj = {\n  run: function () { return 1; },\n  go: () => 2,\n};\n`;
const GO = `package shapes\n\nimport "fmt"\n\ntype Square struct {\n\tside int\n}\n\nfunc (s *Square) Area() int {\n\treturn s.side * s.side\n}\n\nfunc New(side int) *Square {\n\treturn &Square{side: side}\n}\n\nconst Unit = 1\n`;
const JS = `function bar() {\n  const s = "{";\n  return s;\n}\n\nfunction baz() {\n  return 1;\n}\n`;
const RS = `pub struct Square { side: u32 }\n\nimpl Square {\n    pub fn new(side: u32) -> Self {\n        Square { side }\n    }\n\n    /// the area\n    pub fn area(&self) -> u32 {\n        self.side * self.side\n    }\n}\n\nimpl Default for Square {\n    fn default() -> Self { Square::new(1) }\n}\n\npub fn run() -> u32 {\n    Square::new(2).area()\n}\n\npub trait Shape { fn area(&self) -> u32; }\n`;

const st = await initAst();
const when = st.available ? test : test.skip;
if (!st.available) console.error(`ast tests skipped: tree-sitter not installed (${astStatus().error || 'looked in THINKER_AST_DIR, ~/.thinker/ast, node_modules'})`);

when('definitions lists every definition with its parent and lines, per grammar', () => {
  const py = definitions(PY, 'x.py').map(d => `${d.parent ? d.parent + '.' : ''}${d.name}:${d.kind}@${d.start + 1}-${d.end}${d.overload ? '*' : ''}`);
  assert.deepEqual(py, ['Foo:class@3-14', 'Foo.bar:function@5-5*', 'Foo.bar:function@7-7*', 'Foo.bar:function@9-11', 'Foo.baz:function@13-14', 'bar:function@17-19', 'run:function@21-22']);
  const ts = definitions(TS, 'x.ts').map(d => `${d.parent ? d.parent + '.' : ''}${d.name}:${d.kind}@${d.start + 1}-${d.end}`);
  assert.deepEqual(ts, ['Shape:interface@3-3', 'Shape.area:method@3-3', 'Base:class@5-11', 'Base.items:field@6-6', 'Base.area:method@7-7', 'Base.add:field@8-10', 'Square:class@13-18', 'Square.constructor:method@14-14', 'Square.area:method@15-17', 'make:const@20-22', 'Pair:type@24-24', 'Kind:enum@25-25', 'helper:function@26-28', 'obj:const@29-32', 'run:property@30-30', 'go:property@31-31']);
  const go = definitions(GO, 'x.go').map(d => `${d.parent ? d.parent + '.' : ''}${d.name}:${d.kind}@${d.start + 1}-${d.end}`);
  assert.deepEqual(go, ['Square:type@5-7', 'Square.Area:method@9-11', 'New:function@13-15', 'Unit:const@17-17']);
  const rs = definitions(RS, 'x.rs').map(d => `${d.parent ? d.parent + '.' : ''}${d.name}:${d.kind}@${d.start + 1}-${d.end}`);
  assert.deepEqual(rs, ['Square:struct@1-1', 'Square:impl@3-12', 'Square.new:function@4-6', 'Square.area:function@9-11', 'Square:impl@14-16', 'Square.default:function@15-15', 'run:function@18-20', 'Shape:trait@22-22', 'Shape.area:function@22-22']);
  assert.equal(definitions('x = 1', 'x.rb'), null); // no grammar
  assert.equal(grammarOf('a/b.tsx'), 'tsx');
});

when('astFindSymbol takes the implementation over overload stubs, the member of the named parent, and the decorators above', () => {
  assert.deepEqual(astFindSymbol(PY, 'Foo.bar', 'x.py'), { start: 7, end: 11 }); // @decorated def bar ... 1)
  assert.deepEqual(astFindSymbol(PY, 'bar', 'x.py'), { start: 7, end: 11 }); // first definition that is not a stub
  assert.deepEqual(astFindSymbol(PY, 'Foo.baz', 'x.py'), { start: 12, end: 14 });
  assert.equal(astFindSymbol(PY, 'Nope.bar', 'x.py'), null);
  assert.equal(astFindSymbol(PY, 'Foo.run', 'x.py'), null);
  assert.deepEqual(astFindSymbol(TS, 'Square.area', 'x.ts'), { start: 14, end: 17 });
  assert.deepEqual(astFindSymbol(TS, 'Base.add', 'x.ts'), { start: 7, end: 10 });
  assert.deepEqual(astFindSymbol(TS, 'make', 'x.ts'), { start: 19, end: 22 });
  assert.deepEqual(astFindSymbol(GO, 'Square.Area', 'x.go'), { start: 8, end: 11 });
  assert.deepEqual(astFindSymbol(RS, 'Square.area', 'x.rs'), { start: 7, end: 11 }); // doc comment included
  assert.deepEqual(astFindSymbol(RS, 'Square.default', 'x.rs'), { start: 14, end: 15 });
});

when('the parser and the regex agree on plain definitions, and the parser wins where the regex guesses', () => {
  // plain cases: same block, so hashes made before the parser was installed stay valid
  for (const [text, sym, file] of [[PY, 'Foo.baz', 'x.py'], [PY, 'run', 'x.py'], [TS, 'helper', 'x.ts'], [TS, 'Square.area', 'x.ts'], [GO, 'New', 'x.go'], [RS, 'run', 'x.rs']]) {
    assert.deepEqual(astFindSymbol(text, sym, file), findSymbol(text, sym), `${file}:${sym}`);
  }
  // the regex ends a multi-line Python call early only when brackets close on the def line; the parser knows the block
  assert.deepEqual(locateSymbol(PY, 'bar', 'x.py'), { start: 7, end: 11, engine: 'ast' });
  assert.equal(locateSymbol(PY, 'bar', 'x.py', { engine: 'regex' }).engine, 'regex');
  // an object property holding a function is a definition to both
  assert.deepEqual(locateSymbol('const o = {\n  foo: function () {\n    return 1;\n  },\n};\n', 'foo', 'x.js'), { start: 1, end: 4, engine: 'ast' });
  // a brace inside a string throws the regex off; the parser knows where the function ends
  assert.deepEqual(locateSymbol(JS, 'bar', 'x.js'), { start: 0, end: 4, engine: 'ast' });
  assert.deepEqual(locateSymbol(JS, 'bar', 'x.js', { engine: 'regex' }), { start: 0, end: 9, engine: 'regex' });
  // a language without a grammar keeps the regex
  assert.equal(astReady('x.rb'), false);
  assert.equal(locateSymbol('def foo\n  1\nend\n', 'foo', 'x.rb').engine, 'regex');
});

when('deps hashed by the regex are upgraded in place when the parser sees the same code', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ast-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/a.py'), PY);
  fs.writeFileSync(path.join(repo, 'src/b.js'), JS);
  const legacy = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.baz' }, { engine: 'regex' });
  assert.equal(legacy.engine, undefined);
  const now = hashDep(repo, { path: 'src/a.py', symbol: 'Foo.baz' });
  assert.equal(now.engine, 'ast');
  assert.equal(now.hash, legacy.hash); // same block, same hash
  // a block the regex cut differently: not a change, an upgrade
  const legacyBar = hashDep(repo, { path: 'src/b.js', symbol: 'bar' }, { engine: 'regex' });
  assert.notEqual(hashDep(repo, { path: 'src/b.js', symbol: 'bar' }).hash, legacyBar.hash);
  const r = checkNote(repo, { deps: [legacy, legacyBar] });
  assert.deepEqual(r.changed, []);
  assert.equal(r.upgraded, true);
  assert.deepEqual(r.deps.map(d => d.engine), ['ast', 'ast']);
  // refresh persists the upgrade, once
  const store = new Store(repo).init();
  const note = createNote(store, { title: 'Bar', kind: 'location', answers: ['where is bar'], body: 'src/b.js:bar is here', deps: [{ path: 'src/b.js', symbol: 'bar' }] }).note;
  store.put({ ...note, deps: [legacyBar] });
  assert.equal(refresh(store)[0].status, 'fresh');
  assert.equal(store.get(note.id).deps[0].engine, 'ast');
  assert.equal(checkNote(repo, store.get(note.id)).upgraded, false);
  // and from then on only bar's own body counts
  fs.writeFileSync(path.join(repo, 'src/b.js'), JS.replace('return 1;', 'return 2;'));
  assert.deepEqual(checkNote(repo, store.get(note.id)).changed, []); // baz changed, which the regex block had covered
  fs.writeFileSync(path.join(repo, 'src/b.js'), JS.replace('return s;', 'return s + s;'));
  assert.equal(checkNote(repo, store.get(note.id)).changed[0].reason, 'symbol body changed');
  assert.equal(symbolBlock(repo, { path: 'src/b.js', symbol: 'bar' }).engine, 'ast');
  // the other way: a checkout without the parser reads a dep the parser hashed (hashRegex travels with it)
  fs.writeFileSync(path.join(repo, 'src/b.js'), JS);
  const byParser = hashDep(repo, { path: 'src/b.js', symbol: 'bar' });
  assert.equal(byParser.hashRegex, legacyBar.hash);
  resetAst();
  assert.equal(astReady('x.py'), false);
  const r2 = checkNote(repo, { deps: [byParser] });
  assert.deepEqual(r2.changed, []);
  assert.equal(r2.upgraded, false);
  assert.deepEqual(r2.deps[0], byParser); // kept as the parser recorded it, nothing to write
  fs.writeFileSync(path.join(repo, 'src/b.js'), JS.replace('return s;', 'return s + s;'));
  assert.equal(checkNote(repo, { deps: [byParser] }).changed[0].reason, 'symbol body changed');
});

when('one name of a declaration group is its own lines, and a single declaration keeps its keyword and export', async () => {
  await initAst();
  const go = 'package p\n\nconst (\n\t// A is the first\n\tA = 1\n\tB = 2\n)\n\nvar (\n\tX = map[string]int{\n\t\t"a": 1,\n\t}\n\tY = 2\n)\n\nconst Single = 3\n\ntype (\n\tT1 struct {\n\t\ta int\n\t}\n\tT2 int\n)\n';
  const at = (text, sym, file) => { const l = astFindSymbol(text, sym, file); return l && [l.start + 1, l.end]; };
  assert.deepEqual(at(go, 'A', 'x.go'), [4, 5]); // with its comment, without the rest of the group
  assert.deepEqual(at(go, 'B', 'x.go'), [6, 6]);
  assert.deepEqual(at(go, 'X', 'x.go'), [10, 12]);
  assert.deepEqual(at(go, 'Y', 'x.go'), [13, 13]);
  assert.deepEqual(at(go, 'Single', 'x.go'), [16, 16]);
  assert.deepEqual(at(go, 'T1', 'x.go'), [19, 21]);
  assert.deepEqual(at(go, 'T2', 'x.go'), [22, 22]);
  const js = 'export const a = 1,\n  b = () => {\n    return 2;\n  };\n\nexport const alone = {\n  k: 1,\n};\n';
  assert.deepEqual(at(js, 'b', 'x.js'), [2, 4]);
  assert.deepEqual(at(js, 'alone', 'x.js'), [6, 8]);
});

when('a definition with a parse error in it is not trusted: the regex takes over', async () => {
  await initAst();
  // syntax the pinned grammar does not read (Go 1.26 new(expr)); the parser still returns a tree, with errors in it
  const go = 'package p\n\nfunc Clean() int {\n\treturn 1\n}\n\nfunc Uses() *int {\n\tv := new(compute(1, 2))\n\treturn v\n}\n\nfunc After() int {\n\treturn 2\n}\n';
  const defs = definitions(go, 'x.go');
  const by = n => defs.find(d => d.name === n);
  if (!by('Uses')?.broken) return; // a grammar that reads it: nothing to fall back from
  assert.equal(by('Clean').broken, undefined);
  assert.equal(astFindSymbol(go, 'Uses', 'x.go'), null);
  const loc = locateSymbol(go, 'Uses', 'x.go');
  assert.equal(loc.engine, 'regex');
  assert.deepEqual([loc.start + 1, loc.end], [7, 10]);
  assert.equal(locateSymbol(go, 'Clean', 'x.go').engine, 'ast');
});

when('definitions are read back from disk by the text they came from', async t => {
  await initAst();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-astcache-'));
  setDiskCache(dir);
  t.after(() => { setDiskCache(undefined); fs.rmSync(dir, { recursive: true, force: true }); });
  const text = 'function cachedOne() {\n  return 1;\n}\n';
  const first = definitions(text, 'x.js');
  const stored = fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.startsWith('ast') && f.endsWith('.json'));
  assert.equal(stored.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, stored[0]), 'utf8')), first);
  // a later process (nothing in memory) takes what is on disk, without parsing
  fs.writeFileSync(path.join(dir, stored[0]), JSON.stringify([{ name: 'fromDisk', kind: 'function', start: 0, end: 3, parent: null }]));
  const fresh = 'function cachedTwo() {\n  return 1;\n}\n';
  definitions(fresh, 'x.js');
  for (let i = 0; i < 301; i++) definitions(`const filler${i} = ${i};\n`, 'x.js'); // push the first text out of memory
  assert.equal(definitions(text, 'x.js')[0].name, 'fromDisk');
  // another text is another entry
  assert.equal(definitions(text + '\n', 'x.js')[0].name, 'cachedOne');
});

test('the parser is a dependency at the versions that load each other, and thinker\'s own copy is preferred', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(AST_PACKAGES.map(p => p.split('@')[0]).map(n => `${n}@${pkg.dependencies[n]}`), AST_PACKAGES, 'exact pins, in dependencies');
  const dirs = astDirs();
  const own = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const legacy = path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'ast');
  assert.ok(dirs.indexOf(own) !== -1 && dirs.indexOf(own) < dirs.indexOf(legacy), 'own node_modules before the old optional install');
});
