import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { serviceState, proxyOn, proxyUrl, isOwnUrl, freePort, isListening, serviceArgs, plistText, unitText, claudeBlocker, withProxyUrl, withoutProxyUrl,
  wireAgents, enableProxyService, disableProxyService, ensureProxy, installService, uninstallService, wiredLines, removedByHand, standDown, claudeWired, trackClaude, routeAppeared, proxyThrough, SERVICE_HOLDOUT, PROXY_ENV, PROXY_LABEL } from '../src/proxy-service.js';

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
