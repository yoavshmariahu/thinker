// OpenCode 2: the plugin becomes a directory (index.ts server part, tui.tsx terminal part) and the
// hook API changes shape. The v1 file is kept for an opencode 1 binary. These tests hold the wiring:
// what installClient writes, that inferWiring and uninstall agree with it, that the server part calls
// the CLI hooks the way the v1 one did, and that the terminal part says the ledger's words. The live
// behaviour of opencode 2.2.7 the shapes rest on was checked against a real binary (2026-11-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';

process.env.THINKER_HOLDOUT = '0';
process.env.THINKER_CE = 'off';

const { installClient, inferWiring, uninstallWiring } = await import('../src/clients.js');
const { opencodeV2, SYNTHETIC_NOTE } = await import('../src/integrations/opencode-v2.js');
const { thinkerTui, readFooterLine, LEDGER_POLL_MS } = await import('../src/integrations/opencode-tui.js');
const { savingsStatus } = await import('../src/savings-ledger.js');
const { writeNoticeLast, noticeLastFile } = await import('../src/notice-cadence.js');

const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.js');
const ENTRY = { command: 'node', args: ['/x/mcp.js'], env: {} };
const at = (home, ...p) => path.join(home.HOME, ...p);
const fakeHome = () => ({ HOME: fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-oc2-'))), XDG_CONFIG_HOME: '', COPILOT_HOME: '', PI_CODING_AGENT_DIR: '' });
const inHome = (home, fn) => {
  const keep = ['HOME', 'XDG_CONFIG_HOME', 'COPILOT_HOME', 'PI_CODING_AGENT_DIR', 'THINKER_OPENCODE_MAJOR'].map(k => [k, process.env[k]]);
  for (const [k, v] of Object.entries(home)) if (v !== undefined) process.env[k] = v;
  try { return fn(); } finally { for (const [k, v] of keep) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const userOpts = { scope: 'user', cli: CLI, mcpEntry: ENTRY, hooks: true, learn: true, late: true, shared: false, mcp: true };

test('OpenCode 2 gets a plugin directory, and a generated v1 file beside it goes', () => {
  const home = fakeHome();
  inHome(home, () => {
    process.env.THINKER_OPENCODE_MAJOR = '1';
    installClient('opencode', userOpts);
    const v1 = at(home, '.config', 'opencode', 'plugins', 'thinker.js');
    assert.ok(fs.existsSync(v1), 'v1 single file on an opencode 1 binary');
    process.env.THINKER_OPENCODE_MAJOR = '2';
    installClient('opencode', userOpts);
    const dir = at(home, '.config', 'opencode', 'plugins', 'thinker');
    assert.ok(!fs.existsSync(v1), 'the superseded v1 file of the same copy goes');
    const index = fs.readFileSync(path.join(dir, 'index.ts'), 'utf8');
    const tui = fs.readFileSync(path.join(dir, 'tui.tsx'), 'utf8');
    assert.match(index, /from "@opencode\/plugin"/);
    assert.match(index, /opencode-v2\.js/);
    assert.match(tui, /from "@opencode\/plugin\/tui"/);
    assert.match(tui, /opencode-tui\.js/);
    const tuiModule = fs.readFileSync(CLI.replace(/cli\.js$/, 'integrations/opencode-tui.js'), 'utf8');
    assert.match(tuiModule, /prompt\.footer\.status/, 'the terminal part rides the built-in footer row (the one slot both screens draw)');
    const config = JSON.parse(index.split('\n')[0].replace('// thinker integration: ', ''));
    assert.equal(config.client, 'opencode');
    assert.equal(config.repo, null, 'no checkout pinned: the session\'s directory at run time');
    // a second install with the same bytes writes nothing (the watcher must not reload the plugin)
    const stamp = fs.statSync(path.join(dir, 'index.ts')).mtimeMs;
    installClient('opencode', userOpts);
    assert.equal(fs.statSync(path.join(dir, 'index.ts')).mtimeMs, stamp, 'same bytes, nothing written');
  });
});

test('inferWiring reads the directory, and uninstall takes it out', () => {
  const home = fakeHome();
  inHome(home, () => {
    process.env.THINKER_OPENCODE_MAJOR = '2';
    assert.equal(inferWiring(null, 'opencode', { scope: 'user' }), null, 'not installed: not wired');
    installClient('opencode', userOpts);
    const w = inferWiring(null, 'opencode', { scope: 'user' });
    assert.ok(w.hooks && w.learn && w.mcp, 'read from the generated first line');
    assert.deepEqual(w.custom, [], 'not modified');
    const dir = at(home, '.config', 'opencode', 'plugins', 'thinker');
    fs.appendFileSync(path.join(dir, 'index.ts'), '\n// hand edit\n');
    const edited = inferWiring(null, 'opencode', { scope: 'user' });
    assert.deepEqual(edited.custom, ['modified thinker extension'], 'a hand edit is named, never overwritten silently');
    uninstallWiring({ scope: 'user' });
    assert.ok(!fs.existsSync(dir), 'the directory goes with the wiring');
  });
});

test('a checkout wired at repo scope gets the directory, and uninstallWiring repo removes it', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-oc2-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  new Store(dir).init();
  inHome(fakeHome(), () => {
    process.env.THINKER_OPENCODE_MAJOR = '2';
    installClient('opencode', { scope: 'repo', repo: dir, cli: CLI, mcpEntry: ENTRY, hooks: true, learn: false, late: true, shared: false, mcp: true });
    const plugin = path.join(dir, '.opencode', 'plugins', 'thinker');
    assert.ok(fs.existsSync(path.join(plugin, 'index.ts')) && fs.existsSync(path.join(plugin, 'tui.tsx')));
    const w = inferWiring(dir, 'opencode');
    assert.ok(w && w.hooks, 'read back at repo scope');
    uninstallWiring({ scope: 'repo', repo: dir });
    assert.ok(!fs.existsSync(plugin));
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the v2 server part calls the CLI hooks the way the v1 plugin did', async () => {
  const runs = [];
  const run = async (what, ev) => { runs.push([what, ev]); if (what === 'pretool') return ev.tool_name === 'read' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'REPORT' } }) : ''; return what === 'prompt' ? 'SERVED' : 'NOTED'; };
  const hooks = {};
  const synthetic = [];
  let refuse = false;
  const pending = [];
  let resolveNext = null;
  const push = ev => { if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: ev, done: false }); } else pending.push(ev); };
  const ctx = {
    location: { directory: '/tmp/session-cwd' },
    mcp: { transform: async fn => { const set = []; await fn({ set: (n, c) => set.push([n, c]) }); hooks.mcp = set; } },
    session: {
      hook: async (name, fn) => { hooks[name] = fn; },
      synthetic: async a => { synthetic.push(a); if (refuse) throw new Error('Session.SyntheticConflictError'); return { id: 'msg1' }; },
    },
    tool: { hook: async (name, fn) => { hooks[`tool:${name}`] = fn; } },
    event: { subscribe: ({ signal }) => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
          return new Promise(resolve => {
            resolveNext = resolve;
            if (signal) signal.addEventListener('abort', () => resolve({ done: true }), { once: true });
          });
        },
      }),
    }) },
  };
  const plugin = opencodeV2({ client: 'opencode', repo: null, cli: CLI, hooks: true, learn: true, late: true, mcp: true, mcpEntry: ENTRY }, run);
  assert.equal(plugin.id, 'thinker');
  // the delegation hook registers only while the trigger is on (off by default)
  const wasOn = process.env.THINKER_DELEGATE; process.env.THINKER_DELEGATE = 'on';
  const cleanup = await plugin.setup(ctx);
  if (wasOn === undefined) delete process.env.THINKER_DELEGATE; else process.env.THINKER_DELEGATE = wasOn;
  assert.deepEqual(hooks.mcp, [['thinker', { type: 'local', command: ENTRY.command ? [ENTRY.command, ...ENTRY.args] : ENTRY.args, environment: ENTRY.env || {}, enabled: true }]]);
  // the prompt hook: what the CLI serves goes as a synthetic message (the model reads it, the screens draw
  // the description alone), and the person's own prompt is left exactly as they typed it. Checked live on
  // 2.2.7: `ctx.session.synthetic` from inside the hook reaches the same execution -- the model quoted the
  // block's first line in its answer -- and the next turn of that session sees one block, not two.
  const ev = { sessionID: 'ses1', prompt: { text: 'hello' } };
  await hooks.prompt(ev);
  assert.equal(ev.prompt.text, 'hello', 'the draft is the person\'s, untouched');
  assert.deepEqual(synthetic, [{ sessionID: 'ses1', text: 'SERVED', description: SYNTHETIC_NOTE, resume: false }]);
  assert.deepEqual(runs[0], ['prompt', { session_id: 'ses1', cwd: '/tmp/session-cwd', prompt: 'hello' }]);
  // a host that refuses the message still gets the bundle: served in sight beats not served
  refuse = true;
  const refused = { sessionID: 'ses1', prompt: { text: 'hello' } };
  await hooks.prompt(refused);
  assert.match(refused.prompt.text, /hello\n\nSERVED$/);
  refuse = false;
  // the before hook (delegate.js): a denied read throws the report, which v2 makes the call's result; a call
  // that goes through gets silence; a tool that is neither a read nor a shell line never reaches the CLI
  const before = hooks['tool:execute.before'];
  await assert.rejects(before({ tool: 'read', sessionID: 'ses1', agent: 'build', input: { path: '/r/core.py' } }), /REPORT/);
  assert.deepEqual(runs.at(-1), ['pretool', { session_id: 'ses1', cwd: '/tmp/session-cwd', tool_name: 'read', tool_input: { path: '/r/core.py' }, agent: 'build' }]);
  const shell = { tool: 'shell', sessionID: 'ses1', agent: 'build', input: { command: 'ls' } };
  assert.equal(await before(shell), undefined); assert.deepEqual(shell.input, { command: 'ls' }, 'the args are left as they came');
  const n = runs.length;
  assert.equal(await before({ tool: 'glob', sessionID: 'ses1', input: { pattern: '*' } }), undefined);
  assert.equal(runs.length, n, 'glob makes no call');
  // the tool hook: the note rides the result's content, completed results only
  const tool = { status: 'completed', tool: 'shell', sessionID: 'ses1', input: { command: 'ls' }, result: { content: [{ type: 'text', text: 'out' }], output: { output: 'out' } } };
  hooks['tool:execute.after'](tool);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(runs.at(-1), ['tool', { session_id: 'ses1', cwd: '/tmp/session-cwd', tool_name: 'shell', tool_input: { command: 'ls' }, tool_response: 'out' }]);
  assert.deepEqual(tool.result.content[1], { type: 'text', text: 'NOTED' });
  const failed = { status: 'failed', tool: 'shell', sessionID: 'ses1', result: { content: [] } };
  const before_failed = runs.length;
  hooks['tool:execute.after'](failed);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(runs.length, before_failed, 'a failed tool makes no call');
  // the turn's end: stop runs with the session id v2 carries in data
  push({ type: 'session.execution.succeeded', data: { sessionID: 'ses1' } });
  await new Promise(r => setTimeout(r, 20));
  const stop = runs.find(([what]) => what === 'stop');
  assert.deepEqual(stop, ['stop', { session_id: 'ses1', cwd: '/tmp/session-cwd' }]);
  await cleanup();
});

