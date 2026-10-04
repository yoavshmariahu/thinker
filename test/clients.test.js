import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { parseClients, installClient, uninstallClients, pruneInstalls, prunedLines, compareVersions, trustCodex, codexHookHash, toolFiles, hookClient, refreshWiring, inferWiring } from '../src/clients.js';
import { installGitHooks, preCommitHook } from '../src/git-hooks.js';

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
const hook = (dir, what, client, ev, extra = [], env = {}) => execFileSync('node', [CLI, 'hook', what, '--client', client, '--repo', dir, ...extra], { input: JSON.stringify(ev), encoding: 'utf8', env: { ...process.env, THINKER_NO_BG_VERIFY: '1', ...env } }).trim();
const PROMPT = 'add stricter rate limiting to the upload endpoint in upload.py';

test('parseClients validates names and expands all', () => {
  assert.deepEqual(parseClients('codex, cursor'), ['codex', 'cursor']);
  assert.deepEqual(parseClients('all'), ['claude', 'codex', 'cursor', 'gemini']);
  assert.deepEqual(parseClients(undefined), ['claude']);
  assert.throws(() => parseClients('copilot'), /unknown client/);
});

test('Codex trust: the project and thinker\'s hooks are written to Codex\'s config, and taken out on uninstall', () => {
  // a hook Codex 0.157 reviewed, and the hash it stored
  assert.equal(codexHookHash('user_prompt_submit', { type: 'command', command: 'THINKER_EARLY=full THINKER_NO_BG_VERIFY=1 THINKER_NO_LEARN=1 THINKER_LOG=local node "/Users/yoavshmariahu/src/thinker/src/cli.js" hook prompt --client codex --budget 750', timeout: 15 }),
    'sha256:61183e6702c7973ceeece17d218a98de28b1345d2cca1e8b1181fe214f511471');

  const dir = repo();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-codex-home-'));
  const cfg = path.join(codexHome, 'config.toml');
  const before = 'model = "gpt-5"\n\n[projects."/elsewhere"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(cfg, before);
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = codexHome;
  try {
    installClient('codex', opts(dir));
    // a hook of someone else in front of ours moves ours to the second group
    const hf = path.join(dir, '.codex/hooks.json');
    const j = read(dir, '.codex/hooks.json'); j.hooks.UserPromptSubmit.unshift({ hooks: [{ type: 'command', command: 'other' }] });
    j.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'echo thinker' }] }];
    fs.writeFileSync(hf, JSON.stringify(j));
    trustCodex(dir); trustCodex(dir); // idempotent
    const toml = fs.readFileSync(cfg, 'utf8');
    assert.ok(toml.startsWith(before.trimEnd()));
    assert.equal(toml.split(`[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"`).length, 2);
    const ours = j.hooks.UserPromptSubmit[1].hooks[0];
    assert.equal(toml.split(`[hooks.state.${JSON.stringify(hf + ':user_prompt_submit:1:0')}]\ntrusted_hash = "${codexHookHash('user_prompt_submit', ours)}"`).length, 2);
    assert.ok(toml.includes(':post_tool_use:0:0"]'));
    assert.ok(!toml.includes(':user_prompt_submit:0:0"]'));
    assert.ok(!toml.includes(':session_start:0:0"]'));

    uninstallClients(dir);
    const left = fs.readFileSync(cfg, 'utf8');
    assert.ok(!left.includes('hooks.state') && left.includes('[projects."/elsewhere"]'));
  } finally { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; }
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
  // without it Codex asks before each tool call, and codex exec refuses the call
  assert.equal(toml.match(/^default_tools_approval_mode = "approve"$/gm).length, 1);

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

