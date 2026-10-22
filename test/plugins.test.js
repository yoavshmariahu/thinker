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
  assert.deepEqual(claude.map(([ev]) => ev), ['UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop', 'SessionEnd']);
  for (const [, cmd] of claude) assert.match(cmd, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/hook\.mjs" claude (prompt --record|tool --late --record|pre|stop)$/);
  const codex = hooksOf('codex/hooks/hooks.json');
  assert.deepEqual(codex.map(([ev]) => ev), ['UserPromptSubmit', 'PostToolUse', 'PreToolUse', 'Stop']);
  for (const [, cmd] of codex) assert.match(cmd, /^node "\$PLUGIN_ROOT\/bin\/hook\.mjs" codex (prompt --record|tool --late --record|pre|stop --record)$/);
  // Cursor runs scripts from the plugin root; each hands its event to the shim
  const cursor = hooksOf('cursor/hooks/hooks.json');
  assert.deepEqual(cursor.map(([ev]) => ev), ['beforeSubmitPrompt', 'postToolUse', 'afterShellExecution', 'beforeShellExecution', 'stop', 'sessionEnd']);
  for (const [, cmd] of cursor) {
    const script = path.join(root, 'cursor', cmd);
    assert.ok(fs.statSync(script).mode & 0o111, `${cmd} is executable`);
    assert.match(fs.readFileSync(script, 'utf8'), /exec node "\$\(dirname "\$0"\)\/hook\.mjs" cursor (prompt --record|tool --late --record|pre|stop --record)\n$/);
  }
  // the marketplaces point at the plugin directories
  assert.equal(JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf8')).plugins[0].source, './plugins/claude-code');
  assert.equal(JSON.parse(fs.readFileSync('.agents/plugins/marketplace.json', 'utf8')).plugins[0].source.path, './plugins/codex');
  assert.equal(JSON.parse(fs.readFileSync('.cursor-plugin/marketplace.json', 'utf8')).plugins[0].source, './plugins/cursor');
});

test('the shim runs the installed thinker with --plugin, and without one installs it for this host alone, once, and says so', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-plugin-home-'));
  const shim = path.join(root, 'claude-code/bin/hook.mjs');
  const run = env => spawnSync(process.execPath, [shim, 'claude', 'prompt', '--record'], { input: '{"session_id":"s","prompt":"hi","cwd":"' + process.cwd() + '"}', env: { ...process.env, THINKER_TEST: '1', THINKER_HOME: home, ...env }, encoding: 'utf8' });
  // no thinker and installs switched off: nothing
  const off = run({ THINKER_PLUGIN_INSTALL: 'off' });
  assert.deepEqual([off.status, off.stdout], [0, '']);
  // no thinker: a fake installer is started once in the background, the person is told through systemMessage
  const fake = path.join(home, 'installer.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho "$@" > "$THINKER_HOME/installer-args"; exit 3\n'); fs.chmodSync(fake, 0o755);
  const first = run({ THINKER_PLUGIN_INSTALLER: `${fake} --clients claude --no-modify-path --no-ui --yes` });
  assert.equal(first.status, 0);
  assert.match(JSON.parse(first.stdout).systemMessage, /installing for Claude Code in the background.*this host only.*plugin-install-claude\.log/);
  const doneFile = path.join(home, 'state', 'plugin-install-claude.done');
  for (let i = 0; i < 100 && !fs.existsSync(doneFile); i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(fs.readFileSync(doneFile, 'utf8').trim(), '3');
  assert.equal(fs.readFileSync(path.join(home, 'installer-args'), 'utf8').trim(), '--clients claude --no-modify-path --no-ui --yes');
  // the failure is named once, then nothing more; a second prompt never starts a second install
  const second = run({ THINKER_PLUGIN_INSTALLER: fake });
  assert.match(JSON.parse(second.stdout).systemMessage, /did not finish \(exit 3\)/);
  assert.deepEqual([run({}).stdout, run({}).stdout], ['', '']);
  // a tool event with no thinker says nothing and installs nothing
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-plugin-home2-'));
  const tool = spawnSync(process.execPath, [shim, 'claude', 'tool'], { input: '{}', env: { ...process.env, THINKER_TEST: '1', THINKER_HOME: home2, THINKER_PLUGIN_INSTALLER: fake }, encoding: 'utf8' });
  assert.deepEqual([tool.status, tool.stdout, fs.existsSync(path.join(home2, 'state'))], [0, '', false]);
  // Cursor's prompt hook answers {continue} alone
  const cursor = spawnSync(process.execPath, [shim, 'cursor', 'prompt'], { input: '{}', env: { ...process.env, THINKER_TEST: '1', THINKER_HOME: home2, THINKER_PLUGIN_INSTALLER: fake }, encoding: 'utf8' });
  assert.equal(cursor.stdout.trim(), '{"continue":true}');
  // a fake cli records what it was asked
  const cli = path.join(home, 'app', 'src', 'cli.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "process.stdin.resume(); process.stdin.on('end', () => { console.log(process.argv.slice(2).join(' ')); });\n");
  const ran = run({});
  assert.equal(ran.stdout.trim(), 'hook prompt --client claude --user --plugin --record');
  const named = run({ THINKER_CLI: cli });
  assert.equal(named.status, 0);
  const bad = run({ THINKER_CLI: path.join(home, 'nope.js') });
  assert.deepEqual([bad.status, bad.stdout], [0, '']);
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
