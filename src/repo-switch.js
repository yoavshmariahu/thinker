// Repositories thinker is switched off for, machine-wide. A repository with sensitive content is
// turned off with `thinker disable` inside it; from then on the hooks and the MCP server do nothing
// there, no session of it is distilled, and no `.thinker/` folder is started in its checkouts. The list is in
// THINKER_HOME/config.json (`disabledRepos`), so it covers every clone and worktree of the
// repository: a repository is named by its id (store.js:repoId, the origin URL), with the checkout
// it was turned off from kept for the page.
import fs from 'node:fs';
import path from 'node:path';
import { repoId, isGitCheckout } from './store.js';
import { thinkerHome } from './update.js';

const file = home => path.join(home || thinkerHome(), 'config.json');
export function readMachineConfig(home) {
  try { return JSON.parse(fs.readFileSync(file(home), 'utf8')) || {}; } catch { return {}; }
}
function writeMachineConfig(home, cfg) {
  const f = file(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ version: 1, ...cfg }, null, 2) + '\n');
}

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The repositories turned off: [{ id, checkout, name, at }].
export function disabledRepos({ home } = {}) {
  const list = readMachineConfig(home).disabledRepos;
  return Array.isArray(list) ? list.filter(e => e && typeof e.id === 'string') : [];
}

// The entry that turns this checkout off, else null. Cheap: the list is small and the id is read from
// .git/config once per process. Outside a git checkout nothing is off (there is nothing to serve).
export function disabledRepo(repo, { home } = {}) {
  if (!repo || !isGitCheckout(repo)) return null;
  const list = disabledRepos({ home });
  if (!list.length) return null;
  const id = repoId(repo), r = real(repo);
  return list.find(e => e.id === id || (e.checkout && real(e.checkout) === r)) || null;
}
export const isDisabledRepo = (repo, opts) => !!disabledRepo(repo, opts);

// Turn a repository off (`on` false) or back on. Returns the list as it stands.
export function setRepoDisabled(repo, { disabled = true, name, home } = {}) {
  if (!isGitCheckout(repo)) throw new Error(`${repo} is not a git repository`);
  const id = repoId(repo), r = real(repo);
  const cfg = readMachineConfig(home);
  const rest = disabledRepos({ home }).filter(e => e.id !== id && !(e.checkout && real(e.checkout) === r));
  cfg.disabledRepos = disabled ? [...rest, { id, checkout: r, name: name || path.basename(r), at: new Date().toISOString() }] : rest;
  writeMachineConfig(home, cfg);
  return cfg.disabledRepos;
}

// What a command says when it is run in a repository that is off.
export const OFF_MESSAGE = 'thinker is switched off for this repository: no notes are served or learned here and nothing is written into it. `thinker enable` turns it back on.';
