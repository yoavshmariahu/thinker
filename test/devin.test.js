// Devin Local 3.6 contracts: docs.devin.ai/cli/extensibility/hooks/{overview,lifecycle-hooks}
// and /cli/extensibility/mcp/configuration. These exercise Thinker, not a live Devin binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { installClient, inferWiring, refreshWiring, uninstallWiring, detectClients, hookClient, normalizeHookEvent, wiringFiles } from '../src/clients.js';
import { desktopApp, anyDesktopApp, subagentHarness } from '../src/app-host.js';
import { pendingJobs, enqueueJob, startSessionWork } from '../src/session-work.js';
import { subagentPrompt, viaSession, queueDir } from '../src/session-llm.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const MCP = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-devin-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const env = { ...process.env, HOME: home, THINKER_HOME: path.join(root, 'thinker'), THINKER_TEST: '1', THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_CE: 'off', THINKER_HOLDOUT: 'off', THINKER_NO_BG_VERIFY: '1', THINKER_HOOKS: 'on', THINKER_NO_LEARN: '0', DEVIN_PROJECT_DIR: repo };
  // A session with no other CLI/app login must still learn.
  for (const k of ['CURSOR_AGENT', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'THINKER_LLM', 'THINKER_SESSION_QUEUE']) delete env[k];
  const store = new Store(repo).init();
  write(path.join(store.dir, 'config.json'), { ...store.config(), minNotes: 1, holdout: 0 });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/upload.py'), 'class RateLimiter:\n    def allow(self, user):\n        return True\n');
  createNote(store, { kind: 'rule', title: 'Upload rate limits are per user', body: 'src/upload.py:RateLimiter.allow keys upload rate limits on the user, never an IP address.', answers: ['upload rate limits per user'], deps: [{ path: 'src/upload.py', symbol: 'RateLimiter.allow' }], confidence: 0.9 });
  const hook = (what, ev, extra = [], client = 'devin') => execFileSync(process.execPath, [CLI, 'hook', what, '--client', client, '--repo', repo, ...extra], { cwd: home, input: JSON.stringify(ev), encoding: 'utf8', env }).trim();
  return { root, home, repo, env, store, hook };
}
function atHome(home, fn) {
  const old = process.env.HOME; process.env.HOME = home;
  try { return fn(); } finally { if (old === undefined) delete process.env.HOME; else process.env.HOME = old; }
}
const opts = { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: [MCP] }, hooks: true, learn: true, late: true, mcp: true };

