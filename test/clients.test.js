import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { parseClients, installClient, uninstallClients, uninstallWiring, connectFromCheckouts, pruneInstalls, prunedLines, compareVersions, trustCodex, trustCodexUser, codexHookHash, toolFiles, hookClient, stopOutput, refreshWiring, inferWiring } from '../src/clients.js';
import { installGitHooks, preCommitHook, mainCheckout } from '../src/git-hooks.js';
import { knownRepos } from '../src/commands/setup.js';

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

test('hook ownership recognizes the package when the checkout path has no product name', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const install = path.join(dir, 'app');
  fs.mkdirSync(path.join(install, 'src'), { recursive: true });
  fs.writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: 'thinker', version: '0.1.0' }));
  const cli = path.join(install, 'src/cli.js'); fs.writeFileSync(cli, '');
  installClient('claude', { ...opts(dir), cli, mcp: false });
  assert.equal(inferWiring(dir, 'claude').hooks, true);
  assert.deepEqual(inferWiring(dir, 'claude').hookScripts, [cli]);
});

test('parseClients validates names and expands all', () => {
  assert.deepEqual(parseClients('codex, cursor'), ['codex', 'cursor']);
  assert.deepEqual(parseClients('all'), ['claude', 'codex', 'cursor', 'gemini', 'pi', 'windsurf', 'copilot', 'opencode']);
  assert.deepEqual(parseClients(undefined), ['claude']);
  assert.throws(() => parseClients('nonexistent'), /unknown client/);
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
  // the first prompt of a session opens with the tool intro (ops.js:sessionIntro), then the bundle
  assert.ok(codex.startsWith('<thinker-tools>') && codex.includes('\n<thinker-cache>') && codex.includes('RateLimiter.allow'));
  assert.ok(!codex.includes('🧠'), 'the prompt hook says nothing to the user; the stop hook sums the turn');

  const gem = JSON.parse(hook(dir, 'prompt', 'gemini', { session_id: 's2', prompt: PROMPT, cwd: dir }));
  assert.ok(gem.hookSpecificOutput.additionalContext.includes('RateLimiter.allow'));
  assert.equal(Object.keys(gem).join(), 'hookSpecificOutput', 'no systemMessage at prompt time');

  // Claude Code takes the bundle as plain stdout; no JSON, no systemMessage
  const claude = hook(dir, 'prompt', 'claude', { session_id: 's4', prompt: PROMPT, cwd: dir });
  assert.ok(claude.startsWith('<thinker-tools>') && claude.includes('\n<thinker-cache>') && claude.includes('RateLimiter.allow') && !claude.includes('🧠'));

  // nothing relevant: Gemini must get no stray text on stdout
  assert.equal(hook(dir, 'prompt', 'gemini', { session_id: 's2', prompt: 'hello' }), '');
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

  // Codex supports systemMessage without restarting the agent.
  hook(dir, 'prompt', 'codex', { session_id: 't3', prompt: PROMPT, cwd: dir });
  const codex = JSON.parse(hook(dir, 'stop', 'codex', { session_id: 't3', cwd: dir }, noLearn));
  assert.match(codex.systemMessage, /1 note this turn/);
  assert.deepEqual(Object.keys(codex), ['systemMessage']);
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

// a home of its own for a test that wires the agents' settings: the user's own files are never touched
const fakeHome = () => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-')); return { HOME: h, CODEX_HOME: path.join(h, '.codex'), CLAUDE_CONFIG_DIR: '' }; };
const inHome = (env, fn) => { const old = {}; for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === '') delete process.env[k]; else process.env[k] = env[k]; } try { return fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } };

