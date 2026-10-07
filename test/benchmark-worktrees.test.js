import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const helper = new URL('../bench/worktrees.js', import.meta.url).href;
const env = { ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off' };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-worktree-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const wt = path.join(root, 'worktrees', 'worker');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base', '--allow-empty');
  const prefix = `import fs from 'node:fs'; import { createWorktree, removeWorktree, spawn } from ${JSON.stringify(helper)};
    const repo = ${JSON.stringify(repo)}, wt = ${JSON.stringify(wt)};`;
  const run = code => execFileSync(process.execPath, ['--input-type=module', '-e', prefix + code], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const gone = () => {
    assert.equal(fs.existsSync(wt), false);
    assert.equal(git('worktree', 'list', '--porcelain').includes(wt), false);
  };
  return { root, repo, wt, git, prefix, run, gone };
}

test('successful workers remove dirty checkouts and their registration, with repeatable cleanup', t => {
  const f = fixture(t);
  f.run(`createWorktree(repo, wt); fs.writeFileSync(wt + '/scratch', 'result'); removeWorktree(wt); removeWorktree(wt);`);
  f.gone();
  f.run(`createWorktree(repo, wt); fs.writeFileSync(wt + '/scratch', 'result');`);
  f.gone(); // Also covers natural process exit and reuse by the next invocation.
});

test('uncaught errors and explicit failure exits remove every owned checkout', t => {
  const f = fixture(t);
  for (const end of [`throw Error('worker failed')`, 'process.exit(7)']) {
    assert.throws(() => f.run(`createWorktree(repo, wt); createWorktree(repo, wt + '-2'); ${end}`));
    f.gone();
    assert.equal(fs.existsSync(f.wt + '-2'), false);
    assert.equal(f.git('worktree', 'list', '--porcelain').includes(f.wt + '-2'), false);
  }
});

test('failed worktree creation releases its reservation', t => {
  const f = fixture(t);
  assert.throws(() => f.run(`createWorktree(repo, wt, 'missing-base');`));
  f.gone();
});

test('existing directories and registered worktrees are never adopted or deleted', t => {
  const f = fixture(t);
  fs.mkdirSync(f.wt, { recursive: true });
  fs.writeFileSync(path.join(f.wt, 'keep'), 'unsaved');
  assert.throws(() => f.run('createWorktree(repo, wt);'));
  assert.equal(fs.readFileSync(path.join(f.wt, 'keep'), 'utf8'), 'unsaved');
  fs.rmSync(f.wt, { recursive: true });
  f.git('worktree', 'add', '--detach', f.wt, 'HEAD');
  fs.writeFileSync(path.join(f.wt, 'keep'), 'another run');
  assert.throws(() => f.run('createWorktree(repo, wt);'));
  f.run('removeWorktree(wt);'); // Removing a path we do not own is a no-op.
  assert.equal(fs.readFileSync(path.join(f.wt, 'keep'), 'utf8'), 'another run');
  fs.rmSync(f.wt, { recursive: true });
  assert.throws(() => f.run('createWorktree(repo, wt);')); // Missing but still registered.
  assert.equal(f.git('worktree', 'list', '--porcelain').includes(f.wt), true);
});

for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`${signal} stops agent descendants and removes the checkout`, { skip: process.platform === 'win32', timeout: 20000 }, async t => {
    const f = fixture(t);
    const writer = `const fs = require('node:fs');
      setInterval(() => { fs.mkdirSync(${JSON.stringify(f.wt)}, {recursive:true}); fs.writeFileSync(${JSON.stringify(f.wt + '/alive')}, 'alive'); }, 20);`;
    const agent = `const {spawn} = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(writer)}], {stdio:'ignore'});
      setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', f.prefix + `
      createWorktree(repo, wt);
      spawn(process.execPath, ['-e', ${JSON.stringify(agent)}], {cwd:wt});
      console.log('ready');
      setInterval(() => {}, 1000);
    `], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    const closed = once(child, 'close');
    await once(child.stdout, 'data');
    for (let i = 0; i < 100 && !fs.existsSync(f.wt + '/alive'); i++) await delay(20);
    assert.equal(fs.existsSync(f.wt + '/alive'), true);
    child.kill(signal);
    assert.equal((await closed)[0], status);
    await delay(150); // An orphaned writer would recreate the deleted directory.
    f.gone();
  });
}

// Exercise the real entry points without benchmark tasks, caches, agents or model calls.
// Copies retain their imports; src is a symlink so no implementation is re-created here.
for (const runner of ['run', 'codex-run', 'gemini-run', 'jev-opus-run', 'criteria']) {
  test(`${runner} releases its worker pool with an empty task queue`, t => {
    const f = fixture(t);
    const bench = path.join(f.root, 'bench');
    fs.mkdirSync(path.join(bench, 'repos'), { recursive: true });
    fs.symlinkSync(f.repo, path.join(bench, 'repos', 'fixture'), 'dir');
    fs.symlinkSync(new URL('../src', import.meta.url).pathname, path.join(f.root, 'src'), 'dir');
    fs.writeFileSync(path.join(f.root, 'package.json'), '{"type":"module"}');
    for (const file of [runner + '.js', 'worktrees.js', 'judge-protocol.js']) {
      fs.copyFileSync(new URL('../bench/' + file, import.meta.url), path.join(bench, file));
    }
    fs.mkdirSync(path.join(bench, 'codex-home'));
    fs.mkdirSync(path.join(bench, 'runs', 'empty'), { recursive: true });
    const tasks = path.join(f.root, 'tasks.json');
    fs.writeFileSync(tasks, JSON.stringify({ repo: 'fixture', tasks: [] }));
    const args = runner === 'criteria' ? ['grade', tasks, 'empty']
      : ['--repo', 'fixture', '--tasks', tasks, '--tag', 'empty', '--conc', '2', '--arm', 'nocache'];
    execFileSync(process.execPath, [path.join(bench, runner + '.js'), ...args], {
      env, cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000,
    });
    assert.deepEqual(fs.readdirSync(path.join(bench, 'worktrees')), []);
    assert.equal((f.git('worktree', 'list', '--porcelain').match(/^worktree /gm) || []).length, 1);
  });
}
