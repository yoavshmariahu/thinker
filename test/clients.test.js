import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { parseClients, installClient, uninstallClients, toolFiles, hookClient } from '../src/clients.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-clients-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/upload.py'), 'class RateLimiter:\n    def allow(self, key):\n        return True\n\ndef upload_endpoint(request):\n    return RateLimiter().allow(request.user)\n');
  const store = new Store(dir).init();
  createNote(store, { title: 'Where upload rate limiting happens', kind: 'location', answers: ['where is rate limiting for the upload endpoint', 'upload rate limiter'], body: 'Rate limiting for uploads is in src/upload.py:RateLimiter.allow, called from src/upload.py:upload_endpoint.', deps: [{ path: 'src/upload.py', symbol: 'RateLimiter.allow' }], confidence: 0.9 });
  return dir;
}
const opts = dir => ({ repo: dir, cli: CLI, mcpEntry: { command: 'node', args: ['/x/mcp.js'], env: { THINKER_REPO: dir } }, hooks: true, learn: false, late: true, shared: false, mcp: true });
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const hook = (dir, what, client, ev, extra = []) => execFileSync('node', [CLI, 'hook', what, '--client', client, '--repo', dir, ...extra], { input: JSON.stringify(ev), encoding: 'utf8', env: { ...process.env, THINKER_NO_BG_VERIFY: '1' } }).trim();
const PROMPT = 'add stricter rate limiting to the upload endpoint in upload.py';

test('parseClients validates names and expands all', () => {
  assert.deepEqual(parseClients('codex, cursor'), ['codex', 'cursor']);
  assert.deepEqual(parseClients('all'), ['claude', 'codex', 'cursor', 'gemini']);
  assert.deepEqual(parseClients(undefined), ['claude']);
  assert.throws(() => parseClients('copilot'), /unknown client/);
});