test('Devin connects, detects, refreshes idempotently and uninstalls without touching unrelated settings', t => {
  const { home } = fixture(t);
  atHome(home, () => {
    const f = wiringFiles('devin', { scope: 'user' });
    const original = { agent: { model: 'sonnet' }, proxy: { mode: 'manual', url: 'http://company.invalid:8080' }, permissions: { deny: ['Write(secret)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
    write(f.hooks, original); write(f.mcp, { mcpServers: { other: { command: 'other' } } });
    assert.ok(detectClients({ fallback: false }).includes('devin'));
    installClient('devin', opts);
    const cfg = json(f.hooks);
    assert.deepEqual(cfg.proxy, original.proxy);
    assert.deepEqual(cfg.permissions, original.permissions);
    assert.equal(cfg.hooks.Stop.length, 2);
    assert.equal(cfg.hooks.PreToolUse, undefined);
    assert.equal(cfg.hooks.PostToolUse[0].matcher, '.*');
    assert.match(cfg.hooks.UserPromptSubmit[0].hooks[0].command, /--client devin --user --record$/);
    assert.equal(cfg.hooks.UserPromptSubmit[0].hooks[0].timeout, 15);
    assert.ok(cfg.hooks.SessionEnd);
    assert.equal(json(f.mcp).mcpServers.thinker.env.THINKER_SESSION_HOST, 'devin');
    assert.equal(json(f.mcp).mcpServers.thinker.env.THINKER_REPO, undefined);
    assert.deepEqual(json(f.mcp).mcpServers.other, { command: 'other' });
    const w = inferWiring(null, 'devin', { scope: 'user' });
    assert.deepEqual([w.hooks, w.learn, w.late, w.mcp, w.custom], [true, true, true, true, []]);
    assert.deepEqual(refreshWiring(null, { ...opts, clients: ['devin'] }).changed, []);
    uninstallWiring({ scope: 'user' });
    assert.deepEqual(json(f.hooks), original);
    assert.deepEqual(json(f.mcp), { mcpServers: { other: { command: 'other' } } });
  });
});

test('Devin respects no-learn/no-late and preserves malformed or commented configuration', t => {
  const { home } = fixture(t);
  atHome(home, () => {
    const f = wiringFiles('devin', { scope: 'user' });
    installClient('devin', { ...opts, learn: false, late: false });
    assert.deepEqual(Object.keys(json(f.hooks).hooks), ['UserPromptSubmit', 'Stop']);
    assert.match(json(f.hooks).hooks.Stop[0].hooks[0].command, /--no-distill$/);
    const commented = '{ // managed by me\n "proxy": {"mode":"off"}\n}';
    fs.writeFileSync(f.hooks, commented);
    assert.throws(() => installClient('devin', opts), /left unchanged/);
    assert.equal(fs.readFileSync(f.hooks, 'utf8'), commented);
  });
});

test('Devin without MCP delivers notes but does not enqueue unanswerable learning work', t => {
  const { home } = fixture(t);
  atHome(home, () => {
    const f = wiringFiles('devin', { scope: 'user' });
    const lines = installClient('devin', { ...opts, mcp: false });
    assert.match(lines.join('\n'), /learning needs.*MCP/);
    const h = json(f.hooks).hooks;
    assert.doesNotMatch(h.UserPromptSubmit[0].hooks[0].command, /--record/);
    assert.match(h.PostToolUse[0].hooks[0].command, /--late/);
    assert.doesNotMatch(h.PostToolUse[0].hooks[0].command, /--record/);
    assert.match(h.Stop[0].hooks[0].command, /--no-distill/);
    assert.equal(h.SessionEnd, undefined);
    assert.equal(fs.existsSync(f.mcp), false);
  });
});

test('repo-scoped Devin wiring uses flat hooks.v1 and local MCP, and preserves other hooks', t => {
  const { repo } = fixture(t);
  const f = wiringFiles('devin', { repo, scope: 'repo' });
  write(f.hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
  installClient('devin', { ...opts, scope: 'repo', repo });
  assert.equal(json(f.hooks).hooks, undefined);
  assert.match(json(f.hooks).UserPromptSubmit[0].hooks[0].command, /--client devin --repo/);
  assert.ok(inferWiring(repo, 'devin').mcp);
  assert.deepEqual(refreshWiring(repo, { ...opts, scope: 'repo', clients: ['devin'] }).changed, []);
  uninstallWiring({ repo });
  assert.deepEqual(json(f.hooks), { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
});

test('Devin injects notes in documented JSON, records actual outputs/errors and queues learning at session end without a CLI login', t => {
  const { store, hook } = fixture(t);
  const base = { session_id: 'd-main', prompt_id: 'turn-1' };
  const prompt = JSON.parse(hook('prompt', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix upload rate limits per user in src/upload.py' }, ['--record']));
  assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(prompt.hookSpecificOutput.additionalContext, /RateLimiter.allow/);
  hook('tool', { ...base, hook_event_name: 'PostToolUse', tool_name: 'exec', tool_input: { command: 'cat src/upload.py' }, tool_response: { success: true, output: 'actual output', error: null } }, ['--record']);
  hook('tool', { ...base, hook_event_name: 'PostToolUse', tool_name: 'exec', tool_input: { command: 'false' }, tool_response: { success: false, output: '', error: 'permission denied' } }, ['--record']);
  const trace = path.join(store.dir, 'state', 'trace-d-main.jsonl');
  const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[1].name, 'Bash');
  assert.equal(events[1].result, 'actual output');
  assert.match(events[2].result, /Error: permission denied/);
  hook('stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false }, ['--record']);
  assert.deepEqual(pendingJobs(store), []);
  hook('stop', { ...base, hook_event_name: 'SessionEnd', reason: 'exit' }, ['--record']);
  assert.deepEqual(pendingJobs(store).map(j => j.key), ['distill-d-main']);
  assert.equal(json(path.join(store.dir, 'state', 'app-session')).app, 'Devin');
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'session-work.last')), false, 'test mode starts no background model process');
});

test('Devin post-tool context serves file notes; imported Claude hooks and unknown sessions do nothing', t => {
  const { hook, store, repo } = fixture(t);
  const ev = { session_id: 'd-edit', hook_event_name: 'PostToolUse', tool_name: 'edit', tool_input: { file_path: 'src/upload.py' }, tool_response: { success: true, output: 'edited', error: null } };
  const out = JSON.parse(hook('tool', ev, ['--late', '--record']));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /per user/);
  assert.equal(out.hookSpecificOutput.updatedInput, undefined);
  assert.equal(hook('prompt', { session_id: 'imported', prompt_id: 'p', hook_event_name: 'UserPromptSubmit', prompt: 'fix uploads' }, ['--record'], 'claude'), '');
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'trace-imported.jsonl')), false);
  assert.equal(hook('prompt', { prompt: 'fix uploads' }, ['--record']), '');
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'trace-unknown.jsonl')), false);
  const old = process.env.DEVIN_PROJECT_DIR; process.env.DEVIN_PROJECT_DIR = repo;
  try {
    assert.equal(hookClient('claude', { session_id: 'c', transcript_path: '/claude/session.jsonl', hook_event_name: 'Stop' }), 'claude');
    assert.equal(normalizeHookEvent('devin', ev).cwd, repo);
  } finally { if (old === undefined) delete process.env.DEVIN_PROJECT_DIR; else process.env.DEVIN_PROJECT_DIR = old; }
});

