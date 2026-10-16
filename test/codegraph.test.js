import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { references, fanout, callees, annotateFanout, findDefinitions, findSymbols, outline, familyOf, oversized, MAX_GREP_BYTES } from '../src/codegraph.js';
import { codeSnippets, drilldown, find, parsePointer, parsePointers, createNote, orient, lookup } from '../src/ops.js';
import { renderNote, renderPointer } from '../src/rank.js';
import { Store } from '../src/store.js';

const CORE = `import os\n\nclass Command:\n    def invoke(self, ctx):\n        return self.main(ctx)\n\n    def main(self, ctx):\n        return run_callback(ctx)\n\ndef run_callback(ctx):\n    return ctx\n\ndef unused_helper():\n    return 1\n`;
const CLI = `from core import Command, run_callback\n\ndef entry(ctx):\n    cmd = Command()\n    cmd.invoke(ctx)\n    return run_callback(ctx)\n\ndef other(ctx):\n    return run_callback(ctx)\n`;
const TEST = `from core import run_callback\n\ndef test_run_callback():\n    assert run_callback(1) == 1\n`;

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cg-'));
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'src/core.py'), CORE);
  fs.writeFileSync(path.join(dir, 'src/cli.py'), CLI);
  fs.writeFileSync(path.join(dir, 'tests/test_core.py'), TEST);
  fs.writeFileSync(path.join(dir, 'README.md'), 'run_callback is documented here\n');
  fs.writeFileSync(path.join(dir, 'src/long.py'), 'def long_one(x):\n' + Array.from({ length: 40 }, (_, i) => `    x = x + ${i}\n`).join('') + '    return x\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

test('references counts uses outside the definition, by language family, and tells calls from mentions', () => {
  const repo = gitRepo();
  const r = references(repo, 'run_callback', { file: 'src/core.py' });
  assert.equal(r.files, 3); // cli.py, tests/test_core.py and core.py's own call inside main; README.md is not python
  assert.equal(r.sites, 4); // main, entry, other, the test
  const def = r.lines.find(l => l.def); assert.equal(def.path, 'src/core.py'); assert.equal(def.line, 10);
  assert.ok(r.lines.find(l => l.path === 'tests/test_core.py').test);
  assert.ok(r.lines.find(l => l.path === 'src/cli.py' && l.line === 1).import);
  assert.deepEqual(familyOf('x.ts').includes('tsx'), true);
});

test('fanout is the blast radius of a symbol pointer and short or common names are not counted', () => {
  const repo = gitRepo();
  assert.deepEqual(fanout(repo, { path: 'src/core.py', symbol: 'run_callback' }), { files: 3, sites: 4, refs: 6 });
  assert.deepEqual(fanout(repo, { path: 'src/core.py', symbol: 'unused_helper' }), { files: 0, sites: 0, refs: 0 });
  assert.equal(fanout(repo, { path: 'src/core.py', symbol: 'main' }), null);
  assert.equal(fanout(repo, { path: 'src/core.py' }), null);
  const deps = annotateFanout(repo, [{ path: 'src/core.py', symbol: 'Command.invoke' }, { path: 'src/core.py' }]);
  assert.deepEqual(deps[0].fanout, { files: 1, sites: 1, refs: 1 });
  assert.equal(deps[1].fanout, undefined);
  assert.equal(renderPointer({ path: 'src/core.py', symbol: 'run_callback', line: 10, fanout: { files: 3, sites: 4, refs: 6 } }), 'src/core.py:run_callback:L10 [4 call sites in 3 files]');
  assert.equal(renderPointer({ path: 'src/core.py', symbol: 'x', fanout: { files: 0, sites: 0, refs: 0 } }), 'src/core.py:x [no references]');
});

test('callees are the repository symbols a definition calls, resolved to their definitions', () => {
  const repo = gitRepo();
  const c = callees(repo, { path: 'src/cli.py', symbol: 'entry' });
  assert.deepEqual(c.map(x => x.name), ['Command', 'invoke', 'run_callback']);
  assert.deepEqual(c[2].defs, [{ path: 'src/core.py', line: 10 }]);
  assert.deepEqual(findDefinitions(repo, 'entry').map(d => `${d.path}:${d.line}`), ['src/cli.py:3']);
  assert.deepEqual(outline(repo, 'src/core.py').map(d => `${d.parent ? d.parent + '.' : ''}${d.name}@${d.line}`), ['Command@3', 'Command.invoke@4', 'Command.main@7', 'run_callback@10', 'unused_helper@13']);
});

test('references and callees are unknown, not empty, outside a git repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-nogit-'));
  fs.writeFileSync(path.join(dir, 'a.py'), CORE);
  assert.equal(references(dir, 'run_callback', { file: 'a.py' }), null);
  assert.equal(fanout(dir, { path: 'a.py', symbol: 'run_callback' }), null);
});

