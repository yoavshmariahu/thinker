// A repository switched off machine-wide (repo-switch.js): the hooks and the MCP server do nothing
// there, and the CLI refuses to touch it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { setRepoDisabled, isDisabledRepo, disabledRepo, disabledRepos, readMachineConfig } from '../src/repo-switch.js';
import { discoverRepos } from '../src/machine.js';
import { createUiServer, machineRepos } from '../src/ui/server.js';

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function repo(t, name = 'thinker-switch-') {
  const dir = tmp(name);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', `https://github.com/acme/${path.basename(dir)}.git`);
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.js'), 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(dir, 'src/a.js'), `export const a = ${i + 2};\n`); git('commit', '-qam', `fix: bump ${i}`); }
  return { dir, git };
}
const call = (port, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
    let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, body: s }));
  });
  req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
});

test('the switch names a repository by its origin, so a clone or worktree is off with it', t => {
  const { dir, git } = repo(t);
  const home = tmp('thinker-switch-home-');
  assert.equal(isDisabledRepo(dir, { home }), false);
  assert.deepEqual(disabledRepos({ home }), []);
  setRepoDisabled(dir, { disabled: true, name: 'acme/x', home });
  assert.equal(isDisabledRepo(dir, { home }), true);
  assert.equal(disabledRepo(dir, { home }).name, 'acme/x');
  assert.equal(readMachineConfig(home).version, 1, 'the machine config keeps its shape');
  // a worktree of it shares the origin
  const wt = path.join(tmp('thinker-switch-wt-'), 'wt'); git('worktree', 'add', '-q', wt, '-b', 'side');
  t.after(() => fs.rmSync(path.dirname(wt), { recursive: true, force: true }));
  assert.equal(isDisabledRepo(wt, { home }), true, 'a worktree is off with its repository');
  // a repository without an origin is named by its path
  const other = repo(t, 'thinker-switch-b-'); other.git('remote', 'remove', 'origin');
  assert.equal(isDisabledRepo(other.dir, { home }), false);
  setRepoDisabled(other.dir, { disabled: true, home });
  assert.equal(disabledRepos({ home }).length, 2);
  assert.equal(isDisabledRepo(other.dir, { home }), true);
  // back on: only that one
  setRepoDisabled(dir, { disabled: false, home });
  assert.equal(isDisabledRepo(dir, { home }), false); assert.equal(isDisabledRepo(wt, { home }), false);
  assert.equal(isDisabledRepo(other.dir, { home }), true);
  // not a git checkout: never off, and cannot be switched
  const plain = tmp('thinker-switch-plain-'); t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(isDisabledRepo(plain, { home }), false);
  assert.throws(() => setRepoDisabled(plain, { home }), /not a git repository/);
  // the discovery carries the flag
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  const saved = process.env.THINKER_HOME; process.env.THINKER_HOME = home; t.after(() => { if (saved === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = saved; });
  const found = discoverRepos(new Store(other.dir), { home: tmp('thinker-switch-th-') });
  assert.equal(found.find(r => r.checkout === other.dir)?.disabled, true);
});

test('in a repository that is off the CLI refuses, the hooks print nothing and write nothing, and enable turns it back on', t => {
  const { dir } = repo(t);
  const home = tmp('thinker-switch-home2-');
  const env = { ...process.env, THINKER_HOME: home, THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_NO_LEARN: '1', THINKER_NO_AUTO_UPDATE: '1', THINKER_AST: 'off', THINKER_HOOKS: 'on' };
  const run = (...args) => spawnSync('node', [CLI, ...args, '--repo', dir], { env, encoding: 'utf8', input: JSON.stringify({ prompt: 'how does a work?', session_id: 's1', cwd: dir }) });
  const off = run('disable');
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /thinker is off for/);
  assert.equal(isDisabledRepo(dir, { home }), true);
  // a cache command is refused and starts no cache
  const list = run('list');
  assert.equal(list.status, 1);
  assert.match(list.stderr, /switched off for this repository/);
  assert.equal(fs.existsSync(path.join(dir, '.thinker')), false, 'nothing written into the repository');
  // the hooks answer with nothing, at repository scope and at user scope
  for (const args of [['hook', 'prompt'], ['hook', 'prompt', '--user'], ['hook', 'stop']]) {
    const h = run(...args);
    assert.equal(h.status, 0, h.stderr); assert.equal(h.stdout.trim(), '', args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(dir, '.thinker')), false, 'the hooks start no cache either');
  // the machine-wide commands still answer
  assert.equal(run('help').status, 0);
  const on = run('enable');
  assert.equal(on.status, 0, on.stderr); assert.match(on.stdout, /on again/);
  assert.equal(isDisabledRepo(dir, { home }), false);
  const again = run('list');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.existsSync(path.join(dir, '.thinker')), true, 'on again, a cache is started');
});

test('the MCP server offers no tools in a repository that is off', async t => {
  const { dir } = repo(t);
  const home = tmp('thinker-switch-home3-');
  setRepoDisabled(dir, { disabled: true, home });
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const env = { ...process.env, THINKER_HOME: home, THINKER_REPO: dir, THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_AST: 'off' };
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(path.dirname(CLI), 'mcp.js')], env, cwd: dir, stderr: 'pipe' });
  const client = new Client({ name: 't', version: '0' });
  await client.connect(transport);
  t.after(() => client.close());
  // no tool is registered, so the server does not even answer tools/list (as with THINKER_MCP=off)
  await assert.rejects(client.listTools(), /Method not found/);
  assert.match(client.getInstructions() || '', /switched off/);
  assert.equal(fs.existsSync(path.join(dir, '.thinker')), false, 'the server starts no cache');
});