test('the terminal part says the ledger\'s own words, and polls on the mod\'s cadence', () => {
  assert.equal(LEDGER_POLL_MS, 5_000, 'the Claude mod polls the ledger every 5 s; this door does too');
  const ledger = { day: '2026-11-10', version: '0.3.1', today: { cost: 1.14 }, lifetime: { cost: 838.7, tokens: 1_000_000 } };
  const file = path.join(os.tmpdir(), `thinker-oc2-${Date.now()}`, 'savings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger));
  assert.equal(readFooterLine(file), savingsStatus(ledger), 'one voice: the same function the Claude status row reads');
  assert.equal(readFooterLine(path.join(os.tmpdir(), 'thinker-oc2-missing', 'savings.json')), '', 'no ledger: no line');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('the terminal part renders the footer into the built-in row and toasts a fresh notice once', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-oc2-')));
  const ledger = path.join(home, 'state', 'savings.json');
  const notice = path.join(home, 'state', 'notice-last.json');
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  const ledgerBody = { day: '2026-11-10', version: '0.3.1', today: { cost: 1.14 }, lifetime: { cost: 838.7, tokens: 1_000_000 } };
  fs.writeFileSync(ledger, JSON.stringify(ledgerBody));
  let slot = null, toasts = [];
  const subscriptions = {};
  const context = {
    theme: { text: { muted: '#808080' } },
    storage: { memory: (key, { initial }) => { const store = { ...initial }; const subs = new Set(); const bump = () => subs.forEach(fn => fn()); return [{ get line() { return store.line; }, _subs: subs, _bump: bump }, (fn) => { fn(store); bump(); }]; } },
    ui: {
      slot: opts => { slot = opts; return () => { slot = null; }; },
      toast: { show: t => toasts.push(t) },
    },
    data: { on: (name, fn) => { (subscriptions[name] ||= []).push(fn); return () => { subscriptions[name] = subscriptions[name].filter(f => f !== fn); }; } },
  };
  const plugin = thinkerTui({ client: 'opencode' }, {
    text: (line, theme) => ({ text: line, fg: theme.text.muted }),
  }, { ledgerPath: ledger, noticePath: notice, toastDelaysMs: [50, 200], pollMs: 10_000 });
  const cleanup = plugin.setup(context);
  assert.ok(slot, 'the footer is registered');
  assert.deepEqual(slot.append, 'prompt.footer.status');
  assert.deepEqual(slot.render(), { text: savingsStatus(ledgerBody), fg: '#808080' });
  // a fresh notice is toasted once, on the second check if the first is too early
  writeNoticeLastText(notice, { text: 'a summary', at: 1_000 });
  fire(subscriptions, 'session.execution.succeeded');
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(toasts, [], 'too early: the Stop hook has not answered yet');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(toasts.length, 1);
  assert.deepEqual(toasts[0], { title: 'thinker', message: 'a summary', variant: 'info' });
  fire(subscriptions, 'session.execution.succeeded');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(toasts.length, 1, 'the same notice is never said twice');
  // an older notice than the one shown is not toasted again
  writeNoticeLastText(notice, { text: 'an older summary', at: 500 });
  fire(subscriptions, 'session.execution.succeeded');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(toasts.length, 1);
  await cleanup();
  assert.equal(slot, null, 'the slot goes with the plugin');
  fs.rmSync(home, { recursive: true, force: true });
});
const writeNoticeLastText = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(body)); };
const fire = (subscriptions, name) => (subscriptions[name] || []).forEach(fn => fn());

test('the Stop hook writes the notice it delivered for the doors with no message of their own', () => {
  const store = new Store(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-oc2-')))).init();
  writeNoticeLast(store, 'a summary', { now: 1_000 });
  const file = noticeLastFile(store);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { text: 'a summary', at: 1_000 });
  writeNoticeLast(store, '', { now: 2_000 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { text: 'a summary', at: 1_000 }, 'nothing said: nothing written');
  fs.rmSync(store.dir, { recursive: true, force: true });
});
