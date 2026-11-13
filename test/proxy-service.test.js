import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'smol-toml';
import { bedrockState } from '../src/proxy-bedrock.js';
import { serviceState, proxyOn, proxyUrl, isOwnUrl, freePort, isListening, serviceArgs, plistText, unitText, claudeBlocker, withProxyUrl, withoutProxyUrl,
  wireAgents, enableProxyService, disableProxyService, ensureProxy, installService, uninstallService, wiredLines, appVersion, removedByHand, standDown, claudeWired, trackClaude, routeAppeared, proxyThrough, claimRestart, SERVICE_HOLDOUT, PROXY_ENV, PROXY_LABEL, replaceReason, bootOutAgent, bootstrapAgent, BOOTOUT_WAIT_MS, agentInstance, restartDue, requestRestart, restartWanted, clearRestartWanted, idleRestartWatcher, recordProxyListening, RESTART_IDLE_MS, RESTART_PATIENCE_MS, RESTART_DEADLINE_MS } from '../src/proxy-service.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
// Every temporary home this file makes is remembered, and whatever proxy its service state still names is stopped when
// the file is done: a test that failed before its own cleanup left a `thinker proxy` listening from a temp directory,
// one per suite run, four of them from release runs on 2026-11-02.
const homes = new Set();
const tmp = prefix => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); homes.add(d); return d; };
after(() => {
  for (const d of homes) for (const home of [d, path.join(d, 'thinker')]) {
    try { const pid = JSON.parse(fs.readFileSync(path.join(home, 'state', 'proxy-service.json'), 'utf8')).pid; if (pid) process.kill(pid, 'SIGTERM'); } catch {}
  }
});
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// every agent's file under one temporary home: Claude Code's settings, pi's models.json, OpenCode's opencode.json
function fakeMachine() {
  const root = tmp('thinker-proxy-service-');
  const home = path.join(root, 'thinker');
  const env = { CODEX_SANDBOX_NETWORK_DISABLED: '0', CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PI_CODING_AGENT_DIR: path.join(root, 'pi'), XDG_CONFIG_HOME: path.join(root, 'config') };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
  const files = { claude: path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), pi: path.join(env.PI_CODING_AGENT_DIR, 'models.json'), opencode: path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json') };
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(root, { recursive: true, force: true }); };
  return { root, home, env, files, restore };
}

test('Bedrock opt-in wires token Messages, survives reconnect, and off restores native settings without storing AWS credentials', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    const original = { permissions: { deny: ['Bash'] }, env: { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'old-model', ANTHROPIC_AUTH_TOKEN: 'old-auth', KEEP: 'me' } };
    fs.writeFileSync(m.files.claude, JSON.stringify(original));
    const tokenFile = path.join(m.root, 'bedrock-token');
    fs.writeFileSync(tokenFile, 'aws-secret-fixture', { mode: 0o600 });
    const env = { ...m.env, CLAUDE_CODE_USE_BEDROCK: '1' };
    const bedrock = { region: 'us-east-1', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', tokenFile };
    const p = await enableProxyService({ cli: CLI, home: m.home, env, manage: false, force: true, bedrock });
    const wired = readJson(m.files.claude);
    assert.equal(wired.env.ANTHROPIC_BASE_URL, p.url + '/bedrock');
    assert.equal(wired.env.CLAUDE_CODE_USE_BEDROCK, '0');
    assert.equal(wired.env.ANTHROPIC_MODEL, bedrock.model);
    assert.equal(wired.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, bedrock.model);
    assert.deepEqual(wired.permissions, original.permissions);
    assert.ok(!JSON.stringify(wired).includes('aws-secret-fixture'));
    assert.ok(!fs.readFileSync(path.join(m.home, 'state/proxy-bedrock.json'), 'utf8').includes('aws-secret-fixture'));
    assert.equal(fs.statSync(path.join(m.home, 'state/proxy-bedrock.json')).mode & 0o777, 0o600);
    assert.ok(serviceArgs(m.home).includes('--bedrock'));
    assert.equal(readJson(m.files.pi).providers.anthropic.baseUrl, p.url, 'other clients retain the ordinary route');
    assert.equal(routeAppeared({ home: m.home, env }), null);
    assert.equal(removedByHand({ home: m.home }), null);
    await enableProxyService({ cli: CLI, home: m.home, env, manage: false });
    assert.equal(readJson(m.files.claude).env.ANTHROPIC_BASE_URL, p.url + '/bedrock');
    const edited = readJson(m.files.claude);
    edited.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'us.anthropic.user-selected-model';
    fs.writeFileSync(m.files.claude, JSON.stringify(edited));
    await enableProxyService({ cli: CLI, home: m.home, env, manage: false });
    assert.equal(readJson(m.files.claude).env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'us.anthropic.user-selected-model');
    disableProxyService({ home: m.home, manage: false });
    assert.deepEqual(readJson(m.files.claude), { ...original, env: { ...original.env, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.user-selected-model' } }, 'off restores what it wrote and preserves later user edits');
    assert.equal(bedrockState(m.home), null);
    assert.equal(fs.readFileSync(tokenFile, 'utf8'), 'aws-secret-fixture', 'the user owns the credential file');
  } finally { m.restore(); }
});

test('leaving Bedrock restores the gateway the proxy previously replaced', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    const original = { env: { ANTHROPIC_BASE_URL: 'https://gateway.example', ANTHROPIC_AUTH_TOKEN: 'gateway-token' } };
    fs.writeFileSync(m.files.claude, JSON.stringify(original));
    await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false, gateway: original.env.ANTHROPIC_BASE_URL });
    const tokenFile = path.join(m.root, 'token');
    fs.writeFileSync(tokenFile, 'bedrock-fixture', { mode: 0o600 });
    await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false, force: true,
      bedrock: { region: 'us-east-1', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', tokenFile } });
    disableProxyService({ home: m.home, manage: false });
    assert.deepEqual(readJson(m.files.claude), original, 'a gateway token must not be sent to Anthropic after off');
    assert.equal(serviceState(m.home).replaced?.claude, undefined);
  } finally { m.restore(); }
});

test('Bedrock opt-in rejects missing credentials and competing routes before any settings change', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    const original = JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } });
    fs.writeFileSync(m.files.claude, original);
    const tokenFile = path.join(m.root, 'token');
    const bedrock = { region: 'us-east-1', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', tokenFile };
    await assert.rejects(enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false, bedrock }), /token file/);
    fs.writeFileSync(tokenFile, 'fixture', { mode: 0o600 });
    fs.chmodSync(tokenFile, 0o644);
    if (process.platform !== 'win32') await assert.rejects(enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false, bedrock }), /private/);
    fs.chmodSync(tokenFile, 0o600);
    await assert.rejects(enableProxyService({ cli: CLI, home: m.home, env: { ...m.env, ANTHROPIC_BASE_URL: 'https://gateway.example' }, manage: false, bedrock }), /custom Claude route/);
    fs.writeFileSync(path.join(m.root, '.zshrc'), 'export CLAUDE_CODE_USE_BEDROCK=1\nexport ANTHROPIC_BEDROCK_BASE_URL=https://custom-bedrock.example\n');
    await assert.rejects(enableProxyService({ cli: CLI, home: m.home, env: { ...m.env, THINKER_ROUTE_HOME: m.root }, manage: false, bedrock }), /cannot override/);
    fs.unlinkSync(path.join(m.root, '.zshrc'));
    fs.writeFileSync(path.join(m.env.CLAUDE_CONFIG_DIR, 'settings.local.json'), original);
    await assert.rejects(enableProxyService({ cli: CLI, home: m.home, env: { ...m.env, THINKER_ROUTE_HOME: m.root }, manage: false, bedrock }), /cannot override/);
    assert.equal(fs.readFileSync(m.files.claude, 'utf8'), original);
    assert.equal(bedrockState(m.home), null);
    assert.equal(serviceState(m.home).enabled, undefined);
  } finally { m.restore(); }
});

