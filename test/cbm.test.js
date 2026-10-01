import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseSearch, parseOutline, pathFromQn, codegraphEngine, cbmAsset, cbmBin, cbmIndex, cbmForget, cbmProject, cbmNeighbors, resetCbm } from '../src/cbm.js';
import { fanout, callers, callees, findDefinitions, outline } from '../src/codegraph.js';
import { drilldown } from '../src/ops.js';
import { renderFanout } from '../src/rank.js';
import { maintain } from '../src/maintain.js';
import { Store } from '../src/store.js';

// Shapes as codebase-memory-mcp 0.11.0 returns them with format=json.
const SEARCH = { qn_rule: 'qn = …', cols: ['name', 'label', 'lines', 'in', 'out'], groups: [
  { qn_prefix: 'thinker-dev.src.deps', file: 'src/deps.js', rows: [['checkNote', 'Function', '158-175', 3, 2]] },
  { qn_prefix: 'thinker-dev.__branch__', file: '{}', rows: [['main', 'Branch', '', 0, 0]] },
  { qn_prefix: 'thinker-dev.src.store.Store', file: 'src/store.js', rows: [['put', 'Method', '155-163', 0, 3]] },
], total: 3, returned: 3 };
const OUTLINE = { file_path: 'src/store.js', cols: ['name', 'label', 'lines', 'qn'], rows: [
  ['KINDS', 'Variable', '8-8', 'thinker-dev.src.store.KINDS'],
  ['Store', 'Class', '103-179', 'thinker-dev.src.store.Store'],
  ['put', 'Method', '155-163', 'thinker-dev.src.store.Store.put'],
], total: 3 };

test('CBM search results are flattened to definitions with a file and a line; branches are not definitions', () => {
  const hits = parseSearch(SEARCH);
  assert.deepEqual(hits.map(h => h.qn), ['thinker-dev.src.deps.checkNote', 'thinker-dev.src.store.Store.put']);
  assert.deepEqual(hits[0], { name: 'checkNote', qn: 'thinker-dev.src.deps.checkNote', qn_prefix: 'thinker-dev.src.deps', label: 'Function', path: 'src/deps.js', line: 158, end: 175, in: 3, out: 2 });
  assert.equal(hits[1].qn_prefix, 'thinker-dev.src.store.Store');
});

test('a CBM file outline names the parent of a method from its qualified name', () => {
  assert.deepEqual(parseOutline(OUTLINE), [
    { name: 'KINDS', parent: null, kind: 'variable', line: 8, end: 8 },
    { name: 'Store', parent: null, kind: 'class', line: 103, end: 179 },
    { name: 'put', parent: 'Store', kind: 'method', line: 155, end: 163 },
  ]);
});

test('a qualified name of a file resolves to its path in the checkout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cbm-qn-'));
  fs.mkdirSync(path.join(dir, 'src/util'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/mcp.js'), ''); fs.writeFileSync(path.join(dir, 'src/util/a.test.ts'), ''); fs.writeFileSync(path.join(dir, 'Makefile'), '');
  assert.equal(pathFromQn(dir, 'p', 'p.src.mcp'), 'src/mcp.js');
  assert.equal(pathFromQn(dir, 'p', 'p.src.util.a.test'), 'src/util/a.test.ts');
  assert.equal(pathFromQn(dir, 'p', 'p.Makefile'), 'Makefile');
  assert.equal(pathFromQn(dir, 'p', 'p.src.nothing'), null);
  assert.equal(pathFromQn(dir, 'p', 'other.src.mcp'), null);
});

test('THINKER_CODEGRAPH=git keeps the graph out; caller counts render as callers', () => {
  const before = process.env.THINKER_CODEGRAPH;
  process.env.THINKER_CODEGRAPH = 'git';
  try { assert.equal(codegraphEngine(process.cwd()), 'git'); assert.equal(cbmBin(), null); }
  finally { if (before === undefined) delete process.env.THINKER_CODEGRAPH; else process.env.THINKER_CODEGRAPH = before; }
  assert.equal(renderFanout({ files: 3, sites: 5, refs: 5, callers: true }), '5 callers in 3 files');
  assert.equal(renderFanout({ files: 1, sites: 1, refs: 1, callers: true }), '1 caller in 1 file');
  assert.equal(renderFanout({ files: 2, sites: 4, refs: 6 }), '4 call sites in 2 files');
  assert.match(cbmAsset() || 'codebase-memory-mcp-x', /^codebase-memory-mcp-/);
});

