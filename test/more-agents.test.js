import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { installClient, inferWiring, refreshWiring, uninstallWiring, hookClient, detectClients } from '../src/clients.js';

// Droid, Qwen Code, Kiro CLI, Cline, Kilo, Auggie and Goose (2026-10-19), and Copilot in VS Code, which
// runs the Copilot CLI's hook files with payloads of its own. Formats from each agent's documentation.
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const MCP = path.join(path.dirname(CLI), 'mcp.js');
const NEW = ['droid', 'qwen', 'kiro', 'cline', 'kilo', 'augment', 'goose'];

const fakeHome = t => {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-agents-home-')));
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  return { HOME: h, XDG_CONFIG_HOME: '', QWEN_HOME: '', CLINE_DATA_DIR: '', CLINE_DIR: '', GOOSE_PATH_ROOT: '' };
};
const inHome = (env, fn) => { const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === '') delete process.env[k]; else process.env[k] = env[k]; } try { return fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-agents-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/upload.py'), 'class RateLimiter:\n    def allow(self, key):\n        return True\n\ndef upload_endpoint(request):\n    return RateLimiter().allow(request.user)\n');
  const store = new Store(dir).init();
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), minNotes: 1, holdout: 0 }));
  createNote(store, { title: 'Where upload rate limiting happens', kind: 'location', answers: ['where is rate limiting for the upload endpoint', 'upload rate limiter'], body: 'Rate limiting for uploads is in src/upload.py:RateLimiter.allow, called from src/upload.py:upload_endpoint.', deps: [{ path: 'src/upload.py', symbol: 'RateLimiter.allow' }], confidence: 0.9 });
  return dir;
}
const PROMPT = 'add stricter rate limiting to the upload endpoint in upload.py';
// Wiring, not ranking: the cross-encoder (dense.js) stays out of these spawns, as in clients.test.js and
// late.test.js -- it has its own test, and loading it in every spawn is most of what they cost.
const hook = (dir, what, client, ev, extra = []) => execFileSync('node', [CLI, 'hook', what, '--client', client, '--repo', dir, ...extra], { input: JSON.stringify(ev), encoding: 'utf8', env: { ...process.env, THINKER_NO_BG_VERIFY: '1', THINKER_HOLDOUT: 'off', THINKER_CE: 'off' } }).trim();
const served = dir => { try { return fs.readFileSync(path.join(dir, '.thinker', 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.op === 'orient' && r.served?.length); } catch { return []; } };

test('the seven agents are detected by their config directories', t => {
  const home = fakeHome(t);
  inHome({ ...home, PATH: '' }, () => {
    for (const d of ['.factory', '.qwen', '.kiro', 'Documents/Cline', '.config/kilo', '.augment', '.config/goose']) fs.mkdirSync(path.join(home.HOME, d), { recursive: true });
    const found = detectClients({ fallback: false });
    for (const c of NEW) assert.ok(found.includes(c), c);
  });
});

test('Droid, Qwen Code, Kiro, Cline, Kilo, Auggie and Goose are wired in their own files, read back, refreshed without change, removed', t => {
  const home = fakeHome(t);
  inHome(home, () => {
    const at = (...p) => path.join(home.HOME, ...p);
    const entry = { command: 'node', args: [MCP] };
    // what the person had before: thinker keeps all of it
    write(at('.factory', 'settings.json'), JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    write(at('.qwen', 'settings.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    write(at('Documents', 'Cline', 'Hooks', 'TaskComplete'), '#!/bin/sh\necho mine\n');
    write(at('.config', 'goose', 'config.yaml'), 'GOOSE_PROVIDER: anthropic\nextensions:\n  developer:\n    type: builtin\n    name: developer\n    enabled: true\n');
    const o = { scope: 'user', cli: CLI, mcpEntry: entry, hooks: true, learn: true, late: true, mcp: true };
    for (const c of NEW) installClient(c, o);

    // Droid: no hooks.json, so its settings.json carries the hooks; MCP in mcp.json; no instructions (2026-10-22)
    const droid = json(at('.factory', 'settings.json'));
    assert.equal(droid.model, 'x');
    assert.match(droid.hooks.UserPromptSubmit[0].hooks[0].command, / hook prompt --client droid --user --record$/);
    assert.equal(droid.hooks.UserPromptSubmit[0].hooks[0].timeout, 15, 'seconds');
    assert.match(droid.hooks.PostToolUse[0].hooks[0].command, / --late --record$/);
    assert.equal(droid.hooks.Stop.length, 2, 'the person\'s Stop hook stays');
    assert.ok(droid.hooks.SessionEnd);
    assert.deepEqual(json(at('.factory', 'mcp.json')).mcpServers.thinker, { type: 'stdio', command: 'node', args: [MCP], env: {} });
    // Qwen Code: hooks and MCP in settings.json
    const qwen = json(at('.qwen', 'settings.json'));
    assert.ok(qwen.mcpServers.other && qwen.mcpServers.thinker);
    assert.match(qwen.hooks.UserPromptSubmit[0].hooks[0].command, /--client qwen --user/);
    // Kiro: the V3 engine's global hooks file
    const kiro = json(at('.kiro', 'hooks', 'thinker.json'));
    assert.equal(kiro.version, 'v1');
    assert.deepEqual(kiro.hooks.map(h => h.trigger), ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']);
    assert.match(kiro.hooks[0].action.command, /hook prompt --client kiro --user --record$/);
    assert.ok(json(at('.kiro', 'settings', 'mcp.json')).mcpServers.thinker);
    // Cline: executables per event; the person's own TaskComplete is left alone
    const ups = at('Documents', 'Cline', 'Hooks', 'UserPromptSubmit');
    assert.ok(fs.statSync(ups).mode & 0o100, 'executable');
    assert.match(fs.readFileSync(ups, 'utf8'), /^#!\/bin\/sh\n.*\nexec node ".*cli\.js" hook prompt --client cline --user --record\n$/);
    assert.equal(fs.readFileSync(at('Documents', 'Cline', 'Hooks', 'TaskComplete'), 'utf8'), '#!/bin/sh\necho mine\n');
    assert.ok(json(at('.cline', 'data', 'settings', 'cline_mcp_settings.json')).mcpServers.thinker);
    // Kilo: OpenCode's plugin in Kilo's module shape
    const kilo = fs.readFileSync(at('.config', 'kilo', 'plugin', 'thinker.js'), 'utf8');
    assert.match(kilo, /integrations\/opencode\.js/);
    assert.match(kilo, /export default \{ id: 'thinker', server: opencodePlugin\(/);
    // Auggie: scripts only, milliseconds, no prompt hook; the Stop hook asks for the turn's prompt
    const aug = json(at('.augment', 'settings.json'));
    assert.equal(aug.hooks.UserPromptSubmit, undefined);
    const toolScript = aug.hooks.PostToolUse[0].hooks[0].command;
    assert.equal(toolScript, at('.augment', 'thinker', 'tool.sh'));
    assert.equal(aug.hooks.PostToolUse[0].hooks[0].timeout, 10000);
    assert.match(fs.readFileSync(toolScript, 'utf8'), /exec node ".*" hook tool --client augment --user --late --record/);
    assert.deepEqual(aug.hooks.Stop[0].metadata, { includeConversationData: true });
    assert.ok(aug.mcpServers.thinker);
    // Goose: a plugin of hooks that record, and the extension in config.yaml beside the person's
    const goose = json(at('.agents', 'plugins', 'thinker', 'hooks', 'hooks.json'));
    assert.match(goose.hooks.UserPromptSubmit[0].hooks[0].command, /--client goose --user --record$/);
    assert.doesNotMatch(goose.hooks.PostToolUse[0].hooks[0].command, /--late/, 'nothing reaches the model from a Goose hook');
    const yaml = fs.readFileSync(at('.config', 'goose', 'config.yaml'), 'utf8');
    assert.match(yaml, /^GOOSE_PROVIDER: anthropic$/m);
    assert.match(yaml, /^ {2}developer:$/m);
    assert.match(yaml, /^ {2}thinker:\n {4}type: stdio\n/m);
    assert.ok(yaml.includes(`args: ${JSON.stringify([MCP])}`));

    for (const c of NEW) {
      const w = inferWiring(null, c, { scope: 'user' });
      assert.ok(w && w.hooks && w.mcp, c);
      assert.equal(w.learn, true, c);
      assert.deepEqual(w.custom, [], c);
      if (['droid', 'qwen', 'cline', 'augment'].includes(c)) assert.equal(w.late, true, c);
      assert.ok(w.scripts.length, c);
      const r = refreshWiring(null, { scope: 'user', cli: CLI, mcpEntry: entry, clients: [c] });
      assert.deepEqual([r.changed, r.skipped], [[], []], c);
    }

    // Goose records the plugin it loaded in config.yaml, and adds its own extensions after thinker's
    fs.appendFileSync(at('.config', 'goose', 'config.yaml'), `  todo:\n    enabled: false\n    type: platform\nplugins:\n  ${at('.agents', 'plugins', 'thinker')}:\n    enabled: true\n`);
    assert.ok(inferWiring(null, 'goose', { scope: 'user' }).mcp);
    uninstallWiring({ scope: 'user' });
    for (const c of NEW) assert.equal(inferWiring(null, c, { scope: 'user' }), null, c);
    assert.deepEqual(json(at('.factory', 'settings.json')), { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } });
    assert.deepEqual(json(at('.qwen', 'settings.json')), { mcpServers: { other: { command: 'x' } } });
    assert.equal(fs.existsSync(ups), false);
    assert.equal(fs.readFileSync(at('Documents', 'Cline', 'Hooks', 'TaskComplete'), 'utf8'), '#!/bin/sh\necho mine\n');
    for (const f of [['.kiro', 'hooks', 'thinker.json'], ['.augment', 'thinker'], ['.agents', 'plugins', 'thinker'], ['.config', 'kilo', 'plugin', 'thinker.js']]) assert.equal(fs.existsSync(at(...f)), false, f.join('/'));
    assert.equal(fs.readFileSync(at('.config', 'goose', 'config.yaml'), 'utf8'), 'GOOSE_PROVIDER: anthropic\nextensions:\n  developer:\n    type: builtin\n    name: developer\n    enabled: true\n  todo:\n    enabled: false\n    type: platform\n');
    for (const f of [['.factory', 'AGENTS.md'], ['.qwen', 'QWEN.md'], ['.config', 'goose', '.goosehints']]) assert.equal(fs.existsSync(at(...f)), false, f.join('/'));
  });
});

test('Droid: a hooks.json, when there is one, takes the hooks at its top level, and stays when emptied', t => {
  const home = fakeHome(t);
  inHome(home, () => {
    const file = path.join(home.HOME, '.factory', 'hooks.json');
    write(file, JSON.stringify({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] }));
    installClient('droid', { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: [MCP] }, hooks: true, learn: false, late: false, mcp: false });
    const h = json(file);
    assert.ok(h.PreToolUse && h.UserPromptSubmit && h.Stop && !h.hooks);
    assert.match(h.Stop[0].hooks[0].command, / --no-distill$/);
    assert.ok(inferWiring(null, 'droid', { scope: 'user' }).hooks);
    uninstallWiring({ scope: 'user' });
    assert.deepEqual(json(file), { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] });
  });
});

test('Goose hooks are left out without learning: they could only record', t => {
  const home = fakeHome(t);
  inHome(home, () => {
    installClient('goose', { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: [MCP] }, hooks: true, learn: false, late: true, mcp: true });
    assert.equal(fs.existsSync(path.join(home.HOME, '.agents', 'plugins', 'thinker')), false);
    const w = inferWiring(null, 'goose', { scope: 'user' });
    assert.deepEqual([w.hooks, w.mcp], [false, true]);
    assert.match(fs.readFileSync(path.join(home.HOME, '.config', 'goose', 'config.yaml'), 'utf8'), /^extensions:\n {2}thinker:\n/);
  });
});

test('prompt hooks: Droid, Qwen Code and Kiro print the bundle; Cline answers in its JSON', t => {
  for (const client of ['droid', 'qwen', 'kiro']) {
    const dir = repo(t);
    const out = hook(dir, 'prompt', client, { session_id: `${client}-1`, cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
    assert.match(out, /<thinker-cache>[\s\S]*RateLimiter\.allow/, client);
  }
  const dir = repo(t);
  const out = JSON.parse(hook(dir, 'prompt', 'cline', { hookName: 'UserPromptSubmit', taskId: 'task-1', workspaceRoots: [dir], userPromptSubmit: { prompt: PROMPT, attachments: [] } }));
  assert.equal(out.cancel, false);
  assert.match(out.contextModification, /RateLimiter\.allow/);
});

test('the Cline CLI and VS Code\'s Copilot take the bundle with the first tool call', t => {
  const dir = repo(t);
  // the CLI's prompt hook has no return channel (its payload carries a sessionContext): a bundle waits for a tool call;
  // its own nudges are no request
  assert.deepEqual(JSON.parse(hook(dir, 'prompt', 'cline', { hookName: 'prompt_submit', taskId: 'task-3', sessionContext: {}, workspaceRoots: [dir], userPromptSubmit: { prompt: '[SYSTEM] This run is not complete until you call one of these terminal completion tools: submit_and_exit.' } })), { cancel: false });
  const cli = { hookName: 'prompt_submit', taskId: 'task-2', sessionContext: { rootSessionId: 'task-2' }, workspaceRoots: [dir], userPromptSubmit: { prompt: PROMPT } };
  assert.deepEqual(JSON.parse(hook(dir, 'prompt', 'cline', cli)), { cancel: false });
  const tool = JSON.parse(hook(dir, 'tool', 'cline', { hookName: 'tool_result', taskId: 'task-2', sessionContext: {}, workspaceRoots: [dir], tool_call: { name: 'read_file', input: { path: 'README.md' } }, tool_result: 'x' }));
  assert.match(tool.contextModification, /RateLimiter\.allow/);

  assert.equal(hookClient('copilot', { sessionId: 'c', prompt: 'x' }), 'copilot');
  assert.equal(hookClient('copilot', { session_id: 'v', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), 'copilot', 'no transcript: not VS Code');
  assert.equal(hookClient('copilot', { session_id: 'v', transcript_path: '/t', hook_event_name: 'UserPromptSubmit', prompt: 'x' }), 'vscode');
  const vs = repo(t);
  assert.equal(hook(vs, 'prompt', 'copilot', { session_id: 'vs-1', transcript_path: '/nonexistent/t.jsonl', cwd: vs, hook_event_name: 'UserPromptSubmit', prompt: PROMPT }), '');
  const after = JSON.parse(hook(vs, 'tool', 'copilot', { session_id: 'vs-1', transcript_path: '/nonexistent/t.jsonl', cwd: vs, hook_event_name: 'PostToolUse', tool_name: 'read_file', tool_input: { filePath: 'README.md' }, tool_response: 'x' }));
  assert.equal(after.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(after.hookSpecificOutput.additionalContext, /RateLimiter\.allow/);
});

test('Auggie: rules about the files it edits, in hookSpecificOutput; its Stop hook records the turn\'s prompt', t => {
  const dir = repo(t);
  createNote(new Store(dir), { title: 'Upload limits are per user, never per IP', kind: 'rule', answers: ['upload rate limit key'], body: 'src/upload.py:RateLimiter.allow keys on the user; keying on the IP let one office share a limit.', deps: [{ path: 'src/upload.py', symbol: 'RateLimiter.allow' }], confidence: 0.9 });
  const ev = { hook_event_name: 'PostToolUse', conversation_id: 'aug-1', workspace_roots: [dir], tool_name: 'str-replace-editor', tool_input: { path: 'src/upload.py', old_str: 'True', new_str: 'False' }, tool_output: 'edited' };
  const out = JSON.parse(hook(dir, 'tool', 'augment', ev, ['--late', '--record']));
  assert.match(out.hookSpecificOutput.additionalContext, /per user, never per IP/);
  hook(dir, 'stop', 'augment', { hook_event_name: 'Stop', conversation_id: 'aug-1', workspace_roots: [dir], agent_stop_cause: 'end_turn', conversation: { userPrompt: PROMPT } }, ['--record', '--no-distill']);
  const trace = fs.readFileSync(path.join(dir, '.thinker', 'state', 'trace-aug-1.jsonl'), 'utf8');
  assert.match(trace, /"t":"tool"/);
  assert.ok(trace.includes(`"t":"prompt","text":"${PROMPT}"`));
});

test('Goose: the prompt hook records and prints nothing; nothing is counted as served', t => {
  const dir = repo(t);
  assert.equal(hook(dir, 'prompt', 'goose', { event: 'UserPromptSubmit', session_id: 'g-1', working_dir: dir, message: PROMPT }, ['--record']), '');
  assert.deepEqual(served(dir), []);
  assert.match(fs.readFileSync(path.join(dir, '.thinker', 'state', 'trace-g-1.jsonl'), 'utf8'), /"t":"prompt"/);
});