test('the state: off until enabled, the port kept, every port the service had is still ours', () => {
  const home = tmp('thinker-proxy-state-');
  try {
    assert.equal(proxyOn(home), false);
    assert.equal(proxyUrl(home), null);
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port: 6901, ports: [6899, 6901] }));
    assert.equal(proxyOn(home), true);
    assert.equal(proxyUrl(home), 'http://127.0.0.1:6901');
    assert.equal(isOwnUrl('http://127.0.0.1:6899/', home), true, 'an earlier port, trailing slash');
    assert.equal(isOwnUrl('http://127.0.0.1:7000', home), false);
    assert.equal(isOwnUrl('https://gateway.example.com', home), false);
    assert.deepEqual(serviceArgs(home), ['proxy', '--port', '6901', '--holdout', String(SERVICE_HOLDOUT), '--codex']);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout: 0, keep: 3, trigger: 60000 } }));
    assert.deepEqual(serviceArgs(home), ['proxy', '--port', '6901', '--holdout', '0', '--codex', '--trigger', '60000', '--keep', '3'], 'the machine config sets the flags');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout: 0 } }));
    assert.deepEqual(serviceArgs(home), ['proxy', '--port', '6901', '--holdout', '0', '--codex'], 'a config that names them keeps passing them, as the machines set up before the default did');
    // both are on by default now, so the config is only needed to turn one off, and then it is passed as such
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout: 0, clearDeep: true } }));
    assert.deepEqual(serviceArgs(home), ['proxy', '--port', '6901', '--holdout', '0', '--codex', '--clear-deep'], 'a config that names it keeps passing it');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout: 0, clearDeep: false } }));
    assert.deepEqual(serviceArgs(home), ['proxy', '--port', '6901', '--holdout', '0', '--codex', '--no-clear-deep'], 'the deep clear is on by default; false is the off switch');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout: 0 } }));
    assert.deepEqual(serviceArgs(home), ['proxy', '--port', '6901', '--holdout', '0', '--codex'], 'a value that is neither true nor false leaves the default');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude Code is left alone when the person routes elsewhere', () => {
  const home = tmp('thinker-proxy-blocker-');
  try {
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port: 6901, ports: [6901] }));
    const env = {};
    assert.equal(claudeBlocker({}, { home, env }), null);
    assert.equal(claudeBlocker({ env: { [PROXY_ENV]: 'http://127.0.0.1:6901' } }, { home, env }), null, 'ours is no blocker');
    assert.match(claudeBlocker({ env: { [PROXY_ENV]: 'https://gw.corp' } }, { home, env }), /already https:\/\/gw.corp/);
    assert.match(claudeBlocker({}, { home, env: { [PROXY_ENV]: 'https://gw.corp' } }), /in your environment/);
    assert.match(claudeBlocker({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }, { home, env }), /bedrock/);
    assert.equal(claudeBlocker({ env: { CLAUDE_CODE_USE_VERTEX: '0' } }, { home, env }), null, 'an explicit 0 is off');
    assert.deepEqual(withProxyUrl({ model: 'x' }, 'http://127.0.0.1:6901'), { model: 'x', env: { [PROXY_ENV]: 'http://127.0.0.1:6901' } });
    assert.deepEqual(withoutProxyUrl({ env: { [PROXY_ENV]: 'http://127.0.0.1:6901' } }, home), {}, 'an emptied env block goes');
    const theirs = { env: { [PROXY_ENV]: 'https://gw.corp' } };
    assert.equal(withoutProxyUrl(theirs, home), theirs, 'a URL of their own stays');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('enable writes the URL into every agent file and disable takes only ours out', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { A: '1' }, hooks: {} }));
    fs.mkdirSync(path.dirname(m.files.pi), { recursive: true });
    fs.writeFileSync(m.files.pi, JSON.stringify({ providers: { anthropic: { headers: { 'x-a': 'b' } } } }));
    fs.mkdirSync(m.env.CODEX_HOME);
    const codexFile = path.join(m.env.CODEX_HOME, 'config.toml');
    fs.writeFileSync(codexFile, 'model = "test-model"\n');
    const p = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.ok(p.port > 0);
    assert.equal(p.url, `http://127.0.0.1:${p.port}`);
    assert.equal(proxyOn(m.home), true);
    assert.deepEqual(p.wired.changed.map(c => c.agent).sort(), ['claude', 'codex', 'opencode', 'pi']);
    assert.equal(parse(fs.readFileSync(codexFile, 'utf8')).model_providers.thinker_proxy.base_url, `${p.url}/codex`);
    assert.deepEqual(readJson(m.files.claude), { env: { A: '1', [PROXY_ENV]: p.url }, hooks: {} });
    assert.deepEqual(readJson(m.files.pi), { providers: { anthropic: { headers: { 'x-a': 'b' }, baseUrl: p.url } } });
    assert.deepEqual(readJson(m.files.opencode), { provider: { anthropic: { options: { baseURL: p.url } } } });
    // again: nothing changes, the port is kept
    const again = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.equal(again.port, p.port);
    assert.deepEqual(again.wired.changed, []);
    assert.equal(again.wired.unchanged.length, 4);
    assert.ok(wiredLines(p.wired, p.url).some(l => l.startsWith('Claude Code: model calls go through the proxy')));
    // the service entry text names this copy and the port
    const plist = plistText({ cli: CLI, home: m.home });
    assert.ok(plist.includes(`<string>${PROXY_LABEL}</string>`) && plist.includes(`<string>${p.port}</string>`) && plist.includes('<key>KeepAlive</key>'));
    assert.match(unitText({ cli: CLI, home: m.home }), /Restart=always/);
    const r = disableProxyService({ home: m.home, manage: false });
    assert.deepEqual(r.wired.changed.map(c => c.agent).sort(), ['claude', 'codex', 'opencode', 'pi']);
    const restoredCodex = parse(fs.readFileSync(codexFile, 'utf8'));
    assert.equal(restoredCodex.model, 'test-model'); assert.equal(restoredCodex.model_provider, undefined);
    assert.deepEqual(readJson(m.files.claude), { env: { A: '1' }, hooks: {} });
    assert.deepEqual(readJson(m.files.pi), { providers: { anthropic: { headers: { 'x-a': 'b' } } } });
    assert.deepEqual(readJson(m.files.opencode), {});
    assert.equal(proxyOn(m.home), false);
    assert.equal(serviceState(m.home).port, p.port, 'the port is remembered for the next on');
  } finally { m.restore(); }
});

