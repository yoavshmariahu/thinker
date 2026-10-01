import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { references, fanout, callees, annotateFanout, findDefinitions, outline, familyOf } from '../src/codegraph.js';
import { codeSnippets, drilldown, parsePointer, createNote, orient, lookup } from '../src/ops.js';
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
  process.env.THINKER_FANOUT = 'off';
  try { assert.equal(renderPointer({ path: 'a.py', symbol: 'x', fanout: { files: 2, sites: 1, refs: 1 } }), 'a.py:x'); assert.equal(annotateFanout(repo, deps)[0].fanout, deps[0].fanout); }
  finally { delete process.env.THINKER_FANOUT; }
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
  const l = lookup(store, { query: 'command-invocation-path', snippets: true });
  assert.match(l.text, /Code behind the pointers/);
  process.env.THINKER_SNIPPETS = 'off';
  try { assert.ok(!lookup(store, { query: 'command-invocation-path', snippets: true }).text.includes('Code behind')); }
  finally { delete process.env.THINKER_SNIPPETS; }
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
  assert.match(r.text, /^src\/core\.py:run_callback \(L10–L11, 2 lines; 4 call sites in 3 files\)\n```\ndef run_callback\(ctx\):\n    return ctx\n```/);
  assert.match(r.text, /Callers and other references \(6 in 3 files\):\n- src\/cli\.py:L6  return run_callback\(ctx\)\n- src\/cli\.py:L9/); // calls first, tests last, imports after
  assert.ok(r.text.indexOf('tests/test_core.py') > r.text.indexOf('src/cli.py:L6'));
  assert.ok(!r.text.includes('Calls into this repository')); // run_callback calls nothing of the repository
  assert.match(r.text, /Cached notes about this code \(lookup takes an id\):\n### \[callpath\] Command invocation path/);
  assert.deepEqual(r.notes.map(n => n.id), [a.id]);
  // a bare symbol resolves through the notes' pointers, then through the code
  assert.equal(drilldown(store, { pointer: 'invoke' }).file, 'src/core.py');
  const bare = drilldown(store, { pointer: 'other' });
  assert.equal(bare.file, 'src/cli.py');
  assert.match(bare.text, /Callers and other references: none\n\nCalls into this repository: run_callback \(src\/core\.py:L10\)/);
  assert.match(bare.text, /Cached notes about this code \(lookup takes an id\):\n### \[location\] CLI entry point/); // a note on the file
  assert.match(drilldown(store, { pointer: 'tests/test_core.py:test_run_callback' }).text, /No cached notes rest on this code\./);
  // callees of a caller; a path alone is an outline
  assert.match(drilldown(store, { pointer: 'src/cli.py:entry' }).text, /Calls into this repository: Command \(src\/core\.py:L3\), invoke \(src\/core\.py:L4\), run_callback \(src\/core\.py:L10\)/);
  const file = drilldown(store, { pointer: 'src/core.py' });
  assert.match(file.text, /^src\/core\.py: 5 definitions\n- L3 class Command\n- L4 def Command\.invoke/);
  assert.match(file.text, /Cached notes about this code/);
  // errors say what to do
  assert.match(drilldown(store, { pointer: 'src/core.py:nothing' }).error, /nothing is not defined in src\/core\.py/);
  assert.match(drilldown(store, { pointer: 'zzz_undefined' }).error, /no definition of zzz_undefined/);
  assert.match(drilldown(store, { pointer: '' }).error, /needs a pointer/);
  // a budget cuts the code, not the rest
  const small = drilldown(store, { pointer: 'src/long.py:long_one', budget: 300 });
  assert.match(small.text, /^src\/long\.py:long_one \(L1–L42, 42 lines; no references\)\n```\ndef long_one\(x\):\n(    x = x \+ \d+\n){16}… \(25 more lines\)\n```/);
  assert.match(small.text, /No cached notes rest on this code/);
  assert.ok(small.tokens <= 320, String(small.tokens));
  assert.ok(!drilldown(store, { pointer: 'src/long.py:long_one', budget: 3000 }).text.includes('more lines'));
});
