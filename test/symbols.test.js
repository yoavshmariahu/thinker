// The persistent symbol table (src/symbols.js): off by default, built once over the checkout, refreshed
// for the files that changed, and the answer codegraph's definition lookups give when it is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildTable, refreshTable, tableStats, tableDir, lookupNames, outlineFile, symbolTableConfig, resetSymbols, SYMBOL_TABLE } from '../src/symbols.js';
import { findDefinitions, definitionOf, outline } from '../src/codegraph.js';
import { initAst, astStatus } from '../src/ast.js';

// the table is built through the same outline machinery the lookups use, parser included where it loads
await initAst();

process.env.THINKER_TELEMETRY = 'off';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

const CORE = 'import os\n\nclass Command:\n    def invoke(self, ctx):\n        return self.main(ctx)\n\n    def main(self, ctx):\n        return 1\n\ndef run_callback(ctx):\n    return ctx\n';
const CLI = 'from core import Command\n\ndef entry(ctx):\n    return Command().invoke(ctx)\n';

// A checkout with the table switched on and no background rebuilds: a test never spawns one.
function repoWith(t, files, over = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sym-')));
  t.after(() => { resetSymbols(); fs.rmSync(dir, { recursive: true, force: true }); });
  git(dir, 'init', '-q');
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, '.thinker'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ symbolTable: { enabled: true, background: false, sweep: 'inline', recheckMs: 0, ...over } }));
  resetSymbols();
  return dir;
}

test('the table is off until the config turns it on, and the lookups answer exactly as before', t => {
  const repo = repoWith(t, { 'src/core.py': CORE, 'src/cli.py': CLI }, {});
  fs.writeFileSync(path.join(repo, '.thinker', 'config.json'), JSON.stringify({}));
  resetSymbols();
  assert.equal(symbolTableConfig(repo).enabled, false);
  assert.deepEqual(symbolTableConfig(repo), SYMBOL_TABLE);
  assert.equal(lookupNames(repo, ['run_callback']), null, 'nothing is answered from a table that is off');
  assert.equal(outlineFile(repo, 'src/core.py'), null);
  assert.equal(findDefinitions(repo, 'run_callback')[0].path, 'src/core.py', 'git grep still answers');
  assert.equal(fs.existsSync(tableDir(repo)), false, 'and nothing was written');
});

test('a cold build over this repository covers its code and answers its own definitions', t => {
  // this repository's own source, in a checkout of its own: the table is a cache, never written into
  // the developer's working tree by a test
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sym-self-')));
  t.after(() => { resetSymbols(); fs.rmSync(dir, { recursive: true, force: true }); });
  git(dir, 'init', '-q');
  for (const sub of ['src', 'src/commands']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (const f of fs.readdirSync(path.join(REPO, sub))) {
      const from = path.join(REPO, sub, f);
      if (!f.endsWith('.js') || !fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(dir, sub, f));
    }
  }
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, '.thinker'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ symbolTable: { enabled: true, background: false, sweep: 'inline', recheckMs: 0 } }));
  resetSymbols();

  const meta = buildTable(dir, { background: false });
  assert.ok(meta.files > 40, `the build covered ${meta.files} files`);
  assert.ok(meta.symbols > 400, `and ${meta.symbols} definitions`);
  assert.equal(meta.truncated, false);
  assert.equal(tableStats(dir).symbols, meta.symbols);
  // the shards are on disk and the hashes line up with the paths
  assert.equal(JSON.parse(fs.readFileSync(path.join(tableDir(dir), 'paths.json'), 'utf8')).length, meta.files);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tableDir(dir), 'hashes.json'), 'utf8')).length, meta.files);

  resetSymbols(); // a new process reading the table it did not build
  const hit = findDefinitions(dir, 'buildTable');
  assert.deepEqual(hit.map(h => h.path), ['src/symbols.js']);
  assert.match(hit[0].text, /export function buildTable/);
  if (astStatus().available) assert.ok(hit[0].end > hit[0].line, 'the table carries the end of a definition, which git grep cannot');
  const names = outline(dir, 'src/symbols.js', { limit: 500 }).map(d => d.name);
  assert.ok(names.includes('buildTable') && names.includes('lookupNames'), names.slice(0, 5).join(','));
  assert.equal(definitionOf(dir, 'outlineFile').def.path, 'src/symbols.js');
});

