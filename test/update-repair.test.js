import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { rewireAfterUpdate } from '../src/commands/setup.js';
import { checkPendingNotice } from '../src/update.js';
import { repairFile } from '../src/environment-repair.js';

const CLI = path.resolve(import.meta.dirname, '../src/cli.js');
const MCP = path.resolve(import.meta.dirname, '../src/mcp.js');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-upgrade-repair-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const thinker = path.join(home, '.thinker');
  const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), THINKER_HOME: thinker,
    XDG_CONFIG_HOME: path.join(home, '.config'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'), COPILOT_HOME: path.join(home, '.copilot'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), THINKER_TEST: '1', THINKER_LOG: 'off', THINKER_TELEMETRY: 'off',
    PATH: '/usr/bin:/bin', CURSOR_AGENT: '', CLAUDE_CODE_ENTRYPOINT: '' };
  const config = path.join(env.CODEX_HOME, 'config.toml');
  fs.mkdirSync(env.CODEX_HOME);
  // Existing generated hooks (the pre hook since the test wrapper, 2026-10-18), but missing reviewed hashes and disabled subagents.
  const hooks = { hooks: Object.fromEntries([['UserPromptSubmit', 'prompt', 15], ['PreToolUse', 'pre', 10], ['Stop', 'stop', 10]].map(([event, what, timeout]) =>
    [event, [{ hooks: [{ type: 'command', command: `node "${CLI}" hook ${what} --client codex --user${what === 'stop' ? ' --no-distill' : ''}`, timeout }] }]])) };
  fs.writeFileSync(path.join(env.CODEX_HOME, 'hooks.json'), JSON.stringify(hooks, null, 2) + '\n');
  fs.writeFileSync(config, 'model = "my-model"\n[features]\nmulti_agent = false\ncustom_feature = true\n');
  // Mark offered clients, so repair does not reconnect something intentionally removed.
  fs.mkdirSync(path.join(thinker, 'state'), { recursive: true });
  fs.writeFileSync(path.join(thinker, 'state/connected.json'), JSON.stringify({ codex: 'old', cursor: 'old', claude: 'old' }));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
  return { home, thinker, env, config, run };
}

test('the legacy updater entrypoint repairs Codex wiring without approving hooks, survives dry-run, and is idempotent', t => {
  const f = fixture(t), before = fs.readFileSync(f.config, 'utf8');
  const hooksFile = path.join(f.env.CODEX_HOME, 'hooks.json'), hooks = fs.readFileSync(hooksFile, 'utf8');
  let r = f.run('rewire', '--json', '--quiet', '--dry');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).files.some(p => p.endsWith('hooks.json')));
  assert.equal(fs.readFileSync(f.config, 'utf8'), before);
  assert.equal(fs.existsSync(repairFile(f.thinker)), false);
  r = f.run('rewire', '--json', '--quiet'); // exactly what an older update process runs
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  const repaired = fs.readFileSync(f.config, 'utf8');
  assert.doesNotMatch(repaired, /multi_agent = true/);
  assert.doesNotMatch(repaired, /trusted_hash = "sha256:/);
  assert.match(repaired, /custom_feature = true/);
  assert.match(repaired, /model = "my-model"/);
  const expectedHooks = JSON.parse(hooks); delete expectedHooks.hooks.PreToolUse;
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksFile, 'utf8')), expectedHooks, 'the retired test hook is removed');
  const stamp = fs.statSync(f.config).mtimeMs;
  r = f.run('rewire', '--json', '--quiet');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).changed, 0);
  assert.equal(fs.statSync(f.config).mtimeMs, stamp, 'no redundant host config rewrite');
  assert.match(checkPendingNotice(f.thinker), /restart open desktop apps/);
  assert.equal(checkPendingNotice(f.thinker), null);
});

test('repair retains corrupt config, repairs other clients, reports quiet failure, and clears it after recovery', t => {
  const f = fixture(t), bad = path.join(f.home, '.cursor/mcp.json');
  fs.mkdirSync(path.dirname(bad)); fs.writeFileSync(bad, '{broken');
  let r = f.run('rewire', '--json', '--quiet');
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);
  assert.match(r.stderr, /environment repair incomplete/);
  assert.equal(fs.readFileSync(bad, 'utf8'), '{broken');
  assert.match(fs.readFileSync(f.config, 'utf8'), /multi_agent = false/);
  assert.match(checkPendingNotice(f.thinker), /cursor/);
  assert.match(checkPendingNotice(f.thinker), /cursor/, 'failed repair stays visible until fixed');
  fs.writeFileSync(bad, '{}');
  r = f.run('rewire', '--json', '--quiet');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(fs.readFileSync(repairFile(f.thinker))).errors.length, 0);
  assert.doesNotMatch(checkPendingNotice(f.thinker) || '', /incomplete/);
});

