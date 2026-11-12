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
// The service runs with no holdout (SERVICE_HOLDOUT 0 since 2026-11-12, the owner's call; half of the sessions from
// 2026-11-09, 15% from 2026-10-24). The holdout compared sessions that got a cut with sessions held out from one, and a
// session that gets a cut is a long session, so the two sides were never like with like, and at half the sessions it
// cost every install half the saving to answer a question it could not answer. What it was kept for -- the model
// reading again what was cleared -- is read out of each session's own transcript instead (rereads.js) and taken off
// the netted saving (delivery.js); whether the answers got worse is the graded run's question (Artemis).
// `proxy: { holdout, trigger, keep, keepMin, clearAtLeast }` in THINKER_HOME/config.json changes the service's flags
// (holdout 0.5: an experiment arm, read by the Factory's "see diff by"). The desktop mod mirrors the share
// (claude-clear/hooks/register.tsx:HOLDOUT).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { thinkerHome } from './update.js';
import { readMachineConfig } from './repo-switch.js';
import { isTestMode } from './test-mode.js';
import { containerKind, inContainer } from './container-kind.js';
import { wireCodexProxy } from './proxy-codex.js';
import { routeEvidence, ownGateway, cloudOn, isAnthropicHost, CLOUD_VARS, BASE_URL_VAR } from './proxy-route.js';
import { bedrockState, prepareBedrock, commitBedrock, wireBedrock, restoreBedrock } from './proxy-bedrock.js';

export const SERVICE_HOLDOUT = 0;
export const PROXY_LABEL = 'com.thinker.proxy';
export const PROXY_ENV = BASE_URL_VAR;
// Claude Code on a cloud route speaks that provider's format, which the proxy does not read
export const OTHER_ROUTES = CLOUD_VARS;

const stateFile = home => path.join(home, 'state', 'proxy-service.json');
const readJson = (f, d = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || d; } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
// Only transport settings belong in the service environment, never a model API key. Keep the
// shell's settings across launchd/systemd restarts; Claude's env block may supply them too.
const NETWORK_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
export function serviceNetworkEnv(home = thinkerHome(), env = process.env) {
  const settings = (!isTestMode() || env.CLAUDE_CONFIG_DIR) ? readJson(path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json')).env : {};
  const pick = e => Object.fromEntries(NETWORK_KEYS.filter(k => typeof e?.[k] === 'string').map(k => [k, e[k]]));
  return { ...pick(serviceState(home).networkEnv), ...pick(settings), ...pick(env) };
}
function saveNetworkEnv(home, env) {
  writeJson(stateFile(home), { ...serviceState(home), networkEnv: serviceNetworkEnv(home, env) });
  fs.chmodSync(stateFile(home), 0o600); // a proxy URL can carry transport credentials
}
// Only a process that successfully bound the service's port may claim to be the running service.
export function recordProxyListening(port, { home = thinkerHome(), pid = process.pid } = {}) {
  const s = serviceState(home);
  if (!s.enabled || s.port !== port) return;
  clearRestartWanted(home); // whatever asked for a restart has it now
  // `idleRestart`: this instance watches the marker. An instance from before it (none recorded) is booted out as before,
  // since a marker left for it would wait for ever.
  writeJson(stateFile(home), { ...s, pid, startedAt: new Date().toISOString(), args: serviceArgs(home, s).join(' '), version: appVersion(), idleRestart: true });
}
// An agent's own file, read in order to write it back. `readJson` answers `{}` for anything it cannot parse, and
// writing that back replaced a whole settings file -- permissions, hooks, model, every env of the person's -- with
// thinker's one key. A file with a comment in it, a trailing comma, or one caught half-written by another process
// is left exactly as it is and named instead. An absent or empty file is a new one and is fine to write.
const readForWrite = f => {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { return { value: {} }; }
  if (!text.trim()) return { value: {} };
  try { const v = JSON.parse(text); return { value: v && typeof v === 'object' ? v : {} }; }
  catch { return { why: `${path.basename(f)} is not valid JSON, so thinker left it alone` }; }
};

// { enabled, port, ports (every port the service ever had, so an old URL is still known as ours), since, off, pid }
export const serviceState = (home = thinkerHome()) => readJson(stateFile(home));
export const proxyOn = (home = thinkerHome()) => serviceState(home).enabled === true;
export const urlFor = port => `http://127.0.0.1:${port}`;
export const proxyUrl = (home = thinkerHome()) => { const s = serviceState(home); return s.port ? urlFor(s.port) : null; };
const ownUrls = (home, s = serviceState(home)) => new Set([...(s.ports || []), s.port].filter(Boolean).map(urlFor));
const trimUrl = v => String(v || '').replace(/\/+$/, '');
// Where the proxy sends what it receives. The default is Anthropic's API; a person who routes Claude Code
// through a model server of their own can have the proxy sit in front of that instead (`thinker proxy on
// --gateway`, the question in proxy-offer.js), which is the only way the clearing reaches those sessions at all.
// Kept in the service's own state rather than written into the machine's config.json, which is the person's file;
// `proxy: { upstream }` there still wins for anyone who set it by hand. Anthropic's own host is the default
// and never a gateway (proxy-route.js:isAnthropicHost): a state that holds it -- written by a yes to the repair
// question on 2026-11-01, when the desktop app's own ANTHROPIC_BASE_URL was taken for a model server -- reads
// as no upstream, so the flags, the status line and `isOwnRoute` all say the ordinary route.
export const proxyThrough = (home = thinkerHome()) => { const u = readMachineConfig(home).proxy?.upstream || serviceState(home).upstream || null; return u && !isAnthropicHost(u) ? u : null; };
// A route of the person's own that the proxy forwards to is not a reason to leave their settings alone: pointing
// the agent at the proxy keeps every request going to the same place, with the same credentials, plus the edit.
export const isOwnRoute = (value, home = thinkerHome()) => isOwnUrl(value, home) || (!!value && trimUrl(value) === trimUrl(proxyThrough(home)));
// a URL this machine's service had, trailing slash or not
export const isOwnUrl = (value, home = thinkerHome()) => !!value && ownUrls(home).has(String(value).replace(/\/+$/, '').replace(/\/bedrock$/, ''));
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
export async function waitListening(port, wait, { step = 50, ready = () => true } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < wait) { if (await isListening(port, { timeout: 200 }) && ready()) return true; await new Promise(r => setTimeout(r, step)); }
  return await isListening(port, { timeout: 200 }) && ready();
}