test('a build bounded by maxFiles says so and leaves the rest to git grep', t => {
  const repo = repoWith(t, { 'src/core.py': CORE, 'src/cli.py': CLI, 'src/third.py': 'def third():\n    return 3\n' });
  const meta = buildTable(repo, { maxFiles: 1, background: false });
  assert.equal(meta.files, 1);
  assert.equal(meta.truncated, true);
  assert.equal(meta.tracked, 3);
});

test('an edited file refreshes: the lookup sees the new definition and not the old one', t => {
  const repo = repoWith(t, { 'src/core.py': CORE, 'src/cli.py': CLI });
  buildTable(repo, { background: false });
  resetSymbols();
  assert.equal(findDefinitions(repo, 'run_callback')[0].line, 10);
  assert.deepEqual(findDefinitions(repo, 'later_helper'), []);

  // an unstaged edit: nothing in git's index moved
  fs.writeFileSync(path.join(repo, 'src/core.py'), CORE.replace('def run_callback', 'def later_helper'));
  resetSymbols();
  const moved = findDefinitions(repo, 'later_helper');
  assert.deepEqual(moved.map(h => `${h.path}:${h.line}`), ['src/core.py:10'], 'the edited file was outlined again');
  assert.deepEqual(findDefinitions(repo, 'run_callback'), [], 'and its old definition is gone');
  assert.equal(tableStats(repo).delta, 1, 'one file sits in the delta, the rest of the table is untouched');

  // a new, committed file: the index moved, so even without a worktree sweep it is picked up
  fs.writeFileSync(path.join(repo, 'src/extra.py'), 'def extra_one():\n    return 1\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'extra');
  resetSymbols();
  assert.deepEqual(findDefinitions(repo, 'extra_one', { sweep: 'off' }).map(h => h.path), ['src/extra.py']);

  // and a deleted file leaves nothing behind
  fs.rmSync(path.join(repo, 'src/cli.py'));
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'gone');
  resetSymbols();
  assert.deepEqual(findDefinitions(repo, 'entry'), []);
});

test('one file is outlined exactly whatever the sweep last saw, and without reading the tree', t => {
  const repo = repoWith(t, { 'src/core.py': CORE }, { sweep: 'off' });
  buildTable(repo, { background: false });
  resetSymbols();
  fs.writeFileSync(path.join(repo, 'src/core.py'), CORE + '\ndef written_just_now(x):\n    return x\n');
  const defs = outline(repo, 'src/core.py');
  assert.ok(defs.map(d => d.name).includes('written_just_now'), 'the file is hashed on the spot');
  assert.equal(outlineFile(repo, 'src/nothing-here.py'), null);
  // what the per-file path wrote is what the name lookup then answers from
  resetSymbols();
  assert.deepEqual(findDefinitions(repo, 'written_just_now', { sweep: 'inline' }).map(h => h.path), ['src/core.py']);
});

test('refreshTable reports what it brought up to date; a table that is not there asks for a build', t => {
  const repo = repoWith(t, { 'src/core.py': CORE });
  assert.equal(refreshTable(repo, { background: false }).ok, false, 'no table yet');
  buildTable(repo, { background: false });
  resetSymbols();
  assert.deepEqual(refreshTable(repo, { background: false }), { ok: true, refreshed: 0, delta: 0, removed: 0 });
  fs.writeFileSync(path.join(repo, 'src/core.py'), CORE + '\ndef and_another():\n    return 1\n');
  assert.equal(refreshTable(repo, { background: false }).refreshed, 1);
});

test('more changed at once than the delta holds leaves the table as it is for the rebuild', t => {
  const repo = repoWith(t, { 'src/core.py': CORE, 'src/cli.py': CLI }, { maxDelta: 1 });
  buildTable(repo, { background: false });
  resetSymbols();
  fs.writeFileSync(path.join(repo, 'src/core.py'), CORE.replace('run_callback', 'renamed_one'));
  fs.writeFileSync(path.join(repo, 'src/cli.py'), CLI.replace('def entry', 'def renamed_two'));
  resetSymbols();
  assert.deepEqual(findDefinitions(repo, 'renamed_one'), [], 'nothing was outlined again inline');
  assert.equal(tableStats(repo).delta, 0);
  assert.equal(findDefinitions(repo, 'run_callback').length, 1, 'the table still answers from the last build');
});