test('Devin queue workers do not record or distill themselves, and background work uses the session provider', t => {
  const { store, hook, repo } = fixture(t);
  hook('prompt', { session_id: 'worker', prompt: subagentPrompt(repo) }, ['--record']);
  hook('tool', { session_id: 'worker', tool_name: 'mcp_call_tool', tool_input: { server_name: 'thinker', tool_name: 'learn_next' }, tool_response: { output: 'done', success: true } }, ['--record']);
  hook('stop', { session_id: 'worker', hook_event_name: 'SessionEnd' }, ['--record']);
  assert.equal(fs.existsSync(path.join(store.dir, 'state', 'trace-worker.jsonl')), false);
  assert.deepEqual(pendingJobs(store), []);
  assert.equal(subagentHarness('devin-cli'), 'devin');
  assert.equal(desktopApp('devin', { env: {}, ancestry: [] }), 'Devin');
  assert.equal(anyDesktopApp({ env: {}, ancestry: [] }), null);
  assert.equal(anyDesktopApp({ env: { THINKER_SESSION_HOST: 'devin' }, ancestry: [] }), 'Devin');
  enqueueJob(store, 'verify', ['verify']);
  let options;
  const instruction = startSessionWork(store, { cli: CLI, harness: 'devin', spawnFn: (_cmd, _args, o) => { options = o; return { pid: process.pid, unref() {} }; } });
  assert.match(instruction, /run_subagent.*subagent_general.*background/);
  assert.equal(options.env.THINKER_LLM, 'session');
  assert.equal(options.env.THINKER_TEST, '1');
});

test('Devin MCP exposes and answers the learning queue from startup, even outside the checkout', async t => {
  const { env, store, home } = fixture(t);
  const client = new Client({ name: 'devin-cli', version: 'test' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [MCP], cwd: home, env: { ...env, THINKER_SESSION_HOST: 'devin' }, stderr: 'pipe' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(t => t.name === 'learn_next'));
  // No API or CLI model: the real session provider round-trips through MCP.
  const answer = viaSession({ system: 'test', prompt: 'answer ready' }, { dir: queueDir(store), pollMs: 10, unclaimedMs: 5000 });
  const next = await client.callTool({ name: 'learn_next', arguments: { cwd: store.repo } });
  const id = /Request ([^.]+)\./.exec(next.content[0].text)?.[1];
  assert.ok(id, next.content[0].text);
  // Mark the build as ended so handing in an answer returns immediately.
  fs.writeFileSync(path.join(queueDir(store), 'build.json'), JSON.stringify({ pid: 99999999 }));
  await client.callTool({ name: 'learn_next', arguments: { cwd: store.repo, id, answer: 'ready' } });
  assert.equal((await answer).text, 'ready');
});
