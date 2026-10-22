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
const env = { ...process.env, THINKER_TEST: '1', THINKER_OFFERS: 'on', THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_NO_LEARN: '1', HOME, CODEX_HOME: path.join(HOME, '.codex'), CLAUDE_CONFIG_DIR: '', CURSOR_AGENT: '', CLAUDE_CODE_ENTRYPOINT: '' };
delete env.CLAUDE_CONFIG_DIR;
// App identity comes from each fixture's explicit environment, never the test runner's ancestors.
const bin = path.join(HOME, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
env.PATH = bin + path.delimiter + env.PATH;
delete env.CLAUDE_CODE_ENTRYPOINT; delete env.CURSOR_AGENT;
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

// `calls`: tool calls after the listing, answered as `replies` (the text of each), in order
const mcpSession = (cwd, extra = {}, calls = []) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src/mcp.js')], {
    cwd, env: { ...env, THINKER_HOME: path.join(cwd, 'home'), THINKER_NO_BG_VERIFY: '1', CLAUDE_PROJECT_DIR: '', ...extra }, encoding: 'utf8', timeout: 20_000,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      + JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n'
      + calls.map((c, i) => JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: c }) + '\n').join(''),
  });
  const lines = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const replies = calls.map((_, i) => lines.find(l => l.id === 10 + i)?.result?.content?.map(c => c.text).join('\n') ?? null);
  return { init: lines.find(l => l.id === 1), tools: lines.find(l => l.id === 2)?.result?.tools ?? [], replies };
};

// The server keeps no agent tools since 2026-10-22: it starts the cache where it runs and answers thinker's own
// questions and the desktop app's learning queue.
test('the MCP server in a git repository without .thinker starts the cache there and offers the agent no tools', t => {
  const dir = fresh(t);
  const s = mcpSession(dir, { THINKER_REPO: dir });
  assert.equal(s.init.result.instructions, undefined);
  assert.deepEqual(s.tools.map(x => x.name), []);
  assert.ok(fs.existsSync(path.join(dir, '.thinker')));
  // started outside a repository: nothing is created there
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-no-repo-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const none = mcpSession(bare, { THINKER_REPO: '', CLAUDE_CODE_ENTRYPOINT: '' });
  assert.deepEqual(none.tools.map(x => x.name), []);
  assert.ok(!fs.existsSync(path.join(bare, '.thinker')));
});

// A desktop app may run one server for every window: Cursor's started in the home directory and bound to the
// first repository a call named (2026-10-16). Its queue tool is listed from the start, and each call reads
// the queue of the repository its cwd names.
test('in a desktop app the queue tool follows the cwd of each call', t => {
  const a = fresh(t), b = fresh(t);
  const q = path.join(b, '.thinker', 'state', 'session-llm'); fs.mkdirSync(q, { recursive: true });
  fs.writeFileSync(path.join(q, 'r1-abc.req.json'), JSON.stringify({ id: 'r1-abc', system: '', prompt: 'summarize PR 7', schema: null, t: new Date().toISOString() }));
  // a build that has ended, so the call after the answer reads the queue as done instead of waiting for one
  fs.writeFileSync(path.join(q, 'build.json'), JSON.stringify({ pid: 2 ** 22 + 12345, started: new Date().toISOString() }));
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-no-repo-'));
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const s = mcpSession(bare, { THINKER_REPO: '', THINKER_NO_LEARN: '0', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, [
    { name: 'learn_next', arguments: { cwd: b } },
    { name: 'learn_next', arguments: { cwd: b, id: 'r1-abc' } },
    { name: 'learn_next', arguments: { cwd: b, id: 'r1-abc', answer: 'PR 7 fixes the widget' } },
  ]);
  assert.deepEqual(s.tools.map(x => x.name), ['learn_next'], 'listed before any repository is bound, and nothing else');
  assert.match(s.replies[0], /summarize PR 7/, 'the request of the repository cwd names');
  assert.match(s.replies[0], /calling learn_next with id "r1-abc"/);
  assert.match(s.replies[1], /Pass both id and answer/, 'an id without an answer takes nothing and saves nothing');
  assert.match(s.replies[2], /^Saved\. The work is done/, 'the answer is saved and the same call returns what comes next');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(q, 'r1-abc.res.json'), 'utf8')).text, 'PR 7 fixes the widget');
  assert.ok(!fs.existsSync(path.join(q, 'r1-abc.claimed.json')));
  assert.ok(!fs.existsSync(path.join(a, '.thinker', 'state', 'session-llm', 'r1-abc.res.json')));
  // outside an app, unbound, it is not listed
  assert.ok(!mcpSession(bare, { THINKER_REPO: '', CLAUDE_CODE_ENTRYPOINT: '' }).tools.some(x => x.name === 'learn_next'));
});

// install.sh: the tool is installed and the agents are wired up (`thinker connect`, asking nothing); nothing is
// built, and the user is told where the page is. A fake tarball and manifest stand in for the release, served from a file URL rewritten
// to https by a curl stub.
test('the installer installs the tool, connects the agents without asking and builds nothing', t => {
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
  assert.doesNotMatch(r.stdout, /warmup|warm up/i); assert.match(r.stdout, /thinker ui/);
  assert.ok(!/stub ui/.test(r.stdout), 'the page is not launched blind');
  assert.ok(fs.existsSync(path.join(home, 'bin', 'thinker')));
  assert.ok(!fs.existsSync(path.join(work, '.thinker')));
  assert.deepEqual(fs.readdirSync(work), []);
});