test('a base URL of the person\'s own is left alone and named; a jsonc OpenCode config is not rewritten', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { [PROXY_ENV]: 'https://gw.corp' } }));
    fs.mkdirSync(path.dirname(m.files.pi), { recursive: true });
    fs.writeFileSync(m.files.pi, JSON.stringify({ providers: { anthropic: { baseUrl: 'https://pi.corp' } } }));
    fs.writeFileSync(path.join(path.dirname(m.files.opencode), 'opencode.jsonc'), '{ /* mine */ }');
    const p = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.deepEqual(p.wired.changed, []);
    assert.deepEqual(p.wired.skipped.map(s => s.agent).sort(), ['claude', 'opencode', 'pi']);
    assert.match(p.wired.skipped.find(s => s.agent === 'opencode').reason, /opencode\.jsonc/);
    assert.deepEqual(readJson(m.files.claude), { env: { [PROXY_ENV]: 'https://gw.corp' } });
    assert.equal(fs.existsSync(m.files.opencode), false);
    const r = disableProxyService({ home: m.home, manage: false });
    assert.deepEqual(r.wired.changed, [], 'nothing of theirs is touched on the way out');
    assert.deepEqual(readJson(m.files.pi), { providers: { anthropic: { baseUrl: 'https://pi.corp' } } });
  } finally { m.restore(); }
});

test('no OpenCode on the machine: no file is made for it', () => {
  const m = fakeMachine();
  try {
    fs.rmSync(path.dirname(m.files.opencode), { recursive: true, force: true });
    const w = wireAgents('http://127.0.0.1:6901', { home: m.home, env: {}, agents: ['opencode'] });
    assert.deepEqual(w.changed, []);
    assert.equal(fs.existsSync(m.files.opencode), false);
  } finally { m.restore(); }
});

test('ensureProxy starts the proxy when nothing listens, and leaves a listening one alone', async () => {
  const m = fakeMachine();
  let pid = null;
  try {
    assert.deepEqual(await ensureProxy({ cli: CLI, home: m.home }), { on: false }, 'off: nothing');
    const port = await freePort();
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(m.home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port, ports: [port] }));
    fs.writeFileSync(path.join(m.home, 'config.json'), JSON.stringify({ proxy: { holdout: 0 } }));
    const first = await ensureProxy({ cli: CLI, home: m.home, wait: 8000 });
    pid = first.pid;
    assert.equal(first.started, true);
    assert.equal(first.listening, true, 'the proxy came up within the wait');
    assert.equal(await isListening(port), true);
    assert.equal(serviceState(m.home).pid, pid, 'the pid is kept for off');
    assert.deepEqual(await ensureProxy({ cli: CLI, home: m.home }), { on: true, running: true });
    assert.ok(fs.readFileSync(path.join(m.home, 'state', 'proxy-service.log'), 'utf8').includes(`http://127.0.0.1:${port}`));
    assert.ok(fs.readFileSync(path.join(m.home, 'state', 'proxy-service.log'), 'utf8').includes(`http://127.0.0.1:${port}/codex`), 'the managed process enables the Codex route');
    // the service entries are written without a service manager in test mode, and removed again
    const svc = installService({ cli: CLI, home: m.home, manage: false });
    if (svc.path) assert.ok(fs.existsSync(svc.path));
    const removed = uninstallService({ home: m.home, manage: false });
    if (svc.path) assert.deepEqual(removed, [svc.path]);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    m.restore();
  }
});

test('ensureProxy waits for the listener to record ownership before reporting startup complete', { timeout: 15000 }, async () => {
  const m = fakeMachine();
  let pending, pid;
  try {
    const port = await freePort();
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(m.home, 'state/proxy-service.json'), JSON.stringify({ enabled: true, port, ports: [port], wroteClaude: false }));
    const child = path.join(m.root, 'delayed-proxy.mjs');
    const probed = path.join(m.root, 'probed'), release = path.join(m.root, 'release'), owner = path.join(m.root, 'pid');
    fs.writeFileSync(child, `
      import net from 'node:net';
      import fs from 'node:fs';
      import { recordProxyListening } from ${JSON.stringify(pathToFileURL(path.join(path.dirname(CLI), 'proxy-service.js')).href)};
      fs.writeFileSync(${JSON.stringify(owner)}, String(process.pid));
      const server = net.createServer(socket => { socket.end(); fs.writeFileSync(${JSON.stringify(probed)}, 'yes'); });
      server.listen(${port}, '127.0.0.1', () => {
        const timer = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(release)})) return;
          clearInterval(timer);
          recordProxyListening(${port});
        }, 10);
      });
    `);
    pending = ensureProxy({ cli: child, home: m.home, wait: 8000, restartFn: () => false });
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(probed) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(probed), 'the child accepted the startup probe');
    pid = Number(fs.readFileSync(owner, 'utf8'));
    assert.equal(await Promise.race([
      pending.then(() => 'returned'),
      new Promise(resolve => setTimeout(() => resolve('waiting'), 100)),
    ]), 'waiting', 'a listening socket alone must not finish startup');
    assert.equal(serviceState(m.home).pid, undefined, 'only the listener may claim ownership');
    fs.writeFileSync(release, 'yes');
    assert.deepEqual(await pending, { on: true, started: true, pid, listening: true });
    assert.equal(serviceState(m.home).pid, pid);
    assert.deepEqual(await ensureProxy({ cli: child, home: m.home }), { on: true, running: true });
  } finally {
    // Release a delayed child even when an assertion failed, then stop only that fixture.
    fs.writeFileSync(path.join(m.root, 'release'), 'yes');
    await pending;
    pid ||= Number(fs.existsSync(path.join(m.root, 'pid')) && fs.readFileSync(path.join(m.root, 'pid'), 'utf8'));
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    m.restore();
  }
});

test('a route the person exported in their shell leaves Claude Code alone, the other agents are still wired', async () => {
  const m = fakeMachine();
  try {
    const shellHome = path.join(m.root, 'shell');
    fs.mkdirSync(shellHome, { recursive: true });
    fs.writeFileSync(path.join(shellHome, '.zshrc'), 'export ANTHROPIC_BASE_URL=https://router.corp\nexport ANTHROPIC_AUTH_TOKEN=gw-token\n');
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { A: '1' } }));
    const env = { ...m.env, THINKER_ROUTE_HOME: shellHome };
    const p = await enableProxyService({ cli: CLI, home: m.home, env, manage: false });
    const claude = p.wired.skipped.find(s => s.agent === 'claude');
    assert.match(claude.reason, /ANTHROPIC_BASE_URL is set to https:\/\/router\.corp in ~\/\.zshrc/);
    assert.deepEqual(readJson(m.files.claude), { env: { A: '1' } }, 'nothing written where the person routes elsewhere');
    assert.deepEqual(p.wired.changed.map(c => c.agent).sort(), ['opencode', 'pi']);
    assert.equal(serviceState(m.home).wroteClaude, undefined, 'nothing of ours in Claude Code\'s settings to miss later');
  } finally { m.restore(); }
});

for (const gateway of [undefined, 'https://gateway.example']) test(`automatic reconnect respects manual removal before the next prompt (gateway: ${Boolean(gateway)})`, async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    const original = { env: { A: '1', ...(gateway ? { [PROXY_ENV]: gateway, ANTHROPIC_AUTH_TOKEN: 'fixture' } : {}) } };
    fs.writeFileSync(m.files.claude, JSON.stringify(original));
    await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false, gateway });
    assert.equal(claudeWired(m.home), true);
    fs.writeFileSync(m.files.claude, JSON.stringify(original));
    const result = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.deepEqual(readJson(m.files.claude), original, 'connect must not restore the proxy URL before the prompt hook can see its removal');
    assert.match(result.stoodDown, /taken out/);
    assert.equal(proxyOn(m.home), false);
    const forced = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false, force: true, gateway });
    assert.equal(readJson(m.files.claude).env[PROXY_ENV], forced.url, 'explicit proxy on can still enable it');
  } finally { m.restore(); }
});