function storeWithNotes(repo) {
  const store = new Store(repo).init();
  const a = createNote(store, { title: 'Command invocation path', kind: 'callpath', answers: ['how is a command invoked', 'where does invoke call main'], body: 'src/core.py:Command.invoke calls Command.main which calls run_callback.', deps: [{ path: 'src/core.py', symbol: 'Command.invoke' }, { path: 'src/core.py', symbol: 'run_callback' }] }).note;
  const b = createNote(store, { title: 'CLI entry point', kind: 'location', answers: ['where is the cli entry'], body: 'src/cli.py:entry builds a Command and invokes it.', deps: [{ path: 'src/cli.py', symbol: 'entry' }] }).note;
  return { store, a, b };
}

test('notes created with symbol pointers carry their blast radius and show it when served', () => {
  const repo = gitRepo();
  const { store, a } = storeWithNotes(repo);
  const run = a.deps.find(d => d.symbol === 'run_callback');
  assert.deepEqual(run.fanout, { files: 3, sites: 4, refs: 6 });
  assert.match(renderNote(store.get(a.id)), /src\/core\.py:run_callback:L10 \[4 call sites in 3 files\]/);
});

test('codeSnippets inlines the definitions behind the pointers within a budget', () => {
  const repo = gitRepo();
  const { store, a, b } = storeWithNotes(repo);
  const s = codeSnippets(repo, [store.get(a.id), store.get(b.id)], 10000);
  assert.match(s.text, /^### Code behind the pointers\n/);
  assert.match(s.text, /src\/core\.py:Command\.invoke \(L4–L5\)\n```\n    def invoke\(self, ctx\):\n        return self\.main\(ctx\)\n```/);
  assert.match(s.text, /src\/cli\.py:entry \(L3–L6\)/);
  assert.deepEqual(s.shown.map(x => x.symbol), ['Command.invoke', 'run_callback', 'entry']);
  // a long definition is cut to what fits, down to minLines; too small a budget shows nothing
  const long = codeSnippets(repo, [{ id: 'x', deps: [{ path: 'src/core.py', symbol: 'Command' }] }], 10000, { maxLines: 3 });
  assert.match(long.text, /src\/core\.py:Command \(L3–L5 of L3–L8\)\n```\nclass Command:\n    def invoke\(self, ctx\):\n        return self\.main\(ctx\)\n…\n```/);
  assert.equal(codeSnippets(repo, [store.get(a.id)], 10).text, '');
  // the same symbol from two notes is shown once; perNote and max cap the count
  const twice = codeSnippets(repo, [store.get(a.id), { id: 'y', deps: [{ path: 'src/core.py', symbol: 'run_callback' }] }], 10000);
  assert.equal(twice.shown.length, 2);
  assert.equal(codeSnippets(repo, [store.get(a.id), store.get(b.id)], 10000, { perNote: 1 }).shown.length, 2);
});

test('orient and lookup add the code only when asked, in what is left of the budget plus the snippet allowance', async () => {
  const repo = gitRepo();
  const { store } = storeWithNotes(repo);
  const plain = await orient(store, { task: 'how is a command invoked, where does invoke call main', backgroundVerify: false, budget: 3000 });
  assert.ok(plain.included.length >= 1);
  assert.ok(!plain.text.includes('Code behind the pointers'));
  const withCode = await orient(store, { task: 'how is a command invoked, where does invoke call main', backgroundVerify: false, budget: 3000, snippets: true });
  assert.match(withCode.text, /### Code behind the pointers\nsrc\/core\.py:Command\.invoke \(L4–L5\)/);
  assert.ok(withCode.tokens > plain.tokens);
  assert.deepEqual(withCode.snippets[0], { id: 'command-invocation-path', path: 'src/core.py', symbol: 'Command.invoke' });
  // notes fill the budget: the code still gets its own allowance
  const tight = await orient(store, { task: 'how is a command invoked, where does invoke call main', backgroundVerify: false, budget: 200, snippets: { budget: 150 } });
  assert.ok(tight.text.includes('Code behind the pointers'));
  // without the allowance the code only takes what the notes left of the budget
  const zero = await orient(store, { task: 'how is a command invoked, where does invoke call main', backgroundVerify: false, budget: 200, snippets: { budget: 0 } });
  assert.ok(zero.tokens <= 200, String(zero.tokens));
  const l = await lookup(store, { query: 'command-invocation-path', snippets: true });
  assert.match(l.text, /Code behind the pointers/);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ snippets: false }));
  assert.ok(!(await lookup(store, { query: 'command-invocation-path', snippets: true })).text.includes('Code behind'));
  fs.rmSync(path.join(store.dir, 'config.json'));
});

