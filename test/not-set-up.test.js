import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src/cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-not-set-up-home-'));
const env = { ...process.env, THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_NO_LEARN: '1', HOME, CODEX_HOME: path.join(HOME, '.codex'), CLAUDE_CONFIG_DIR: '' };
delete env.CLAUDE_CONFIG_DIR;
const fresh = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-not-set-up-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
  return dir;
};

test('a repository without .thinker is served nothing by the CLI and nothing is created', t => {
  const dir = fresh(t);
  for (const cmd of [['orient', 'how do I run tests'], ['lookup', 'tests'], ['list'], ['check'], ['maintain', '--dry']]) {
    const r = spawnSync(process.execPath, [CLI, ...cmd, '--repo', dir], { env: { ...env, THINKER_HOME: path.join(dir, 'home') }, encoding: 'utf8' });
    assert.equal(r.status, 1, cmd.join(' '));
    assert.match(r.stderr, /not set up in this repository .*thinker setup/);
  }
  assert.ok(!fs.existsSync(path.join(dir, '.thinker')));
});

test('after setup the same commands answer', t => {
  const dir = fresh(t);
  const home = path.join(dir, 'home');
  execFileSync(process.execPath, [CLI, 'setup', '--no-build', '--repo', dir, '--clients', 'claude', '--no-mcp', '--no-git-hook'], { env: { ...env, THINKER_HOME: home }, encoding: 'utf8' });
  const r = spawnSync(process.execPath, [CLI, 'orient', 'how do I run tests', '--repo', dir], { env: { ...env, THINKER_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no matching notes/);
});

test('the MCP server offers no tools in a repository without .thinker and creates nothing', async t => {
  const dir = fresh(t);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/mcp.js')], {
    env: { ...env, THINKER_REPO: dir, THINKER_HOME: path.join(dir, 'home') }, encoding: 'utf8', timeout: 20_000,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
  });
  const lines = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const init = lines.find(l => l.id === 1), tools = lines.find(l => l.id === 2);
  assert.match(init.result.instructions, /not set up for this repository[\s\S]*thinker setup/);
  // no tools registered: like THINKER_MCP=off, the server has no tools capability, so tools/list is "Method not found"
  assert.deepEqual(tools.result?.tools ?? [], []);
  assert.ok(!init.result.capabilities.tools);
  assert.ok(!fs.existsSync(path.join(dir, '.thinker')));
});

// install.sh outside a git repository: the tool is installed, the agents are wired up (`thinker connect`) and the user is told to run `thinker setup`.
// A fake tarball and manifest stand in for the release, served from a file URL rewritten to https by a curl stub.
test('the installer installs the tool outside a repository, connects the agents and points at thinker setup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-install-norepo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), work = path.join(dir, 'work'), dist = path.join(dir, 'dist');
  fs.mkdirSync(bin); fs.mkdirSync(work); fs.mkdirSync(path.join(dist, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'app', 'src', 'cli.js'), 'console.log("stub " + process.argv.slice(2).join(" "))\n');
  fs.writeFileSync(path.join(dist, 'app', 'package.json'), JSON.stringify({ version: '9.9.9' }));
  execFileSync('tar', ['-czf', path.join(dist, 'thinker.tgz'), '-C', path.join(dist, 'app'), '.']);
  const sha = execFileSync('shasum', ['-a', '256', path.join(dist, 'thinker.tgz')], { encoding: 'utf8' }).split(' ')[0];
  fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify({ schemaVersion: 1, version: '9.9.9', commit: 'a'.repeat(40), sha256: sha }));
  // curl -o <out> <url>: copy the named file of the fake release
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\nout=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; https://*) url="$1"; shift;; *) shift;; esac; done\ncp "${dist}/$(basename "$url")" "$out"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', [path.join(ROOT, 'install.sh'), '--no-auto-update', '--no-modify-path'], {
    cwd: work, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, THINKER_HOME: home, THINKER_DIST_URL: 'https://example.invalid/dist/thinker.tgz', SHELL: '/bin/zsh' },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /stub connect --clients auto/, 'the agents are wired up');
  assert.match(r.stdout, /not a git repository, so no cache was set up here/);
  assert.match(r.stdout, /thinker setup/);
  assert.ok(fs.existsSync(path.join(home, 'bin', 'thinker')));
  assert.ok(!fs.existsSync(path.join(work, '.thinker')));
  assert.deepEqual(fs.readdirSync(work), []);
});

// The user's machine-wide MCP entry pins no repository: the server takes it from the directory the
// client starts it in, serves a repository that is set up, and offers nothing anywhere else.
const mcpSession = (cwd, extra = {}) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/mcp.js')], {
    cwd, env: { ...env, THINKER_HOME: path.join(cwd, 'home'), THINKER_NO_BG_VERIFY: '1', ...extra }, encoding: 'utf8', timeout: 20_000,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n',
  });
  const lines = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { init: lines.find(l => l.id === 1), tools: lines.find(l => l.id === 2)?.result?.tools ?? [] };
};
// No instruction asks the agent to save or grade notes, and with learning off the tools are not
// there either: on the Click rerun of 2026-10-08 every Opus arm told learning was disabled still
// ended by saving a note, because the server's own instructions asked it to.
test('the MCP server never asks for notes; remember and feedback are registered only on request, never with learning off', t => {
  const dir = fresh(t);
  execFileSync(process.execPath, [CLI, 'setup', '--no-build', '--repo', dir, '--clients', 'claude', '--no-mcp', '--no-git-hook'], { env: { ...env, THINKER_HOME: path.join(dir, 'home') }, encoding: 'utf8' });
  const retrieval = ['drilldown', 'find', 'lookup', 'orient'];
  const plain = mcpSession(dir, { THINKER_REPO: '', THINKER_NO_LEARN: '' });
  assert.deepEqual(plain.tools.map(x => x.name).sort(), retrieval, 'by default the retrieval tools alone: a schema is paid on every request');
  assert.doesNotMatch(plain.init.result.instructions, /remember|feedback/);
  const cfg = path.join(dir, '.thinker/config.json');
  fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), mcp: { learningTools: true } }));
  const asked = mcpSession(dir, { THINKER_REPO: '', THINKER_NO_LEARN: '' });
  assert.deepEqual(asked.tools.map(x => x.name).sort(), [...retrieval, 'feedback', 'remember'].sort());
  assert.doesNotMatch(asked.init.result.instructions, /remember|feedback/, 'registered, still not asked for');
  const off = mcpSession(dir, { THINKER_REPO: '', THINKER_NO_LEARN: '1' });
  assert.deepEqual(off.tools.map(x => x.name).sort(), retrieval);
});

test('the MCP server takes the repository from its working directory: tools where it is set up, none elsewhere', t => {
  const dir = fresh(t);
  execFileSync(process.execPath, [CLI, 'setup', '--no-build', '--repo', dir, '--clients', 'claude', '--no-mcp', '--no-git-hook'], { env: { ...env, THINKER_HOME: path.join(dir, 'home') }, encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'sub'));
  const set = mcpSession(path.join(dir, 'sub'), { THINKER_REPO: '' });
  assert.ok(set.init.result.instructions.includes(`cache of notes about this repository (${fs.realpathSync(dir)})`), set.init.result.instructions.slice(0, 120));
  assert.ok(set.tools.some(x => x.name === 'orient'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-no-repo-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const none = mcpSession(bare, { THINKER_REPO: '' });
  assert.match(none.init.result.instructions, /outside a git repository[\s\S]*thinker setup/);
  assert.deepEqual(none.tools, []);
  assert.ok(!fs.existsSync(path.join(bare, '.thinker')));
});