test('the URL taken out of Claude Code\'s settings by hand turns the service off, and nothing writes it back', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { A: '1' } }));
    const p = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.equal(serviceState(m.home).wroteClaude, true);
    assert.equal(claudeWired(m.home), true);
    assert.equal(removedByHand({ home: m.home }), null, 'it is there');
    // the person deletes the line (or points Claude Code at a gateway of their own)
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { A: '1' } }));
    assert.match(removedByHand({ home: m.home }), /taken out of Claude Code/);
    // the prompt hook is the first thing to run after that: the service goes rather than the URL coming back
    const e = await ensureProxy({ cli: CLI, home: m.home, wait: 1 });
    assert.match(e.stoodDown, /taken out of Claude Code/);
    assert.equal(e.on, false);
    const s = serviceState(m.home);
    assert.equal(s.enabled, false);
    assert.match(s.standDown.reason, /taken out of Claude Code/);
    assert.equal(fs.existsSync(m.files.pi), false, 'the other agents are taken out with it');
    // an install, a connect or the daily rewire does not put it back
    const again = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.match(again.stoodDown, /taken out of Claude Code/);
    assert.deepEqual(again.wired.changed, []);
    assert.equal(proxyOn(m.home), false);
    assert.deepEqual(readJson(m.files.claude), { env: { A: '1' } });
    // only the person asking for it does
    const forced = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false, force: true });
    assert.equal(proxyOn(m.home), true);
    assert.equal(readJson(m.files.claude).env[PROXY_ENV], forced.url);
    assert.equal(serviceState(m.home).standDown, undefined);
  } finally { m.restore(); }
});

test('standDown: the service off with its reason, and no-op for a proxy on another port', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    const p = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.equal(standDown('x', { home: m.home, manage: false, port: p.port + 1 }), null, 'another proxy\'s business');
    assert.equal(proxyOn(m.home), true);
    const r = standDown('the API refused the agent\'s credentials', { home: m.home, manage: false, port: p.port });
    assert.equal(proxyOn(m.home), false);
    assert.match(r.reason, /refused/);
    assert.equal(readJson(m.files.claude).env?.[PROXY_ENV], undefined);
    assert.equal(standDown('again', { home: m.home, manage: false }), null, 'off already');
  } finally { m.restore(); }
});

test('a service enabled before the record: the settings now are the baseline, and an absence nothing explains stands it down', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    const legacy = extra => fs.writeFileSync(path.join(m.home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port: 6901, ports: [6901], ...extra }));
    // ours is there: recorded, nothing else happens
    legacy();
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { [PROXY_ENV]: 'http://127.0.0.1:6901' } }));
    assert.equal(trackClaude({ home: m.home, env: {} }), null);
    assert.equal(serviceState(m.home).wroteClaude, true);
    // Claude Code was never wired because the person routes elsewhere: recorded as such, left alone
    legacy();
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { [PROXY_ENV]: 'https://gw.corp' } }));
    assert.equal(trackClaude({ home: m.home, env: {} }), null);
    assert.equal(serviceState(m.home).wroteClaude, false);
    // no settings file at all (no Claude Code here): nothing is concluded
    legacy();
    fs.rmSync(m.files.claude);
    assert.equal(trackClaude({ home: m.home, env: {} }), null);
    assert.equal(serviceState(m.home).wroteClaude, undefined);
    // the file is there, our URL is not, and no route explains it: the person took it out before this version
    legacy();
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { A: '1' } }));
    assert.match(trackClaude({ home: m.home, env: {} }), /taken out/);
  } finally { m.restore(); }
});

test('a route the person sets up after the wiring: the next prompt takes the proxy out, before a call fails', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { A: '1' } }));
    const p = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.equal(readJson(m.files.claude).env[PROXY_ENV], p.url);
    const env = { ...m.env, THINKER_ROUTE_HOME: path.join(m.root, 'shell') };
    assert.equal(routeAppeared({ home: m.home, env }), null, 'no route of theirs yet');
    fs.mkdirSync(path.join(m.root, 'shell'), { recursive: true });
    fs.writeFileSync(path.join(m.root, 'shell', '.zshrc'), 'export ANTHROPIC_BASE_URL=https://smartrouter.internal\n');
    const why = routeAppeared({ home: m.home, env });
    assert.match(why, /smartrouter\.internal in ~\/\.zshrc/);
    standDown(why, { home: m.home, manage: false });
    assert.equal(proxyOn(m.home), false);
    assert.equal(readJson(m.files.claude).env?.[PROXY_ENV], undefined, 'their route is the only one left');
  } finally { m.restore(); }
});

test('the proxy in front of a model server of the person\'s own: asked for, named in the flags, and no longer a blocker', async () => {
  const m = fakeMachine();
  try {
    const shellHome = path.join(m.root, 'shell');
    fs.mkdirSync(shellHome, { recursive: true });
    fs.writeFileSync(path.join(shellHome, '.zshrc'), 'export ANTHROPIC_BASE_URL=https://smartrouter.internal\n');
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, '{}');
    const env = { ...m.env, THINKER_ROUTE_HOME: shellHome };
    // unasked, the route is left alone: that is the rule of 2026-10-28
    const left = await enableProxyService({ cli: CLI, home: m.home, env, manage: false });
    assert.match(left.wired.skipped.find(s => s.agent === 'claude').reason, /smartrouter/);
    assert.equal(left.upstream, null);
    // asked for: the proxy forwards there, so pointing the agent at it keeps every request on the same route
    const g = await enableProxyService({ cli: CLI, home: m.home, env, manage: false, force: true, gateway: true });
    assert.equal(g.upstream, 'https://smartrouter.internal');
    assert.equal(g.gatewayFrom, '~/.zshrc');
    assert.equal(proxyThrough(m.home), 'https://smartrouter.internal');
    assert.deepEqual(g.wired.changed.map(c => c.agent), ['claude'], 'the others were already wired by the first run');
    assert.equal(readJson(m.files.claude).env[PROXY_ENV], g.url);
    assert.ok(serviceArgs(m.home).join(' ').includes('--upstream https://smartrouter.internal'));
    assert.equal(claudeBlocker({ env: { [PROXY_ENV]: 'https://smartrouter.internal' } }, { home: m.home, env: {} }), null, 'the route we forward to is not a blocker');
    assert.equal(routeAppeared({ home: m.home, env }), null, 'nor does the shell file read as a route that appeared');
    assert.match(claudeBlocker({ env: { [PROXY_ENV]: 'https://other.gw' } }, { home: m.home, env: {} }), /other\.gw/, 'another one still is');
    assert.ok(wiredLines(g.wired, g.url, g.upstream).some(l => l.includes('on to https://smartrouter.internal')));
    // off puts the route back to the person's own hands
    disableProxyService({ home: m.home, manage: false });
    assert.equal(proxyThrough(m.home), null);
    assert.equal(readJson(m.files.claude).env?.[PROXY_ENV], undefined);
  } finally { m.restore(); }
});

