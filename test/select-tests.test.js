// The test selection behind `npm test` (scripts/select-tests.mjs): which test files a change reaches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildGraph, selectTests, changedFiles, edgesOf, RUN_EVERYTHING, isTestFile } from '../scripts/select-tests.mjs';

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'select-tests-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const FILES = {
  'src/store.js': 'export const a = 1;\n',
  'src/ops.js': "import { a } from './store.js';\nexport const b = a;\n",
  'src/cli.js': "import './ops.js';\nconst { c } = await import('./commands/learn.js');\n",
  'src/commands/learn.js': "export const c = 1;\n",
  'src/ui/server.js': "import fs from 'node:fs';\nexport const page = fs.readFileSync(new URL('./page.html', import.meta.url), 'utf8');\n",
  'src/ui/page.html': '<html></html>\n',
  'src/leaf.js': 'export const leaf = 1;\n',
  'src/orphan.js': 'export const o = 1;\n',
  'install.sh': '#!/bin/sh\n',
  'site/index.html': '<html></html>\n',
  'test/ops.test.js': "import { b } from '../src/ops.js';\n",
  'test/cli.test.js': "import { execFileSync } from 'node:child_process';\nconst CLI = 'src/cli.js';\nexecFileSync('node', [CLI]);\n",
  'test/ui.test.js': "const { page } = await import('../src/ui/server.js');\n",
  'test/leaf.test.js': "import { leaf } from '../src/leaf.js';\n// a comment: '../src/store.js' is not an edge\nconst fixture = 'AGENTS.md';\nconst other = 'src/a.js';\n",
  'test/install.test.js': "import path from 'node:path';\nconst SRC = path.join('x', 'src');\nconst sh = path.join(SRC, '..', 'install.sh');\nconst site = new URL('../site/index.html', import.meta.url);\n",
  'test/helper.js': "export const h = 1;\n",
  'test/helped.test.js': "import { h } from './helper.js';\n",
  'test/gone.test.js': "import { z } from '../src/removed.js';\n",
};

test('edges: specifiers from every file, repository paths and upward joins from tests alone', () => {
  const root = repo(FILES);
  assert.deepEqual([...edgesOf(root, 'src/cli.js')].sort(), ['src/commands/learn.js', 'src/ops.js']);
  assert.deepEqual([...edgesOf(root, 'src/ui/server.js')], ['src/ui/page.html']);
  assert.deepEqual([...edgesOf(root, 'test/cli.test.js')], ['src/cli.js']);
  assert.deepEqual([...edgesOf(root, 'test/leaf.test.js')], ['src/leaf.js'], 'a bare name and a path that does not exist are not edges');
  assert.deepEqual([...edgesOf(root, 'test/install.test.js')].sort(), ['install.sh', 'site/index.html']);
  assert.deepEqual([...edgesOf(root, 'test/gone.test.js')], ['src/removed.js'], 'a module that is gone keeps its edge');
});

test('selection: the tests whose closure holds a changed file, the changed tests, and the gaps', () => {
  const root = repo(FILES);
  const graph = buildGraph(root);
  assert.ok(isTestFile('test/ops.test.js') && !isTestFile('test/helper.js'));

  let sel = selectTests(graph, ['src/store.js']);
  assert.equal(sel.all, false);
  assert.deepEqual(sel.tests, ['test/cli.test.js', 'test/ops.test.js'], 'store reaches ops directly and cli through the handlers');
  assert.deepEqual(sel.why.get('test/cli.test.js'), ['src/store.js']);

  sel = selectTests(graph, ['src/commands/learn.js']);
  assert.deepEqual(sel.tests, ['test/cli.test.js'], 'a dynamic import is an edge');

  sel = selectTests(graph, ['src/ui/page.html']);
  assert.deepEqual(sel.tests, ['test/ui.test.js'], 'an asset read by URL is an edge');

  sel = selectTests(graph, ['src/leaf.js', 'test/helper.js', 'test/leaf.test.js']);
  assert.deepEqual(sel.tests, ['test/helped.test.js', 'test/leaf.test.js']);

  sel = selectTests(graph, ['install.sh', 'site/index.html']);
  assert.deepEqual(sel.tests, ['test/install.test.js']);

  sel = selectTests(graph, ['src/removed.js']);
  assert.deepEqual(sel.tests, ['test/gone.test.js']);

  sel = selectTests(graph, ['src/orphan.js', 'README.md']);
  assert.deepEqual(sel.tests, []);
  assert.deepEqual(sel.unreached, ['src/orphan.js'], 'a code file no test reaches is named; a document is not');
});

test('selection: the whole suite for the run\'s own files and for no change at all', () => {
  const root = repo(FILES);
  const graph = buildGraph(root);
  const all = [...graph.keys()].filter(isTestFile).sort();
  for (const f of RUN_EVERYTHING) {
    const sel = selectTests(graph, ['src/leaf.js', f]);
    assert.equal(sel.all, true, f);
    assert.deepEqual(sel.tests, all);
    assert.match(sel.reason, new RegExp(f.replace(/[.]/g, '\\.')));
  }
  const sel = selectTests(graph, []);
  assert.equal(sel.all, true);
  assert.match(sel.reason, /nothing changed/);
});

test('changed files: since the merge base with the base, the working tree and untracked; a version bump alone does not count', () => {
  const root = repo({ ...FILES, 'package.json': '{\n  "name": "x",\n  "version": "1.0.0"\n}\n', 'package-lock.json': '{\n  "version": "1.0.0"\n}\n' });
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'work');
  fs.writeFileSync(path.join(root, 'src/leaf.js'), 'export const leaf = 2;\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'leaf');
  // main moves on: only what the branch changed counts, not what main did since
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(root, 'src/store.js'), 'export const a = 3;\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'main moves');
  git('checkout', '-q', 'work');
  // the working tree: an edit, a new file, a version bump, and the cache's own state
  fs.writeFileSync(path.join(root, 'src/ops.js'), "import { a } from './store.js';\nexport const b = a + 1;\n");
  fs.writeFileSync(path.join(root, 'src/new.js'), 'export const n = 1;\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.1"\n}\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{\n  "version": "1.0.1"\n}\n');
  fs.mkdirSync(path.join(root, '.thinker'), { recursive: true });
  fs.writeFileSync(path.join(root, '.thinker/config.json'), '{}\n');
  assert.deepEqual(changedFiles(root, 'main'), ['src/leaf.js', 'src/new.js', 'src/ops.js']);
  fs.writeFileSync(path.join(root, 'package.json'), '{\n  "name": "y",\n  "version": "1.0.1"\n}\n');
  assert.ok(changedFiles(root, 'main').includes('package.json'), 'a change beyond the version counts');
});