test('repair moves a missing installation to the updated copy, but keeps a live other copy and opt-outs intact', t => {
  const f = fixture(t), config = path.join(f.home, '.cursor/mcp.json');
  fs.mkdirSync(path.dirname(config));
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { thinker: { command: 'node', args: [path.join(f.home, 'gone-thinker/src/mcp.js')] }, other: { command: 'untouched' } } }));
  let r = f.run('rewire', '--json', '--quiet');
  assert.equal(r.status, 0, r.stderr);
  const entries = JSON.parse(fs.readFileSync(config)).mcpServers;
  assert.deepEqual(entries.thinker.args, [MCP]);
  assert.equal(entries.thinker.env.THINKER_MCP_LAUNCHER, '1');
  assert.equal(entries.other.command, 'untouched');
  assert.equal(fs.existsSync(path.join(f.home, '.claude/settings.json')), false, 'an opted-out client is not reconnected');
  const other = path.join(f.home, 'live-thinker/src/mcp.js');
  fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, '');
  entries.thinker.args = [other]; fs.writeFileSync(config, JSON.stringify({ mcpServers: entries }));
  r = f.run('rewire', '--json', '--quiet');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another copy/);
  assert.deepEqual(JSON.parse(fs.readFileSync(config)).mcpServers.thinker.args, [other]);
});

test('the update wrapper rejects missing reports, child failure, timeout and spawn failure, retaining actionable status', t => {
  const f = fixture(t);
  for (const result of [{ status: 1, stderr: 'permission denied' }, { status: 0, stdout: 'not json' },
    { status: null, signal: 'SIGTERM' }, { error: new Error('ETIMEDOUT') },
    { status: 0, stdout: JSON.stringify({ files: [], errors: [{ scope: 'codex', message: 'read-only config' }] }) }]) {
    assert.throws(() => rewireAfterUpdate(CLI, { quiet: true, home: f.thinker, spawnFn: () => result }), /environment repair failed/);
    assert.match(checkPendingNotice(f.thinker), /environment repair incomplete/);
  }
  rewireAfterUpdate(CLI, { quiet: true, home: f.thinker, spawnFn: () => ({ status: 0, stdout: JSON.stringify({ files: [], changed: 0 }) }) });
  assert.equal(checkPendingNotice(f.thinker), null);
});

