import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installClient } from '../src/clients.js';

const CLI = path.resolve('src/cli.js');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-removed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the removed test command cannot execute its argument or create a cache', t => {
  const dir = fixture(t), marker = path.join(dir, 'executed');
  const r = spawnSync(process.execPath, [CLI, 'test', '--', 'touch', marker], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1', THINKER_HOME: path.join(dir, 'home') },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /test wrapper has been removed/);
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('legacy pre hooks are inert even with old opt-in config and user-scope wiring', t => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, '.thinker'));
  const config = path.join(dir, '.thinker/config.json');
  fs.writeFileSync(config, JSON.stringify({ tests: { nudge: true } }));
  for (const client of ['claude', 'codex', 'cursor', 'gemini']) {
    const r = spawnSync(process.execPath, [CLI, 'hook', 'pre', '--client', client, '--user'], {
      cwd: dir, encoding: 'utf8', input: JSON.stringify({ cwd: dir, session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' }, command: 'npm test' }),
      env: { ...process.env, THINKER_TEST: '1', THINKER_HOOKS: 'on', THINKER_HOME: path.join(dir, 'home') },
    });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, '', ''], client);
  }
  assert.deepEqual(fs.readdirSync(dir), ['.thinker']);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.thinker')), ['config.json']);
});

test('wiring removes old test hooks, preserves other hooks, and never installs new pre hooks', t => {
  const dir = fixture(t);
  const o = { repo: dir, cli: CLI, hooks: true, learn: true, late: true, shared: true, mcp: false };
  for (const [client, file, event] of [
    ['claude', '.claude/settings.json', 'PreToolUse'],
    ['codex', '.codex/hooks.json', 'PreToolUse'],
    ['cursor', '.cursor/hooks.json', 'beforeShellExecution'],
  ]) {
    const f = path.join(dir, file);
    installClient(client, o);
    let c = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(c.hooks[event], undefined, client);
    const ours = { type: 'command', command: `node "${CLI}" hook pre --client ${client} --repo "${dir}"`, timeout: 10 };
    const other = { type: 'command', command: 'my-security-check', timeout: 10 };
    const group = h => client === 'cursor' ? h : { hooks: [h] };
    c.hooks[event] = [group(ours), group(other)];
    fs.writeFileSync(f, JSON.stringify(c));
    installClient(client, o);
    c = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.deepEqual(c.hooks[event], [group(other)], client);
    assert.ok(c.hooks[client === 'cursor' ? 'beforeSubmitPrompt' : 'UserPromptSubmit'], 'note injection remains wired');
    assert.ok(c.hooks[client === 'cursor' ? 'postToolUse' : 'PostToolUse'], 'context hooks remain wired');
  }
});
