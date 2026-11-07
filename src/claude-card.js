// The Claude Code cache-hit card: a mod (src/integrations/claude-card) that draws the notes a turn
// was served as a card under the answer, kept in the chat history. The Stop hook's own line
// (`systemMessage`) is shown collapsed in the Claude desktop app, where nobody saw it.
//
// `thinker connect` names the mod's folder in CLAUDE_CODE_PLUGIN_DIRS in the `env` block of
// ~/.claude/settings.json, which Claude Code reads in a terminal and in the desktop app alike
// (clients.js:installClient); `rewire` after an update points it at the new copy. The mod marks each
// session it runs in under thinker's home, and the Stop hook leaves its line out there: a Claude
// Code too old for mods, or one that refused the folder, keeps the line.
//
// The folder named is never one an update replaces (2026-11-06). Claude Code watches a mod's files
// and reloads it in every open session when they move, saying so under the answer ("plugin.json
// changed -- reloaded"), and it keys on the file event, not the bytes: an update renames a whole new
// tree over ~/.thinker/app, so every release reloaded both mods in every open session, three of
// them in one session in a day, two of those for a manifest whose bytes had not changed. So on an
// archive install the mods are copied out of the app into <home>/plugins/<name>-<digest of its
// files> (`installClaudeMods`), renamed into place whole, and the settings name that folder. A
// release that leaves a mod's bytes alone computes the same digest, copies nothing and rewrites no
// setting; one that changes them makes a new folder and repoints the settings, which a session
// reads at its start, so an open session keeps the folder it loaded and sees no change at all (it
// gets the new mod when it is next started, as it gets a changed hook). Folders no setting names
// any more go after `PRUNE_DAYS`. A git checkout keeps pointing at its own source, so editing a mod
// there still reloads it live.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const CARD_ENV = 'CLAUDE_CODE_PLUGIN_DIRS';
export const MODS = ['claude-card', 'claude-clear'];
export const PRUNE_DAYS = 14;
const thinkerHome = () => process.env.THINKER_HOME || path.join(os.homedir(), '.thinker');
// where the mod ships: beside the CLI, in the checkout or the installed app
export const modSource = (cli, name) => path.join(path.dirname(cli), 'integrations', name);
// an archive install keeps its code in <home>/app, which an update replaces whole
const underApp = (cli, home) => path.resolve(path.dirname(path.dirname(cli))) === path.resolve(home, 'app');
// Claude Code writes its own files into a mod's folder when it loads one (type definitions for the
// author, a tsconfig); neither is the mod, so neither is copied or counted
const CLAUDE_OWN = new Set(['.claude-plugin/types', 'tsconfig.json']);
function modFiles(src) {
  const out = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (CLAUDE_OWN.has(r)) continue;
      if (e.isDirectory()) walk(r); else if (e.isFile()) out.push(r);
    }
  };
  try { walk(''); } catch { return null; }
  return out;
}
// eight hex characters of the mod's files, paths and bytes: the same mod gives the same folder
export function modDigest(src) {
  const files = modFiles(src);
  if (!files || !files.length) return null;
  const h = createHash('sha256');
  for (const f of files) { h.update(f); h.update('\0'); h.update(fs.readFileSync(path.join(src, f))); h.update('\0'); }
  return h.digest('hex').slice(0, 8);
}
// The folder the settings name for a mod: the source itself in a checkout, the content-addressed copy
// under the home for an installed app. Pure: `installClaudeMods` makes the copy.
export function modDir(cli, name, { home = thinkerHome() } = {}) {
  const src = modSource(cli, name);
  if (!underApp(cli, home)) return src;
  const digest = modDigest(src);
  return digest ? path.join(home, 'plugins', `${name}-${digest}`) : src;
}
export const claudeCardDir = (cli, opts) => modDir(cli, 'claude-card', opts);
// the clearing mod (src/integrations/claude-clear): thinker's context clearing inside the sessions the
// proxy cannot reach, the desktop app's above all; wired beside the card, under the same variable
export const claudeClearDir = (cli, opts) => modDir(cli, 'claude-clear', opts);
// any copy's folder, in a checkout or copied out of an installed app: the one being installed
// replaces the others, so a session loads one card
const isCardDir = p => /[\\/](?:integrations[\\/]claude-card|plugins[\\/]claude-card-[0-9a-f]{8})[\\/]?$/.test(p);
const isClearDir = p => /[\\/](?:integrations[\\/]claude-clear|plugins[\\/]claude-clear-[0-9a-f]{8})[\\/]?$/.test(p);

