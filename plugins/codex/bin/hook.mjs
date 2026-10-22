#!/usr/bin/env node
// The plugin's hook: a pointer to the thinker installed on this machine (THINKER_HOME/app, by default
// ~/.thinker/app). Nothing of thinker runs from the plugin; the installed copy serves the notes and learns,
// as it does from the agent's own settings. usage: node hook.mjs <client> <event> [flags]
//   The hook runs `thinker hook <event> --client <client> --user --plugin <flags>` with the host's payload on
//   stdin and prints what it prints. `--plugin` makes it yield where the agent's own settings already run
//   thinker's hooks (one copy only, or every note reaches the agent twice).
//   Without an installed thinker, the first prompt starts the installer once, in the background, for this
//   host alone (`npx -y @zerotimedev/thinker --clients <client> --no-modify-path --no-ui --yes`: no other
//   agent is wired, no shell file is edited), and says so to the person through the hook's `systemMessage`
//   (Claude Code and Codex show it; Cursor's prompt hook answers {continue} alone). The installer wires the
//   host's own settings, so from the next session the plugin yields and the installed copy does the work. An
//   install that did not finish is named once, with its log. THINKER_PLUGIN_INSTALL=off never installs.
//   The hook never fails the host's turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const [client, event, ...flags] = process.argv.slice(2);
const home = process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
const cli = process.env.THINKER_CLI || path.join(home, 'app', 'src', 'cli.js');
const HOST = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const say = text => { if (event === 'prompt' && (client === 'claude' || client === 'codex')) process.stdout.write(JSON.stringify({ systemMessage: text }) + '\n'); else if (event === 'prompt' && client === 'cursor') process.stdout.write('{"continue":true}\n'); };

if (!client || !event) process.exit(0);
if (fs.existsSync(cli)) {
  const r = spawnSync(process.execPath, [cli, 'hook', event, '--client', client, '--user', '--plugin', ...flags], { stdio: 'inherit', timeout: 20000 });
  process.exit(r.error ? 0 : r.status ?? 0);
}

// no installed thinker: install it for this host, once
try {
  if (process.env.THINKER_PLUGIN_INSTALL === 'off' || event !== 'prompt') process.exit(0);
  const state = path.join(home, 'state');
  const started = path.join(state, `plugin-install-${client}.started`);
  const done = path.join(state, `plugin-install-${client}.done`);
  const told = path.join(state, `plugin-install-${client}.told`);
  const log = path.join(state, `plugin-install-${client}.log`);
  if (fs.existsSync(done)) {
    const code = fs.readFileSync(done, 'utf8').trim();
    if (code !== '0' && !fs.existsSync(told)) { fs.writeFileSync(told, ''); say(`thinker: the install for ${HOST[client] || client} did not finish (exit ${code}). See ${log}, or run: npx @zerotimedev/thinker`); }
    process.exit(0);
  }
  if (fs.existsSync(started)) process.exit(0);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(started, new Date().toISOString());
  // THINKER_PLUGIN_INSTALLER names another command (tests); the exit code lands in the done file
  const installer = process.env.THINKER_PLUGIN_INSTALLER || `npx -y @zerotimedev/thinker --clients ${client} --no-modify-path --no-ui --yes`;
  const sh = `${installer} >${JSON.stringify(log)} 2>&1; echo $? >${JSON.stringify(done)}`;
  const child = spawn('sh', ['-c', sh], { cwd: os.homedir(), detached: true, stdio: 'ignore', env: { ...process.env, THINKER_HOME: home } });
  child.unref();
  say(`thinker: installing for ${HOST[client] || client} in the background (about a minute; this host only). Notes start with your next session. Log: ${log}`);
} catch { /* a plugin must never fail the host's turn */ }
process.exit(0);
