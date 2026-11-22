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
import { mergeManaged } from './managed.js';
import { isTestMode } from './test-mode.js';

const file = home => path.join(home || thinkerHome(), 'config.json');
// The machine's settings as they are in force: its own file, with whatever its fleet operator set over it
// (managed.js -- an allow-list of paths, never written into the person's file). `{ local: true }` is the file
// alone, which is what a writer must read: a central setting may never be baked into a file thinker does not own.
export function readMachineConfig(home, { local = false } = {}) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file(home), 'utf8')) || {}; } catch { cfg = {}; }
  return local ? cfg : mergeManaged(cfg, { home: home || thinkerHome() });
}
// one read-modify-write of the machine config, for a command that sets one key (thinker models assign Explore)
export function updateMachineConfig(home, fn) {
  const read = () => readMachineConfig(home, { local: true });
  const cfg = fn(read()) || read();
  writeMachineConfig(home, cfg);
  return cfg;
}
// A block a person may set for the machine or for one repository (`learn`, `notice`, `maintain`: settings.js): the
// machine's, with the repository's own over it, key by key. Until 2026-11-21 these three were the repository's
// alone, so "learn nothing from my sessions" had to be said once a checkout. A test that names no home never
// reads the person's own file: what they set on their machine is not a test's input.
export function layeredConfig(store, key, { home } = {}) {
  let m, r;
  if (home || process.env.THINKER_HOME || !isTestMode()) { try { m = readMachineConfig(home)[key]; } catch {} }
  try { r = store?.config?.()?.[key]; } catch {}
  if (r === undefined) return m;
  const obj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  return obj(m) && obj(r) ? { ...m, ...r } : r;
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
export const OFF_MESSAGE = 'thinker is switched off for this repository: nothing is served or learned here and nothing is written into it. `thinker enable` turns it back on.';
