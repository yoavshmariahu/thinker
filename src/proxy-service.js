// The context proxy (proxy.js) as a service of this machine: on by default since 2026-10-24, the owner's decision.
//
// `thinker connect` (so the installer and `setup`) picks a free port once, keeps it in THINKER_HOME/state/proxy-service.json,
// starts `thinker proxy --port <port>` and keeps it running (a LaunchAgent with KeepAlive on macOS, a systemd user unit on
// Linux, and everywhere the prompt hook, which starts it again when nothing listens on the port: a wired base URL with no
// listener would break every session, and the hook is the one thing that runs before each model call; that is the exception
// to the rule that the hooks do nothing but the cache's work), and writes the proxy's URL where each agent that speaks the
// Messages API at a settable base URL reads it: Claude Code's `env.ANTHROPIC_BASE_URL` in `~/.claude/settings.json` (the CLI
// and the IDE extensions; the desktop app sets the variable itself and ignores the file), pi's
// `providers.anthropic.baseUrl` in `~/.pi/agent/models.json`, OpenCode's `provider.anthropic.options.baseURL` in
// `opencode.json`. A person already routing elsewhere is left alone and told: a base URL of their own, or Claude Code on
// Bedrock, Vertex or Foundry (those routes do not speak the Messages format). `thinker proxy off` takes it all out,
// `thinker proxy on` puts it back, `thinker uninstall --user` removes it with the rest of the wiring.
// Codex joins this service by default (owner's request, 2026-10-25): --codex adds a
// fixed OpenAI/ChatGPT Responses route, and proxy-codex.js selects the managed provider.
//
// The service runs with a holdout share (SERVICE_HOLDOUT, 15% of sessions, as the hooks' notes have since 2026-10-04) so
// that `thinker proxy report` compares the two sides on the machine's own work; `proxy: { holdout, trigger, keep, keepMin,
// clearAtLeast }` in THINKER_HOME/config.json changes the service's flags (holdout 0: none).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { thinkerHome } from './update.js';
import { readMachineConfig } from './repo-switch.js';
import { isTestMode } from './test-mode.js';
import { wireCodexProxy } from './proxy-codex.js';
import { routeEvidence, cloudOn, CLOUD_VARS, BASE_URL_VAR } from './proxy-route.js';

export const SERVICE_HOLDOUT = 0.15;
export const PROXY_LABEL = 'com.thinker.proxy';
export const PROXY_ENV = BASE_URL_VAR;
// Claude Code on a cloud route speaks that provider's format, which the proxy does not read
export const OTHER_ROUTES = CLOUD_VARS;

const stateFile = home => path.join(home, 'state', 'proxy-service.json');
const readJson = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || d; } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };

// { enabled, port, ports (every port the service ever had, so an old URL is still known as ours), since, off, pid }
export const serviceState = (home = thinkerHome()) => readJson(stateFile(home));
export const proxyOn = (home = thinkerHome()) => serviceState(home).enabled === true;
export const urlFor = port => `http://127.0.0.1:${port}`;
export const proxyUrl = (home = thinkerHome()) => { const s = serviceState(home); return s.port ? urlFor(s.port) : null; };
const ownUrls = (home, s = serviceState(home)) => new Set([...(s.ports || []), s.port].filter(Boolean).map(urlFor));
// a URL this machine's service had, trailing slash or not
export const isOwnUrl = (value, home = thinkerHome()) => !!value && ownUrls(home).has(String(value).replace(/\/+$/, ''));
export const logFile = (home = thinkerHome()) => path.join(home, 'state', 'proxy-service.log');
// where the proxy writes a line per request it passes (proxy.js:startProxy); `thinker proxy report` and the
// telemetry's proxy block read it
export const proxyLogFile = (home = thinkerHome(), env = process.env) => env.THINKER_PROXY_LOG || path.join(home, 'state', 'proxy.jsonl');

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// up to `wait` ms for something to listen on the port
export async function waitListening(port, wait, { step = 50 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < wait) { if (await isListening(port, { timeout: 200 })) return true; await new Promise(r => setTimeout(r, step)); }
  return isListening(port, { timeout: 200 });
}

