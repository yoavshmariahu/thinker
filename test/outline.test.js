import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { outlineText, outlineOf, outlineFiles, renderOutline, coverage, languageOf } from '../src/outline.js';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-outline-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const write = (dir, name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
const find = (defs, name) => defs.find(d => d.name === name);

test('python: classes own their methods, ranges end at the last line of the body, locals are left out', () => {
  const defs = outlineText([
    'import os',                      // 1
    '',                               // 2
    'TOP = 1',                        // 3
    'class Store:',                   // 4
    '    """A docstring with def fake(): inside it."""', // 5
    '',                               // 6
    '    def get(self, key):',        // 7
    '        local = 1',              // 8
    '        def inner():',           // 9
    '            return 2',           // 10
    '        return local',           // 11
    '',                               // 12
    '    async def put(self, key, v):', // 13
    '        return None',            // 14
    '',                               // 15
    'def helper(x):',                 // 16
    '    return x',                   // 17
  ].join('\n'), 'store.py');
  assert.deepEqual(defs.map(d => [d.kind, d.name, d.parent, d.line, d.end]), [
    ['class', 'Store', null, 4, 14],
    ['method', 'get', 'Store', 7, 11],
    ['method', 'put', 'Store', 13, 14],
    ['function', 'helper', null, 16, 17],
  ]);
  // a def written inside a docstring is not a definition, and neither is a nested one
  assert.equal(find(defs, 'fake'), undefined);
  assert.equal(find(defs, 'inner'), undefined);
});

test('javascript: a class method has no keyword, and a regex literal does not open a block', () => {
  const defs = outlineText([
    'const RE = /^a(b|c)\\{2\\}$/;',   // 1  parens and a brace inside a regex
    'export function first(a) {',      // 2
    '  const hidden = 1;',             // 3
    '  return hidden;',                // 4
    '}',                               // 5
    'export class Cache {',            // 6
    '  constructor(n) { this.n = n; }',// 7
    '  async get(k) {',                // 8
    '    if (k) { return 1; }',        // 9
    '    return 0;',                   // 10
    '  }',                             // 11
    '  static of = (n) => new Cache(n);', // 12
    '}',                               // 13
    'const arrow = async (x) => x + 1;', // 14
    'export const PLAIN = { a: 1 };',  // 15
  ].join('\n'), 'cache.js');
  const got = defs.map(d => [d.kind, d.name, d.parent]);
  assert.deepEqual(got, [
    ['const', 'RE', null],
    ['function', 'first', null],
    ['class', 'Cache', null],
    ['method', 'constructor', 'Cache'],
    ['method', 'get', 'Cache'],
    ['method', 'of', 'Cache'],
    ['function', 'arrow', null],
    ['const', 'PLAIN', null],
  ]);
  assert.equal(find(defs, 'hidden'), undefined);          // a local
  assert.equal(find(defs, 'first').end, 5);               // the body's closing brace
  assert.equal(find(defs, 'Cache').end, 13);
  assert.equal(find(defs, 'if'), undefined);              // `if (k) {` is not a method
});

test('go and rust: a receiver and an impl block name the parent', () => {
  const go = outlineText([
    'package store',                            // 1
    'type Store struct {',                      // 2
    '\tn int',                                  // 3
    '}',                                        // 4
    'func New(n int) *Store {',                 // 5
    '\treturn &Store{n}',                       // 6
    '}',                                        // 7
    'func (s *Store) Get(k string) int {',      // 8
    '\treturn s.n',                             // 9
    '}',                                        // 10
  ].join('\n'), 'store.go');
  assert.deepEqual(go.map(d => [d.kind, d.name, d.parent]), [
    ['struct', 'Store', null], ['function', 'New', null], ['method', 'Get', 'Store'],
  ]);
  const rs = outlineText([
    'pub struct Store { n: u32 }',               // 1
    'impl Store {',                              // 2
    '    pub fn new(n: u32) -> Self {',          // 3
    '        Store { n }',                       // 4
    '    }',                                     // 5
    '}',                                         // 6
    'pub async fn run() {}',                     // 7
  ].join('\n'), 'store.rs');
  assert.deepEqual(rs.map(d => [d.kind, d.name, d.parent]), [
    ['struct', 'Store', null], ['impl', 'Store', null], ['method', 'new', 'Store'], ['function', 'run', null],
  ]);
});

test('a language with no patterns, and a file with too little in it, give nothing', t => {
  const d = tmp(t);
  assert.equal(languageOf('notes.md'), null);
  assert.equal(outlineText('# title\n\ntext\n', 'notes.md'), null);
  assert.equal(outlineOf(write(d, 'a.md', '# t\n')), null);
  assert.equal(outlineOf(write(d, 'small.py', 'x = 1\n')), null);       // under minDefs
  assert.equal(outlineOf(path.join(d, 'gone.py')), null);
  assert.equal(outlineFiles([write(d, 'b.md', 'x')], { cwd: d }), null);
});

test('coverage is the share of lines inside a top-level definition, never over 1', () => {
  assert.equal(coverage([], 10), 0);
  assert.equal(coverage([{ line: 1, end: 5, parent: null }], 10), 0.5);
  // overlapping ranges are counted once, members never twice
  assert.equal(coverage([{ line: 1, end: 10, parent: null }, { line: 2, end: 4, parent: 'A' }], 10), 1);
});

test('render: the range leads each line, members are indented, the biggest survive the cap', () => {
  const defs = outlineText(['def a():', '    return 1', '', 'def b():', '    return 2'].join('\n'), 'x.py');
  const text = renderOutline({ file: '/repo/x.py', defs, lineCount: 5, cwd: '/repo' });
  assert.match(text, /^x\.py: 5 lines, 2 definitions$/m);
  assert.match(text, /1-2 {2}function a/);
  const many = Array.from({ length: 40 }, (_, i) => `def f${i}():\n    return ${i}`).join('\n');
  const big = outlineText(many + '\ndef huge():\n' + '    x = 1\n'.repeat(50), 'y.py');
  const capped = renderOutline({ file: 'y.py', defs: big, lineCount: 140, maxLines: 5 });
  assert.match(capped, /function huge/);                       // the largest is kept
  assert.match(capped, /36 smaller definitions not listed/);
  assert.equal(capped.split('\n').length, 7);                  // head + 5 + the note
});

test('a real file of this repository outlines in milliseconds and accounts for most of it', () => {
  const t0 = Date.now();
  const o = outlineOf(new URL('../src/delegate.js', import.meta.url).pathname, { cwd: new URL('..', import.meta.url).pathname });
  const ms = Date.now() - t0;
  assert.ok(o.defs.length > 15, `defs ${o.defs.length}`);
  assert.ok(o.coverage > 0.5, `coverage ${o.coverage}`);
  assert.ok(ms < 200, `${ms} ms`);
  assert.ok(find(o.defs, 'delegateTool').end > find(o.defs, 'delegateTool').line + 10);
  assert.ok(o.text.length < 8000, `${o.text.length} chars`);
});
