// The Claude Code cache-hit card: a mod (src/integrations/claude-card) that draws the notes a turn
// was served as a card under the answer, kept in the chat history. The Stop hook's own line
// (`systemMessage`) is shown collapsed in the Claude desktop app, where nobody saw it.
//
// `thinker connect` names the mod's folder in CLAUDE_CODE_PLUGIN_DIRS in the `env` block of
// ~/.claude/settings.json, which Claude Code reads in a terminal and in the desktop app alike
// (clients.js:installClient); `rewire` after an update points it at the new copy. The mod marks each
// session it runs in under thinker's home, and the Stop hook leaves its line out there: a Claude
// Code too old for mods, or one that refused the folder, keeps the line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CARD_ENV = 'CLAUDE_CODE_PLUGIN_DIRS';
export const claudeCardDir = cli => path.join(path.dirname(cli), 'integrations', 'claude-card');
// any copy's folder: the one being installed replaces the others, so a session loads one card
const isCardDir = p => /[\\/]integrations[\\/]claude-card[\\/]?$/.test(p);

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

const markDir = (home = process.env.THINKER_HOME || path.join(os.homedir(), '.thinker')) => path.join(home, 'state', 'claude-card');

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