// The OS accepts connections before the child's `listening` callback has recorded its
// ownership. Wait for both: `off` needs the PID, and the next hook needs the flags and
// version to avoid restarting a process that has only just started. A detached child
// that failed to bind must not borrow readiness from some other listener on the port.
function waitProxyStarted(home, port, wait, pid) {
  const args = serviceArgs(home).join(' '), version = appVersion();
  return waitListening(port, wait, { ready: () => {
    const s = serviceState(home);
    return s.enabled === true && s.port === port && Number.isSafeInteger(s.pid) && s.pid > 0 &&
      (pid === undefined || s.pid === pid) && s.args === args && s.version === version;
  } });
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
  if (bedrockState(home)) args.push('--bedrock');
  const upstream = proxyThrough(home);
  for (const [key, flag] of [['trigger', '--trigger'], ['keep', '--keep'], ['keepMin', '--keep-min'], ['clearAtLeast', '--clear-at-least']]) if (cfg[key] != null) args.push(flag, String(cfg[key]));
  if (upstream) args.push('--upstream', String(upstream));
  // on by default (proxy.js:PROXY_DEFAULTS, 2026-10-28); a machine config that says false keeps that clear off
  for (const [key, flag] of [['clearDeep', 'clear-deep']]) {
    if (cfg[key] === false) args.push(`--no-${flag}`);
    else if (cfg[key] === true) args.push(`--${flag}`);
  }
  // the model gateways (proxy.js): `gateways: { openrouter: true | '<upstream>', litellm: 'https://…' }`
  // in the `proxy` block. OpenRouter needs no URL; a string moves the same door to another
  // upstream (a self-hosted mirror, a test fixture); any other gateway is its base URL, and a
  // new one is an entry here, read by the same door.
  const gateways = cfg.gateways && typeof cfg.gateways === 'object' ? cfg.gateways : {};
  if (gateways.openrouter === true || (typeof gateways.openrouter === 'string' && gateways.openrouter)) args.push('--gateway-openrouter', ...(typeof gateways.openrouter === 'string' ? [gateways.openrouter] : []));
  if (typeof gateways.litellm === 'string' && gateways.litellm) args.push('--gateway-litellm', gateways.litellm);
  return args;
}

// the proxy as a detached process (the hook's way, and the only one where no service manager runs); the pid is kept so
// `off` can stop it
// The version of the copy this process runs from, recorded with the flags a running proxy was started with
// Why a running service has to be replaced, or null when it already runs this version with the flags this copy would
// start it with. One answer for the prompt hook (`ensureProxy`) and for `thinker rewire`: until 2026-11-06 rewire
// restarted the service whenever the proxy was on, and the background update runs rewire every four hours whether or
// not it installed anything, so this machine's proxy was taken down five times a day to be started again as it was.
export function replaceReason(home = thinkerHome(), s = serviceState(home)) {
  const want = serviceArgs(home, s).join(' '), version = appVersion();
  if (s.args === want && s.version === version) return null;
  return s.args === undefined ? 'the first run that records them' : s.version !== version ? `a new version (${s.version || 'unknown'} -> ${version})` : 'the flags changed';
}
export const appVersion = () => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || null; } catch { return null; } };

export function startDetached({ cli, home = thinkerHome() }) {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') return null;
  saveNetworkEnv(home, process.env);
  const s = serviceState(home);
  if (!s.port) return null;
  fs.mkdirSync(path.dirname(logFile(home)), { recursive: true });
  const fd = fs.openSync(logFile(home), 'a');
  const child = spawn(process.execPath, [cli, ...serviceArgs(home, s)], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...serviceNetworkEnv(home), THINKER_HOME: home } });
  child.unref();
  try { fs.closeSync(fd); } catch {}
  return child.pid;
}

// From the prompt hook on every prompt: nothing when the service is off or already listening (one connect, under a
// millisecond); else the proxy is started and given `wait` ms to listen before the hook returns, so the agent's next
// model call finds it.
// How long one session's replacement of a running proxy stands for every other session's hook.
//
// `thinker update` changes the version for the whole machine at once, and the next prompt in every
// session reaches the branch below and replaces the proxy -- each replacement a SIGTERM to a process
// that is streaming other sessions' answers, and each new process racing the service manager for the
// port. On this machine's log: 105 recorded starts against 26,245 EADDRINUSE lines. One of them needs
// to do it, so the first to arrive claims it and the rest find the proxy they wanted on their next
// prompt. Keyed on what the restart is for, so a genuinely different target (another version, changed
// flags) is never held back by a claim made for the previous one, and left behind to expire rather than
// released on success: the window that matters is the one between SIGTERM and the new process recording
// its own version, where every other hook still reads the old state and would restart it again.
export const RESTART_GRACE_MS = 30000;
export function claimRestart(home, target, { now = Date.now(), grace = RESTART_GRACE_MS } = {}) {
  const f = path.join(home, 'state', 'proxy-restart.json');
  const mine = JSON.stringify({ target, at: new Date(now).toISOString(), pid: process.pid });
  // `wx` is the claim: the file is created by one caller or by none, which two hooks reading and then
  // writing could not promise each other.
  const take = () => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, mine, { flag: 'wx' }); return true; } catch { return false; } };
  if (take()) return true;
  const prev = readJson(f, null);
  const at = prev?.at ? Date.parse(prev.at) : 0;
  if (prev?.target === target && now - at < grace) return false;   // another session has this one in hand
  try { fs.unlinkSync(f); } catch { /* another caller got there first, and then it is theirs */ }
  return take();
}

