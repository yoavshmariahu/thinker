#!/usr/bin/env node
// The plugin's hook: a pointer to the thinker installed on this machine (THINKER_HOME/app, by default
// ~/.thinker/app). Nothing of thinker runs from the plugin; the installed copy serves the notes and learns,
// as it does from the agent's own settings. usage: node hook.mjs <client> <event> [flags]
//   The hook runs `thinker hook <event> --client <client> --user --plugin <flags>` with the host's payload on
//   stdin and prints what it prints. `--plugin` makes it yield where the agent's own settings already run
//   thinker's hooks (one copy only, or every note reaches the agent twice).
//   The hooks are for the cache and nothing else: without an installed thinker they do nothing. Installing
//   is the plugin's command (/thinker:install in Claude Code, the thinker-install skill in Codex, the
//   command in Cursor), run by the person. A hook never fails the host's turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [client, event, ...flags] = process.argv.slice(2);
const cli = process.env.THINKER_CLI || path.join(process.env.THINKER_HOME || path.join(os.homedir(), '.thinker'), 'app', 'src', 'cli.js');
if (!client || !event || !fs.existsSync(cli)) {
  // Cursor's prompt hook must answer; the others take silence
  if (client === 'cursor' && event === 'prompt') process.stdout.write('{"continue":true}\n');
  process.exit(0);
}
const r = spawnSync(process.execPath, [cli, 'hook', event, '--client', client, '--user', '--plugin', ...flags], { stdio: 'inherit', timeout: 20000 });
process.exit(r.error ? 0 : r.status ?? 0);
