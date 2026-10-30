import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pluginYields, installClient } from '../src/clients.js';

const root = path.resolve('plugins');
const read = f => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const hooksOf = f => Object.entries(read(f).hooks).flatMap(([ev, groups]) => groups.flatMap(g => (g.hooks || [g]).map(h => [ev, h.command])));

test('the three host plugins carry one and the same hook shim, and every hook runs it with the host as client', () => {
  const shim = fs.readFileSync(path.join(root, 'claude-code/bin/hook.mjs'), 'utf8');
  for (const d of ['codex', 'cursor']) assert.equal(fs.readFileSync(path.join(root, d, 'bin/hook.mjs'), 'utf8'), shim);
  assert.equal(read('claude-code/.claude-plugin/plugin.json').name, 'thinker');
  assert.equal(read('codex/plugin.json').name, 'thinker');
  assert.equal(read('cursor/.cursor-plugin/plugin.json').name, 'thinker');
  const claude = hooksOf('claude-code/hooks/hooks.json');
  assert.deepEqual(claude.map(([ev]) => ev), ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
  for (const [, cmd] of claude) assert.match(cmd, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/hook\.mjs" claude (prompt --record|tool --late --record|stop)$/);
  const codex = hooksOf('codex/hooks/hooks.json');
  assert.deepEqual(codex.map(([ev]) => ev), ['UserPromptSubmit', 'PostToolUse', 'Stop']);
  for (const [, cmd] of codex) assert.match(cmd, /^node "\$PLUGIN_ROOT\/bin\/hook\.mjs" codex (prompt --record|tool --late --record|stop --record)$/);
  // Cursor runs scripts from the plugin root; each hands its event to the shim
  const cursor = hooksOf('cursor/hooks/hooks.json');
  assert.deepEqual(cursor.map(([ev]) => ev), ['beforeSubmitPrompt', 'postToolUse', 'afterShellExecution', 'stop', 'sessionEnd']);
  for (const [, cmd] of cursor) {
    const script = path.join(root, 'cursor', cmd);
    assert.ok(fs.statSync(script).mode & 0o111, `${cmd} is executable`);
    assert.match(fs.readFileSync(script, 'utf8'), /exec node "\$\(dirname "\$0"\)\/hook\.mjs" cursor (prompt --record|tool --late --record|stop --record)\n$/);
  }
  // the marketplaces point at the plugin directories
  assert.equal(JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf8')).plugins[0].source, './plugins/claude-code');
  assert.equal(JSON.parse(fs.readFileSync('.agents/plugins/marketplace.json', 'utf8')).plugins[0].source.path, './plugins/codex');
  assert.equal(JSON.parse(fs.readFileSync('.cursor-plugin/marketplace.json', 'utf8')).plugins[0].source, './plugins/cursor');
});

test('the shim runs the installed thinker with --plugin and does nothing without one: the hooks are for the cache alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-plugin-home-'));
  const shim = path.join(root, 'claude-code/bin/hook.mjs');
  const run = (env, client = 'claude', event = 'prompt') => spawnSync(process.execPath, [shim, client, event, '--record'], { input: '{"session_id":"s","prompt":"hi","cwd":"' + process.cwd() + '"}', env: { ...process.env, THINKER_TEST: '1', THINKER_HOME: home, ...env }, encoding: 'utf8' });
  const missing = run({});
  assert.deepEqual([missing.status, missing.stdout, fs.existsSync(path.join(home, 'state'))], [0, '', false]);
  assert.equal(run({}, 'cursor').stdout.trim(), '{"continue":true}');
  assert.equal(run({}, 'codex', 'tool').stdout, '');
  // a fake cli records what it was asked
  const cli = path.join(home, 'app', 'src', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "process.stdin.resume(); process.stdin.on('end', () => { console.log(process.argv.slice(2).join(' ')); });\n");
  assert.equal(run({}).stdout.trim(), 'hook prompt --client claude --user --plugin --record');
  assert.equal(run({ THINKER_CLI: cli }).status, 0);
  const bad = run({ THINKER_CLI: path.join(home, 'nope.js') });
  assert.deepEqual([bad.status, bad.stdout], [0, '']);
});

test('installing is the plugin command, for the one host, never a hook', () => {
  const files = { claude: 'claude-code/commands/install.md', codex: 'codex/skills/thinker-install/SKILL.md', cursor: 'cursor/commands/install.md' };
  for (const [client, f] of Object.entries(files)) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(text, /^---\n/);
    assert.ok(text.includes(`npx -y @zerotimedev/thinker --clients ${client} --no-modify-path --no-ui --yes`), `${f} installs for ${client} alone`);
    assert.doesNotMatch(text, /--clients (all|auto)/);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'cursor/.cursor-plugin/plugin.json'), 'utf8')).commands, './commands');
  for (const d of ['claude-code', 'codex', 'cursor']) assert.doesNotMatch(fs.readFileSync(path.join(root, d, 'bin/hook.mjs'), 'utf8'), /npx|spawn\(/);
});

test('a plugin hook yields where the agent settings already run thinker hooks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-plugin-yield-'));
  const prev = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.equal(pluginYields('claude'), false);
    installClient('claude', { scope: 'user', repo: null, cli: path.resolve('src/cli.js'), hooks: true, learn: true, late: true, mcp: false });
    assert.equal(pluginYields('claude'), true);
  } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
});