export function isListening(port, { timeout = 400 } = {}) {
  return new Promise(resolve => {
    if (!port) return resolve(false);
    const c = net.connect({ port, host: '127.0.0.1' });
    const done = v => { try { c.destroy(); } catch {} resolve(v); };
    c.setTimeout(timeout, () => done(false));
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });
}

// the service's flags: the port, the holdout, and what THINKER_HOME/config.json's `proxy` block sets
export function serviceArgs(home = thinkerHome(), state = serviceState(home)) {
  const cfg = readMachineConfig(home).proxy || {};
  const holdout = cfg.holdout == null ? SERVICE_HOLDOUT : Number(cfg.holdout) || 0;
  const args = ['proxy', '--port', String(state.port), '--holdout', String(holdout), '--codex'];
  for (const [key, flag] of [['trigger', '--trigger'], ['keep', '--keep'], ['keepMin', '--keep-min'], ['clearAtLeast', '--clear-at-least'], ['upstream', '--upstream']]) if (cfg[key] != null) args.push(flag, String(cfg[key]));
  for (const [key, flag] of [['clearInputs', '--clear-inputs'], ['clearThinking', '--clear-thinking']]) if (cfg[key] === true) args.push(flag); // off until an experiment (proxy.js)
  return args;
}

// the proxy as a detached process (the hook's way, and the only one where no service manager runs); the pid is kept so
// `off` can stop it
export function startDetached({ cli, home = thinkerHome() }) {
  const s = serviceState(home);
  if (!s.port) return null;
  fs.mkdirSync(path.dirname(logFile(home)), { recursive: true });
  const fd = fs.openSync(logFile(home), 'a');
  const child = spawn(process.execPath, [cli, ...serviceArgs(home, s)], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, THINKER_HOME: home } });
  child.unref();
  try { fs.closeSync(fd); } catch {}
  writeJson(stateFile(home), { ...s, pid: child.pid, startedAt: new Date().toISOString() });
  return child.pid;
}

// From the prompt hook on every prompt: nothing when the service is off or already listening (one connect, under a
// millisecond); else the proxy is started and given `wait` ms to listen before the hook returns, so the agent's next
// model call finds it.
export async function ensureProxy({ cli, home = thinkerHome(), wait = 1500 } = {}) {
  const s = serviceState(home);
  if (!s.enabled || !s.port) return { on: false };
  // the setting taken out by hand is an answer, and this is the first thing that runs after it: the service goes,
  // rather than the URL being written in again on the next update (`removedByHand`)
  const gone = trackClaude({ home }) || removedByHand({ home }) || routeAppeared({ home });
  if (gone) { standDown(gone, { home }); return { on: false, stoodDown: gone }; }
  if (await isListening(s.port)) return { on: true, running: true };
  const pid = startDetached({ cli, home });
  const listening = await waitListening(s.port, wait);
  return { on: true, started: true, pid, listening };
}

