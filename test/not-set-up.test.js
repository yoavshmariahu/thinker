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

// Every git repository has a cache: the first command that reads one starts it, empty, and keeps it
// out of the repository's git status.
test('a git repository without .thinker gets a cache on first use, excluded from git status', t => {
  const dir = fresh(t);
  const r = spawnSync(process.execPath, [CLI, 'orient', 'how do I run tests', '--repo', dir], { env: { ...env, THINKER_HOME: path.join(dir, 'home') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no matching notes/);
  assert.ok(fs.existsSync(path.join(dir, '.thinker', 'config.json')));
  assert.match(fs.readFileSync(path.join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\.thinker\/config\.json$/m);
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' });
  assert.ok(!status.includes('.thinker'), status);
  for (const cmd of [['list'], ['check'], ['maintain', '--dry']]) {
    const r2 = spawnSync(process.execPath, [CLI, ...cmd, '--repo', dir], { env: { ...env, THINKER_HOME: path.join(dir, 'home') }, encoding: 'utf8' });
    assert.equal(r2.status, 0, cmd.join(' ') + ': ' + r2.stderr);
  }
});

test('outside a git repository there is no cache, and nothing is created', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-no-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [CLI, 'list', '--repo', dir], { env: { ...env, THINKER_HOME: path.join(dir, 'home') }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git repository/);
  assert.ok(!fs.existsSync(path.join(dir, '.thinker')));
});

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

test('the MCP server offers its tools in a git repository without .thinker and starts the cache there', t => {
  const dir = fresh(t);
  const s = mcpSession(dir, { THINKER_REPO: dir });
  assert.ok(s.init.result.instructions.includes('cache of notes about this repository'), s.init.result.instructions.slice(0, 120));
  assert.ok(s.tools.some(x => x.name === 'orient'));
  assert.ok(fs.existsSync(path.join(dir, '.thinker')));
});

// The user's machine-wide MCP entry pins no repository: the server takes it from the directory the
// client starts it in, and offers nothing outside a git repository.
test('the MCP server takes the repository from its working directory: tools in a checkout, none elsewhere', t => {
  const dir = fresh(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  const set = mcpSession(path.join(dir, 'sub'), { THINKER_REPO: '' });
  assert.ok(set.init.result.instructions.includes(`cache of notes about this repository (${fs.realpathSync(dir)})`), set.init.result.instructions.slice(0, 120));
  assert.ok(set.tools.some(x => x.name === 'orient'));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-no-repo-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const none = mcpSession(bare, { THINKER_REPO: '' });
  assert.match(none.init.result.instructions, /outside a git repository/);
  assert.deepEqual(none.tools, []);
  assert.ok(!fs.existsSync(path.join(bare, '.thinker')));
});

// install.sh: the tool is installed, the agents are wired up (`thinker connect`, asking nothing), and the
// warm-up page is where the caches are chosen; from a pipe with no terminal the page is not opened and the
// user is told how. A fake tarball and manifest stand in for the release, served from a file URL rewritten
// to https by a curl stub.
test('the installer installs the tool, connects the agents without asking and points at the warm-up page', t => {
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
  assert.match(r.stdout, /stub connect --clients auto --yes/, 'the agents are wired up, with nothing asked');
  assert.ok(!/stub setup/.test(r.stdout), 'no per-repository setup');
  assert.match(r.stdout, /every git repository on this machine/);
  assert.match(r.stdout, /thinker ui/);
  assert.ok(fs.existsSync(path.join(home, 'bin', 'thinker')));
  assert.ok(!fs.existsSync(path.join(work, '.thinker')));
  assert.deepEqual(fs.readdirSync(work), []);
});
