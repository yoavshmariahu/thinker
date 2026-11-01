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
import { subagentPrompt, viaSession, queueDir, nextRequest, releaseStaleClaims, CLAIM_STALE_MS } from '../src/session-llm.js';
import { DEVIN_COMPACT_KEY, DEVIN_COMPACT_AT, devinCompactAt, setDevinCompaction, compactionsOf, callSavings, contextNodes, recordDevinCompactions } from '../src/devin-compaction.js';
import { readCompression } from '../src/compression.js';
import { execFileSync as execFile } from 'node:child_process';

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
    const skillHook = { matcher: '.*', hooks: [{ type: 'command', command: "'/usr/bin/node' '/home/me/.config/devin/skills/thinker-context/scripts/context.mjs' hook", timeout: 5 }] };
    const original = { agent: { model: 'sonnet' }, proxy: { mode: 'manual', url: 'http://company.invalid:8080' }, permissions: { deny: ['Write(secret)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PostToolUse: [skillHook] } };
    write(f.hooks, original); write(f.mcp, { mcpServers: { other: { command: 'other' } } });
    assert.ok(detectClients({ fallback: false }).includes('devin'));
    installClient('devin', opts);
    const cfg = json(f.hooks);
    assert.deepEqual(cfg.proxy, original.proxy);
    // Devin denies a background subagent every tool not approved already: the worker needs learn_next allowed
    assert.deepEqual(cfg.permissions, { deny: ['Write(secret)'], allow: ['mcp__thinker__learn_next'] });
    assert.equal(cfg.hooks.Stop.length, 2);
    assert.equal(cfg.hooks.PreToolUse, undefined);
    // the context skill's own hook has 'thinker' in its path and is not connect's to remove
    assert.deepEqual(cfg.hooks.PostToolUse[0], skillHook);
    assert.equal(cfg.hooks.PostToolUse.length, 2);
    assert.equal(cfg.hooks.PostToolUse[1].matcher, '.*');
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
  hook('stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Checked the upload rate limiter.' }, ['--record']);
  assert.deepEqual(pendingJobs(store), []);
  assert.ok(fs.readFileSync(trace, 'utf8').includes('Checked the upload rate limiter.'));
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
  assert.match(instruction, /mcp_call_tool with server_name/);
  assert.match(instruction, /not a shell command/);
  assert.equal(options.env.THINKER_LLM, 'session');
  assert.equal(options.env.THINKER_TEST, '1');
});

test('a Devin session keeps its own record when its background learning worker runs under the same session id', t => {
  const { store, hook, repo } = fixture(t);
  const base = { session_id: 'd-parent', hook_event_name: 'PostToolUse' };
  hook('prompt', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'document the upload rate limit' }, ['--record']);
  hook('tool', { ...base, tool_name: 'read', tool_input: { file_path: 'src/upload.py' }, tool_response: { success: true, output: 'class RateLimiter', error: null } }, ['--record']);
  // the parent launches the worker: Devin reports the subagent's calls with the parent's session id
  hook('tool', { ...base, tool_name: 'run_subagent', tool_input: { title: 'Thinker learning', task: subagentPrompt(repo, { harness: 'devin' }) }, tool_response: { success: true, output: 'Background subagent started', error: null } }, ['--record']);
  hook('tool', { ...base, tool_name: 'mcp_call_tool', tool_input: { server_name: 'thinker', tool_name: 'learn_next', arguments: {} }, tool_response: { success: true, output: 'nothing has come yet', error: null } }, ['--record']);
  hook('tool', { ...base, tool_name: 'edit', tool_input: { file_path: 'src/upload.py' }, tool_response: { success: true, output: 'edited', error: null } }, ['--record']);
  hook('stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Documented it.' }, ['--record']);
  const events = fs.readFileSync(path.join(store.dir, 'state', 'trace-d-parent.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(e => e.t === 'tool' ? e.name : e.t), ['prompt', 'Read', 'Edit', 'say'], 'the worker\'s launch and calls are left out; nothing else is');
});

test('the worker instruction is given again while a live runner has a request nobody took', t => {
  const { store } = fixture(t);
  enqueueJob(store, 'verify', ['verify']);
  const start = () => startSessionWork(store, { cli: CLI, harness: 'devin', spawnFn: () => ({ pid: process.pid, unref() {} }) });
  assert.match(start(), /<thinker-learning>/);
  assert.equal(start(), '', 'the runner is alive and has written nothing yet');
  const req = path.join(queueDir(store), 'x.req.json');
  fs.writeFileSync(req, '{}');
  assert.equal(start(), '', 'a request just written may still be taken by the subagent already asked for');
  const old = new Date(Date.now() - 5 * 60_000); fs.utimesSync(req, old, old);
  assert.match(start(), /<thinker-learning>/, 'a request untaken for a minute means no subagent is working the queue');
  assert.ok(fs.existsSync(req), 'the waiting request is left for the subagent this prompt starts');
  // a subagent took the request and its session ended: the claim goes stale and counts the same
  fs.renameSync(req, path.join(queueDir(store), 'x.claimed.json'));
  const fresh = new Date(); fs.utimesSync(path.join(queueDir(store), 'x.claimed.json'), fresh, fresh);
  assert.equal(start(), '', 'a fresh claim is being answered');
  const stale = new Date(Date.now() - CLAIM_STALE_MS - 1000); fs.utimesSync(path.join(queueDir(store), 'x.claimed.json'), stale, stale);
  assert.match(start(), /<thinker-learning>/, 'a claim nobody answered for three minutes means the subagent died with its session');
});