test('--gateway with nothing of the person\'s own to forward to', async () => {
  const m = fakeMachine();
  try {
    const shellHome = path.join(m.root, 'shell');
    fs.mkdirSync(shellHome, { recursive: true });
    const p = await enableProxyService({ cli: CLI, home: m.home, env: { ...m.env, THINKER_ROUTE_HOME: shellHome }, manage: false, gateway: true });
    assert.equal(p.upstream, null, 'the API as usual');
    assert.equal(serviceArgs(m.home).includes('--upstream'), false);
  } finally { m.restore(); }
});

test('a proxy already listening is replaced when its flags or its version moved, and left alone otherwise', async () => {
  const m = fakeMachine();
  const server = http.createServer(() => {});
  // every replacement here spawns a real detached proxy, and the state this test writes names no pid for the next
  // call to stop, so they are stopped by hand: one of them outlived every suite run until 2026-11-02
  const children = [];
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const write = extra => fs.writeFileSync(path.join(m.home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port, ports: [port], wroteClaude: false, ...extra }));
    // a state from before the record: replaced once, so every machine picks up the present policy
    write({});
    // `restartGrace: 0` because this test puts three reasons to restart milliseconds apart and asks what each
    // one does about them; one session's claim standing for 30 seconds is the next test's subject.
    const first = await ensureProxy({ cli: CLI, home: m.home, wait: 1, restartGrace: 0 }); children.push(first.pid);
    assert.equal(first.restarted, true);
    assert.equal(first.listening, false, 'the existing listener cannot establish readiness for the new child');
    assert.match(first.why, /first run that records them/);
    // the flags and the version recorded and matching: nothing to do
    write({ args: serviceArgs(m.home).join(' '), version: appVersion() });
    assert.deepEqual(await ensureProxy({ cli: CLI, home: m.home, wait: 1 }), { on: true, running: true });
    // an older thinker started it
    write({ args: serviceArgs(m.home).join(' '), version: '0.0.1' });
    const upgraded = await ensureProxy({ cli: CLI, home: m.home, wait: 1, restartGrace: 0 }); children.push(upgraded.pid);
    assert.equal(upgraded.restarted, true);
    assert.equal(upgraded.listening, false);
    assert.match(upgraded.why, /new version \(0\.0\.1 -> /);
    // the flags moved under it (a gateway, a clearing policy, the codex route)
    write({ args: 'proxy --port 1 --holdout 0.15', version: appVersion() });
    const reflagged = await ensureProxy({ cli: CLI, home: m.home, wait: 1, restartGrace: 0 }); children.push(reflagged.pid);
    assert.equal(reflagged.restarted, true);
    assert.equal(reflagged.listening, false);
    assert.equal(reflagged.why, 'the flags changed');
  } finally { for (const pid of children) { try { process.kill(pid, 'SIGTERM'); } catch {} } server.close(); m.restore(); }
});

test('a settings file that does not parse is left exactly as it is, never written over', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    // what a person's settings file can look like: a comment in it, or caught half-written
    const theirs = '{\n  // my own gateway\n  "env": { "ANTHROPIC_BASE_URL": "https://gw.corp" },\n  "permissions": { "deny": ["Workflow"] }\n}\n';
    fs.writeFileSync(m.files.claude, theirs);
    const p = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false });
    assert.match(p.wired.skipped.find(s => s.agent === 'claude').reason, /not valid JSON, so thinker left it alone/);
    assert.equal(fs.readFileSync(m.files.claude, 'utf8'), theirs, 'byte for byte');
    disableProxyService({ home: m.home, manage: false });
    assert.equal(fs.readFileSync(m.files.claude, 'utf8'), theirs, 'byte for byte on the way out too');
  } finally { m.restore(); }
});

test('a route taken over by --gateway is put back when the proxy is taken out', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://smartrouter.internal', ANTHROPIC_AUTH_TOKEN: 'gw-token' }, permissions: { deny: ['Workflow'] } }, null, 2));
    const g = await enableProxyService({ cli: CLI, home: m.home, env: m.env, manage: false, gateway: 'https://smartrouter.internal' });
    const after = readJson(m.files.claude);
    assert.equal(after.env[PROXY_ENV], g.url, 'the agent goes through the proxy');
    assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, 'gw-token', 'their token is untouched');
    assert.deepEqual(after.permissions, { deny: ['Workflow'] }, 'and the rest of their settings');
    assert.equal(serviceState(m.home).replaced.claude, 'https://smartrouter.internal', 'what was replaced is remembered');
    disableProxyService({ home: m.home, manage: false });
    const back = readJson(m.files.claude);
    assert.equal(back.env[PROXY_ENV], 'https://smartrouter.internal', 'their own route is back, not deleted');
    assert.equal(back.env.ANTHROPIC_AUTH_TOKEN, 'gw-token');
    assert.equal(serviceState(m.home).replaced, undefined, 'and forgotten once restored');
  } finally { m.restore(); }
});

test('service restarts retain network proxy settings but never copy model API credentials', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, JSON.stringify({ env: { HTTPS_PROXY: 'http://network.example:3128', NODE_EXTRA_CA_CERTS: '/corporate/ca.pem', ANTHROPIC_AUTH_TOKEN: 'not-for-the-service' } }));
    await enableProxyService({ cli: CLI, home: m.home, env: { ...m.env, HTTP_PROXY: 'http://user:pass@network.example:3128', NO_PROXY: 'localhost,127.0.0.1', OPENAI_API_KEY: 'not-for-the-service' }, manage: false });
    const state = serviceState(m.home);
    assert.deepEqual(state.networkEnv, { HTTP_PROXY: 'http://user:pass@network.example:3128', HTTPS_PROXY: 'http://network.example:3128', NO_PROXY: 'localhost,127.0.0.1', NODE_EXTRA_CA_CERTS: '/corporate/ca.pem' });
    assert.equal(fs.statSync(path.join(m.home, 'state/proxy-service.json')).mode & 0o777, 0o600);
    const plist = plistText({ cli: CLI, home: m.home });
    const unit = unitText({ cli: CLI, home: m.home });
    for (const text of [plist, unit]) {
      assert.match(text, /network.example:3128/);
      assert.match(text, /NODE_EXTRA_CA_CERTS/);
      assert.match(text, /localhost,127.0.0.1/);
      assert.doesNotMatch(text, /not-for-the-service|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY/);
    }
  } finally { m.restore(); }
});

test('a managed restart never spawns a detached competitor, and the listening process records its own PID', async () => {
  const { recordProxyListening } = await import('../src/proxy-service.js');
  const m = fakeMachine(), server = http.createServer();
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(m.home, 'state/proxy-service.json'), JSON.stringify({ enabled: true, port, wroteClaude: false, version: 'old' }));
    let calls = 0;
    const result = await ensureProxy({ cli: CLI, home: m.home, restartFn: opts => {
      calls++; assert.equal(opts.managedOnly, true);
      recordProxyListening(port, { home: m.home, pid: 123456 });
      return true;
    } });
    assert.equal(calls, 1); assert.equal(result.managed, true); assert.equal(result.listening, true);
    assert.equal(result.pid, undefined, 'no detached child was started');
    assert.equal(serviceState(m.home).pid, 123456, 'only the listener claims the service');
    assert.deepEqual(await ensureProxy({ cli: CLI, home: m.home }), { on: true, running: true });
    recordProxyListening(port + 1, { home: m.home, pid: 999 });
    assert.equal(serviceState(m.home).pid, 123456, 'a manually started proxy on another port does not claim the service');
  } finally { server.close(); m.restore(); }
});

