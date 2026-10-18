// The outline of a file served on its first sight (ops.js:onSightOutlines): off by default, code files
// only, once per file per session, capped, and centred on the lines a search hit rather than the top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { onSightOutlines, onSightOutlineConfig, fileOutline, ON_SIGHT_OUTLINE } from '../src/ops.js';
import { seenHits, searchedIdentifier } from '../src/clients.js';
import { initAst } from '../src/ast.js';

process.env.THINKER_TELEMETRY = 'off';
await initAst();
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

const BIG = Array.from({ length: 60 }, (_, i) => `def helper_${i}(x):\n    return x + ${i}\n`).join('\n');
const CLASSY = 'class Loader:\n    def read_rows(self, n):\n        return n\n\n    def write_rows(self, n):\n        return n\n\ndef only_here(z):\n    return z\n';

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sightout-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/big.py'), BIG);
  fs.writeFileSync(path.join(dir, 'src/loader.py'), CLASSY);
  fs.writeFileSync(path.join(dir, 'src/arrow.js'), 'import os from "os";\nexport const PORT = 8080;\nexport const makeServer = (opts) => {\n  return opts;\n};\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# docs\n\n## a heading\n');
  fs.writeFileSync(path.join(dir, 'data.json'), '{"a": 1}\n');
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const on = (store, over = {}) => fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ onSightOutline: { enabled: true, ...over } }));
const logLines = store => fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('off by default; the config turns it on', t => {
  const store = new Store(repo(t)).init();
  assert.equal(onSightOutlineConfig(store).enabled, false);
  assert.deepEqual(onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/loader.py', lines: [] }] }), { text: '', files: [] });
  on(store, { perSession: 3 });
  assert.deepEqual(onSightOutlineConfig(store), { ...ON_SIGHT_OUTLINE, enabled: true, perSession: 3 });
  const r = onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/loader.py', lines: [] }] });
  assert.deepEqual(r.files, ['src/loader.py']);
  assert.match(r.text, /<thinker-outline>/);
  assert.match(r.text, /Loader\.read_rows/);
  assert.match(r.text, /only_here/);
});

test('functions and classes only: no imports, no plain constants, no docs or data files', t => {
  const store = new Store(repo(t)).init();
  on(store);
  const r = onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/arrow.js', lines: [] }, { file: 'README.md', lines: [] }, { file: 'data.json', lines: [] }] });
  assert.deepEqual(r.files, ['src/arrow.js'], 'a markdown or json sighting is not outlined');
  assert.match(r.text, /makeServer/, 'a const holding an arrow function is a definition');
  assert.doesNotMatch(r.text, /PORT/, 'a plain constant is not');
  assert.doesNotMatch(r.text, /import|require/);
});

test('a search hit centres the outline on the lines it hit, past the cap', t => {
  const store = new Store(repo(t)).init();
  on(store, { maxLines: 6 });
  const deep = BIG.split('\n').findIndex(l => l.startsWith('def helper_55')) + 1;
  const r = onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/big.py', lines: [deep + 1] }] });
  assert.match(r.text, /helper_55/, 'the definition the hit line sits in is always there');
  assert.doesNotMatch(r.text, /helper_0\b/, 'and the top of the file is not what fills the cap');
  assert.equal(r.text.match(/^L\d+/gm).length, 6);
  assert.match(r.text, /\+54 more definitions/);

  // with no hit line the top-level definitions come first
  const r2 = onSightOutlines(store, { session: 's2', client: 'claude', sighted: [{ file: 'src/big.py', lines: [] }] });
  assert.match(r2.text, /helper_0\b/);
});

test('the enclosing class comes with the member a hit line sits in', t => {
  const store = new Store(repo(t)).init();
  on(store, { maxLines: 2 });
  const line = CLASSY.split('\n').findIndex(l => l.includes('def write_rows')) + 2;
  const r = onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/loader.py', lines: [line] }] });
  assert.match(r.text, /Loader\.write_rows/);
  assert.match(r.text, /^L1\S*\s+Loader$/m);
  assert.doesNotMatch(r.text, /only_here/);
});

test('once per file per session, hits with lines first, and the session cap holds', t => {
  const store = new Store(repo(t)).init();
  on(store, { perSession: 1 });
  // a bare listing beside a grep hit: the hit is served, the listing waits
  const r = onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/arrow.js', lines: [] }, { file: 'src/loader.py', lines: [2] }] });
  assert.deepEqual(r.files, ['src/loader.py']);
  assert.deepEqual(onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/loader.py', lines: [2] }] }).files, [], 'not twice');
  assert.deepEqual(onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/big.py', lines: [1] }] }).files, [], 'and not past the cap');
  assert.deepEqual(onSightOutlines(store, { session: 's2', client: 'claude', sighted: [{ file: 'src/loader.py', lines: [2] }] }).files, ['src/loader.py'], 'the next session starts over');
});

test('a grep for an identifier the checkout defines once says where it is', t => {
  const store = new Store(repo(t)).init();
  on(store);
  const r = onSightOutlines(store, { session: 's1', client: 'claude', sighted: [{ file: 'src/loader.py', lines: [8] }], identifier: 'only_here' });
  assert.match(r.text, /only_here is defined at src\/loader\.py:L8/);
  const r2 = onSightOutlines(store, { session: 's2', client: 'claude', sighted: [{ file: 'src/big.py', lines: [1] }], identifier: 'helper_0' });
  assert.match(r2.text, /helper_0 is defined at src\/big\.py:L1/);
  const r3 = onSightOutlines(store, { session: 's3', client: 'claude', sighted: [], identifier: 'nowhere_at_all' });
  assert.deepEqual(r3, { text: '', files: [] }, 'a name with no single definition adds nothing');
});

test('a serving is logged as a file-keyed serving with its own kind', t => {
  const store = new Store(repo(t)).init();
  on(store);
  onSightOutlines(store, { session: 's1', client: 'claude', turn: 3, sighted: [{ file: 'src/loader.py', lines: [2] }], identifier: 'only_here' });
  const row = logLines(store).filter(e => e.op === 'late' && e.on === 'outline').pop();
  assert.deepEqual(row.files, ['src/loader.py']);
  assert.deepEqual(row.served, []);
  assert.equal(row.turn, 3);
  assert.equal(row.defined, 'only_here');
  assert.ok(row.tokens > 0);
});

test('seenHits keeps the lines a search hit and searchedIdentifier reads the one name a tool searched for', t => {
  const dir = repo(t);
  const ev = { tool_response: 'src/loader.py:2:    def read_rows(self, n):\nsrc/loader.py:5:    def write_rows\nsrc/big.py\nnope/missing.py:9:x\n' };
  assert.deepEqual(seenHits(ev, dir), [{ file: 'src/loader.py', lines: [2, 5] }, { file: 'src/big.py', lines: [] }]);
  assert.deepEqual(seenHits({ tool_response: 'src/loader.py:2:x\nsrc/big.py:1:y' }, dir, { max: 1 }), [{ file: 'src/loader.py', lines: [2] }]);
  assert.equal(searchedIdentifier({ tool_name: 'Grep', tool_input: { pattern: 'read_rows' } }), 'read_rows');
  assert.equal(searchedIdentifier({ tool_name: 'Grep', tool_input: { pattern: 'def .*rows' } }), null);
  assert.equal(searchedIdentifier({ tool_name: 'Bash', tool_input: { command: 'rg -n write_rows src/' } }), 'write_rows');
  assert.equal(searchedIdentifier({ tool_name: 'Bash', tool_input: { command: 'ls -R src' } }), null);
});

test('fileOutline alone says nothing about a file with no definitions', t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'src/empty.py'), '# just a comment\nX = 1\n');
  assert.equal(fileOutline(dir, 'src/empty.py'), '');
  assert.equal(fileOutline(dir, 'README.md'), '');
  assert.match(fileOutline(dir, 'src/loader.py'), /^src\/loader\.py \(\d+ lines, 4 definitions\)/);
});