test('a claim whose subagent stopped answering is released to the next worker', async t => {
  const { store } = fixture(t);
  const dir = queueDir(store); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(path.join(dir, 'a.claimed.json'), JSON.stringify({ id: 'a', prompt: 'p' }));
  assert.equal(releaseStaleClaims(dir), 0, 'a fresh claim stays with its taker');
  const stale = new Date(Date.now() - CLAIM_STALE_MS - 1000); fs.utimesSync(path.join(dir, 'a.claimed.json'), stale, stale);
  const r = await nextRequest(dir, { waitMs: 50, pollMs: 5 });
  assert.equal(r.request?.id, 'a', 'the next worker takes the released request');
  assert.ok(fs.existsSync(path.join(dir, 'a.claimed.json')) && !fs.existsSync(path.join(dir, 'a.req.json')));
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

test('the compaction threshold is written into Devin\'s config by policy and what was there comes back', t => {
  const { home } = fixture(t);
  const thome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-home-'));
  t.after(() => fs.rmSync(thome, { recursive: true, force: true }));
  atHome(home, () => {
    const f = wiringFiles('devin', { scope: 'user' });
    fs.mkdirSync(path.dirname(f.hooks), { recursive: true });
    fs.writeFileSync(f.hooks, JSON.stringify({ agent: { model: 'swe-2-medium', [DEVIN_COMPACT_KEY]: 90000 } }));
    const merge = (file, fn) => fs.writeFileSync(file, JSON.stringify(fn(json(file))));
    assert.equal(devinCompactAt(thome, {}), DEVIN_COMPACT_AT, 'the default is on (the owner\'s call, 2026-11-01)');
    assert.equal(devinCompactAt(thome, { THINKER_DEVIN_COMPACT_AT: 'off' }), 0);
    assert.equal(devinCompactAt(thome, { THINKER_DEVIN_COMPACT_AT: '0' }), 0);
    assert.equal(setDevinCompaction(f.hooks, { home: thome, at: 0, merge }), null, 'a value thinker did not write is not touched');
    assert.equal(json(f.hooks).agent[DEVIN_COMPACT_KEY], 90000);
    assert.equal(devinCompactAt(thome, { THINKER_DEVIN_COMPACT_AT: '140000' }), 140000);
    fs.mkdirSync(thome, { recursive: true }); fs.writeFileSync(path.join(thome, 'config.json'), JSON.stringify({ devin: { compactAt: 0 } }));
    assert.equal(devinCompactAt(thome, {}), 0, 'compactAt 0 in the machine config is off');
    fs.writeFileSync(path.join(thome, 'config.json'), JSON.stringify({ devin: { compactAt: 120000 } }));
    assert.equal(devinCompactAt(thome, {}), 120000, 'the machine config carries the policy');
    assert.match(setDevinCompaction(f.hooks, { home: thome, merge }), /compacts the conversation at 120000 tokens/);
    assert.equal(json(f.hooks).agent[DEVIN_COMPACT_KEY], 120000);
    assert.equal(json(f.hooks).agent.model, 'swe-2-medium', 'the rest of the agent block stays');
    assert.equal(setDevinCompaction(f.hooks, { home: thome, merge }), null, 'already there: nothing to say');
    // the person changed it by hand since: not thinker's any more
    fs.writeFileSync(f.hooks, JSON.stringify({ agent: { model: 'swe-2-medium', [DEVIN_COMPACT_KEY]: 70000 } }));
    assert.equal(setDevinCompaction(f.hooks, { home: thome, at: 0, merge }), null);
    assert.equal(json(f.hooks).agent[DEVIN_COMPACT_KEY], 70000);
    // thinker's own value, policy taken out: what was there before comes back
    fs.writeFileSync(f.hooks, JSON.stringify({ agent: { model: 'swe-2-medium', [DEVIN_COMPACT_KEY]: 120000 } }));
    assert.match(setDevinCompaction(f.hooks, { home: thome, at: 0, merge }), /back to 90000/);
    assert.equal(json(f.hooks).agent[DEVIN_COMPACT_KEY], 90000);
    // nothing there before: the key goes
    fs.writeFileSync(f.hooks, JSON.stringify({ agent: { model: 'swe-2-medium' } }));
    setDevinCompaction(f.hooks, { home: thome, at: 100000, merge });
    assert.match(setDevinCompaction(f.hooks, { home: thome, at: 0, merge }), /Devin's own default/);
    assert.deepEqual(json(f.hooks).agent, { model: 'swe-2-medium' });
    // through connect, with the environment policy; uninstall restores
    process.env.THINKER_DEVIN_COMPACT_AT = '140000'; process.env.THINKER_HOME = thome;
    try {
      const lines = installClient('devin', opts);
      assert.match(lines.join('\n'), /compacts the conversation at 140000 tokens/);
      assert.equal(json(f.hooks).agent[DEVIN_COMPACT_KEY], 140000);
      delete process.env.THINKER_DEVIN_COMPACT_AT;
      fs.writeFileSync(path.join(thome, 'config.json'), JSON.stringify({ devin: { compactAt: 0 } }));
      uninstallWiring({ scope: 'user' });
      assert.equal(json(f.hooks).agent?.[DEVIN_COMPACT_KEY], undefined);
    } finally { delete process.env.THINKER_DEVIN_COMPACT_AT; delete process.env.THINKER_HOME; }
  });
});

test('what a Devin compaction took out is read from its session database and recorded as a clear', async t => {
  const { store } = fixture(t);
  // the shape Devin stores: the context size at each assistant node, a summary node between (2026-11-01, brawny-cave)
  const nodes = [
    { node: 48, tokens: 14556, summary: false }, { node: 59, tokens: 23394, summary: false }, { node: 65, tokens: 23777, summary: false },
    { node: 70, tokens: null, summary: true }, { node: 85, tokens: 25855, summary: false }, { node: 90, tokens: null, summary: true },
    { node: 102, tokens: 17267, summary: false }, { node: 110, tokens: 18805, summary: false },
  ];
  assert.deepEqual(compactionsOf(nodes), [
    { node: 70, before: 23777, after: 25855, saved: 0 },
    { node: 90, before: 25855, after: 17267, saved: 8588 },
  ]);
  const dir = path.join(store.dir, 'state', 'compression'); fs.mkdirSync(dir, { recursive: true });
  const logged = []; const s = { ...store, log: row => logged.push(row) };
  // every call after the summary leaves those 8,588 tokens out again: the proxy's accounting
  assert.deepEqual(callSavings(nodes), [{ node: 102, saved: 8588, summary: 90 }, { node: 110, saved: 8588, summary: 90 }]);
  const fresh = await recordDevinCompactions(s, { session: 'brawny-cave', dir, nodes });
  assert.deepEqual(fresh.map(c => c.node), [90], 'a summary that saved nothing is not a clear');
  assert.deepEqual(logged.map(r => [r.op, r.client, r.before, r.after, r.saved]), [['compaction', 'devin', 25855, 17267, 8588]]);
  const rec = readCompression(dir, 'brawny-cave');
  assert.equal(rec.saved, 2 * 8588); assert.equal(rec.requests, 2); assert.equal(rec.kind, 'compaction');
  assert.deepEqual(await recordDevinCompactions(s, { session: 'brawny-cave', dir, nodes }), [], 'recorded once');
  assert.equal(logged.length, 1); assert.equal(readCompression(dir, 'brawny-cave').saved, 2 * 8588);
  // a later compaction in the same session: its own row, and the call after it adds its own saving
  const later = [...nodes, { node: 116, tokens: null, summary: true }, { node: 121, tokens: 16000, summary: false }];
  assert.deepEqual((await recordDevinCompactions(s, { session: 'brawny-cave', dir, nodes: later })).map(c => c.saved), [2805]);
  assert.equal(readCompression(dir, 'brawny-cave').saved, 2 * 8588 + 2805);
  assert.equal(readCompression(dir, 'brawny-cave').requests, 3);
  // the database itself, where sqlite3 is on this machine
  let have = false; try { execFile('sqlite3', ['-version'], { stdio: 'ignore' }); have = true; } catch {}
  if (!have) { t.diagnostic('sqlite3 not installed: the database read is not exercised'); return; }
  const db = path.join(store.dir, 'sessions.db');
  const row = (id, role, meta) => `insert into message_nodes values (${id}, 's1', ${id}, null, '${JSON.stringify({ role })}', 0, '${JSON.stringify(meta)}');`;
  execFile('sqlite3', [db, 'create table message_nodes(row_id integer primary key, session_id text, node_id integer, parent_node_id integer, chat_message text, created_at integer, metadata text);'
    + row(1, 'user', { num_tokens_preceding: null }) + row(2, 'assistant', { num_tokens_preceding: 1000, summarized_from: null }) + row(3, 'assistant', { num_tokens_preceding: null, summarized_from: 2 }) + row(4, 'assistant', { num_tokens_preceding: 400, summarized_from: null })]);
  assert.deepEqual(await contextNodes('s1', { db }), [{ node: 2, tokens: 1000, summary: false }, { node: 3, tokens: null, summary: true }, { node: 4, tokens: 400, summary: false }]);
  assert.deepEqual(await contextNodes('nobody', { db }), []);
  assert.deepEqual(await contextNodes('s1', { db: path.join(store.dir, 'missing.db') }), []);
});