test('a managed listener without its startup record times out without claiming readiness', async () => {
  const m = fakeMachine(), server = http.createServer();
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(m.home, 'state/proxy-service.json'), JSON.stringify({ enabled: true, port, wroteClaude: false }));
    const result = await ensureProxy({ cli: CLI, home: m.home, wait: 1, restartFn: () => true });
    assert.equal(result.managed, true);
    assert.equal(result.pid, undefined, 'no detached competitor was spawned');
    assert.equal(result.listening, false, 'timeout does not bypass the ownership check');
    assert.equal(serviceState(m.home).pid, undefined, 'the parent must not invent an owner');
  } finally { server.close(); m.restore(); }
});

test('a network-restricted hook cannot replace a working proxy with a sandboxed child', async () => {
  const { startDetached } = await import('../src/proxy-service.js');
  const m = fakeMachine(), server = http.createServer();
  const previous = process.env.CODEX_SANDBOX_NETWORK_DISABLED;
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(m.home, 'state/proxy-service.json'), JSON.stringify({ enabled: true, port, wroteClaude: false, version: 'old' }));
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = '1';
    assert.equal(startDetached({ cli: CLI, home: m.home }), null);
    const result = await ensureProxy({ cli: CLI, home: m.home, restartFn: () => false });
    assert.equal(result.deferred, 'network-restricted hook');
    assert.equal(serviceState(m.home).version, 'old', 'a blocked restart must not claim the new code is running');
    assert.equal(server.listening, true);
  } finally {
    previous === undefined ? delete process.env.CODEX_SANDBOX_NETWORK_DISABLED : process.env.CODEX_SANDBOX_NETWORK_DISABLED = previous;
    server.close(); m.restore();
  }
});

// The Claude desktop app sets ANTHROPIC_BASE_URL=https://api.anthropic.com in the environment of every local
// session. On 2026-11-01 the prompt hook in one read that as a route of the person's own ("ANTHROPIC_BASE_URL is
// https://api.anthropic.com in your environment"), stood the machine's service down, and the repair offer then put
// the proxy back "in front of" api.anthropic.com. Anthropic's own host is no route and no upstream.
test('Anthropic\'s own host in the environment is no blocker, stands nothing down, and is never an upstream', async () => {
  const API = 'https://api.anthropic.com';
  const m = fakeMachine();
  try {
    const shellHome = path.join(m.root, 'shell');
    fs.mkdirSync(shellHome, { recursive: true });
    fs.mkdirSync(path.dirname(m.files.claude), { recursive: true });
    fs.writeFileSync(m.files.claude, '{}');
    const env = { ...m.env, THINKER_ROUTE_HOME: shellHome };
    const desktop = { ...env, [PROXY_ENV]: API };
    assert.equal(claudeBlocker({}, { home: m.home, env: desktop }), null, 'the desktop app\'s own value');
    assert.equal(claudeBlocker({ env: { [PROXY_ENV]: `${API}/` } }, { home: m.home, env }), null, 'in the settings too');
    assert.match(claudeBlocker({}, { home: m.home, env: { ...env, [PROXY_ENV]: 'https://gw.corp' } }), /gw\.corp in your environment/, 'anyone else\'s still is');
    const p = await enableProxyService({ cli: CLI, home: m.home, env: desktop, manage: false });
    assert.deepEqual(p.wired.skipped.filter(s => s.agent === 'claude'), [], 'Claude Code is wired');
    assert.equal(readJson(m.files.claude).env[PROXY_ENV], p.url);
    assert.equal(routeAppeared({ home: m.home, env: desktop }), null, 'a desktop session\'s hook stands nothing down');
    fs.writeFileSync(path.join(shellHome, '.zshrc'), `export ANTHROPIC_BASE_URL=${API}/v1\n`);
    assert.equal(routeAppeared({ home: m.home, env: desktop }), null, 'nor does a shell line exporting the default');
    fs.writeFileSync(path.join(shellHome, '.zshrc'), 'export ANTHROPIC_BASE_URL=https://smartrouter.internal\n');
    assert.match(routeAppeared({ home: m.home, env: desktop }), /smartrouter\.internal/, 'a route of their own still does');
    fs.rmSync(path.join(shellHome, '.zshrc'));
    // --gateway with only Anthropic's host to be found: the API as usual, not "a model server of your own"
    const g = await enableProxyService({ cli: CLI, home: m.home, env: desktop, manage: false, force: true, gateway: true });
    assert.equal(g.upstream, null); assert.equal(g.gatewayFrom, null);
    assert.equal(proxyThrough(m.home), null);
    assert.equal(serviceArgs(m.home).includes('--upstream'), false);
    // named as the upstream by hand, or left in the state by the yes of 2026-11-01: normalised away
    const named = await enableProxyService({ cli: CLI, home: m.home, env: desktop, manage: false, force: true, gateway: `${API}/` });
    assert.equal(named.upstream, null); assert.equal(serviceState(m.home).upstream, undefined);
    fs.writeFileSync(path.join(m.home, 'state', 'proxy-service.json'), JSON.stringify({ ...serviceState(m.home), upstream: API }));
    assert.equal(proxyThrough(m.home), null, 'the status line reads as the ordinary route');
    assert.equal(serviceArgs(m.home).includes('--upstream'), false);
    const again = await enableProxyService({ cli: CLI, home: m.home, env: desktop, manage: false, force: true });
    assert.equal(again.upstream, null); assert.equal(serviceState(m.home).upstream, undefined, 'the stored value is dropped on the next on');
  } finally { m.restore(); }
});

test('in a container, a proxy that will not stay up stands down rather than leave the agent on a dead port', async () => {
  const m = fakeMachine();
  try {
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    // a port nothing listens on, and a container (the marks a runtime leaves; containerKind reads them)
    fs.writeFileSync(path.join(m.home, 'state/proxy-service.json'), JSON.stringify({ enabled: true, port: 1, wroteClaude: true }));
    const { containerKind } = await import('../src/container-kind.js');
    assert.equal(containerKind({ env: {}, exists: f => f === '/.dockerenv', readFile: () => { throw new Error('x'); } }), 'docker');
    // the fault this is for, measured in a devcontainer on 2026-11-05: the proxy bound its port, logged its
    // banner and was gone seconds later, and no later hook brought it back -- so the route would have
    // stayed dead for the life of the container and every model call in there would have failed.
    const result = await ensureProxy({ cli: CLI, home: m.home, wait: 1, restartFn: () => false });
    assert.equal(result.listening, false);
    // on this machine (not a container) the service stays on and the next prompt tries again
    assert.equal(result.on, true, 'a host keeps the service: a port dead for a moment is ordinary there');
    assert.equal(serviceState(m.home).standDown, undefined);
  } finally { m.restore(); }
});

