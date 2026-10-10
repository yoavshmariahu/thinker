import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';

// A person adds, reads, changes and removes system behaviors by asking their coding agent: through the
// `behavior` tool where the agent has thinker's MCP server, through `thinker system add|edit|rm` where
// it has only the command line. What they ask for is theirs and in force at once.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function machine(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-agent-behaviors-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, 'src/guard.js'), `export function guard(input) {\n  if (!input) throw new Error('input required');\n  return input.trim();\n}\n`);
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test'); git('add', '-A'); git('commit', '-qm', 'init');
  const env = { ...process.env, HOME: home, THINKER_HOME: path.join(home, '.thinker'), THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_NO_LEARN: '1', THINKER_REPO: repo };
  return { repo, env, store: new Store(repo).init() };
}

test('an agent with the MCP tools adds, lists, changes and removes a behavior the person asked for', async t => {
  const { repo, env, store } = machine(t);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'src/mcp.js')], env, cwd: repo, stderr: 'ignore' }));
  t.after(() => client.close());
  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

  const tool = (await client.listTools()).tools.find(x => x.name === 'behavior');
  assert.match(tool.description, /only when the person asks you/i);
  assert.match(tool.description, /Never call it on your own initiative/);

  assert.match(await call('behavior', { action: 'add', title: 'guard rejects empty input' }), /add needs title, body and deps/);
  const saved = await call('behavior', { action: 'add', title: 'guard rejects empty input', body: 'src/guard.js:guard throws when the input is empty.', deps: [{ path: 'src/guard.js', symbol: 'guard' }] });
  const id = saved.match(/Saved behavior (\S+) \(mutable\), in force now/)?.[1];
  assert.ok(id, saved);
  assert.equal(store.get(id).source.type, 'human', 'what the person asked for is theirs, not a proposal');
  assert.match(await call('lookup', { query: '', kind: 'behavior' }), new RegExp(`\\[mutable\\] guard rejects empty input  \\(id: ${id}\\)`));

  assert.match(await call('behavior', { action: 'edit', id }), /edit needs a new title, body or mutability/);
  assert.match(await call('behavior', { action: 'edit', id, title: 'guard never accepts empty input', mutability: 'fixed' }), /\(fixed\): guard never accepts empty input/);
  assert.equal(store.get(id).history.at(-1).title, 'guard rejects empty input');

  assert.match(await call('behavior', { action: 'remove', id: 'nope' }), /no such behavior/);
  assert.match(await call('behavior', { action: 'remove', id }), /Removed behavior/);
  assert.equal(store.get(id), null);
  assert.match(await call('lookup', { query: '', kind: 'behavior' }), /when the person asks for one, the behavior tool adds it/);
});

test('an agent with only the command line does the same with thinker system add, edit and rm', t => {
  const { repo, env, store } = machine(t);
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'src/cli.js'), ...args, '--repo', repo], { env, cwd: repo, encoding: 'utf8', timeout: 60_000 });
  const file = path.join(repo, '..', 'b.json');
  fs.writeFileSync(file, JSON.stringify({ title: 'guard rejects empty input', body: 'src/guard.js:guard throws when the input is empty.', answers: ['what does guard do with empty input'], deps: [{ path: 'src/guard.js', symbol: 'guard' }] }));
  const id = run('system', 'add', file).stdout.match(/saved (\S+) \(mutable\)/)?.[1];
  assert.ok(id);
  // the listing names the commands: the guidance an agent reads has no line to spare for them
  assert.match(run('system').stdout, /guard rejects empty input[^]*Change them: thinker system add <file\.json> \| edit <id>[^\n]*\| rm <id>/);

  assert.match(run('system', 'edit', id, '--title', 'guard never accepts empty input').stdout, /saved \S+ \(mutable\)  guard never accepts empty input/);
  assert.match(run('system', 'edit', id, '--fixed').stdout, /\(fixed\)/);
  fs.writeFileSync(file, JSON.stringify({ body: 'src/guard.js:guard throws on empty or missing input.' }));
  assert.equal(run('system', 'edit', id, file).status, 0);
  const n = store.get(id);
  assert.deepEqual([n.title, n.body, n.mutability], ['guard never accepts empty input', 'src/guard.js:guard throws on empty or missing input.', 'fixed']);
  assert.equal(run('system', 'edit', 'nope', '--title', 'x').status, 1);

  assert.match(run('system', 'rm', id).stdout, /: removed/);
  assert.equal(store.get(id), null);
  assert.equal(run('system', 'rm', id).status, 1);
});