test('Cursor MCP opt-out does not write or approve an MCP server', () => {
  const dir = repo();
  installClient('cursor', { ...opts(dir), mcp: false, hooks: false });
  assert.equal(fs.existsSync(path.join(dir, '.cursor', 'mcp.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '.cursor', 'rules', 'thinker.mdc')), false);
});

test('prompt hook output matches what each client accepts', () => {
  const dir = repo();
  const codex = hook(dir, 'prompt', 'codex', { session_id: 's1', prompt: PROMPT, cwd: dir });
  assert.ok(codex.startsWith('<thinker-cache>') && codex.includes('RateLimiter.allow'));
  assert.ok(!codex.includes('🧠'), 'the prompt hook says nothing to the user; the stop hook sums the turn');

  const gem = JSON.parse(hook(dir, 'prompt', 'gemini', { session_id: 's2', prompt: PROMPT, cwd: dir }));
  assert.ok(gem.hookSpecificOutput.additionalContext.includes('RateLimiter.allow'));
  assert.equal(Object.keys(gem).join(), 'hookSpecificOutput', 'no systemMessage at prompt time');

  // Claude Code takes the bundle as plain stdout; no JSON, no systemMessage
  const claude = hook(dir, 'prompt', 'claude', { session_id: 's4', prompt: PROMPT, cwd: dir });
  assert.ok(claude.startsWith('<thinker-cache>') && claude.includes('RateLimiter.allow') && !claude.includes('🧠'));

  // nothing relevant: Gemini must get no stray text on stdout
  assert.equal(hook(dir, 'prompt', 'gemini', { session_id: 's3', prompt: 'hello' }), '');
});

test('stop hook tells the user what the turn saved, once, where the client can show it', () => {
  const dir = repo();
  const noLearn = ['--no-distill'];
  assert.equal(hook(dir, 'stop', 'claude', { session_id: 't0', cwd: dir }, noLearn), '', 'nothing served: nothing said');

  hook(dir, 'prompt', 'claude', { session_id: 't1', prompt: PROMPT, cwd: dir });
  const claude = JSON.parse(hook(dir, 'stop', 'claude', { session_id: 't1', cwd: dir }, noLearn));
  assert.match(claude.systemMessage, /^🧠 thinker: 1 note this turn \(pointing at 1 file, ~\d+k? tokens of code\)$/);
  assert.equal(Object.keys(claude).join(), 'systemMessage', 'no decision: the agent stops as it meant to');
  assert.equal(hook(dir, 'stop', 'claude', { session_id: 't1', cwd: dir }, noLearn), '', 'the next turn starts from none');

  hook(dir, 'prompt', 'gemini', { session_id: 't2', prompt: PROMPT, cwd: dir });
  assert.match(JSON.parse(hook(dir, 'stop', 'gemini', { session_id: 't2', cwd: dir }, noLearn)).systemMessage, /1 note this turn/);

  // Codex has no channel to the user from a stop hook; its stdout stays empty
  hook(dir, 'prompt', 'codex', { session_id: 't3', prompt: PROMPT, cwd: dir });
  assert.equal(hook(dir, 'stop', 'codex', { session_id: 't3', cwd: dir }, noLearn), '');

  // turned off
  hook(dir, 'prompt', 'claude', { session_id: 't4', prompt: PROMPT, cwd: dir });
  const off = execFileSync('node', [CLI, 'hook', 'stop', '--client', 'claude', '--repo', dir, ...noLearn], { input: JSON.stringify({ session_id: 't4', cwd: dir }), encoding: 'utf8', env: { ...process.env, THINKER_NO_BG_VERIFY: '1', THINKER_NOTICE: 'off' } }).trim();
  assert.equal(off, '');
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
    execFileSync('node', [CLI, 'setup', '--no-build', '--no-mcp', '--clients', 'claude', '--repo', dir, ...args], { env: { ...process.env, THINKER_NO_LEARN: '', THINKER_TELEMETRY: 'off', ...env }, stdio: 'pipe' });
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

// a copy of thinker somewhere else: package.json with a version, src/cli.js, src/mcp.js
function otherInstall(version) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-copy-')));
  fs.mkdirSync(path.join(root, 'src'));
  if (version) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'thinker', version }));
  fs.writeFileSync(path.join(root, 'src/cli.js'), '');
  fs.writeFileSync(path.join(root, 'src/mcp.js'), '');
  return root;
}
const wire = (dir, root, file = '.claude/settings.json') => {
  fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `node "${root}/src/cli.js" hook prompt`, timeout: 15 }] }], Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node "${root}/src/cli.js" hook stop`, timeout: 10 }] }] } }));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, thinker: { command: 'node', args: [`${root}/src/mcp.js`], env: { THINKER_REPO: dir } } } }));
};

test('init takes the entries of another copy of thinker out of the checkout: one copy per checkout', () => {
  const dir = repo();
  const old = otherInstall('0.1.4');
  wire(dir, old);
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.codex/config.toml'), `model = "gpt-5"\n\n# thinker:start (managed by thinker, do not edit)\n[mcp_servers.thinker]\ncommand = "node"\nargs = ["${old}/src/mcp.js"]\n\n[mcp_servers.thinker.env]\nTHINKER_REPO = "${dir}"\n# thinker:end\n`);
  const lines = installClient('claude', opts(dir));
  assert.ok(lines[0].includes('another thinker install') && lines[0].includes('0.1.4') && lines[0].includes('.claude/settings.json') && lines[0].includes('.mcp.json'), lines[0]);
  assert.ok(!fs.existsSync(path.join(dir, '.claude/settings.json')), 'nothing else in the shared file: it goes');
  assert.ok(read(dir, '.claude/settings.local.json').hooks.UserPromptSubmit[0].hooks[0].command.includes(CLI));
  const mcp = read(dir, '.mcp.json').mcpServers;
  assert.equal(mcp.thinker.args[0], '/x/mcp.js', 'the MCP entry points at this install now');
  assert.equal(mcp.other.command, 'x');
  // the Codex block is another client's: touched when that client is installed
  assert.ok(fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8').includes(old));
  installClient('codex', opts(dir));
  const toml = fs.readFileSync(path.join(dir, '.codex/config.toml'), 'utf8');
  assert.ok(toml.startsWith('model = "gpt-5"') && toml.includes('"/x/mcp.js"') && !toml.includes(old));
  assert.equal(toml.match(/\[mcp_servers\.thinker\]/g).length, 1);

  // the shared file held this install's own hooks before (installed with --shared): moving to --local leaves one set
  wire(dir, path.dirname(path.dirname(CLI)));
  const moved = installClient('claude', opts(dir));
  assert.ok(moved.some(l => l.includes("removed thinker's hooks from .claude/settings.json")), moved.join('\n'));
  assert.ok(!fs.existsSync(path.join(dir, '.claude/settings.json')));
  assert.equal(read(dir, '.claude/settings.local.json').hooks.UserPromptSubmit.length, 1);
});

