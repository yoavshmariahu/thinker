// Where else Claude Code's route can come from, and why the proxy must look before it writes anything.
//
// Many people run Claude Code against a model server of their own -- a gateway that routes each request to
// whichever model it picks -- by setting ANTHROPIC_BASE_URL and a token minted for that gateway. The proxy
// forwards what it receives to api.anthropic.com, so pointing such a client at the proxy sends the gateway's
// token to Anthropic: every model call of every session fails ("invalid bearer token") until the person finds
// the setting. Reported on 2026-10-28, from a machine whose route is exported by the shell.
//
// Until then `claudeBlocker` (proxy-service.js) read two places: the `env` block of ~/.claude/settings.json and
// thinker's own process environment. Neither is where a routed harness usually keeps it:
//  - the settings file's `env` block is applied to the session over the variables the shell exported, so
//    thinker's URL wins over the person's export -- that is the case that breaks, and the one nothing saw;
//  - once thinker has written its URL, a hook's own environment holds thinker's URL and the person's value is
//    nowhere to be found, so the check can never see it again;
//  - `thinker connect` and the installer run in a plain terminal, often not the one the gateway is exported in.
//
// So every file Claude Code can take a route from is read instead (`routeEvidence`). A route in the user's
// settings.local.json, in the enterprise policy file or in a project's own settings outranks the file thinker
// writes, so thinker's URL would be inert there rather than harmful; it is still treated as a reason to leave
// the person alone, since someone who routes Claude Code anywhere of their own did not ask for a proxy in
// front of it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestMode } from './test-mode.js';

export const BASE_URL_VAR = 'ANTHROPIC_BASE_URL';
// Claude Code on one of these speaks that provider's format, which the proxy does not read
export const CLOUD_VARS = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
// a route of any kind, in a settings `env` block or in a shell's startup file
export const ROUTE_VARS = [BASE_URL_VAR, ...CLOUD_VARS, 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL'];
// a gateway's token is not an Anthropic one: every key and OAuth token the API issues starts with this
export const ANTHROPIC_TOKEN = /^sk-ant-/;
// the shell startup files a route is usually exported from, including a wrapper or an alias that names it
const SHELL_FILES = ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile', path.join('.config', 'fish', 'config.fish')];
// Claude Code's enterprise policy file
const MANAGED = { darwin: '/Library/Application Support/ClaudeCode/managed-settings.json', linux: '/etc/claude-code/managed-settings.json' };

export const cloudOn = v => v != null && !/^(0|false|)$/i.test(String(v).trim());
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { return {}; } };
const shortPath = (f, home) => (home && f.startsWith(home + path.sep) ? '~' + f.slice(home.length) : f);

// `{ where, what }` for the route an `env` block holds, or null
export function envRoute(block, { isOwn = () => false } = {}) {
  if (!block || typeof block !== 'object') return null;
  const url = block[BASE_URL_VAR];
  if (url && !isOwn(url)) return `${BASE_URL_VAR} is ${url}`;
  for (const k of CLOUD_VARS) if (cloudOn(block[k])) return `Claude Code runs on ${k.replace('CLAUDE_CODE_USE_', '').toLowerCase()}, which the proxy does not speak`;
  return null;
}

// The files read, in the order Claude Code reads them (the policy file wins; the user's settings.json, the one
// thinker writes, loses). A project's own files are read for the checkouts named in `repos`.
export function routeFiles({ env = process.env, repos = [], home = env.HOME || os.homedir() } = {}) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const files = [];
  const managed = MANAGED[process.platform];
  if (managed) files.push({ file: managed, kind: 'settings' });
  for (const r of repos) for (const n of ['settings.json', 'settings.local.json']) files.push({ file: path.join(r, '.claude', n), kind: 'settings' });
  files.push({ file: path.join(claudeDir, 'settings.local.json'), kind: 'settings' });
  for (const f of SHELL_FILES) files.push({ file: path.join(home, f), kind: 'shell' });
  return files;
}

// A shell startup file is not evaluated: any line that names a route variable and is not a comment counts,
// whatever it does with it (an export, a wrapper function, an alias around `claude`). A line that names
// thinker's own URL is the proxy's own doing and no evidence of anything.
export function shellRoute(text, { isOwn = () => false } = {}) {
  for (const line of String(text).split('\n')) {
    const code = line.replace(/^\s+/, '');
    if (!code || code.startsWith('#')) continue;
    const v = ROUTE_VARS.find(name => code.includes(name));
    if (!v) continue;
    const value = new RegExp(`${v}[=\\s:]+["']?([^"'\\s;]+)`).exec(code)?.[1];
    if (value && isOwn(value)) continue;
    if (v === BASE_URL_VAR && value) return `${BASE_URL_VAR} is set to ${value}`;
    return `${v} is set`;
  }
  return null;
}

// Every route this machine holds for Claude Code besides the settings file thinker writes, nearest first.
// In test mode nothing outside the test's own directories is read: THINKER_ROUTE_HOME names the home to scan
// (test/proxy-route.test.js), as CLAUDE_CONFIG_DIR names the settings directory.
export function routeEvidence({ env = process.env, isOwn = () => false, repos = [], limit = 3 } = {}) {
  const home = env.THINKER_ROUTE_HOME || (isTestMode() ? null : env.HOME || os.homedir());
  if (!home) return [];
  const out = [];
  for (const { file, kind } of routeFiles({ env, repos, home })) {
    if (out.length >= limit) break;
    let what = null;
    try {
      if (!fs.statSync(file).isFile()) continue;
      what = kind === 'settings' ? envRoute(readJson(file).env, { isOwn }) : shellRoute(fs.readFileSync(file, 'utf8').slice(0, 256_000), { isOwn });
    } catch { continue; }
    if (what) out.push({ where: shortPath(file, home), what });
  }
  return out;
}

// The request's credentials are not Anthropic's, so forwarding it to api.anthropic.com can only fail: the
// agent is routed through a gateway of its own and reached the proxy by mistake. A request that carries no
// credentials at all says nothing (the proxy is not the one authenticating).
export function foreignAuth(headers = {}) {
  const bearer = /^Bearer\s+(\S+)/i.exec(headers.authorization || headers.Authorization || '')?.[1];
  const tokens = [headers['x-api-key'], bearer].filter(Boolean).map(String);
  return tokens.length > 0 && tokens.every(t => !ANTHROPIC_TOKEN.test(t));
}