test('install writes each client\'s config and keeps what was there', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.gemini'));
  fs.writeFileSync(path.join(dir, '.gemini/settings.json'), JSON.stringify({ telemetry: { enabled: true }, hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.codex/config.toml'), 'model = "gpt-5"\n');
  for (const c of ['claude', 'codex', 'cursor', 'gemini']) installClient(c, opts(dir));
  for (const c of ['codex', 'gemini']) installClient(c, opts(dir)); // idempotent

  assert.ok(read(dir, '.claude/settings.local.json').hooks.UserPromptSubmit[0].hooks[0].command.includes('hook prompt'));
  assert.equal(read(dir, '.mcp.json').mcpServers.thinker.command, 'node');

  const codex = read(dir, '.codex/hooks.json').hooks;
  assert.equal(codex.UserPromptSubmit.length, 1);
  assert.ok(codex.UserPromptSubmit[0].hooks[0].command.includes('--client codex'));
  const toml = fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8');
  assert.ok(toml.startsWith('model = "gpt-5"'));
  assert.equal(toml.match(/\[mcp_servers\.thinker\]/g).length, 1);
  assert.ok(toml.includes(`THINKER_REPO = ${JSON.stringify(dir)}`));

  const gem = read(dir, '.gemini/settings.json');
  assert.equal(gem.telemetry.enabled, true);
  assert.equal(gem.hooks.BeforeAgent.length, 2);
  assert.equal(gem.hooks.BeforeAgent[1].hooks[0].timeout, 15000);
  assert.ok(gem.hooks.AfterTool && gem.mcpServers.thinker);

  const cur = read(dir, '.cursor/hooks.json');
  assert.equal(cur.version, 1);
  assert.ok(cur.hooks.beforeSubmitPrompt[0].command.includes('--client cursor'));
  assert.ok(read(dir, '.cursor/mcp.json').mcpServers.thinker);
  assert.ok(fs.readFileSync(path.join(dir, '.cursor/rules/thinker.mdc'), 'utf8').includes('alwaysApply: true'));
  assert.ok(fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8').includes('.cursor/hooks.json'));

  uninstallClients(dir);
  assert.ok(!fs.existsSync(path.join(dir, '.codex/hooks.json')));
  assert.equal(fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8').trim(), 'model = "gpt-5"');
  const left = read(dir, '.gemini/settings.json');
  assert.equal(left.hooks.BeforeAgent.length, 1);
  assert.equal(left.mcpServers, undefined);
  assert.ok(!fs.existsSync(path.join(dir, '.cursor/rules/thinker.mdc')));
  assert.ok(!fs.existsSync(path.join(dir, '.cursor/hooks.json')));
  assert.ok(!fs.existsSync(path.join(dir, '.cursor/mcp.json')) && !fs.existsSync(path.join(dir, '.mcp.json')));
});

test('prompt hook output matches what each client accepts', () => {
  const dir = repo();
  const codex = hook(dir, 'prompt', 'codex', { session_id: 's1', prompt: PROMPT, cwd: dir });
  assert.ok(codex.startsWith('<thinker-cache>') && codex.includes('RateLimiter.allow'));

  const gem = JSON.parse(hook(dir, 'prompt', 'gemini', { session_id: 's2', prompt: PROMPT, cwd: dir }));
  assert.ok(gem.hookSpecificOutput.additionalContext.includes('RateLimiter.allow'));

  // nothing relevant: Gemini must get no stray text on stdout
  assert.equal(hook(dir, 'prompt', 'gemini', { session_id: 's3', prompt: 'hello' }), '');
});

test('cursor gets the bundle on the first tool call, once', () => {
  const dir = repo();
  const first = hook(dir, 'prompt', 'cursor', { conversation_id: 'c1', prompt: PROMPT, workspace_roots: [dir], cursor_version: '3.0' });
  assert.deepEqual(JSON.parse(first), { continue: true });
  const tool = JSON.parse(hook(dir, 'tool', 'cursor', { conversation_id: 'c1', tool_name: 'Grep', tool_input: { pattern: 'x' } }));
  assert.ok(tool.additional_context.includes('RateLimiter.allow'));
  assert.equal(hook(dir, 'tool', 'cursor', { conversation_id: 'c1', tool_name: 'Grep', tool_input: { pattern: 'x' } }), '');
});

test('Claude Code hooks imported by Cursor stay silent', () => {
  const dir = repo();
  assert.equal(hookClient(undefined, { cursor_version: '3.0' }), 'cursor-import');
  const o = execFileSync('node', [CLI, 'hook', 'prompt', '--repo', dir], { input: JSON.stringify({ prompt: PROMPT, cursor_version: '3.0', conversation_id: 'c2' }), encoding: 'utf8' });
  assert.equal(o.trim(), '');
});

test('toolFiles reads the different tool input shapes', () => {
  const dir = repo();
  assert.deepEqual(toolFiles({ tool_input: { file_path: path.join(dir, 'src/upload.py') } }, dir), ['src/upload.py']);
  assert.deepEqual(toolFiles({ tool_input: { absolute_path: path.join(dir, 'src/upload.py') } }, dir), ['src/upload.py']);
  assert.deepEqual(toolFiles({ tool_input: { command: 'sed -n 1,20p src/upload.py' } }, dir), ['src/upload.py']);
  assert.deepEqual(toolFiles({ tool_input: { file_path: '/etc/passwd' } }, dir), []);
});

test('cursor: the bundle waits past MCP calls and is dropped when the agent asked the cache itself', () => {
  const dir = repo();
  hook(dir, 'prompt', 'cursor', { conversation_id: 'c5', prompt: PROMPT });
  assert.equal(hook(dir, 'tool', 'cursor', { conversation_id: 'c5', tool_name: 'MCP:get_issue', tool_input: {} }), '');
  assert.ok(JSON.parse(hook(dir, 'tool', 'cursor', { conversation_id: 'c5', tool_name: 'Grep', tool_input: { pattern: 'x' } })).additional_context.includes('RateLimiter.allow'));
  hook(dir, 'prompt', 'cursor', { conversation_id: 'c6', prompt: PROMPT });
  assert.equal(hook(dir, 'tool', 'cursor', { conversation_id: 'c6', tool_name: 'MCP:orient', tool_input: { task: PROMPT } }), '');
  assert.equal(hook(dir, 'tool', 'cursor', { conversation_id: 'c6', tool_name: 'Grep', tool_input: { pattern: 'x' } }), '');
});

test('init learns from sessions by default; --no-learn and THINKER_NO_LEARN switch it off', () => {
  const run = (args, env = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-learn-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('node', [CLI, 'init', '--local', '--no-mcp', '--clients', 'claude', '--repo', dir, ...args], { env: { ...process.env, THINKER_NO_LEARN: '', ...env }, stdio: 'pipe' });
    const f = path.join(dir, '.claude', 'settings.local.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).hooks || {} : null;
  };
  const on = run([]);
  assert.ok(on.UserPromptSubmit, 'notes are served');
  assert.ok(on.Stop, 'sessions are distilled when they end');
  for (const off of [run(['--no-learn']), run(['--serve-only']), run([], { THINKER_NO_LEARN: '1' })]) {
    assert.ok(off.UserPromptSubmit, 'notes are still served');
    assert.equal(off.Stop, undefined);
  }
  assert.ok(!run(['--no-hooks'])?.UserPromptSubmit, 'no hooks at all');
});