function copyMod(src, dir) {
  const tmp = `${dir}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of modFiles(src) || []) {
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true });
    fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  }
  try { fs.renameSync(tmp, dir); }                      // whole, so a session starting now sees all of it or none
  catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); if (!fs.existsSync(dir)) throw e; }   // another connect got there first
}
// Folders of this mod no setting names any more (an older digest), left for PRUNE_DAYS so a session
// still running one keeps its files, then removed. The copy's own manifest carries the copy's time;
// the folder's does not, since Claude Code writes into it.
function pruneMods(home, name, keep) {
  const base = path.join(home, 'plugins');
  let entries; try { entries = fs.readdirSync(base); } catch { return []; }
  const gone = [], old = Date.now() - PRUNE_DAYS * 86400e3;
  for (const e of entries) {
    const dir = path.join(base, e);
    if (dir === keep || !new RegExp(`^${name}-[0-9a-f]{8}$`).test(e)) continue;
    try { if (fs.statSync(path.join(dir, '.claude-plugin', 'plugin.json')).mtimeMs >= old) continue; } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); gone.push(dir); } catch {}
  }
  return gone;
}
// The folders to name in the settings, in place: copied out of an installed app when this content is
// not there yet, nothing written when it is. Returns each mod's folder and whether it was copied.
export function installClaudeMods(cli, { home = thinkerHome() } = {}) {
  const out = {};
  for (const name of MODS) {
    const src = modSource(cli, name), dir = modDir(cli, name, { home });
    let copied = false;
    if (dir !== src && !fs.existsSync(dir)) { copyMod(src, dir); copied = true; }
    out[name] = { dir, copied, pruned: dir !== src ? pruneMods(home, name, dir) : [] };
  }
  return out;
}
// `thinker uninstall --user`: every copy under the home goes with the settings entry
export function removeClaudeMods({ home = thinkerHome() } = {}) {
  const base = path.join(home, 'plugins');
  let entries; try { entries = fs.readdirSync(base); } catch { return; }
  for (const e of entries) if (MODS.some(n => new RegExp(`^${n}-[0-9a-f]{8}$`).test(e))) fs.rmSync(path.join(base, e), { recursive: true, force: true });
  try { if (!fs.readdirSync(base).length) fs.rmdirSync(base); } catch {}
}

function setDirs(settings, dirs) {
  const env = { ...(settings.env || {}) };
  if (dirs.length) env[CARD_ENV] = dirs.join(path.delimiter); else delete env[CARD_ENV];
  const out = { ...settings, env };
  if (!Object.keys(env).length) delete out.env;
  return out;
}
const dirsOf = settings => String(settings?.env?.[CARD_ENV] || '').split(path.delimiter).filter(Boolean);

// Claude Code's settings with this copy's card folder named, every other entry kept as it was.
export const withCardDir = (settings, dir) => setDirs(settings, [...dirsOf(settings).filter(p => !isCardDir(p)), dir]);
export const withoutCardDir = settings => setDirs(settings, dirsOf(settings).filter(p => !isCardDir(p)));
export const cardDirIn = settings => dirsOf(settings).find(isCardDir) || null;
export const withClearDir = (settings, dir) => setDirs(settings, [...dirsOf(settings).filter(p => !isClearDir(p)), dir]);
export const withoutClearDir = settings => setDirs(settings, dirsOf(settings).filter(p => !isClearDir(p)));
export const clearDirIn = settings => dirsOf(settings).find(isClearDir) || null;

const markDir = (home = thinkerHome()) => path.join(home, 'state', 'claude-card');

// Whether the card mod runs in this Claude Code session (it wrote the mark at the session's start).
// Marks older than two days are cleared on the way, once there are more than a hundred.
export function claudeCardActive(session, { home } = {}) {
  if (!session || session === 'unknown') return false;
  const dir = markDir(home);
  try {
    const marks = fs.readdirSync(dir);
    if (marks.length > 100) {
      const old = Date.now() - 2 * 86400e3;
      for (const m of marks) { try { const f = path.join(dir, m); if (fs.statSync(f).mtimeMs < old) fs.rmSync(f, { force: true }); } catch {} }
    }
    return fs.existsSync(path.join(dir, String(session).replace(/[^\w.-]/g, '_')));
  } catch { return false; }
}