// `thinker update` moves the version for the whole machine, and then every session's next prompt has a
// reason to replace the proxy. One of them needs to: the rest would be SIGTERMing a process that is
// streaming another session's answer, and racing the service manager for the port (105 recorded starts
// against 26,245 EADDRINUSE lines on this machine).
test('one session replaces a running proxy; the others find it on their next prompt', async () => {
  const m = fakeMachine();
  const server = http.createServer(() => {});
  try {
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const state = { enabled: true, port, ports: [port], wroteClaude: false, args: serviceArgs(m.home).join(' '), version: '0.0.1' };
    fs.writeFileSync(path.join(m.home, 'state', 'proxy-service.json'), JSON.stringify(state));
    let restarts = 0;
    const restartFn = () => { restarts++; return true; };

    // four sessions reach the hook at once, as they do after an update
    const all = await Promise.all([1, 2, 3, 4].map(() => ensureProxy({ cli: CLI, home: m.home, wait: 1, restartFn })));
    assert.equal(restarts, 1, 'the port is replaced once');
    assert.equal(all.filter(r => r.restarted).length, 1);
    assert.deepEqual(all.filter(r => !r.restarted), [1, 2, 3].map(() => ({ on: true, running: true, deferred: 'another session is replacing it' })));

    // A proxy to replace with something else is its own claim: the clearing policy moved under it here,
    // so the flags this would start are not the flags the claim above was made for.
    fs.writeFileSync(path.join(m.home, 'config.json'), JSON.stringify({ proxy: { trigger: 120000 } }));
    fs.writeFileSync(path.join(m.home, 'state', 'proxy-service.json'), JSON.stringify({ ...state, version: appVersion() }));
    assert.equal((await ensureProxy({ cli: CLI, home: m.home, wait: 1, restartFn })).why, 'the flags changed');
    assert.equal(restarts, 2);

    // and once the claim has gone stale, the reason stands again: a restart that never took hold is retried
    fs.writeFileSync(path.join(m.home, 'state', 'proxy-service.json'), JSON.stringify({ ...state, args: serviceArgs(m.home).join(' ') }));
    assert.equal((await ensureProxy({ cli: CLI, home: m.home, wait: 1, restartFn, restartGrace: 0 })).restarted, true);
    assert.equal(restarts, 3);
  } finally { server.close(); m.restore(); }
});

test('a restart claim is one caller\'s, for one target, and expires', () => {
  const m = fakeMachine();
  try {
    const now = Date.now();
    assert.equal(claimRestart(m.home, '0.2.24 proxy --port 7', { now }), true, 'the first caller takes it');
    assert.equal(claimRestart(m.home, '0.2.24 proxy --port 7', { now: now + 1000 }), false, 'the next finds it taken');
    assert.equal(claimRestart(m.home, '0.2.25 proxy --port 7', { now: now + 1000 }), true, 'another target is its own claim');
    assert.equal(claimRestart(m.home, '0.2.25 proxy --port 7', { now: now + 31000 }), true, 'and a claim nothing came of expires');
  } finally { m.restore(); }
});

test('replaceReason: a service running this version with these flags is left alone; another version, other flags or no record is replaced', () => {
  const home = tmp('thinker-proxy-replace-');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const state = extra => fs.writeFileSync(path.join(home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port: 6901, ...extra }));
  state({ args: serviceArgs(home, { port: 6901 }).join(' '), version: appVersion() });
  assert.equal(replaceReason(home), null, 'what rewire and the prompt hook would start is what runs: no restart');
  state({ args: serviceArgs(home, { port: 6901 }).join(' '), version: '0.0.1' });
  assert.match(replaceReason(home), /a new version \(0\.0\.1 -> /);
  state({ args: 'proxy --port 6901 --holdout 0.5 --codex', version: appVersion() });   // the share before 2026-11-12: not what runs now
  assert.equal(replaceReason(home), 'the flags changed');
  state({});
  assert.equal(replaceReason(home), 'the first run that records them');
});

// A fake `launchctl` on the PATH, with launchd's shape: `bootout` answers at once and the label stays registered
// (`print` succeeds) for as long as the old process takes to leave; `bootstrap` of a registered label fails;
// `load` exits 0 whether or not it loaded anything. The old instance prints as pid 11, a new one as 22.
function fakeLaunchctl({ draining = 0, bootstrapRefuses = false, loadWorks = false } = {}) {
  const dir = tmp('thinker-launchctl-');
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'loaded'), '');
  fs.writeFileSync(path.join(state, 'draining'), String(draining));
  const script = `#!/bin/sh
S="${state}"
echo "$1" >> "$S/calls"
case "$1" in
  bootout) [ -f "$S/loaded" ] || exit 3; touch "$S/terming"; exit 0;;
  print)
    [ -f "$S/loaded" ] || exit 113
    if [ -f "$S/terming" ]; then n=$(cat "$S/draining"); if [ "$n" -gt 0 ]; then echo $((n-1)) > "$S/draining"; printf '\tstate = SIGTERMed\n\tpid = 11\n'; exit 0; fi; rm -f "$S/loaded" "$S/terming"; exit 113; fi
    printf '\tstate = running\n\tpid = 22\n\tprogram = /usr/bin/node\n\targuments = {\n\t\t/usr/bin/node\n\t\t/app/src/cli.js\n\t\tproxy\n\t\t--port\n\t\t6901\n\t}\n'; exit 0;;
  bootstrap) [ -f "$S/loaded" ] && exit 5; ${bootstrapRefuses ? 'exit 5' : 'touch "$S/loaded"; exit 0'};;
  load) ${loadWorks ? 'touch "$S/loaded";' : ''} exit 0;;
esac
exit 1
`;
  fs.writeFileSync(path.join(dir, 'launchctl'), script, { mode: 0o755 });
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
  const calls = () => { try { return fs.readFileSync(path.join(state, 'calls'), 'utf8').trim().split('\n'); } catch { return []; } };
  const loaded = () => fs.existsSync(path.join(state, 'loaded'));
  return { calls, loaded, restore: () => { process.env.PATH = savedPath; } };
}

test('a launchd restart waits for the booted-out label to leave before bootstrapping, and reads bootstrap\'s own answer', () => {
  const l = fakeLaunchctl({ draining: 3 });
  try {
    assert.equal(bootOutAgent({ wait: 5000, step: 5 }), true);
    assert.equal(l.loaded(), false, 'the old instance is gone');
    assert.deepEqual(l.calls().filter(c => c === 'print').length, 4, 'polled until the label left');
    assert.equal(bootstrapAgent('/tmp/x.plist'), true);
    assert.equal(l.loaded(), true, 'the new instance is registered');
    assert.ok(!l.calls().includes('load'), 'bootstrap answered, so load was never tried');
  } finally { l.restore(); }
});

test('a launchd restart that bootstraps while the label is still registered is what it used to do, and fails', () => {
  const l = fakeLaunchctl({ draining: 1000 });
  try {
    assert.equal(bootstrapAgent('/tmp/x.plist'), true, 'without a bootout the instance print names is running: believed');
    assert.equal(bootOutAgent({ wait: 60, step: 5 }), false, 'a label that will not leave within the wait is reported, not assumed gone');
    assert.equal(bootstrapAgent('/tmp/x.plist'), false, 'bootstrap refused (5), load exited 0, and the instance registered is the old one draining: not believed');
    assert.equal(bootstrapAgent('/tmp/x.plist', { was: 11 }), false, 'nor when it is named by pid');
    assert.deepEqual(l.calls().slice(-3), ['bootstrap', 'load', 'print']);
  } finally { l.restore(); }
});

