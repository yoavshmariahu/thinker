// The pi package (`pi install npm:@zerotimedev/thinker`): a pointer to the thinker installed on this
// machine, loaded when pi starts. Nothing of thinker runs from the package: the hooks, the learning and
// the notes come from the installed copy (THINKER_HOME/app, by default ~/.thinker/app), through the same
// extension module `thinker connect` wires for pi (src/integrations/pi.js), in every checkout.
//
// One copy only: `thinker connect` writes ~/.pi/agent/extensions/thinker.js, and where that file is in
// place it does the work and this package does nothing, or every note would reach the agent twice.
// Without an installed thinker the package says so once per session and does nothing else.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const home = () => process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
const piDir = () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
export const INSTALL_HINT = 'thinker is not installed on this machine: run `npx @zerotimedev/thinker` (the pi package only points at the installed copy).';

// the installed command line: THINKER_CLI names one (tests), else the install under THINKER_HOME
export function findCli(env = process.env) {
  const named = env.THINKER_CLI;
  if (named) return fs.existsSync(named) ? named : null;
  const cli = path.join(home(), 'app', 'src', 'cli.js');
  return fs.existsSync(cli) ? cli : null;
}

export const connectedByThinker = () => fs.existsSync(path.join(piDir(), 'extensions', 'thinker.js'));

// Handlers are registered at once, synchronously; the extension module behind them is loaded on
// the first event, so a pi that loads extensions synchronously is served too.
export default function thinkerPackage(pi, { cli = findCli(), yieldTo = connectedByThinker() } = {}) {
  if (yieldTo) return;
  if (!cli) {
    let said = false;
    pi.on('before_agent_start', async (_e, ctx) => { if (!said && ctx.hasUI) { said = true; ctx.ui.notify(INSTALL_HINT, 'warning'); } });
    return;
  }
  const handlers = {};
  const collector = { on: (event, fn) => { handlers[event] = fn; } };
  const loaded = import(pathToFileURL(path.join(path.dirname(cli), 'integrations', 'pi.js')).href)
    .then(m => { m.piExtension(collector, { client: 'pi', repo: null, cli, hooks: true, learn: true, late: true, shared: false, mcp: false }); })
    .catch(() => {}); // a broken install must not interrupt the host agent
  for (const event of ['before_agent_start', 'tool_result', 'agent_end', 'session_shutdown']) {
    pi.on(event, async (e, ctx) => { await loaded; return handlers[event] ? handlers[event](e, ctx) : undefined; });
  }
}
