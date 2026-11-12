import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestMode } from './test-mode.js';

// Orca (orca.dev) is not an agent of its own: it runs the agents' CLIs -- Claude Code, Codex and the
// rest -- one git worktree to a task, so thinker's user-scope wiring already serves an Orca pane
// unchanged. Checked live on Orca 1.4.257: in a terminal pane and in its structured chat alike the
// prompt hook serves the profile, the session is logged and the proxy sees every call, and a linked
// worktree reads the main checkout's cache (store.js:cacheCheckout). Orca appends its managed hooks
// to the agents' files instead of replacing them, and setHooks only ever drops thinker's own entries,
// so neither takes the other's out.
//
// One thing is Orca's own: a MANAGED ACCOUNT (`orca account add`). Orca keeps a configuration
// directory per account and starts the agent pointed at it -- CLAUDE_CONFIG_DIR for Claude Code,
// CODEX_HOME for Codex -- and what it carries over from the person's own directory deliberately
// leaves `settings.json` out (read from Orca's bundle, where the excluded-names set names it). So an
// account made there would hold none of thinker's hooks, and, because no hook of ours runs in it,
// nothing could notice or repair that. The homes are listed here so the user-scope wiring covers them
// as it covers `~/.claude` and `~/.codex`; an account added later is wired by the next `rewire`.
//
// What this does NOT cover is the proxy's route (`ANTHROPIC_BASE_URL` in the settings file). That
// writer carries per-machine state -- the route it replaced, Bedrock, the stand-down count -- keyed
// by client and not by home, and "the proxy never takes over another's route" is judged per machine,
// so a second home there is a policy question rather than a path. The clearing still reaches a
// managed account through the desktop mod, which rides on the settings key this wiring writes.

// Where Orca keeps its user data. Both spellings are listed because macOS is case-insensitive by
// default and Orca's own paths use either. THINKER_ORCA_HOME names one directly (the tests, and a
// person whose Orca keeps its data somewhere else).
export function orcaDataDirs({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (env.THINKER_ORCA_HOME) return [env.THINKER_ORCA_HOME];
  // real machine state is never read under test
  if (isTestMode(env)) return [];
  const roots = platform === 'win32' ? [env.APPDATA || path.join(home, 'AppData', 'Roaming')]
    : platform === 'darwin' ? [path.join(home, 'Library', 'Application Support')]
      : [env.XDG_CONFIG_HOME || path.join(home, '.config')];
  return roots.flatMap(r => ['Orca', 'orca'].map(n => path.join(r, n)));
}

// Orca's directory of managed account homes, by thinker's client id. Only these two: `orca account
// add` also takes opencode and devin, whose homes Orca keeps as private XDG directories whose layout
// is not settled here -- when they are, they belong in this table and nothing else changes.
const ACCOUNT_ROOT = { claude: 'claude-profiles', codex: 'codex-accounts' };
// Orca's pointer at the host's active account, not an account home.
const NOT_A_HOME = new Set(['selected-host']);
// Orca's own record of every Claude configuration directory it has started the agent with.
const OBSERVED = { claude: 'claude-observed-config-dirs.json' };
const ownHome = (client, home, env) => client === 'claude'
  ? env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
  : env.CODEX_HOME || path.join(home, '.codex');

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// Orca keeps the agent's files one level down where it has to set HOME too (`codex-runtime-home/home`)
const homeOf = dir => isDir(path.join(dir, 'home')) ? path.join(dir, 'home') : dir;

// The configuration homes this agent has on this machine besides its own: one per Orca managed
// account. Empty where there is no Orca, no account, or the client has no managed home.
export function orcaConfigHomes(client, { home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (!ACCOUNT_ROOT[client]) return [];
  const out = new Set();
  for (const data of orcaDataDirs({ home, platform, env })) {
    if (!isDir(data)) continue;
    if (OBSERVED[client]) {
      let listed = [];
      try { listed = JSON.parse(fs.readFileSync(path.join(data, OBSERVED[client]), 'utf8')); } catch {}
      if (Array.isArray(listed)) for (const d of listed) if (typeof d === 'string' && isDir(d)) out.add(path.resolve(d));
    }
    const root = path.join(data, ACCOUNT_ROOT[client]);
    let names = [];
    try { names = fs.readdirSync(root); } catch {}
    for (const name of names) {
      if (NOT_A_HOME.has(name) || name.startsWith('.')) continue;
      if (isDir(path.join(root, name))) out.add(path.resolve(homeOf(path.join(root, name))));
    }
  }
  out.delete(path.resolve(ownHome(client, home, env)));
  return [...out].sort();
}