export async function ensureProxy({ cli, home = thinkerHome(), wait = 1500, restartFn = restartService, restartGrace = RESTART_GRACE_MS } = {}) {
  const s = serviceState(home);
  if (!s.enabled || !s.port) return { on: false };
  // the setting taken out by hand is an answer, and this is the first thing that runs after it: the service goes,
  // rather than the URL being written in again on the next update (`removedByHand`)
  const gone = trackClaude({ home }) || removedByHand({ home }) || routeAppeared({ home });
  if (gone) { standDown(gone, { home }); return { on: false, stoodDown: gone }; }
  if (await isListening(s.port)) {
    // A running proxy keeps the flags, the routes and the code it was started with, and nothing replaced it: this
    // function only ever started one when none was listening. So a new clearing policy, a `--gateway` upstream or
    // a route added to the proxy reached nobody until the process happened to die. On this machine a proxy from
    // 2026-10-24 served 0.2.11's flags for four days -- no `/codex` route, so every Codex model call answered 404.
    // The prompt hook is the quiet moment to replace it: between turns, with no request of the agent's in flight.
    // A state without the record (every machine, the first time this runs) counts as different, so each is
    // replaced once and picks up the present policy.
    const why = replaceReason(home, s);
    if (!why) return { on: true, running: true };
    const version = appVersion(), want = serviceArgs(home, s).join(' ');
    // One session replaces it; the others would only be SIGTERMing a process mid-answer (`claimRestart`).
    // Only this branch is gated: a port with nothing on it is a broken route for every session, and must
    // never wait on another session's claim.
    if (!claimRestart(home, `${version} ${want}`, { grace: restartGrace })) return { on: true, running: true, deferred: 'another session is replacing it' };
    // Let the installed service manager own the process. Starting a detached competitor here
    // caused repeated EADDRINUSE crashes, and could inherit the invoking agent's network sandbox.
    saveNetworkEnv(home, process.env);
    const r = restartFn({ cli, home, managedOnly: true, why });
    if (r === 'pending') return { on: true, running: true, pending: why }; // it goes at its first idle moment
    if (r) {
      const listening = await waitProxyStarted(home, s.port, wait);
      if (listening) return { on: true, restarted: true, why, managed: true, listening };
      // Something is on the port without having recorded its startup -- a proxy mid-start, or another
      // process entirely. Claim nothing and start nothing: a competitor there is the EADDRINUSE race this
      // branch exists to avoid.
      if (await isListening(s.port)) return { on: true, restarted: true, why, managed: true, listening };
      // Nothing is on the port at all, and the manager said yes: a stub `systemctl` (every devcontainer
      // image ships one), a unit it refused, a launchd agent that never came up. Start it here, because an
      // agent pointed at a dead port is the one outcome worse than no proxy.
      const own = startDetached({ cli, home });
      return { on: true, restarted: true, why, managed: false, fellBack: 'the service manager started nothing', pid: own, listening: await waitProxyStarted(home, s.port, wait, own) };
    }
    if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') return { on: true, running: true, deferred: 'network-restricted hook' };
    if (s.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
    const pid = startDetached({ cli, home });
    const listening = await waitProxyStarted(home, s.port, wait, pid);
    return { on: true, restarted: true, why, pid, listening };
  }
  saveNetworkEnv(home, process.env);
  if (restartFn({ cli, home, managedOnly: true, whenIdle: false })) {
    const listening = await waitProxyStarted(home, s.port, wait);
    if (listening) return { on: true, started: true, managed: true, listening };
    // as above: a listener that has not recorded ownership is left alone and claimed for nothing; a dead
    // port after the manager said yes is started here
    if (await isListening(s.port)) return { on: true, started: true, managed: true, listening };
    const own = startDetached({ cli, home });
    const up = await waitProxyStarted(home, s.port, wait, own);
    if (!up && !(await isListening(s.port))) return { ...deadPort({ cli, home }), started: true, managed: false, fellBack: 'the service manager started nothing' };
    return { on: true, started: true, managed: false, fellBack: 'the service manager started nothing', pid: own, listening: up };
  }
  const pid = startDetached({ cli, home });
  const listening = await waitProxyStarted(home, s.port, wait, pid);
  if (!listening && !(await isListening(s.port))) return { ...deadPort({ cli, home }), started: true, pid };
  return { on: true, started: true, pid, listening };
}

// An agent routed at a proxy that is not there fails every model call, which is worse than no proxy at all
// (the mandatory rule: thinker never trades a working harness for itself). On a host, a port that is dead
// for a moment is ordinary -- the next prompt starts it, and the agent's own requests have not begun -- so
// nothing is given up on. In a container it is not ordinary: measured on 2026-11-05 in a devcontainer, a
// proxy spawned by a short-lived parent bound its port, logged its banner and was gone seconds later, and
// nothing a later hook did brought it back, so the route would have stayed dead for the life of the
// container. There the service stands down instead: the URL comes out of every agent's file, those sessions
// go straight to the API, and `thinker proxy on` is the only thing that turns it back on. The install starts
// the proxy in the form that does survive in a container (`containers.js:installInContainer`), so this is
// the floor, not the normal path.
function deadPort({ cli, home }) {
  if (!inContainer()) return { on: true, listening: false };
  const why = 'the proxy would not stay up in this container';
  try { standDown(why, { home }); } catch {}
  return { on: false, stoodDown: why, listening: false };
}

// The service manager's entry is one per machine, and only the machine's own THINKER_HOME may write or restart it.
// A benchmark or a scratch install runs with a THINKER_HOME of its own, and not always in test mode: on 2026-11-03 a
// clearing-bench arm (THINKER_HOME under a scratchpad, its proxy started without THINKER_TEST) rewrote
// ~/.config/systemd/user/thinker-proxy.service to point at its own port and restarted it, which killed the proxy the
// person's Claude Code was talking through ("Connection lost mid-response", then ECONNREFUSED for 12 hours). Any
// other home keeps its entry under itself and never touches launchctl or systemctl.
const ownsService = home => !isTestMode() && path.resolve(home) === path.resolve(os.homedir(), '.thinker');
const plistPath = home => path.join(ownsService(home) ? path.join(os.homedir(), 'Library', 'LaunchAgents') : path.join(home, 'LaunchAgents'), `${PROXY_LABEL}.plist`);
const unitPath = home => ownsService(home) ? path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', 'thinker-proxy.service') : path.join(home, 'systemd-user', 'thinker-proxy.service');
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
export function plistText({ cli, home = thinkerHome(), args = serviceArgs(home) }) {
  const items = [process.execPath, cli, ...args].map(a => `        <string>${xml(a)}</string>`).join('\n');
  const network = Object.entries(serviceNetworkEnv(home)).map(([k, v]) => `        <key>${k}</key>\n        <string>${xml(v)}</string>`).join('\n');
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
${network}
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
  const network = Object.entries(serviceNetworkEnv(home)).map(([k, v]) => `Environment="${k}=${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`).join('\n');
  return `[Unit]
Description=thinker context proxy

[Service]
Environment=THINKER_HOME=${home}
${network}
ExecStart=${[process.execPath, cli, ...args].map(q).join(' ')}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}
const run = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; } };
const uid = () => os.userInfo().uid;
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// `launchctl bootout` answers before the process is gone: launchd has sent SIGTERM, the proxy is draining the answers
// it is streaming, and the label stays registered until it exits (launchd's own ExitTimeOut, 20 s, then SIGKILL).
// A `bootstrap` of the same label in that window is refused ("Bootstrap failed: 5: Input/output error"), and the
// `load` that stood in for it prints "Load failed" and exits 0 all the same, so `run` read the restart as done.
// Reproduced on a throwaway label on 2026-11-06, after a day in which every `thinker rewire` left the service
// unregistered and nothing listening on the proxy's port until some session's prompt hook found it dead -- 13 to
// 100 seconds of ECONNREFUSED for every other session, seven times in the day. So: wait for the label to leave
// before bootstrapping, believe `bootstrap`'s own exit code, and believe `load` only when the label is there after it.
export const BOOTOUT_WAIT_MS = 25_000;
// the registered instance, as `launchctl print` describes it (`state = SIGTERMed` and the old pid while it drains), or null
export function agentInstance() {
  let out;
  try { out = execFileSync('launchctl', ['print', `gui/${uid()}/${PROXY_LABEL}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
  const args = /^\s*arguments = \{\n([\s\S]*?)\n\s*\}/m.exec(out)?.[1]?.split('\n').map(l => l.trim()).filter(Boolean) || null;
  return { pid: Number(/^\s*pid = (\d+)/m.exec(out)?.[1]) || null, state: /^\s*state = (.+)$/m.exec(out)?.[1]?.trim() || null, args };
}

// --- a restart that waits for the proxy to be idle (2026-11-06) ---
// A restart is a gap: the old process stops listening, drains what it is streaming, the new one boots, and every
// session's model calls are refused in between. Measured on this machine: launchd's KeepAlive brings a cleanly
// exited process back in 0.93 s (7 s if it had run under ten seconds), and Claude Code retries a refused
// connection by itself. So a restart taken at a moment with nothing in flight costs at most one retry delay to
// one request, and the drain -- as long as the longest answer in flight, up to launchd's 20 s cutoff -- is gone.
// Where the service manager would start the same program line again (an update: the program is the app's path,
// which does not change), an update or a rewire no longer boots the service out. It leaves a marker, and the
// proxy exits with 0 at the first idle moment (`idleRestartWatcher`, in the proxy's own process), the manager
// starting it again on the new code; a proxy with no manager starts its own replacement first. Booting out
// is kept for what the manager cannot do: a changed program line (another port, other flags), a stand-down,
// or a port with nothing on it.
export const RESTART_IDLE_MS = 3000;            // nothing in flight, and nothing finished for this long
export const RESTART_PATIENCE_MS = 15 * 60_000; // past this, the first moment with nothing in flight will do
export const RESTART_DEADLINE_MS = 60 * 60_000; // past this, stop listening and drain, as a bootout did
export const restartWantedFile = home => path.join(home, 'state', 'proxy-restart-wanted.json');
export function requestRestart(home, { why = 'restart', respawn = false, version = appVersion(), args = serviceArgs(home).join(' ') } = {}) {
  const f = restartWantedFile(home);
  const had = readJson(f); // the first ask's time stays, so the patience runs from it
  fs.mkdirSync(path.dirname(f), { recursive: true });
  writeJson(f, { at: had.at || new Date().toISOString(), why, respawn, version, args });
}
export const restartWanted = home => { const m = readJson(restartWantedFile(home)); return m.at ? m : null; };
export const clearRestartWanted = home => { try { fs.rmSync(restartWantedFile(home), { force: true }); } catch {} };
// when the proxy should go: 'idle', 'deadline', or null for not yet
export function restartDue(marker, load, { now = Date.now(), idle = RESTART_IDLE_MS, patience = RESTART_PATIENCE_MS, deadline = RESTART_DEADLINE_MS } = {}) {
  if (!marker?.at) return null;
  const waited = now - Date.parse(marker.at);
  if (load.inFlight === 0 && (load.idleMs >= idle || waited >= patience)) return 'idle';
  if (waited >= deadline) return 'deadline';
  return null;
}
// In the proxy's own process: reads the marker every `every` ms and goes when it is due -- stops listening, lets
// what is in flight finish (`close`), starts its replacement where it was asked to (`respawn`), and exits. A marker
// that asks for what this process already is (same version, same flags) is cleared and ignored.
export function idleRestartWatcher({ home, running = null, load, close, respawn = () => {}, exit, log = () => {}, every = 1000, ...limits }) {
  let going = false;
  const tick = () => {
    if (going) return;
    const m = restartWanted(home);
    if (!m) return;
    if (running && m.version === running.version && m.args === running.args) { clearRestartWanted(home); return; }
    const when = restartDue(m, load(), limits);
    if (!when) return;
    going = true; clearInterval(timer);
    log({ op: 'proxy-restart-idle', why: m.why, when, waitedMs: Date.now() - Date.parse(m.at), inFlight: load().inFlight, respawn: !!m.respawn });
    Promise.resolve().then(close).then(() => { if (m.respawn) respawn(); exit(); });
  };
  const timer = setInterval(tick, every); timer.unref?.();
  return () => clearInterval(timer);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
export function bootOutAgent({ wait = BOOTOUT_WAIT_MS, step = 100 } = {}) {
  run('launchctl', ['bootout', `gui/${uid()}/${PROXY_LABEL}`]);
  const t0 = Date.now();
  while (agentInstance()) { if (Date.now() - t0 >= wait) return false; sleepSync(step); }
  return true;
}
// `was` is the pid of the instance being replaced: a `print` after `load` that still names it is the old one draining
export function bootstrapAgent(plist, { was = null } = {}) {
  if (run('launchctl', ['bootstrap', `gui/${uid()}`, plist])) return true;
  if (!run('launchctl', ['load', plist])) return false;
  const inst = agentInstance();
  return !!inst && inst.state !== 'SIGTERMed' && (was == null || inst.pid !== was);
}
// `systemctl` answering is not the same as systemd running this machine. Microsoft's devcontainer images --
// and many other container images -- ship a stub `systemctl` on the PATH that exits 0 for everything and
// starts nothing. Measured on 2026-11-05 in `mcr.microsoft.com/devcontainers/javascript-node:22`:
// `systemctl --user show-environment`, `enable --now` and `restart` all succeeded, a unit was written, the
// service recorded itself as on, and nothing ever listened -- so the agent in the container had
// `ANTHROPIC_BASE_URL` pointing at a dead port and would have failed every model call. systemd is in charge
// only where it booted the machine, which is what `/run/systemd/system` says; the stub cannot fake that.
const hasSystemd = () => process.platform === 'linux' && fs.existsSync('/run/systemd/system') && run('systemctl', ['--user', 'show-environment']);

// the service manager's entry: launchd on macOS, systemd on Linux with a user session; elsewhere the hook alone
export function installService({ cli, home = thinkerHome(), manage = !isTestMode() } = {}) {
  manage = manage && ownsService(home);
  const s = serviceState(home);
  if (!s.port) return { type: 'none' };
  if (process.platform === 'darwin') {
    const p = plistPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (manage) bootOutAgent();
    fs.writeFileSync(p, plistText({ cli, home }), { mode: 0o600 }); fs.chmodSync(p, 0o600);
    if (manage && !bootstrapAgent(p)) return { type: 'hook', path: p, reason: 'launchctl refused the agent' };
    return { type: 'launchd', path: p };
  }
  if (hasSystemd()) {
    const u = unitPath(home);
    fs.mkdirSync(path.dirname(u), { recursive: true });
    fs.writeFileSync(u, unitText({ cli, home }), { mode: 0o600 }); fs.chmodSync(u, 0o600);
    if (manage) { run('systemctl', ['--user', 'daemon-reload']); if (!run('systemctl', ['--user', 'enable', '--now', 'thinker-proxy.service'])) return { type: 'hook', path: u, reason: 'systemctl refused the unit' }; }
    return { type: 'systemd', path: u };
  }
  return { type: 'hook' };
}
export function uninstallService({ home = thinkerHome(), manage = !isTestMode() } = {}) {
  manage = manage && ownsService(home);
  const done = [];
  const p = plistPath(home);
  if (fs.existsSync(p)) { if (manage) run('launchctl', ['bootout', `gui/${uid()}/${PROXY_LABEL}`]); fs.rmSync(p, { force: true }); done.push(p); }
  const u = unitPath(home);
  if (fs.existsSync(u)) { if (manage) { run('systemctl', ['--user', 'disable', '--now', 'thinker-proxy.service']); } fs.rmSync(u, { force: true }); if (manage) run('systemctl', ['--user', 'daemon-reload']); done.push(u); }
  const s = serviceState(home);
  if (s.pid && manage) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  return done;
}
// after an update the service runs the old code until it is started again
// `whenIdle`: leave the marker and let the proxy go at an idle moment, where the manager would start the same
// program line again (answers 'pending'); false boots it out now, for a port with nothing listening on it.
export function restartService({ cli, home = thinkerHome(), manage = !isTestMode(), managedOnly = false, whenIdle = true, why = 'restart' } = {}) {
  manage = manage && ownsService(home);
  const s = serviceState(home);
  if (!s.enabled || !manage) return false;
  if (process.platform === 'darwin' && fs.existsSync(plistPath(home))) {
    const p = plistPath(home);
    fs.writeFileSync(p, plistText({ cli, home }), { mode: 0o600 }); fs.chmodSync(p, 0o600);
    const inst = whenIdle && s.idleRestart ? agentInstance() : null;
    const program = [process.execPath, cli, ...serviceArgs(home, s)].join('\n');
    if (inst?.pid && inst.state === 'running' && inst.args?.join('\n') === program) { requestRestart(home, { why }); return 'pending'; }
    bootOutAgent(); // kickstart -k would restart the old ProgramArguments
    // An old detached competitor may still own the port after bootout.
    if (s.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
    const started = bootstrapAgent(p, { was: s.pid });
    return managedOnly || started; // an installed manager must not race a detached fallback
  }
  if (fs.existsSync(unitPath(home))) {
    const u = unitPath(home), text = unitText({ cli, home });
    let same = false; try { same = fs.readFileSync(u, 'utf8') === text; } catch {}
    fs.writeFileSync(u, text, { mode: 0o600 }); fs.chmodSync(u, 0o600);
    if (whenIdle && s.idleRestart && same && run('systemctl', ['--user', 'is-active', '--quiet', 'thinker-proxy.service'])) { requestRestart(home, { why }); return 'pending'; } // Restart=always brings it back
    run('systemctl', ['--user', 'daemon-reload']);
    const started = run('systemctl', ['--user', 'restart', 'thinker-proxy.service']);
    return managedOnly || started;
  }
  if (managedOnly) return false;
  if (whenIdle && s.idleRestart && s.pid && alive(s.pid)) { requestRestart(home, { why, respawn: true }); return 'pending'; } // it starts its own replacement
  if (s.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  return true; // the next prompt's hook starts the new code
}

// --- the agents' configuration ---

// Why Claude Code is left alone, or null: a route of the person's own anywhere this machine keeps one -- the
// settings' env block, the process environment, a shell's startup file, the user's settings.local.json, the
// enterprise policy file (proxy-route.js:routeEvidence) -- or a cloud route. A gateway that routes to models of
// its own is the common case, and its token is not Anthropic's: forwarding it would fail every call of every
// session, so anything short of certainty leaves the person's settings as they are.
//
// Anthropic's own host is not a route (proxy-route.js:isAnthropicHost): the Claude desktop app puts
// `ANTHROPIC_BASE_URL=https://api.anthropic.com` in every local session's environment, and on 2026-11-01 that
// stood this machine's service down from inside a desktop session.
export function claudeBlocker(settings, { home = thinkerHome(), env = process.env, repos = [] } = {}) {
  const bedrock = bedrockState(home);
  if (bedrock?.managed.ANTHROPIC_BASE_URL && settings?.env?.CLAUDE_CODE_USE_BEDROCK !== '0') return 'The native Bedrock selection was changed in Claude settings; the token route has been left.';
  if (bedrock?.managed.ANTHROPIC_BASE_URL && settings?.env?.ANTHROPIC_AUTH_TOKEN !== bedrock.localToken) return 'The local Bedrock proxy credential was changed in Claude settings.';
  const theirs = v => !!v && !isOwnRoute(v, home) && !isAnthropicHost(v);
  const inFile = settings?.env?.[PROXY_ENV];
  if (theirs(inFile)) return `${PROXY_ENV} is already ${inFile} in the settings`;
  if (theirs(env[PROXY_ENV])) return `${PROXY_ENV} is ${env[PROXY_ENV]} in your environment`;
  for (const k of OTHER_ROUTES) if (!(bedrock && k === 'CLAUDE_CODE_USE_BEDROCK') && cloudOn(settings?.env?.[k] || env[k])) return `Claude Code runs on ${k.replace('CLAUDE_CODE_USE_', '').toLowerCase()}, which the proxy does not speak`;
  const [found] = routeEvidence({ env, repos, isOwn: u => isOwnRoute(u, home), limit: 1, ignoreShellCloud: bedrock ? ['CLAUDE_CODE_USE_BEDROCK'] : [] });
  return found ? `${found.what} in ${found.where}` : null;
}
const setEnv = (settings, value) => {
  const e = { ...(settings.env || {}) };
  if (value) e[PROXY_ENV] = value; else delete e[PROXY_ENV];
  const out = { ...settings, env: e };
  if (!Object.keys(e).length) delete out.env;
  return out;
};
// Taking over a route of the person's own happens in one case only: they asked the proxy to sit in front of
// their model server (`--gateway`), so `isOwnRoute` lets the write through. The value replaced is kept here, and
// unwiring puts it back. Without that, `thinker proxy off` deleted the key -- thinker's own by then -- and their
// gateway URL was gone from the file: Claude Code would go straight to the API with a token minted for their
// server, which is the failure of 2026-10-28 all over again, caused by thinker on its way out.
const rememberReplaced = (home, agent, url) => writeJson(stateFile(home), { ...serviceState(home), replaced: { ...(serviceState(home).replaced || {}), [agent]: url } });
const takeReplaced = (home, agent) => {
  const s = serviceState(home);
  const url = s.replaced?.[agent];
  if (!url) return null;
  const replaced = { ...s.replaced }; delete replaced[agent];
  writeJson(stateFile(home), { ...s, replaced: Object.keys(replaced).length ? replaced : undefined });
  return url;
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
  const read = readForWrite(f);
  if (read.why) return { file: f, skipped: read.why, unchanged: !url };
  const cur = read.value;
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
// OpenCode: opencode.json `provider.anthropic.options.baseURL`; a config kept as opencode.jsonc (comments) is not rewritten.
// Where the openrouter gateway is on in the machine config, the openrouter provider is pointed at the same
// proxy behind its path prefix (`/openrouter/v1`), so the chat door serves it too.
function opencodeFile(url, home) {
  const dir = opencodeDir();
  const f = path.join(dir, 'opencode.json'), fc = path.join(dir, 'opencode.jsonc');
  const guard = testGuard('XDG_CONFIG_HOME'); if (guard) return url ? { file: f, skipped: guard } : { file: f, unchanged: true };
  if (!fs.existsSync(f) && fs.existsSync(fc)) return { file: fc, skipped: url ? 'the config is opencode.jsonc, which thinker does not rewrite: set provider.anthropic.options.baseURL there' : undefined, unchanged: !url };
  const read = readForWrite(f);
  if (read.why) return { file: f, skipped: read.why, unchanged: !url };
  const cur = read.value;
  // One provider at a time, the same rule each: write ours when absent, leave the person's own
  // route with the reason, take ours out on the way off. A provider nobody uses is not created.
  const setProvider = (obj, name, target, label) => {
    const have = obj.provider?.[name]?.options?.baseURL;
    if (target) {
      if (have && !isOwnUrl(have, home)) return { obj, note: `${label} is already ${have}` };
      if (have === target) return { obj };
      const p = obj.provider?.[name] || {};
      return { obj: { ...obj, provider: { ...(obj.provider || {}), [name]: { ...p, options: { ...(p.options || {}), baseURL: target } } } }, changed: true };
    }
    if (!have || !isOwnUrl(have, home)) return { obj };
    const options = { ...obj.provider[name].options }; delete options.baseURL;
    const p = { ...obj.provider[name] }; if (Object.keys(options).length) p.options = options; else delete p.options;
    const provider = { ...obj.provider }; if (Object.keys(p).length) provider[name] = p; else delete provider[name];
    const next = { ...obj }; if (Object.keys(provider).length) next.provider = provider; else delete next.provider;
    return { obj: next, changed: true };
  };
  const gateways = readMachineConfig(home).proxy?.gateways || {};
  const openrouterOn = gateways.openrouter === true || (typeof gateways.openrouter === 'string' && gateways.openrouter);
  const anthropic = setProvider(cur, 'anthropic', url, 'provider.anthropic.options.baseURL');
  if (anthropic.note) return { file: f, skipped: anthropic.note, unchanged: !url };
  const openrouter = setProvider(anthropic.obj, 'openrouter', openrouterOn && url ? `${String(url).replace(/\/+$/, '')}/openrouter` : null, 'provider.openrouter.options.baseURL');
  if (openrouter.note) return { file: f, skipped: openrouter.note };
  const next = openrouter.obj, changed = !!anthropic.changed || !!openrouter.changed;
  if (!changed) {
    if (url && !fs.existsSync(f) && !fs.existsSync(dir)) return { file: f, unchanged: true, absent: true }; // no OpenCode here
    return { file: f, unchanged: true };
  }
  if (!fs.existsSync(f) && !fs.existsSync(dir)) return { file: f, unchanged: true, absent: true }; // no OpenCode here: none is created
  writeJson(f, next);
  return { file: f, changed: true };
}
function claudeFile(url, home, env, repos) {
  const f = claudeSettings();
  const guard = testGuard('CLAUDE_CONFIG_DIR'); if (guard) return url ? { file: f, skipped: guard } : { file: f, unchanged: true };
  const read = readForWrite(f);
  if (read.why) return { file: f, skipped: read.why, unchanged: !url };
  const cur = read.value;
  if (bedrockState(home)) {
    if (!url) { const restored = restoreBedrock(home); takeReplaced(home, 'claude'); return restored; }
    const why = claudeBlocker(cur, { home, env, repos });
    return why ? { file: f, skipped: why } : wireBedrock(home, url);
  }
  if (url) {
    const why = claudeBlocker(cur, { home, env, repos });
    if (why) return { file: f, skipped: why };
    if (cur.env?.[PROXY_ENV] === url) return { file: f, unchanged: true };
    const theirs = cur.env?.[PROXY_ENV];
    if (theirs && !isOwnUrl(theirs, home)) rememberReplaced(home, 'claude', theirs);
    writeJson(f, withProxyUrl(cur, url));
    return { file: f, changed: true };
  }
  if (!isOwnUrl(cur.env?.[PROXY_ENV], home)) { takeReplaced(home, 'claude'); return { file: f, unchanged: true }; }
  const back = takeReplaced(home, 'claude');
  writeJson(f, setEnv(cur, back || null));
  return { file: f, changed: true, ...(back ? { restored: back } : {}) };
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
export async function enableProxyService({ cli, home = thinkerHome(), env = process.env, manage, force = false, repos = [], gateway, bedrock } = {}) {
  let s = serviceState(home);
  if (bedrock) {
    if (gateway !== undefined) throw Error('--bedrock cannot be combined with --gateway or --upstream.');
    const prepared = prepareBedrock(home, bedrock, env);
    if (isOwnUrl(prepared.before.ANTHROPIC_BASE_URL, home)) prepared.before.ANTHROPIC_BASE_URL = s.replaced?.claude || null;
    // Explicit consent covers the native Bedrock flag, never a separate gateway, policy or cloud provider.
    const settings = readJson(prepared.settings);
    for (const block of [settings.env, env]) {
      if (block?.ANTHROPIC_BEDROCK_BASE_URL) throw Error('A custom Bedrock endpoint is configured; remove it before opting into the AWS token route.');
      if (block?.ANTHROPIC_BASE_URL && !isOwnRoute(block.ANTHROPIC_BASE_URL, home) && !isAnthropicHost(block.ANTHROPIC_BASE_URL)) throw Error('A custom Claude route is already configured; remove it before opting into Bedrock.');
      for (const k of OTHER_ROUTES.filter(k => k !== 'CLAUDE_CODE_USE_BEDROCK')) if (cloudOn(block?.[k])) throw Error('A different cloud provider is configured; leave it unchanged or remove it before opting into Bedrock.');
    }
    const [conflict] = routeEvidence({ env, repos, isOwn: u => isOwnRoute(u, home), limit: 1, ignoreShellCloud: ['CLAUDE_CODE_USE_BEDROCK'] });
    if (conflict) throw Error(`Bedrock opt-in cannot override ${conflict.what} in ${conflict.where}.`);
    commitBedrock(home, prepared);
  }
  // Connect/setup can run before the next prompt observes a manual removal or a
  // new route. Preserve that answer before resetting wroteClaude and rewiring.
  if (s.enabled && !force) {
    const gone = trackClaude({ home, env }) || removedByHand({ home }) || routeAppeared({ home, env });
    if (gone) { standDown(gone, { home, manage }); s = serviceState(home); }
  }
  // `stoodDown` is the reason, as `ensureProxy` returns it
  if (s.standDown && !force) return { stoodDown: s.standDown.reason || 'it stood aside earlier', at: s.standDown.at, port: s.port, url: s.port ? urlFor(s.port) : null, service: { type: 'none' }, wired: { changed: [], skipped: [], unchanged: [] } };
  const port = s.port || await freePort();
  const ports = [...new Set([...(s.ports || []), port])];
  // `gateway: true` finds the person's own model server and forwards to it; a URL names one; `false` goes back to
  // Anthropic's API. Only ever set by the person (the flag, or a yes to the question): the proxy never puts itself
  // in front of a gateway unasked.
  // Anthropic's own host named as the gateway, or left in the state by an earlier yes, is the default upstream
  // and is not stored (proxy-route.js:isAnthropicHost).
  const found = gateway === true ? ownGateway({ env, repos, isOwn: u => isOwnUrl(u, home) }) : null;
  const notDefault = u => (u && !isAnthropicHost(u) ? u : undefined);
  const upstream = gateway === true ? found?.url : gateway === false ? undefined : gateway ? notDefault(trimUrl(gateway)) : notDefault(s.upstream);
  writeJson(stateFile(home), { ...s, enabled: true, port, ports, since: s.since || new Date().toISOString(), off: undefined, standDown: undefined, wroteClaude: undefined, upstream });
  saveNetworkEnv(home, env);
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
  return { port, url: urlFor(port), service, wired, listening, upstream: upstream || null, gatewayFrom: found?.where || null };
}
// `thinker proxy off`, `uninstall --user`: the agents' files first (a session started now goes straight to the API),
// then the service
export function disableProxyService({ home = thinkerHome(), manage, keepState = true } = {}) {
  const wired = wireAgents(null, { home });
  const removed = uninstallService({ home, manage });
  const s = serviceState(home);
  // the version that turned it off, so the one-off offer can tell someone who turned it off while the fault of
  // 2026-10-28 was live from someone who turned it off on a version that already behaves (proxy-offer.js)
  if (keepState) writeJson(stateFile(home), { ...s, enabled: false, off: new Date().toISOString(), offVersion: appVersion(), pid: undefined, wroteClaude: undefined, upstream: undefined });
  else fs.rmSync(stateFile(home), { force: true });
  return { wired, removed };
}

// one line per agent for the commands' output
export function wiredLines(wired, url, upstream = null, { hint = true, home = thinkerHome(), env = process.env, repos = [] } = {}) {
  const lines = [];
  const names = { claude: 'Claude Code', pi: 'pi', opencode: 'OpenCode', codex: 'Codex' };
  for (const c of wired.changed) lines.push(`${names[c.agent]}: ${url ? `model calls go through the proxy (${url}${upstream ? ` on to ${upstream}` : ''}, ${c.file})` : `the proxy's URL taken out of ${c.file}`}`);
  for (const s of wired.skipped) lines.push(`${names[s.agent]}: left as it is, ${s.reason}`);
  // An agent left alone because it is routed somewhere of the person's own is a dead end without this: the
  // reason says what thinker saw and nothing says what to do about it (2026-10-28).
  if (hint && url && wired.skipped.length) { const h = gatewayHint({ home, env, repos }); if (h) lines.push(h); }
  return lines;
}

// What to tell someone whose agent is routed through a model server of their own. Worked out from this machine,
// not parsed out of a blocker's message: a cloud route cannot be helped, a gateway that speaks the Messages API
// can, and the proxy never goes in front of one unasked (enableProxyService). null when there is nothing to say.
export function gatewayHint({ home = thinkerHome(), env = process.env, repos = [] } = {}) {
  if (cloudOn(env.CLAUDE_CODE_USE_BEDROCK)) return 'Claude Code uses native bedrock signing, so the proxy cannot clear that transport. To opt in to the token route, use `thinker proxy on --bedrock --region REGION --model BEDROCK_MODEL_ID --token-file PRIVATE_FILE`, then restart Claude Code. It requires a Bedrock API key or bearer token; proxy off restores the previous settings.';
  for (const k of CLOUD_VARS) if (cloudOn(env[k])) return `Claude Code runs on ${k.replace('CLAUDE_CODE_USE_', '').toLowerCase()}, which does not take the API's context-management edit, so the proxy cannot clear old tool results in those sessions.`;
  const found = ownGateway({ env, repos, isOwn: u => isOwnRoute(u, home) });
  if (!found?.url) return null;
  return 'A model server of your own is the route: `thinker proxy on --gateway` puts the proxy in front of it instead of the API, which is how the clearing reaches those sessions. The requests keep going to the same place with the same credentials.';
}
