import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src/cli.js');
const env = { ...process.env, THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_NO_LEARN: '1' };
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

// install.sh outside a git repository: the tool is installed and the user is told to run `thinker setup`.
// A fake tarball and manifest stand in for the release, served from a file URL rewritten to https by a curl stub.
test('the installer installs the tool outside a repository and points at thinker setup', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-install-norepo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home'), bin = path.join(dir, 'bin'), work = path.join(dir, 'work'), dist = path.join(dir, 'dist');
  fs.mkdirSync(bin); fs.mkdirSync(work); fs.mkdirSync(path.join(dist, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'app', 'src', 'cli.js'), 'console.log("stub")\n');
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
  assert.match(r.stdout, /not a git repository, so nothing was set up here/);
  assert.match(r.stdout, /thinker setup/);
  assert.ok(fs.existsSync(path.join(home, 'bin', 'thinker')));
  assert.ok(!fs.existsSync(path.join(work, '.thinker')));
  assert.deepEqual(fs.readdirSync(work), []);
});
