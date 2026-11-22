// Reading a log a line at a time (src/jsonl.js): the same lines the whole file gives, whatever the chunk cuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eachLine, eachLineBackwards } from '../src/jsonl.js';

function file(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-jsonl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'log.jsonl');
  fs.writeFileSync(f, text);
  return f;
}
// what `readFileSync(f).split('\n')` gave, less the empty string after a final newline
const whole = text => { const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop(); return lines; };
const TEXTS = [
  '',
  'one',
  'one\n',
  '{"a":1}\n\n{"b":"é ünï 😀 字"}\n{"c":3}',
  '\n\nfirst after two blanks\n',
  `${'x'.repeat(300)}\n${'😀'.repeat(50)}\nlast\n`,
];

test('every line, in order, with its index, wherever a chunk ends -- inside a character too', t => {
  for (const text of TEXTS) for (const chunk of [1, 2, 3, 7, 64, 1 << 16]) {
    const got = [], indexes = [];
    eachLine(file(t, text), (line, i) => { got.push(line); indexes.push(i); }, { chunk });
    assert.deepEqual(got, whole(text), `chunk ${chunk}: ${JSON.stringify(text.slice(0, 30))}`);
    assert.deepEqual(indexes, got.map((_, i) => i), 'the index is the line number less one, blank lines counted');
  }
});

test('a reader told where the file ended reads no further, so two passes see the same lines', t => {
  const f = file(t, 'one\ntwo\n');
  const end = fs.statSync(f).size;
  fs.appendFileSync(f, 'three\n');
  for (const chunk of [1, 3, 1 << 16]) {
    const got = []; eachLine(f, l => got.push(l), { end, chunk });
    assert.deepEqual(got, ['one', 'two'], `chunk ${chunk}`);
  }
  const all = []; eachLine(f, l => all.push(l));
  assert.deepEqual(all, ['one', 'two', 'three']);
});

test('a file that is not there throws, as reading it whole did', () => {
  assert.throws(() => eachLine(path.join(os.tmpdir(), 'thinker-jsonl-missing', 'none.jsonl'), () => {}), /ENOENT/);
});

test('from the end: the lines that hold something, newest first, and no further back than asked', t => {
  for (const text of TEXTS) for (const chunk of [1, 2, 3, 7, 64, 1 << 16]) {
    const got = [];
    eachLineBackwards(file(t, text), line => { got.push(line); }, { chunk });
    assert.deepEqual(got, whole(text).filter(Boolean).reverse(), `chunk ${chunk}: ${JSON.stringify(text.slice(0, 30))}`);
  }
  const seen = [];
  eachLineBackwards(file(t, 'a\nb\nc\nd\n'), line => { seen.push(line); return line === 'c'; }, { chunk: 2 });
  assert.deepEqual(seen, ['d', 'c'], 'it stops where it is told to');
});

test('the end of a large file is read without reading the file', t => {
  const f = file(t, `${'{"old":true}\n'.repeat(200_000)}{"checkout":"/the/last"}\n`);
  const read = fs.readSync; let bytes = 0;
  t.mock.method(fs, 'readSync', (...a) => { const n = read(...a); bytes += n; return n; });
  let last = null;
  eachLineBackwards(f, line => { last = JSON.parse(line); return true; });
  assert.equal(last.checkout, '/the/last');
  assert.ok(bytes <= 1 << 16, `read ${bytes} bytes of ${fs.statSync(f).size}`);
});