test('at prompt time only a copy that is older or gone is taken out, and the user is told at the end of the turn', () => {
  const dir = repo();
  const mine = path.dirname(path.dirname(CLI));
  const same = otherInstall(JSON.parse(fs.readFileSync(path.join(mine, 'package.json'), 'utf8')).version);
  installClient('claude', { ...opts(dir), shared: true, mcp: false });
  wire(dir, same, '.claude/settings.local.json');
  // a copy of the same version stays: two copies of one version must not take each other out
  assert.equal(pruneInstalls(dir, { cli: CLI, olderOnly: true }).length, 0);
  assert.ok(read(dir, '.claude/settings.local.json').hooks.UserPromptSubmit[0].hooks[0].command.includes(same));
  // a newer copy stays too; it cleans up after this one
  const newer = otherInstall('99.0.0');
  wire(dir, newer, '.claude/settings.local.json');
  assert.equal(pruneInstalls(dir, { cli: CLI, olderOnly: true }).length, 0);
  // an older copy goes, through the prompt hook, and the stop hook says so
  const old = otherInstall('0.0.1');
  wire(dir, old, '.claude/settings.local.json');
  hook(dir, 'prompt', 'claude', { session_id: 's1', prompt: PROMPT }, [], { THINKER_LOG: 'local' });
  assert.ok(!fs.existsSync(path.join(dir, '.claude/settings.local.json')));
  assert.ok(read(dir, '.claude/settings.json').hooks.UserPromptSubmit[0].hooks[0].command.includes(CLI), 'this install\'s hooks stay');
  assert.equal(read(dir, '.mcp.json').mcpServers.thinker.args[0], path.join(mine, 'src', 'mcp.js'), 'the MCP entry is pointed at this install');
  const stop = JSON.parse(hook(dir, 'stop', 'claude', { session_id: 's1', transcript_path: '/nonexistent' }));
  assert.ok(stop.systemMessage.includes('another thinker install') && stop.systemMessage.includes('0.0.1') && stop.systemMessage.includes('.claude/settings.local.json'), stop.systemMessage);
  assert.ok(!JSON.parse(hook(dir, 'stop', 'claude', { session_id: 's1', transcript_path: '/nonexistent' }) || '{}').systemMessage, 'said once');
  const log = fs.readFileSync(path.join(dir, '.thinker/log.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(log.some(l => l.op === 'prune' && l.removed[0].version === '0.0.1'));
  // a copy that is no longer there goes too
  const gone = otherInstall(null); fs.rmSync(gone, { recursive: true });
  wire(dir, gone, '.claude/settings.local.json');
  const done = pruneInstalls(dir, { cli: CLI, olderOnly: true });
  assert.equal(done.length, 3);
  assert.ok(prunedLines(done)[0].includes('no longer there'));
});

test('compareVersions orders release versions', () => {
  assert.equal(compareVersions('0.1.4', '0.1.8'), -1);
  assert.equal(compareVersions('0.1.10', '0.1.8'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions(null, '0.1.0'), -1);
});

test('refreshWiring brings a checkout\'s entries to this version\'s shape, keeps the options they were installed with, and leaves other copies and hand-written commands alone', () => {
  const dir = repo();
  const MCP = path.join(path.dirname(CLI), 'mcp.js');
  const mine = { ...opts(dir), learn: true, mcpEntry: { command: 'node', args: [MCP], env: { THINKER_REPO: dir } } };
  installClient('claude', mine);
  const file = path.join(dir, '.claude/settings.local.json');
  // what an older version left: learning on (Stop), late notes on, but no SessionEnd, and the user's own settings beside it
  const cur = read(dir, '.claude/settings.local.json');
  delete cur.hooks.SessionEnd; cur.permissions = { allow: ['Bash(ls)'] };
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
  assert.deepEqual(inferWiring(dir, 'claude'), { hooks: true, learn: true, late: true, shared: false, mcp: true, scripts: [CLI, MCP], custom: [] });
  const dry = refreshWiring(dir, { cli: CLI, mcpEntry: mine.mcpEntry, dry: true });
  assert.deepEqual(dry.changed, ['.claude/settings.local.json']);
  assert.equal(read(dir, '.claude/settings.local.json').hooks.SessionEnd, undefined, 'a dry run writes nothing');
  const r = refreshWiring(dir, { cli: CLI, mcpEntry: mine.mcpEntry });
  assert.deepEqual(r.changed, ['.claude/settings.local.json']); assert.deepEqual(r.clients, ['claude']);
  const after = read(dir, '.claude/settings.local.json');
  assert.equal(after.hooks.SessionEnd.length, 1, 'the new event is added');
  assert.equal(after.hooks.PostToolUse.length, 1, 'late notes stay as installed'); assert.equal(after.hooks.Stop.length, 1);
  assert.deepEqual(after.permissions, { allow: ['Bash(ls)'] }, 'what else is in the file stays');
  assert.ok(!fs.existsSync(path.join(dir, '.claude/settings.json')), 'the local file stays the one in use');
  const mtime = fs.statSync(file).mtimeMs;
  const again = refreshWiring(dir, { cli: CLI, mcpEntry: mine.mcpEntry });
  assert.deepEqual(again.changed, []); assert.equal(fs.statSync(file).mtimeMs, mtime, 'an unchanged file is not touched');

  // hooks that run another, living copy of thinker are not this copy's to rewrite
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-other-'));
  fs.mkdirSync(path.join(other, 'src')); fs.writeFileSync(path.join(other, 'src/cli.js'), ''); fs.writeFileSync(path.join(other, 'package.json'), '{"version":"0.0.1"}');
  installClient('codex', { ...opts(dir), cli: path.join(other, 'src/cli.js'), mcp: false });
  // a copy that is gone (a deleted worktree) is not this copy's either: its entries wait for the prompt hook's prune
  installClient('cursor', { ...opts(dir), cli: '/gone/thinker/src/cli.js', mcp: false });
  // and a command tuned by hand (a benchmark arm's env prefix) is left as it is
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gemini/settings.json'), JSON.stringify({ hooks: { BeforeAgent: [{ hooks: [{ name: 'thinker-prompt', type: 'command', command: `THINKER_LOG=local node "${CLI}" hook prompt --client gemini --repo "${dir}" --budget 750`, timeout: 15000 }] }] } }));
  const codexBefore = fs.readFileSync(path.join(dir, '.codex/hooks.json'), 'utf8'), gemBefore = fs.readFileSync(path.join(dir, '.gemini/settings.json'), 'utf8');
  const r2 = refreshWiring(dir, { cli: CLI, mcpEntry: mine.mcpEntry });
  assert.deepEqual(r2.changed, []);
  assert.match(r2.skipped.find(s => s.client === 'codex').reason, /another copy of thinker/);
  assert.match(r2.skipped.find(s => s.client === 'gemini').reason, /written by hand/);
  assert.match(r2.skipped.find(s => s.client === 'cursor').reason, /\/gone\/thinker, no longer there/);
  assert.ok(read(dir, '.cursor/hooks.json').hooks.beforeSubmitPrompt[0].command.includes('/gone/thinker'));
  assert.equal(fs.readFileSync(path.join(dir, '.codex/hooks.json'), 'utf8'), codexBefore);
  assert.equal(fs.readFileSync(path.join(dir, '.gemini/settings.json'), 'utf8'), gemBefore);

  // git hooks of this copy are rewritten too, in the shape this version writes
  installGitHooks(dir, CLI, true);
  const pre = path.join(dir, '.git/hooks/pre-commit');
  fs.writeFileSync(pre, `#!/bin/sh\n# thinker: old shape\nnode '${CLI}' share --repair-staged\n`);
  const r3 = refreshWiring(dir, { cli: CLI, mcpEntry: mine.mcpEntry });
  assert.deepEqual(r3.changed, ['.git/hooks/pre-commit']);
  assert.equal(fs.readFileSync(pre, 'utf8'), preCommitHook(CLI));

  // the command, for one checkout
  // the command, for one checkout
  const outp = execFileSync('node', [CLI, 'rewire', '--here', '--dry', '--repo', dir], { encoding: 'utf8', env: { ...process.env, THINKER_LOG: 'off', THINKER_TELEMETRY: 'off' } });
  assert.match(outp, /codex left alone/); assert.match(outp, /cursor left alone/); assert.match(outp, /1 checkouts checked; the wiring is current/);
  fs.rmSync(other, { recursive: true, force: true });
});