test('setup learns from sessions by default; --no-learn and THINKER_NO_LEARN switch it off', () => {
  const run = (args, env = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-learn-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const home = fakeHome();
    execFileSync('node', [CLI, 'setup', '--no-build', '--no-mcp', '--clients', 'claude', '--repo', dir, ...args], { env: { ...process.env, THINKER_NO_LEARN: '', THINKER_TELEMETRY: 'off', ...home, ...env }, stdio: 'pipe' });
    // the hooks go into the user's own settings, for every checkout; nothing into the checkout
    assert.ok(!fs.existsSync(path.join(dir, '.claude')), 'nothing written into the checkout');
    const f = path.join(home.HOME, '.claude', 'settings.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).hooks || {} : null;
  };
  const on = run([]);
  assert.ok(on.UserPromptSubmit, 'notes are served');
  assert.ok(on.Stop, 'sessions are distilled when they end');
  for (const off of [run(['--no-learn']), run(['--serve-only']), run([], { THINKER_NO_LEARN: '1' })]) {
    assert.ok(off.UserPromptSubmit, 'notes are still served');
    assert.match(off.Stop[0].hooks[0].command, / --no-distill$/);
    assert.equal(off.SessionEnd, undefined);
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
  assert.match(stop.systemMessage, /Thinker setup updated/);
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
  assert.deepEqual(inferWiring(dir, 'claude'), { hooks: true, learn: true, late: true, shared: false, mcp: true, scripts: [CLI, MCP], hookScripts: [CLI], custom: [] });
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

test('new clients install idempotently, refresh and uninstall only their entries', () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, '.windsurf'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.windsurf/hooks.json'), JSON.stringify({ hooks: { pre_user_prompt: [{ command: 'other' }] } }));
  const files = { pi: '.pi/extensions/thinker.js', opencode: '.opencode/plugins/thinker.js', windsurf: '.windsurf/hooks.json', copilot: '.github/hooks/thinker.json' };
  for (const client of Object.keys(files)) {
    installClient(client, { ...opts(dir), learn: true });
    const before = fs.readFileSync(path.join(dir, files[client]), 'utf8');
    installClient(client, { ...opts(dir), learn: true });
    assert.equal(fs.readFileSync(path.join(dir, files[client]), 'utf8'), before);
    const wiring = inferWiring(dir, client);
    assert.equal(wiring.hooks, true); assert.equal(wiring.learn, true);
    assert.deepEqual(wiring.custom, []);
    const refreshed = refreshWiring(dir, { cli: CLI, mcpEntry: opts(dir).mcpEntry, clients: [client] });
    assert.deepEqual(refreshed.changed, []);
    assert.deepEqual(refreshed.skipped, []);
    assert.ok(fs.readFileSync(path.join(dir, '.git/info/exclude'), 'utf8').includes(files[client]));
  }
  uninstallClients(dir);
  assert.deepEqual(read(dir, files.windsurf).hooks.pre_user_prompt, [{ command: 'other' }]);
  for (const c of ['pi', 'opencode', 'copilot']) assert.equal(fs.existsSync(path.join(dir, files[c])), false);
  assert.equal(fs.existsSync(path.join(dir, '.windsurf/rules/thinker.md')), false);
});

test('Windsurf records documented nested events without claiming to inject context', () => {
  const dir = repo();
  // Disable background learning in config, while allowing the hook trace to be recorded.
  const store = new Store(dir); const cfg = store.config(); cfg.learn = { sessions: false }; fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify(cfg));
  const env = { THINKER_NO_LEARN: '', THINKER_LOG: 'local' };
  const ev = (agent_action_name, tool_info) => ({ trajectory_id: 'cascade-1', execution_id: 'turn-1', agent_action_name, tool_info });
  assert.equal(hook(dir, 'prompt', 'windsurf', ev('pre_user_prompt', { user_prompt: PROMPT }), ['--record'], env), '');
  assert.equal(hook(dir, 'tool', 'windsurf', ev('post_write_code', { file_path: 'src/upload.py', edits: [{ old_string: 'True', new_string: 'False' }] }), ['--record'], env), '');
  hook(dir, 'stop', 'windsurf', ev('post_cascade_response', { response: 'Updated the limiter.' }), ['--record', '--no-distill'], env);
  const trace = fs.readFileSync(path.join(store.dir, 'state/trace-cascade-1.jsonl'), 'utf8');
  assert.match(trace, /stricter rate limiting/); assert.match(trace, /Updated the limiter/); assert.match(trace, /"name":"Edit"/);
  assert.equal(hook(dir, 'prompt', 'windsurf', { tool_info: { user_prompt: PROMPT } }, ['--record'], env), '');
  assert.equal(fs.existsSync(path.join(store.dir, 'state/trace-unknown.jsonl')), false);
});

test('Copilot parks prompt context and returns native post-tool additionalContext', () => {
  const dir = repo();
  assert.equal(hook(dir, 'prompt', 'copilot', { sessionId: 'copilot-1', prompt: PROMPT }), '');
  assert.equal(hook(dir, 'tool', 'copilot', { sessionId: 'copilot-1', toolName: 'view', toolArgs: {}, error: 'not found' }), '');
  const result = hook(dir, 'tool', 'copilot', { sessionId: 'copilot-1', toolName: 'view', toolArgs: JSON.stringify({ path: 'src/upload.py' }), toolResult: { resultType: 'success', textResultForLlm: 'file contents' } });
  assert.match(JSON.parse(result).additionalContext, /RateLimiter/);
  assert.equal(hook(dir, 'tool', 'copilot', { sessionId: 'copilot-1', toolName: 'view', toolArgs: {} }), '');
});

test('Windsurf respects preferred Devin hook location and preserves unrelated hooks', () => {
  const dir = repo(); fs.mkdirSync(path.join(dir, '.devin/rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.devin/hooks.json'), JSON.stringify({ hooks: { pre_read_code: [{ command: 'other' }] } }));
  installClient('windsurf', { ...opts(dir), learn: true });
  assert.ok(read(dir, '.devin/hooks.json').hooks.pre_user_prompt);
  assert.equal(inferWiring(dir, 'windsurf').shared, false);
  assert.ok(fs.existsSync(path.join(dir, '.devin/rules/thinker.md')));
  assert.equal(fs.existsSync(path.join(dir, '.windsurf/hooks.json')), false);
  uninstallClients(dir);
  assert.deepEqual(read(dir, '.devin/hooks.json').hooks.pre_read_code, [{ command: 'other' }]);
});

test('Pi and OpenCode generated extensions retrieve a real note through the CLI', async () => {
  const { pathToFileURL } = await import('node:url');
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  installClient('pi', opts(dir));
  const pi = await import(pathToFileURL(path.join(dir, '.pi/extensions/thinker.js')).href);
  const handlers = {}; pi.default({ on: (ev, fn) => { handlers[ev] = fn; } });
  const answer = await handlers.before_agent_start({ prompt: PROMPT }, { sessionManager: { getSessionId: () => 'pi-real' } });
  assert.match(answer.message.content, /RateLimiter/);
  installClient('opencode', opts(dir));
  const oc = await import(pathToFileURL(path.join(dir, '.opencode/plugins/thinker.js')).href);
  const plugin = await oc.default({});
  const output = { parts: [{ type: 'text', text: PROMPT }] };
  await plugin['chat.message']({ sessionID: 'opencode-real' }, output);
  assert.match(output.parts[0].text, /RateLimiter/);
});

test('connect wires the agents into their own settings, once per machine: no --repo in the hooks, no pinned repository in the MCP entry', () => {
  const home = fakeHome();
  inHome(home, () => {
    const MCP = path.join(path.dirname(CLI), 'mcp.js');
    const entry = { command: 'node', args: [MCP] };
    fs.mkdirSync(path.join(home.HOME, '.claude'));
    fs.writeFileSync(path.join(home.HOME, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));
    fs.writeFileSync(path.join(home.HOME, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { other: { command: 'x' } } }));
    fs.mkdirSync(home.CODEX_HOME);
    fs.writeFileSync(path.join(home.CODEX_HOME, 'config.toml'), 'model = "gpt-5"\n');
    const o = { scope: 'user', cli: CLI, mcpEntry: entry, hooks: true, learn: true, late: true, mcp: true };
    const lines = [];
    for (const c of ['claude', 'codex', 'cursor', 'gemini']) lines.push(...installClient(c, o));
    for (const c of ['claude', 'codex']) installClient(c, o); // idempotent
    assert.ok(lines.some(l => l.includes('~/.claude/settings.json')) && lines.some(l => l.includes('~/.claude.json')), lines.join('\n'));

    const claude = JSON.parse(fs.readFileSync(path.join(home.HOME, '.claude', 'settings.json'), 'utf8'));
    assert.equal(claude.model, 'opus', 'what else is in the file stays');
    assert.equal(claude.hooks.UserPromptSubmit[0].hooks[0].command, `node "${CLI}" hook prompt --client claude --user`);
    assert.equal(claude.hooks.Stop.length, 2); assert.equal(claude.hooks.SessionEnd.length, 1);
    const cj = JSON.parse(fs.readFileSync(path.join(home.HOME, '.claude.json'), 'utf8'));
    assert.equal(cj.numStartups, 3);
    assert.deepEqual(cj.mcpServers.thinker, entry); assert.equal(cj.mcpServers.other.command, 'x');

    const codex = JSON.parse(fs.readFileSync(path.join(home.CODEX_HOME, 'hooks.json'), 'utf8')).hooks;
    assert.equal(codex.UserPromptSubmit[0].hooks[0].command, `node "${CLI}" hook prompt --client codex --user --record`);
    const toml = fs.readFileSync(path.join(home.CODEX_HOME, 'config.toml'), 'utf8');
    assert.ok(toml.startsWith('model = "gpt-5"'));
    assert.equal(toml.match(/\[mcp_servers\.thinker\]/g).length, 1);
    assert.ok(!toml.includes('THINKER_REPO') && !toml.includes('[mcp_servers.thinker.env]'), 'no pinned repository');
    // Codex reviews the user's hooks too: their hashes, keyed by the user's hooks.json
    assert.deepEqual(trustCodexUser().length, 1);
    const trusted = fs.readFileSync(path.join(home.CODEX_HOME, 'config.toml'), 'utf8');
    const hf = fs.realpathSync(path.join(home.CODEX_HOME, 'hooks.json'));
    assert.ok(trusted.includes(`[hooks.state.${JSON.stringify(hf + ':user_prompt_submit:0:0')}]\ntrusted_hash = "${codexHookHash('user_prompt_submit', codex.UserPromptSubmit[0].hooks[0])}"`));
    assert.ok(trusted.includes(':post_tool_use:0:0"]') && trusted.includes(':stop:0:0"]') && !trusted.includes('[projects.'));

    const gem = JSON.parse(fs.readFileSync(path.join(home.HOME, '.gemini', 'settings.json'), 'utf8'));
    assert.ok(gem.hooks.BeforeAgent[0].hooks[0].command.endsWith('--client gemini --user --record') && gem.mcpServers.thinker);
    const cur = JSON.parse(fs.readFileSync(path.join(home.HOME, '.cursor', 'hooks.json'), 'utf8'));
    assert.ok(cur.hooks.beforeSubmitPrompt[0].command.endsWith('--client cursor --user --record'));
    assert.ok(JSON.parse(fs.readFileSync(path.join(home.HOME, '.cursor', 'mcp.json'), 'utf8')).mcpServers.thinker);
    assert.ok(!fs.existsSync(path.join(home.HOME, '.cursor', 'rules')), 'the Cursor rule is a checkout file');

    // what the files say, and the rewrite for a new version: nothing to change
    assert.deepEqual(inferWiring(null, 'claude', { scope: 'user' }), { hooks: true, learn: true, late: true, shared: false, mcp: true, scripts: [CLI, MCP], hookScripts: [CLI], custom: [] });
    assert.deepEqual(refreshWiring(null, { scope: 'user', cli: CLI, mcpEntry: entry }).changed, []);
    const old = JSON.parse(fs.readFileSync(path.join(home.HOME, '.claude', 'settings.json'), 'utf8')); delete old.hooks.SessionEnd;
    fs.writeFileSync(path.join(home.HOME, '.claude', 'settings.json'), JSON.stringify(old));
    assert.deepEqual(refreshWiring(null, { scope: 'user', cli: CLI, mcpEntry: entry }).changed, ['~/.claude/settings.json']);
    // and the command, which does the user's files first
    const outp = execFileSync('node', [CLI, 'rewire', '--here', '--dry', '--repo', os.tmpdir()], { encoding: 'utf8', env: { ...process.env, ...home, THINKER_LOG: 'off', THINKER_TELEMETRY: 'off' } });
    assert.match(outp, /the wiring is current/);

    uninstallWiring({ scope: 'user' });
    const left = JSON.parse(fs.readFileSync(path.join(home.HOME, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(left, { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home.HOME, '.claude.json'), 'utf8')).mcpServers, { other: { command: 'x' } });
    assert.ok(!fs.existsSync(path.join(home.CODEX_HOME, 'hooks.json')));
    const t2 = fs.readFileSync(path.join(home.CODEX_HOME, 'config.toml'), 'utf8');
    assert.equal(t2.trim(), 'model = "gpt-5"');
    assert.ok(!fs.existsSync(path.join(home.HOME, '.gemini', 'settings.json')) && !fs.existsSync(path.join(home.HOME, '.cursor', 'mcp.json')));
  });
});

test('a hook at user scope takes the checkout from the agent\'s input: notes where it is set up, nothing elsewhere, and the checkout\'s own hooks of this copy are moved out of its way', () => {
  const home = fakeHome();
  const env = { ...process.env, ...home, THINKER_HOOKS: 'on', THINKER_NO_BG_VERIFY: '1', THINKER_LOG: 'local', THINKER_TELEMETRY: 'off' };
  const userHook = (what, ev) => execFileSync('node', [CLI, 'hook', what, '--client', 'claude', '--user'], { input: JSON.stringify(ev), encoding: 'utf8', env, cwd: os.tmpdir() }).trim();
  const dir = repo();
  inHome(home, () => installClient('claude', { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: ['/x/mcp.js'] }, hooks: true, learn: false, late: true, mcp: true }));
  // a checkout that is set up: the bundle, from the checkout the input names, not the hook's working directory
  assert.match(userHook('prompt', { session_id: 's1', prompt: PROMPT, cwd: dir }), /<thinker-cache>[\s\S]*upload rate limiting/);
  // one that is not: nothing, and nothing created there
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-nocache-')); execFileSync('git', ['init', '-q'], { cwd: other });
  assert.equal(userHook('prompt', { session_id: 's2', prompt: PROMPT, cwd: other }), '');
  assert.ok(!fs.existsSync(path.join(other, '.thinker')));
  // Cursor names its workspace differently; its prompt-time bundle is parked in the checkout it names
  execFileSync('node', [CLI, 'hook', 'prompt', '--client', 'cursor', '--user'], { input: JSON.stringify({ conversation_id: 's3', prompt: PROMPT, workspace_roots: [dir] }), encoding: 'utf8', env, cwd: os.tmpdir() });
  assert.ok(fs.existsSync(path.join(dir, '.thinker', 'state', 'pending-s3.json')));

  // the checkout's own files run this copy's hooks (set up before the wiring went machine-wide): the
  // machine-local ones go, and the user is told once
  installClient('claude', opts(dir));
  assert.ok(fs.existsSync(path.join(dir, '.claude/settings.local.json')));
  userHook('prompt', { session_id: 's4', prompt: PROMPT, cwd: dir });
  assert.ok(!fs.existsSync(path.join(dir, '.claude/settings.local.json')), 'this copy\'s local hooks are taken out of the checkout');
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers.thinker, 'a committable file is left to the team');
  const stop = JSON.parse(userHook('stop', { session_id: 's4', transcript_path: '/nonexistent', cwd: dir }));
  assert.match(stop.systemMessage, /Thinker setup updated/);
  // committed hooks (--shared) stay, and the hook at user scope yields to them
  installClient('claude', { ...opts(dir), shared: true });
  assert.equal(userHook('prompt', { session_id: 's5', prompt: PROMPT, cwd: dir }), '');
  assert.ok(fs.existsSync(path.join(dir, '.claude/settings.json')));
  // so does it to a checkout wired to another copy of thinker (a benchmark arm's), whose hooks fire by themselves
  fs.rmSync(path.join(dir, '.claude'), { recursive: true });
  wire(dir, otherInstall('0.0.1'), '.claude/settings.local.json');
  assert.equal(userHook('prompt', { session_id: 's6', prompt: PROMPT, cwd: dir }), '');
  assert.ok(fs.existsSync(path.join(dir, '.claude/settings.local.json')), 'another copy\'s wiring is not this hook\'s to remove');
  fs.rmSync(path.join(dir, '.claude'), { recursive: true });
  // and THINKER_HOOKS=off silences it, for an arm that must see no notes
  assert.equal(execFileSync('node', [CLI, 'hook', 'prompt', '--client', 'claude', '--user'], { input: JSON.stringify({ session_id: 's7', prompt: PROMPT, cwd: dir }), encoding: 'utf8', env: { ...env, THINKER_HOOKS: 'off' }, cwd: os.tmpdir() }).trim(), '');
  assert.match(userHook('prompt', { session_id: 's8', prompt: PROMPT, cwd: dir }), /<thinker-cache>/);
  const log = fs.readFileSync(path.join(dir, '.thinker/log.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(log.some(l => l.op === 'prune' && l.removed[0].what === 'repo-scope'));
});

test('an update wires the user\'s settings from the checkouts: the agents they wire to this copy, with their options, once', () => {
  const home = fakeHome();
  inHome(home, () => {
    const a = repo(), b = repo();
    installClient('claude', { ...opts(a), learn: true, late: false, mcp: false });
    installClient('claude', { ...opts(b), learn: false, late: true, mcp: true });
    installClient('codex', { ...opts(b), learn: true });
    // a checkout wired to another copy is not this copy's to speak for
    const c = repo(); installClient('gemini', { ...opts(c), cli: otherInstall('0.0.1') + '/src/cli.js' });
    const entry = { command: 'node', args: [path.join(path.dirname(CLI), 'mcp.js')] };
    const dry = connectFromCheckouts([a, b, c], { cli: CLI, mcpEntry: entry, dry: true });
    assert.deepEqual(dry.map(d => [d.client, d.from, d.options]), [['claude', 2, { hooks: true, learn: true, late: true, mcp: true }], ['codex', 1, { hooks: true, learn: true, late: true, mcp: true }]]);
    assert.ok(!fs.existsSync(path.join(home.HOME, '.claude', 'settings.json')), 'a dry run writes nothing');
    const done = connectFromCheckouts([a, b, c], { cli: CLI, mcpEntry: entry });
    assert.deepEqual(done.map(d => d.client), ['claude', 'codex']);
    const claude = JSON.parse(fs.readFileSync(path.join(home.HOME, '.claude', 'settings.json'), 'utf8')).hooks;
    assert.ok(claude.UserPromptSubmit[0].hooks[0].command.endsWith('--client claude --user') && claude.Stop && claude.PostToolUse);
    assert.ok(JSON.parse(fs.readFileSync(path.join(home.HOME, '.claude.json'), 'utf8')).mcpServers.thinker);
    assert.ok(fs.readFileSync(path.join(home.CODEX_HOME, 'config.toml'), 'utf8').includes('[hooks.state.'), 'Codex\'s user hooks are marked reviewed');
    assert.ok(!fs.existsSync(path.join(home.HOME, '.gemini', 'settings.json')));
    // and once: what is wired stays as it is
    assert.deepEqual(connectFromCheckouts([a, b, c], { cli: CLI, mcpEntry: entry }), []);
    // the checkouts keep their hooks until their next prompt moves them out (see the hook test above)
    assert.ok(fs.existsSync(path.join(a, '.claude/settings.local.json')));
  });
});

test('a worktree installs the same git hooks as its main checkout: the shared file is not rewritten by each in turn', () => {
  const dir = repo();
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir });
  const wt = path.join(dir, '.worktrees', 'one');
  execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: dir });
  assert.equal(mainCheckout(wt), dir); assert.equal(mainCheckout(dir), dir);
  installGitHooks(dir, CLI, true);
  const hook = path.join(dir, '.git', 'hooks', 'post-commit');
  const text = fs.readFileSync(hook, 'utf8');
  assert.ok(text.includes(`repo='${dir}'`));
  const mtime = fs.statSync(hook).mtimeMs;
  const lines = []; installGitHooks(wt, CLI, true, l => lines.push(l));
  assert.equal(fs.readFileSync(hook, 'utf8'), text);
  assert.equal(fs.statSync(hook).mtimeMs, mtime, 'the shared hook is left as it is');
  assert.ok(lines.every(l => /already in place/.test(l)), lines.join('\n'));
  assert.deepEqual(refreshWiring(wt, { cli: CLI, mcpEntry: { command: 'node', args: ['/x/mcp.js'] } }).changed, []);
});