function installedFixture(t) {
  const f = fixture(t), app = path.join(f.thinker, 'app');
  fs.mkdirSync(app);
  fs.cpSync(path.resolve(import.meta.dirname, '../src'), path.join(app, 'src'), { recursive: true });
  fs.symlinkSync(path.resolve(import.meta.dirname, '../node_modules'), path.join(app, 'node_modules'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'thinker', type: 'module', version: '0.0.1' }));
  const cli = path.join(app, 'src/cli.js');
  // The fixture stubs only model downloading; actual update, repair and client adapters run unchanged.
  const source = fs.readFileSync(cli, 'utf8');
  fs.writeFileSync(cli, source.replace(/^#!.*\n/, '') .replace("import { isTestMode }", "if (process.argv[2] === 'ranker') process.exit(0);\nimport { isTestMode }"));
  const hooks = path.join(f.env.CODEX_HOME, 'hooks.json');
  fs.writeFileSync(hooks, fs.readFileSync(hooks, 'utf8').split(CLI).join(cli));
  const dist = path.join(f.home, 'release'); fs.mkdirSync(dist);
  const release = { schemaVersion: 1, version: '0.0.1', commit: 'a'.repeat(40), sha256: 'b'.repeat(64) };
  const archive = path.join(dist, 'thinker.tgz'); fs.writeFileSync(archive, 'unused');
  fs.writeFileSync(path.join(dist, 'version.json'), JSON.stringify(release));
  fs.writeFileSync(path.join(f.thinker, 'install.json'), JSON.stringify({ source: 'archive', dist: pathToFileURL(archive).href, commit: release.commit }));
  const bin = path.join(f.home, 'bin'); fs.mkdirSync(bin); fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.mkdirSync(path.join(f.thinker, 'bin'));
  fs.writeFileSync(path.join(f.thinker, 'bin/thinker'), `#!/bin/sh\nexec node "${cli}" "$@"\n`, { mode: 0o755 });
  f.env.PATH = bin + path.delimiter + f.env.PATH;
  return { ...f, app, cli, dist, release, archive };
}

test('already-current foreground and background updates repair settings and report repair errors', t => {
  const f = installedFixture(t);
  for (const args of [['update', '--quiet'], ['update', '--background', '--quiet']]) {
    fs.writeFileSync(f.config, '[features]\nmulti_agent = false\n');
    const r = spawnSync(process.execPath, [f.cli, ...args], { cwd: f.home, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(fs.readFileSync(f.config, 'utf8'), /multi_agent = false/);
    assert.doesNotMatch(fs.readFileSync(f.config, 'utf8'), /trusted_hash/);
  }
  const bad = path.join(f.home, '.cursor/mcp.json');
  fs.mkdirSync(path.dirname(bad)); fs.writeFileSync(bad, '{broken');
  for (const args of [['update', '--quiet'], ['update', '--background', '--quiet']]) {
    const r = spawnSync(process.execPath, [f.cli, ...args], { cwd: f.home, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /environment repair failed/);
    assert.match(checkPendingNotice(f.thinker), /cursor/);
  }
});

test('Codex MCP entries without managed comments receive the launcher marker without losing custom settings', t => {
  const f = fixture(t);
  fs.appendFileSync(f.config, `\n[mcp_servers.thinker]\ncommand = "node"\nargs = [${JSON.stringify(MCP)}]\nstartup_timeout_sec = 30\n[mcp_servers.thinker.env]\nTHINKER_REPO = "/old/checkout"\nCUSTOM_SETTING = "keep"\n`);
  let r = f.run('rewire', '--json', '--quiet');
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(f.config, 'utf8');
  assert.match(text, /THINKER_MCP_LAUNCHER = "1"/);
  assert.doesNotMatch(text, /THINKER_REPO/);
  assert.match(text, /CUSTOM_SETTING = "keep"/);
  assert.match(text, /startup_timeout_sec = 30/);
  assert.equal((text.match(/\[mcp_servers.thinker\]/g) || []).length, 1);
  r = f.run('rewire', '--json', '--quiet');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).changed, 0);
});

test('the installer update entrypoint repairs the installed environment through the new CLI', t => {
  const f = installedFixture(t);
  // Publish an isolated local archive; no registry, model or production endpoint is contacted.
  const pkg = path.join(f.app, 'package.json');
  fs.writeFileSync(pkg, JSON.stringify({ name: 'thinker', type: 'module', version: '0.0.2' }));
  execFileSync('tar', ['-czf', f.archive, '-C', f.app, '.'], { env: f.env });
  fs.writeFileSync(pkg, JSON.stringify({ name: 'thinker', type: 'module', version: '0.0.1' }));
  const release = { ...f.release, version: '0.0.2', commit: 'c'.repeat(40), sha256: createHash('sha256').update(fs.readFileSync(f.archive)).digest('hex') };
  fs.writeFileSync(path.join(f.dist, 'version.json'), JSON.stringify(release));
  // Run the installer's exact Node entrypoint; download/checksum coverage lives in update.test.js.
  // This also models older installers: they call the downloaded copy's applyUpdate directly.
  const installer = fs.readFileSync(path.resolve(import.meta.dirname, '../install.sh'), 'utf8');
  const entrypoint = installer.match(/node --input-type=module - "\$tmp\/app\/src\/update.js"[^\n]*<<'JS'\n([\s\S]*?)\nJS/)[1];
  const r = spawnSync(process.execPath, ['--input-type=module', '-', path.resolve(import.meta.dirname, '../src/update.js'), f.thinker, pathToFileURL(f.archive).href, 'latest'], {
    cwd: f.home, env: f.env, input: entrypoint, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Updated thinker to v0.0.2/);
  assert.match(fs.readFileSync(f.config, 'utf8'), /multi_agent = false/);
  assert.doesNotMatch(fs.readFileSync(f.config, 'utf8'), /trusted_hash/);
  assert.equal(JSON.parse(fs.readFileSync(repairFile(f.thinker))).ok, true);
});