test('parsePointer reads path:Symbol:L12 in any order of its tail', () => {
  assert.deepEqual(parsePointer('src/core.py:Command.invoke:L4'), { path: 'src/core.py', symbol: 'Command.invoke', line: 4 });
  assert.deepEqual(parsePointer('src/core.py:12'), { path: 'src/core.py', symbol: null, line: 12 });
  assert.deepEqual(parsePointer('src/core.py'), { path: 'src/core.py', symbol: null, line: null });
  assert.equal(parsePointer('src/core.py:a b'), null);
});

test('drilldown returns the definition with its lines, callers and callees, and the notes on it', () => {
  const repo = gitRepo();
  const { store, a } = storeWithNotes(repo);
  const r = drilldown(store, { pointer: 'src/core.py:run_callback' });
  assert.match(r.text, /^src\/core\.py:run_callback \(L10–L11, 2 lines; 4 call sites in 3 files\)\n```\n10  def run_callback\(ctx\):\n11      return ctx\n```/, 'lines carry their numbers');
  assert.match(r.text, /Callers and other references \(6 in 3 files\):\n- src\/cli\.py:L6  return run_callback\(ctx\)\n- src\/cli\.py:L9/); // calls first, tests last, imports after
  assert.ok(r.text.indexOf('tests/test_core.py') > r.text.indexOf('src/cli.py:L6'));
  assert.ok(!r.text.includes('Calls into this repository')); // run_callback calls nothing of the repository
  assert.match(r.text, /Cached notes about this code \(lookup takes an id\):\n### \[map\] Command invocation path/);
  assert.deepEqual(r.notes.map(n => n.id), [a.id]);
  // a bare symbol resolves through the notes' pointers, then through the code
  assert.equal(drilldown(store, { pointer: 'invoke' }).file, 'src/core.py');
  const bare = drilldown(store, { pointer: 'other' });
  assert.equal(bare.file, 'src/cli.py');
  assert.match(bare.text, /Callers and other references: none\n\nCalls into this repository: run_callback \(src\/core\.py:L10\)/);
  // a note on the file, not on the symbol: listed by title, never printed whole
  assert.match(bare.text, /Cached notes about this code \(lookup takes an id\):\n- \[map\] CLI entry point  \(id: cli-entry-point\)/);
  assert.match(drilldown(store, { pointer: 'tests/test_core.py:test_run_callback' }).text, /No cached notes rest on this code\./);
  // callees of a caller; a path alone is an outline
  assert.match(drilldown(store, { pointer: 'src/cli.py:entry' }).text, /Calls into this repository: Command \(src\/core\.py:L3\), invoke \(src\/core\.py:L4\), run_callback \(src\/core\.py:L10\)/);
  const file = drilldown(store, { pointer: 'src/core.py' });
  assert.match(file.text, /^src\/core\.py: 5 definitions\n- L3 class Command\n- L4 method Command\.invoke/);
  assert.match(file.text, /Cached notes about this code/);
  // errors say what to do
  assert.match(drilldown(store, { pointer: 'src/core.py:nothing' }).error, /nothing is not defined in src\/core\.py/);
  assert.match(drilldown(store, { pointer: 'zzz_undefined' }).error, /no definition of zzz_undefined/);
  assert.match(drilldown(store, { pointer: '' }).error, /needs a pointer/);
  // a budget cuts the code, not the rest
  const small = drilldown(store, { pointer: 'src/long.py:long_one', budget: 300 });
  assert.match(small.text, /^src\/long\.py:long_one \(L1–L42, 42 lines; no references\)\n```\n 1  def long_one\(x\):\n( ?\d\d? {6}x = x \+ \d+\n){17}… \(24 more lines; drilldown with a larger budget for all of it\)\n```/);
  assert.match(small.text, /No cached notes rest on this code/);
  assert.ok(small.tokens <= 320, String(small.tokens));
  assert.ok(!drilldown(store, { pointer: 'src/long.py:long_one', budget: 3000 }).text.includes('more lines'));
});

test('findSymbols lists the definitions carrying the words, name matches first, with exact spans', () => {
  const repo = gitRepo();
  {
    const r = findSymbols(repo, 'run callback');
    assert.equal(r.hits[0].symbol, 'run_callback'); // named by both words
    assert.equal(r.hits[0].path, 'src/core.py'); assert.equal(r.hits[0].line, 10); assert.equal(r.hits[0].end, 11);
    assert.ok(r.hits.some(h => h.symbol === 'Command.main'), 'a method whose body calls run_callback'); // body mention, parent resolved
    const test = r.hits.find(h => h.path === 'tests/test_core.py'); const prod = r.hits.find(h => h.symbol === 'entry');
    assert.ok(!test || test.score < prod.score, 'tests rank below production code');
    assert.deepEqual(findSymbols(repo, 'the and of').hits, []); // nothing left after stop words
    assert.equal(findSymbols(repo, 'Command').hits[0].symbol, 'Command'); // an identifier: the exact name first
    assert.equal(findSymbols(repo, 'run callback', { scope: 'tests/' }).hits.every(h => h.path.startsWith('tests/')), true);
    assert.equal(findSymbols(repo, 'run callback', { scope: '**/*.py' }).hits.length > 0, true);
  }
});

test('find renders pointers drilldown takes, with the notes on them; drilldown reads several pointers and outlines a long class', () => {
  const repo = gitRepo();
  process.env.THINKER_LOG = 'off';
  try {
    const store = new Store(repo).init();
    createNote(store, { title: 'Callbacks run through run_callback', kind: 'callpath', body: 'src/core.py:run_callback is the end of the line.', deps: [{ path: 'src/core.py', symbol: 'run_callback' }] });
    const f = find(store, { query: 'run callback' });
    assert.match(f.text, /^Definitions carrying "run callback"/);
    assert.match(f.text, /- src\/core\.py:run_callback:L10  \(function, 2 lines; 4 call sites in 3 files\)/);
    assert.match(f.text, /Cached notes on this code.*\n- \[map\] Callbacks run through run_callback/);
    assert.match(find(store, { query: 'zzzz_nothing_here' }).text, /No definition carries/);
    // one identifier: the code of its definition comes with the list, so no second call is needed; words: pointers only
    assert.match(find(store, { query: 'run_callback' }).text, /\n\nsrc\/core\.py:run_callback \(L10–L11[^\n]*\n```\n10  def run_callback\(ctx\):/);
    assert.doesNotMatch(f.text, /```/);
    assert.doesNotMatch(f.text + find(store, { query: 'run_callback' }).text, /Next: drilldown/);
    // drilldown takes a list of pointers as well
    assert.match(drilldown(store, { pointers: ['src/core.py:Command.invoke', 'src/core.py:run_callback'] }).text, /Command\.invoke \(L4–L5[\s\S]*run_callback \(L10–L11/);
    assert.deepEqual(parsePointers('src/core.py:Command.invoke:L4 (method, 2 lines; 1 call site), src/core.py:run_callback and `src/cli.py`'), ['src/core.py:Command.invoke:L4', 'src/core.py:run_callback', 'src/cli.py']);
    assert.deepEqual(parsePointers('invoke'), ['invoke']);
    const d = drilldown(store, { pointer: 'src/core.py:Command.invoke, src/core.py:run_callback' });
    assert.match(d.text, /src\/core\.py:Command\.invoke \(L4–L5, 2 lines/); assert.match(d.text, /src\/core\.py:run_callback \(L10–L11, 2 lines/);
    assert.doesNotMatch(d.text, /Callers \(/); assert.doesNotMatch(d.text, /drilldown with one pointer/, 'no invitation to another call');
    assert.match(d.text, /Callbacks run through run_callback/);
    // a class longer than the room is shown as its head and its members
    fs.writeFileSync(path.join(repo, 'src/big.py'), 'class Big:\n    """doc"""\n' + Array.from({ length: 6 }, (_, i) => `    def m${i}(self):\n` + Array.from({ length: 12 }, (_, j) => `        x${j} = ${j}\n`).join('') + '        return x0\n').join(''));
    const big = drilldown(store, { pointer: 'src/big.py:Big', budget: 400 });
    assert.match(big.text, /src\/big\.py:Big \(L1–L86, 86 lines\)/); assert.match(big.text, /Members \(6; drilldown src\/big\.py:Big\.<member> for one\):\n- L3 method m0/);
    assert.doesNotMatch(big.text, /x11 = 11/);
    const whole = drilldown(store, { pointer: 'src/big.py:Big', budget: 4000 });
    assert.match(whole.text, /x11 = 11/); assert.doesNotMatch(whole.text, /Members/);
  } finally { delete process.env.THINKER_LOG; }
});

test('find and references leave a checkout nested under the repository alone', () => {
  const repo = gitRepo();
  // a benchmark's clone left in a run directory, untracked: `git grep --untracked` would read it
  const nested = path.join(repo, 'bench/runs/x/wt/clone');
  fs.mkdirSync(path.join(nested, 'src'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.git'), 'gitdir: /elsewhere\n');
  fs.writeFileSync(path.join(nested, 'src/core.py'), CORE);
  fs.writeFileSync(path.join(repo, 'bench/runs/x/plain.py'), 'def run_callback_copy():\n    return run_callback\n');
  const hits = findSymbols(repo, 'run callback').hits;
  assert.ok(hits.length > 0);
  assert.ok(hits.every(h => !h.path.includes('wt/clone')), hits.map(h => h.path).join(', '));
  assert.ok(hits.some(h => h.path === 'bench/runs/x/plain.py'), 'an untracked file outside a nested checkout still counts');
  const refs = references(repo, 'run_callback');
  assert.ok(refs.lines.every(l => !l.path.includes('wt/clone')));
});

test('drilldown lists no callers for a name defined in many places: by name they cannot be told apart', () => {
  const repo = gitRepo();
  process.env.THINKER_LOG = 'off';
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(repo, `src/m${i}.py`), `class M${i}:\n    def load(self):\n        return ${i}\n\ndef use${i}(x):\n    return x.load()\n`);
  execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'loads'], { cwd: repo });
  const d = drilldown(new Store(repo).init(), { pointer: 'src/m0.py:M0.load' });
  assert.match(d.text, /Callers not listed: load is defined in 5 places/);
  assert.doesNotMatch(d.text, /Callers and other references/);
});

test('the guard line says where an uncovered identifier is defined, only when that is one place', async () => {
  const { anchoringGuard } = await import('../src/guard.js');
  const repo = gitRepo();
  for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(repo, `src/h${i}.py`), 'def helper_twice(x):\n    return x\n');
  execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'helpers'], { cwd: repo });
  const g = anchoringGuard(repo, 'make `run_callback` and `helper_twice` faster', [], { explicitOnly: true, max: 5 });
  assert.match(g.text, /`run_callback` \(\d files?; defined at src\/core\.py:L10\)/);
  assert.match(g.text, /`helper_twice` \(2 files; defined in 2 places\)/, 'several definitions are counted, not one picked');
});

test('find on one identifier lists its definitions first, however large their file or body, and shows code only for a single one', () => {
  const repo = gitRepo();
  process.env.THINKER_LOG = 'off';
  // a class past both limits of the word search: a file over 400 kB and a body over 1,500 lines
  const body = Array.from({ length: 1700 }, (_, i) => `    def m${i}(self):\n        return "${'x'.repeat(220)}"\n`).join('');
  fs.writeFileSync(path.join(repo, 'src/big_store.py'), `class BigStore:\n${body}`);
  fs.writeFileSync(path.join(repo, 'src/other.py'), 'def use_store():\n    return BigStore()\n\ndef big_helper():\n    return 1\n');
  fs.writeFileSync(path.join(repo, 'src/again.py'), 'def big_helper():\n    return 2\n');
  execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'big'], { cwd: repo });
  assert.ok(fs.statSync(path.join(repo, 'src/big_store.py')).size > 400_000);
  const store = new Store(repo).init();
  const f = find(store, { query: 'BigStore' });
  assert.match(f.text, /^Definitions carrying "BigStore"[^\n]*\n- src\/big_store\.py:BigStore:L1  \(class/, 'the class comes first');
  assert.match(f.text, /```\n +1  class BigStore:/, 'one definition of the name: its code (head and members) comes with the list');
  const two = find(store, { query: 'big_helper' });
  assert.match(two.text, /- src\/(other|again)\.py:big_helper:L\d+[\s\S]*- src\/(other|again)\.py:big_helper:L\d+/);
  assert.doesNotMatch(two.text, /```/, 'two definitions of the name: none of them is picked to show');
});

test('find puts every identifier the query names first, a named class with the members asked for, and words fill the rest', () => {
  const repo = gitRepo();
  process.env.THINKER_LOG = 'off';
  fs.writeFileSync(path.join(repo, 'src/params.py'), [
    'class Option:', '    def __init__(self):', '        self.x = 1', '    def to_info_dict(self):', '        return {"convert": 1, "type": 2}',
    'class Parameter:', '    def to_info_dict(self):', '        return {"convert": 3}',
    'def convert_type(ty):', '    return ty', 'def convert_value(x):', '    return convert_type(x) or "convert type convert type"', ''].join('\n'));
  execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'params'], { cwd: repo });
  const store = new Store(repo).init();
  const syms = q => find(store, { query: q, limit: 6 }).hits.map(h => h.symbol);
  assert.equal(syms('flag_value convert_type')[0], 'convert_type', 'an identifier among words is not split into "convert" and "type"');
  assert.deepEqual(syms('run_callback convert_type').slice(0, 2), ['run_callback', 'convert_type'], 'several identifiers, in the order named');
  assert.deepEqual(syms('to_info_dict Option Parameter').slice(0, 2), ['Option.to_info_dict', 'Parameter.to_info_dict'], 'a class named beside a member: that member first');
  assert.equal(syms('Option init')[0], 'Option.__init__', 'a plain word names a member of the class too');
});

