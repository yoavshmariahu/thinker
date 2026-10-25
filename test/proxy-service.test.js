import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { serviceState, proxyOn, proxyUrl, isOwnUrl, freePort, isListening, serviceArgs, plistText, unitText, claudeBlocker, withProxyUrl, withoutProxyUrl,
  wireAgents, enableProxyService, disableProxyService, ensureProxy, installService, uninstallService, wiredLines, SERVICE_HOLDOUT, PROXY_ENV, PROXY_LABEL } from '../src/proxy-service.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// every agent's file under one temporary home: Claude Code's settings, pi's models.json, OpenCode's opencode.json
function fakeMachine() {
  const root = tmp('thinker-proxy-service-');
  const home = path.join(root, 'thinker');
  const env = { CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), PI_CODING_AGENT_DIR: path.join(root, 'pi'), XDG_CONFIG_HOME: path.join(root, 'config') };
  const saved = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'opencode'), { recursive: true });
  const files = { claude: path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), pi: path.join(env.PI_CODING_AGENT_DIR, 'models.json'), opencode: path.join(env.XDG_CONFIG_HOME, 'opencode', 'opencode.json') };
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(root, { recursive: true, force: true }); };
  return { root, home, env, files, restore };
}

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
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout: 0, clearInputs: true, clearThinking: true } }));
    assert.deepEqual(serviceArgs(home), ['proxy', '--port', '6901', '--holdout', '0', '--codex', '--clear-inputs', '--clear-thinking'], 'the two off-by-default policies, as flags when the config turns them on');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout: 0, clearInputs: 'yes' } }));
    assert.deepEqual(serviceArgs(home), ['proxy', '--port', '6901', '--holdout', '0', '--codex'], 'only true turns one on');
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