test('maintenance re-indexes the graph when HEAD moved, only for a checkout that has one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cbm-m-'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const store = new Store(dir); store.init();
  const calls = [];
  const fns = { cochange: () => {}, refresh: () => [], phrase: async () => ({ done: [] }), spentToday: () => 0, graphIndexed: () => false, graphIndex: () => { calls.push('index'); return { project: 'x' }; } };
  let r = await maintain(store, dir, { fns });
  assert.equal(r.graph, false); assert.deepEqual(calls, []);
  fns.graphIndexed = () => 'x';
  r = await maintain(store, dir, { fns });
  assert.equal(r.graph, true); assert.deepEqual(calls, ['index']);
  r = await maintain(store, dir, { fns });
  assert.equal(r.graph, false); assert.deepEqual(calls, ['index'], 'same HEAD: no second index');
});

// The live engine: needs the binary and leave to write to its index (~/.cache/codebase-memory-mcp).
// THINKER_CBM_TEST=1 THINKER_CBM_BIN=/path/to/codebase-memory-mcp npm test
const live = process.env.THINKER_CBM_TEST === '1' && process.env.THINKER_CBM_BIN;
test('the graph answers callers, callees, definitions and outlines for an indexed checkout', { skip: !live && 'set THINKER_CBM_TEST=1 and THINKER_CBM_BIN' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cbm-live-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/core.py'), 'class Command:\n    def invoke(self, ctx):\n        return run_callback(ctx)\n\ndef run_callback(ctx):\n    return helper(ctx)\n\ndef helper(ctx):\n    return ctx\n');
  fs.writeFileSync(path.join(dir, 'src/cli.py'), 'from core import run_callback\n\ndef entry(ctx):\n    return run_callback(ctx)\n');
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const env = { CODEGRAPH: process.env.THINKER_CODEGRAPH, AST: process.env.THINKER_AST };
  process.env.THINKER_CODEGRAPH = 'cbm'; process.env.THINKER_AST = 'off';
  resetCbm();
  try {
    const ix = cbmIndex(dir, { name: `thinker-test-${process.pid}` });
    assert.ok(!ix.error, ix.error);
    assert.equal(cbmProject(dir, { fresh: true }), ix.project);
    assert.equal(codegraphEngine(dir), 'cbm');
    const n = cbmNeighbors(ix.project, { path: 'src/core.py', symbol: 'run_callback' });
    assert.deepEqual(n.callers.map(c => `${c.path}:${c.name}`).sort(), ['src/cli.py:entry', 'src/core.py:invoke']);
    assert.deepEqual(n.callees.map(c => `${c.path}:${c.name}:L${c.line}`), ['src/core.py:helper:L8']);
    assert.deepEqual(fanout(dir, { path: 'src/core.py', symbol: 'run_callback' }), { files: 2, sites: 2, refs: 2, callers: true });
    assert.equal(callers(dir, { path: 'src/core.py', symbol: 'Command.invoke' })?.length, 0);
    assert.deepEqual(callees(dir, { path: 'src/core.py', symbol: 'run_callback' }), [{ name: 'helper', defs: [{ path: 'src/core.py', line: 8 }] }]);
    assert.deepEqual(findDefinitions(dir, 'helper').map(d => `${d.path}:L${d.line}`), ['src/core.py:L8']);
    assert.deepEqual(outline(dir, 'src/core.py').map(d => `${d.parent ? d.parent + '.' : ''}${d.name}`), ['Command', 'Command.invoke', 'run_callback', 'helper']);
    const store = new Store(dir); store.init();
    const d = drilldown(store, { pointer: 'src/core.py:run_callback' });
    assert.match(d.text, /2 callers in 2 files/);
    assert.match(d.text, /Callers \(2 in 2 files\):\n- src\/c(li|ore)\.py:/);
    assert.match(d.text, /Calls into this repository: helper \(src\/core\.py:L8\)/);
  } finally {
    cbmForget(dir);
    if (env.CODEGRAPH === undefined) delete process.env.THINKER_CODEGRAPH; else process.env.THINKER_CODEGRAPH = env.CODEGRAPH;
    if (env.AST === undefined) delete process.env.THINKER_AST; else process.env.THINKER_AST = env.AST;
    resetCbm();
  }
});