test('the home directory is not a checkout: .thinker/ there is thinker\'s own home, and a hook at user scope serves nothing outside a git checkout', () => {
  const home = fakeHome();
  // a .thinker/ with notes, as THINKER_HOME would have, but no .git
  fs.mkdirSync(path.join(home.HOME, '.thinker', 'notes'), { recursive: true });
  const dir = repo();
  const store = new Store(dir);
  // the log names the home directory, as a command run there does
  fs.mkdirSync(path.join(dir, '.thinker'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.thinker', 'log.jsonl'), JSON.stringify({ t: new Date().toISOString(), repo: home.HOME, op: 'rewire' }) + '\n');
  const known = inHome({ ...home, THINKER_LOG: 'local' }, () => knownRepos(store, dir));
  assert.ok(!known.includes(fs.realpathSync(home.HOME)), known.join(', '));
  const env = { ...process.env, ...home, THINKER_HOOKS: 'on', THINKER_TELEMETRY: 'off', THINKER_LOG: 'off' };
  const outp = execFileSync('node', [CLI, 'hook', 'prompt', '--client', 'claude', '--user'], { input: JSON.stringify({ session_id: 'h1', prompt: PROMPT, cwd: home.HOME }), encoding: 'utf8', env, cwd: home.HOME }).trim();
  assert.equal(outp, '');
});


test('all command adapters keep stop hooks with learning disabled across refresh', () => {
  const stops = { claude: ['.claude/settings.local.json', 'Stop'], codex: ['.codex/hooks.json', 'Stop'], gemini: ['.gemini/settings.json', 'AfterAgent'], cursor: ['.cursor/hooks.json', 'stop'], windsurf: ['.windsurf/hooks.json', 'post_cascade_response'], copilot: ['.github/hooks/thinker.json', 'agentStop'] };
  const dir = repo();
  for (const client of Object.keys(stops)) {
    installClient(client, opts(dir));
    assert.equal(inferWiring(dir, client).learn, false, client);
  }
  refreshWiring(dir, { cli: CLI, mcpEntry: opts(dir).mcpEntry });
  for (const [client, [file, event]] of Object.entries(stops)) {
    const entry = read(dir, file).hooks[event][0];
    assert.match((entry.hooks?.[0] || entry).command, / --no-distill$/, client);
    assert.equal(inferWiring(dir, client).learn, false, client);
    assert.deepEqual(inferWiring(dir, client).custom, [], client);
    if (client === 'windsurf') assert.equal(entry.show_output, true);
  }
});

test('stop output follows native notice contracts and never requests continuation', () => {
  for (const client of ['claude', 'codex', 'gemini']) assert.deepEqual(JSON.parse(stopOutput(client, 'cache hit')), { systemMessage: 'cache hit' });
  for (const client of ['pi', 'opencode', 'windsurf']) assert.equal(stopOutput(client, 'cache hit'), 'cache hit');
  for (const client of ['cursor', 'copilot']) assert.equal(stopOutput(client, 'cache hit'), '');
  for (const client of parseClients('all')) assert.equal(stopOutput(client, ''), '');
});


test('CLI retrieval attributed to a Windsurf trajectory produces one visible stop notice', () => {
  const dir = repo();
  for (const command of ['orient', 'lookup']) {
    execFileSync('node', [CLI, command, PROMPT, '--repo', dir, '--session', 'wind-hit'], { env: { ...process.env, THINKER_NO_BG_VERIFY: '1' } });
    const event = { trajectory_id: 'wind-hit', agent_action_name: 'post_cascade_response', tool_info: { response: 'done' } };
    assert.match(hook(dir, 'stop', 'windsurf', event, ['--no-distill']), /1 note this turn/);
    assert.equal(hook(dir, 'stop', 'windsurf', event, ['--no-distill']), '');
  }
});

test('a Codex MCP table whose thinker markers Codex dropped still counts as wired, and a rewire leaves it alone', () => {
  const dir = repo();
  installClient('codex', opts(dir));
  const file = path.join(dir, '.codex/config.toml');
  // Codex rewrites config.toml when it records trusted hooks, and comments do not survive
  const bare = fs.readFileSync(file, 'utf8').split('\n').filter(l => !l.startsWith('# thinker:')).join('\n') + '\n[features]\nhooks = true\n';
  fs.writeFileSync(file, bare);
  const w = inferWiring(dir, 'codex');
  assert.equal(w.mcp, true);
  assert.ok(w.scripts.includes('/x/mcp.js'));
  installClient('codex', opts(dir));
  const toml = fs.readFileSync(file, 'utf8');
  assert.equal(toml.match(/\[mcp_servers\.thinker\]/g).length, 1, 'not added a second time');
  assert.ok(toml.includes('[features]'));
});