test('a launchd restart believes `load` only when the label is there after it', () => {
  const l = fakeLaunchctl({ draining: 0, bootstrapRefuses: true, loadWorks: true });
  try {
    assert.equal(bootOutAgent({ wait: 1000, step: 5 }), true);
    assert.equal(bootstrapAgent('/tmp/x.plist', { was: 11 }), true, 'bootstrap refused, load loaded it: print names a running instance that is not the old one');
    assert.ok(BOOTOUT_WAIT_MS > 20_000, 'the wait outlasts launchd\'s own ExitTimeOut (20 s), after which it SIGKILLs and the label leaves');
  } finally { l.restore(); }
});

test('agentInstance reads the program line launchd loaded, so a restart knows whether KeepAlive would start the same thing', () => {
  const l = fakeLaunchctl();
  try {
    assert.deepEqual(agentInstance(), { pid: 22, state: 'running', args: ['/usr/bin/node', '/app/src/cli.js', 'proxy', '--port', '6901'] });
  } finally { l.restore(); }
});

test('restartDue: nothing in flight and idle, or patient enough, or past the deadline', () => {
  const at = new Date(1_000_000).toISOString();
  const m = { at };
  assert.equal(restartDue(null, { inFlight: 0, idleMs: 10 ** 6 }), null, 'no marker, no restart');
  assert.equal(restartDue(m, { inFlight: 1, idleMs: 0 }, { now: 1_000_000 + 5000 }), null, 'a request in flight');
  assert.equal(restartDue(m, { inFlight: 0, idleMs: RESTART_IDLE_MS - 1 }, { now: 1_000_000 + 5000 }), null, 'one just finished: the next may be on its way');
  assert.equal(restartDue(m, { inFlight: 0, idleMs: RESTART_IDLE_MS }, { now: 1_000_000 + 5000 }), 'idle');
  assert.equal(restartDue(m, { inFlight: 0, idleMs: 1 }, { now: 1_000_000 + RESTART_PATIENCE_MS }), 'idle', 'past the patience the first empty moment will do');
  assert.equal(restartDue(m, { inFlight: 3, idleMs: 0 }, { now: 1_000_000 + RESTART_PATIENCE_MS }), null, 'but not with requests in flight');
  assert.equal(restartDue(m, { inFlight: 3, idleMs: 0 }, { now: 1_000_000 + RESTART_DEADLINE_MS }), 'deadline', 'past the deadline it drains, as a bootout did');
  assert.ok(RESTART_IDLE_MS < RESTART_PATIENCE_MS && RESTART_PATIENCE_MS < RESTART_DEADLINE_MS);
});

test('requestRestart keeps the first ask\'s time, and the marker is cleared by hand or by the new instance', () => {
  const home = tmp('thinker-proxy-wanted-');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port: 6901 }));
  assert.equal(restartWanted(home), null);
  requestRestart(home, { why: 'a new version (0.1 -> 0.2)' });
  const first = restartWanted(home);
  assert.equal(first.why, 'a new version (0.1 -> 0.2)');
  assert.equal(first.respawn, false);
  assert.equal(first.version, appVersion());
  assert.equal(first.args, serviceArgs(home).join(' '));
  requestRestart(home, { why: 'asked again by the next prompt', respawn: true });
  assert.equal(restartWanted(home).at, first.at, 'the patience runs from the first ask, however many hooks repeat it');
  assert.equal(restartWanted(home).respawn, true, 'the rest follows the latest ask');
  clearRestartWanted(home);
  assert.equal(restartWanted(home), null);
  requestRestart(home, { why: 'once more' });
  recordProxyListening(6901, { home, pid: 4242 });
  assert.equal(restartWanted(home), null, 'the instance that listens is the one that was asked for: it clears the marker');
  assert.equal(serviceState(home).idleRestart, true, 'and records that it watches the marker, so the next ask can be left to it; an older instance never did, and is booted out');
});

test('the watcher lets what is in flight finish, then closes, respawns where asked, and exits', async () => {
  const home = tmp('thinker-proxy-watch-');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  requestRestart(home, { why: 'update', respawn: true, version: '0.0.1', args: 'proxy --port 1' });
  let inFlight = 2; const order = []; const rows = [];
  const stop = idleRestartWatcher({
    home, running: { version: '0.0.0', args: 'proxy --port 1' },
    load: () => ({ inFlight, idleMs: 10 ** 6 }),
    close: () => { order.push('close'); return new Promise(r => setTimeout(r, 10)); },
    respawn: () => order.push('respawn'), exit: () => order.push('exit'), log: r => rows.push(r), every: 5,
  });
  try {
    await new Promise(r => setTimeout(r, 40));
    assert.deepEqual(order, [], 'two requests in flight: nothing happens');
    inFlight = 0;
    const t = Date.now(); while (order.length < 3 && Date.now() - t < 2000) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(order, ['close', 'respawn', 'exit'], 'the listener goes first, then the replacement is started, then this process leaves');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op, 'proxy-restart-idle'); assert.equal(rows[0].when, 'idle'); assert.equal(rows[0].why, 'update'); assert.equal(rows[0].respawn, true);
  } finally { stop(); }
});

test('the watcher clears a marker that asks for what this process already is', async () => {
  const home = tmp('thinker-proxy-watch-same-');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  requestRestart(home, { why: 'the first run that records them', version: '0.2.0', args: 'proxy --port 1' });
  let exited = false;
  const stop = idleRestartWatcher({ home, running: { version: '0.2.0', args: 'proxy --port 1' }, load: () => ({ inFlight: 0, idleMs: 10 ** 6 }), close: () => {}, exit: () => { exited = true; }, every: 5 });
  try {
    await new Promise(r => setTimeout(r, 40));
    assert.equal(exited, false, 'already this version with these flags: no restart');
    assert.equal(restartWanted(home), null, 'and the marker is gone, so nothing asks again');
  } finally { stop(); }
});

test('ensureProxy answers pending when the restart is left to an idle moment, and boots a dead port out now', async () => {
  const m = fakeMachine();
  const srv = http.createServer((req, res) => res.end('x'));
  try {
    const port = await freePort();
    await new Promise(r => srv.listen(port, '127.0.0.1', r));
    fs.mkdirSync(path.join(m.home, 'state'), { recursive: true });
    fs.writeFileSync(path.join(m.home, 'config.json'), JSON.stringify({ proxy: { holdout: 0 } }));
    fs.writeFileSync(path.join(m.home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port, ports: [port], pid: process.pid, args: serviceArgs(m.home, { port }).join(' '), version: '0.0.1' }));
    const calls = [];
    const r = await ensureProxy({ cli: CLI, home: m.home, restartGrace: 0, restartFn: o => { calls.push(o); return 'pending'; } });
    assert.deepEqual(r, { on: true, running: true, pending: `a new version (0.0.1 -> ${appVersion()})` });
    assert.equal(calls[0].whenIdle, undefined, 'a listening service is asked to go when idle');
    assert.equal(calls[0].why, `a new version (0.0.1 -> ${appVersion()})`);
    srv.close();
    await new Promise(r => setTimeout(r, 50));
    const dead = await ensureProxy({ cli: CLI, home: m.home, wait: 1, restartFn: o => { calls.push(o); return false; } });
    assert.equal(calls[1].whenIdle, false, 'nothing listening: booted out and started now, never left to a marker');
    assert.equal(dead.on, true);
    if (dead.pid) { try { process.kill(dead.pid, 'SIGTERM'); } catch {} }
  } finally { try { srv.close(); } catch {} m.restore(); }
});