const plistPath = home => path.join(isTestMode() ? path.join(home, 'LaunchAgents') : path.join(os.homedir(), 'Library', 'LaunchAgents'), `${PROXY_LABEL}.plist`);
const unitPath = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'thinker-proxy.service');
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
export function plistText({ cli, home = thinkerHome(), args = serviceArgs(home) }) {
  const items = [process.execPath, cli, ...args].map(a => `        <string>${xml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PROXY_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${items}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>THINKER_HOME</key>
        <string>${xml(home)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>${xml(logFile(home))}</string>
    <key>StandardOutPath</key>
    <string>${xml(logFile(home))}</string>
</dict>
</plist>
`;
}
export function unitText({ cli, home = thinkerHome(), args = serviceArgs(home) }) {
  const q = a => `"${String(a).replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=thinker context proxy

[Service]
Environment=THINKER_HOME=${home}
ExecStart=${[process.execPath, cli, ...args].map(q).join(' ')}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}
const run = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const uid = () => os.userInfo().uid;
const hasSystemd = () => process.platform === 'linux' && run('systemctl', ['--user', 'show-environment']);

// the service manager's entry: launchd on macOS, systemd on Linux with a user session; elsewhere the hook alone
export function installService({ cli, home = thinkerHome(), manage = !isTestMode() } = {}) {
  const s = serviceState(home);
  if (!s.port) return { type: 'none' };
  if (process.platform === 'darwin') {
    const p = plistPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (manage) run('launchctl', ['bootout', `gui/${uid()}/${PROXY_LABEL}`]);
    fs.writeFileSync(p, plistText({ cli, home }));
    if (manage && !run('launchctl', ['bootstrap', `gui/${uid()}`, p]) && !run('launchctl', ['load', p])) return { type: 'hook', path: p, reason: 'launchctl refused the agent' };
    return { type: 'launchd', path: p };
  }
  if (hasSystemd()) {
    const u = unitPath();
    fs.mkdirSync(path.dirname(u), { recursive: true });
    fs.writeFileSync(u, unitText({ cli, home }));
    if (manage) { run('systemctl', ['--user', 'daemon-reload']); if (!run('systemctl', ['--user', 'enable', '--now', 'thinker-proxy.service'])) return { type: 'hook', path: u, reason: 'systemctl refused the unit' }; }
    return { type: 'systemd', path: u };
  }
  return { type: 'hook' };
}
export function uninstallService({ home = thinkerHome(), manage = !isTestMode() } = {}) {
  const done = [];
  const p = plistPath(home);
  if (fs.existsSync(p)) { if (manage) run('launchctl', ['bootout', `gui/${uid()}/${PROXY_LABEL}`]); fs.rmSync(p, { force: true }); done.push(p); }
  const u = unitPath();
  if (fs.existsSync(u)) { if (manage) { run('systemctl', ['--user', 'disable', '--now', 'thinker-proxy.service']); } fs.rmSync(u, { force: true }); if (manage) run('systemctl', ['--user', 'daemon-reload']); done.push(u); }
  const s = serviceState(home);
  if (s.pid && manage) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  return done;
}
// after an update the service runs the old code until it is started again
export function restartService({ cli, home = thinkerHome(), manage = !isTestMode() } = {}) {
  const s = serviceState(home);
  if (!s.enabled || !manage) return false;
  if (process.platform === 'darwin' && fs.existsSync(plistPath(home))) {
    const p = plistPath(home);
    fs.writeFileSync(p, plistText({ cli, home }));
    run('launchctl', ['bootout', `gui/${uid()}/${PROXY_LABEL}`]); // kickstart -k would restart the old ProgramArguments
    return run('launchctl', ['bootstrap', `gui/${uid()}`, p]) || run('launchctl', ['load', p]);
  }
  if (fs.existsSync(unitPath())) { fs.writeFileSync(unitPath(), unitText({ cli, home })); run('systemctl', ['--user', 'daemon-reload']); return run('systemctl', ['--user', 'restart', 'thinker-proxy.service']); }
  if (s.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  return true; // the next prompt's hook starts the new code
}

// --- the agents' configuration ---

// Why Claude Code is left alone, or null: a route of the person's own anywhere this machine keeps one -- the
// settings' env block, the process environment, a shell's startup file, the user's settings.local.json, the
// enterprise policy file (proxy-route.js:routeEvidence) -- or a cloud route. A gateway that routes to models of
// its own is the common case, and its token is not Anthropic's: forwarding it would fail every call of every
// session, so anything short of certainty leaves the person's settings as they are.
export function claudeBlocker(settings, { home = thinkerHome(), env = process.env, repos = [] } = {}) {
  const inFile = settings?.env?.[PROXY_ENV];
  if (inFile && !isOwnUrl(inFile, home)) return `${PROXY_ENV} is already ${inFile} in the settings`;
  if (env[PROXY_ENV] && !isOwnUrl(env[PROXY_ENV], home)) return `${PROXY_ENV} is ${env[PROXY_ENV]} in your environment`;
  for (const k of OTHER_ROUTES) if (cloudOn(settings?.env?.[k] || env[k])) return `Claude Code runs on ${k.replace('CLAUDE_CODE_USE_', '').toLowerCase()}, which the proxy does not speak`;
  const [found] = routeEvidence({ env, repos, isOwn: u => isOwnUrl(u, home), limit: 1 });
  return found ? `${found.what} in ${found.where}` : null;
}
const setEnv = (settings, value) => {
  const e = { ...(settings.env || {}) };
  if (value) e[PROXY_ENV] = value; else delete e[PROXY_ENV];
  const out = { ...settings, env: e };
  if (!Object.keys(e).length) delete out.env;
  return out;
};
export const withProxyUrl = (settings, url) => setEnv(settings, url);
export const withoutProxyUrl = (settings, home = thinkerHome()) => isOwnUrl(settings?.env?.[PROXY_ENV], home) ? setEnv(settings, null) : settings;

// in test mode an agent's real file is left alone unless the test names the directory (test/proxy-service.test.js:fakeMachine)
const testGuard = key => (isTestMode() && !process.env[key] ? `test mode and ${key} is not set: the real file is left alone` : null);
const claudeSettings = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const piModels = () => path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'models.json');
const opencodeDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');

// pi: models.json `providers.anthropic.baseUrl`, set when absent or ours
function piFile(url, home) {
  const f = piModels();
  const guard = testGuard('PI_CODING_AGENT_DIR'); if (guard) return url ? { file: f, skipped: guard } : { file: f, unchanged: true };
  const cur = readJson(f);
  const have = cur.providers?.anthropic?.baseUrl;
  if (url) {
    if (have && !isOwnUrl(have, home)) return { file: f, skipped: `providers.anthropic.baseUrl is already ${have}` };
    if (have === url) return { file: f, unchanged: true };
    writeJson(f, { ...cur, providers: { ...(cur.providers || {}), anthropic: { ...(cur.providers?.anthropic || {}), baseUrl: url } } });
    return { file: f, changed: true };
  }
  if (!isOwnUrl(have, home)) return { file: f, unchanged: true };
  const anthropic = { ...cur.providers.anthropic }; delete anthropic.baseUrl;
  const providers = { ...cur.providers }; if (Object.keys(anthropic).length) providers.anthropic = anthropic; else delete providers.anthropic;
  const next = { ...cur }; if (Object.keys(providers).length) next.providers = providers; else delete next.providers;
  if (Object.keys(next).length) writeJson(f, next); else fs.rmSync(f, { force: true });
  return { file: f, changed: true };
}
// OpenCode: opencode.json `provider.anthropic.options.baseURL`; a config kept as opencode.jsonc (comments) is not rewritten
function opencodeFile(url, home) {
  const dir = opencodeDir();
  const f = path.join(dir, 'opencode.json'), fc = path.join(dir, 'opencode.jsonc');
  const guard = testGuard('XDG_CONFIG_HOME'); if (guard) return url ? { file: f, skipped: guard } : { file: f, unchanged: true };
  if (!fs.existsSync(f) && fs.existsSync(fc)) return { file: fc, skipped: url ? 'the config is opencode.jsonc, which thinker does not rewrite: set provider.anthropic.options.baseURL there' : undefined, unchanged: !url };
  const cur = readJson(f);
  const have = cur.provider?.anthropic?.options?.baseURL;
  if (url) {
    if (have && !isOwnUrl(have, home)) return { file: f, skipped: `provider.anthropic.options.baseURL is already ${have}` };
    if (have === url) return { file: f, unchanged: true };
    if (!fs.existsSync(f) && !fs.existsSync(dir)) return { file: f, unchanged: true, absent: true }; // no OpenCode here
    const anthropic = cur.provider?.anthropic || {};
    writeJson(f, { ...cur, provider: { ...(cur.provider || {}), anthropic: { ...anthropic, options: { ...(anthropic.options || {}), baseURL: url } } } });
    return { file: f, changed: true };
  }
  if (!isOwnUrl(have, home)) return { file: f, unchanged: true };
  const options = { ...cur.provider.anthropic.options }; delete options.baseURL;
  const anthropic = { ...cur.provider.anthropic }; if (Object.keys(options).length) anthropic.options = options; else delete anthropic.options;
  const provider = { ...cur.provider }; if (Object.keys(anthropic).length) provider.anthropic = anthropic; else delete provider.anthropic;
  const next = { ...cur }; if (Object.keys(provider).length) next.provider = provider; else delete next.provider;
  writeJson(f, next);
  return { file: f, changed: true };
}
function claudeFile(url, home, env, repos) {
  const f = claudeSettings();
  const guard = testGuard('CLAUDE_CONFIG_DIR'); if (guard) return url ? { file: f, skipped: guard } : { file: f, unchanged: true };
  const cur = readJson(f);
  if (url) {
    const why = claudeBlocker(cur, { home, env, repos });
    if (why) return { file: f, skipped: why };
    if (cur.env?.[PROXY_ENV] === url) return { file: f, unchanged: true };
    writeJson(f, withProxyUrl(cur, url));
    return { file: f, changed: true };
  }
  const next = withoutProxyUrl(cur, home);
  if (next === cur) return { file: f, unchanged: true };
  writeJson(f, next);
  return { file: f, changed: true };
}

// Whether the proxy's URL is in Claude Code's settings now: true, false (the file is there and it is not), or
// null where the file cannot be judged -- no settings file at all (no Claude Code on this machine), an unreadable
// one, test mode without CLAUDE_CONFIG_DIR. Null is never read as a removal.
export function claudeWired(home = thinkerHome()) {
  if (testGuard('CLAUDE_CONFIG_DIR')) return null;
  let cur; try { cur = JSON.parse(fs.readFileSync(claudeSettings(), 'utf8')); } catch { return null; }
  return isOwnUrl(cur?.env?.[PROXY_ENV], home);
}

// A service enabled before this version kept no record of what it wrote (`wroteClaude`), so what the settings
// hold now becomes the baseline and a later removal reads as the person's answer. Where the URL is not there and
// no route of the person's own explains its absence, it was taken out before this version arrived: that is the
// machine the proxy broke, and it steps aside at once.
export function trackClaude({ home = thinkerHome(), env = process.env } = {}) {
  const s = serviceState(home);
  if (!s.enabled || s.wroteClaude !== undefined) return null;
  const wired = claudeWired(home);
  if (wired === null) return null;
  const record = v => writeJson(stateFile(home), { ...serviceState(home), wroteClaude: v });
  if (wired) { record(true); return null; }
  let settings = {}; try { settings = JSON.parse(fs.readFileSync(claudeSettings(), 'utf8')) || {}; } catch {}
  if (claudeBlocker(settings, { home, env })) { record(false); return null; }
  return 'its URL is not in Claude Code\'s settings: it was taken out';
}

// The person took the proxy out of Claude Code's settings by hand -- deleted the line, or pointed the agent at a
// gateway of their own -- which is an answer: the service does not put it back. Before 2026-10-28 it did: the
// rewire after the daily update wrote the URL in again and the launchd job restarted the process, so someone
// whose harness the proxy had broken could delete the setting, kill the process, and have both back the next day.
export function removedByHand({ home = thinkerHome() } = {}) {
  const s = serviceState(home);
  if (!s.enabled || !s.wroteClaude) return null;
  // no path in the reason: it is sent with the telemetry (telemetry.js:proxyMetrics), and every reason a
  // stand-down carries must be a sentence of thinker's own with nothing of this machine in it
  return claudeWired(home) === false ? 'its URL was taken out of Claude Code\'s settings by hand' : null;
}

// A route of the person's own that turned up after the wiring: a gateway they have just set up, an export added
// to a shell file, a policy file that arrived. The prompt hook runs before the model call, so the proxy can step
// aside before anything fails rather than after the API has refused a request (proxy.js:authWatch is the net for
// the clients the hook never runs in).
export function routeAppeared({ home = thinkerHome(), env = process.env } = {}) {
  const s = serviceState(home);
  if (!s.enabled || s.wroteClaude !== true) return null;
  let settings = {}; try { settings = JSON.parse(fs.readFileSync(claudeSettings(), 'utf8')) || {}; } catch { return null; }
  return claudeBlocker(settings, { home, env });
}

// The proxy steps aside and stays aside: the URL out of every agent's file, the service entry and process gone,
// the reason kept so `thinker proxy status` and the next turn's notice can say it, and `enableProxyService`
// leaves it off until someone runs `thinker proxy on`. Called when a route of the person's own turns up after the
// wiring (proxy.js: credentials that are not Anthropic's, or the API refusing them) and when the setting is taken
// out by hand. No-op unless this machine's service is the one in question.
export function standDown(reason, { home = thinkerHome(), manage, port } = {}) {
  const s = serviceState(home);
  if (!s.enabled || (port && s.port !== port)) return null;
  const r = disableProxyService({ home, manage });
  writeJson(stateFile(home), { ...serviceState(home), standDown: { at: new Date().toISOString(), reason } });
  return { ...r, reason };
}

// The URL written to (url given) or taken out of (null) every agent's file. Returns what changed and what was left
// alone with the reason, by agent.
export function wireAgents(url, { home = thinkerHome(), env = process.env, agents = ['claude', 'pi', 'opencode', 'codex'], repos = [] } = {}) {
  const out = { changed: [], skipped: [], unchanged: [] };
  const fns = { claude: () => claudeFile(url, home, env, repos), pi: () => piFile(url, home), opencode: () => opencodeFile(url, home), codex: () => wireCodexProxy(url, { home, env }) };
  for (const a of agents) {
    let r; try { r = fns[a](); } catch (e) { r = { skipped: e.message }; }
    if (r.changed) out.changed.push({ agent: a, file: r.file });
    else if (r.skipped) out.skipped.push({ agent: a, file: r.file, reason: r.skipped });
    else out.unchanged.push({ agent: a, file: r.file });
  }
  return out;
}

// `thinker proxy on` (force), `connect`: the port once, the service, the agents' files.
// A service that stood down (the person's own route, or the setting deleted) stays off until `thinker proxy on`
// asks for it: rerunning the installer or `thinker connect` does not put it back.
export async function enableProxyService({ cli, home = thinkerHome(), env = process.env, manage, force = false, repos = [] } = {}) {
  const s = serviceState(home);
  // `stoodDown` is the reason, as `ensureProxy` returns it
  if (s.standDown && !force) return { stoodDown: s.standDown.reason || 'it stood aside earlier', at: s.standDown.at, port: s.port, url: s.port ? urlFor(s.port) : null, service: { type: 'none' }, wired: { changed: [], skipped: [], unchanged: [] } };
  const port = s.port || await freePort();
  const ports = [...new Set([...(s.ports || []), port])];
  writeJson(stateFile(home), { ...s, enabled: true, port, ports, since: s.since || new Date().toISOString(), off: undefined, standDown: undefined, wroteClaude: undefined });
  const service = installService({ cli, home, manage });
  const wired = wireAgents(urlFor(port), { home, env, repos });
  // whether Claude Code's settings hold the URL, so that its disappearance can be read as the person's answer
  // (`removedByHand`) rather than as a file to write again
  if (claudeWired(home)) writeJson(stateFile(home), { ...serviceState(home), wroteClaude: true });
  let listening = null;
  if (manage !== false) {
    listening = ['launchd', 'systemd'].includes(service.type) ? await waitListening(port, 2500) : false;
    if (!listening) listening = (await ensureProxy({ cli, home })).listening !== false;
  }
  return { port, url: urlFor(port), service, wired, listening };
}
// `thinker proxy off`, `uninstall --user`: the agents' files first (a session started now goes straight to the API),
// then the service
export function disableProxyService({ home = thinkerHome(), manage, keepState = true } = {}) {
  const wired = wireAgents(null, { home });
  const removed = uninstallService({ home, manage });
  const s = serviceState(home);
  if (keepState) writeJson(stateFile(home), { ...s, enabled: false, off: new Date().toISOString(), pid: undefined, wroteClaude: undefined });
  else fs.rmSync(stateFile(home), { force: true });
  return { wired, removed };
}

// one line per agent for the commands' output
export function wiredLines(wired, url) {
  const lines = [];
  const names = { claude: 'Claude Code', pi: 'pi', opencode: 'OpenCode', codex: 'Codex' };
  for (const c of wired.changed) lines.push(`${names[c.agent]}: ${url ? `model calls go through the proxy (${url}, ${c.file})` : `the proxy's URL taken out of ${c.file}`}`);
  for (const s of wired.skipped) lines.push(`${names[s.agent]}: left as it is, ${s.reason}`);
  return lines;
}