test('git grep reaches a file the agent just wrote without walking the tree, and leaves nested checkouts out', () => {
  const repo = gitRepo();
  process.env.THINKER_LOG = 'off';
  fs.writeFileSync(path.join(repo, 'src/fresh.py'), 'def brand_new_helper():\n    return 1\n');  // untracked
  const nested = path.join(repo, 'bench/clone'); fs.mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: nested }); fs.writeFileSync(path.join(nested, 'x.py'), 'def brand_new_helper():\n    return 2\n');
  assert.deepEqual((findDefinitions(repo, 'brand_new_helper') || []).map(d => d.path), ['src/fresh.py']);
  assert.equal(find(new Store(repo).init(), { query: 'brand_new_helper' }).hits[0].path, 'src/fresh.py');
});

test('a generated source file over the size cap is left out of every search, and a hand-written file under it is not', () => {
  const repo = gitRepo();
  // a protobuf-style stub past the cap that defines and mentions the name, like mlflow's Service.java
  const stub = 'public final class Service {\n' + Array.from({ length: 6000 }, (_, i) => `  public static void runCallback${i}() { /* run_callback ${'x'.repeat(80)} */ }\n`).join('') + '  class run_callback {}\n}\n';
  fs.writeFileSync(path.join(repo, 'src/Service.java'), stub);
  execFileSync('git', ['add', '-A'], { cwd: repo }); execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'stub'], { cwd: repo });
  assert.ok(fs.statSync(path.join(repo, 'src/Service.java')).size > MAX_GREP_BYTES);
  assert.deepEqual(oversized(repo), ['src/Service.java']);
  assert.ok(!(findDefinitions(repo, 'run_callback') || []).some(d => d.path === 'src/Service.java'), 'not where a definition is looked for');
  assert.ok((findDefinitions(repo, 'run_callback') || []).some(d => d.path === 'src/core.py'), 'the real definition is still found');
  const r = findSymbols(repo, 'run callback');
  assert.ok(r && r.hits.length && !r.hits.some(h => h.path === 'src/Service.java'));
  assert.ok(!references(repo, 'run_callback').lines.some(l => l.path === 'src/Service.java'), 'nor where its callers are looked for');
});
