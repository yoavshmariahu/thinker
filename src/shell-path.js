// thinker on PATH for the shells agents run commands in, not only the person's own. The installer puts
// THINKER_HOME/bin on PATH in the startup file of the login shell (install.sh:add_to_path); until
// 2026-10-15 that was the only file, so on a zsh machine an agent running commands in bash said
// "thinker: command not found". Bash gets the line too now: .bashrc, which interactive bash and Claude
// Code's shell snapshot read, and the login file (`bash -l`), .bash_profile or .profile (created on macOS only).
// The installer writes them on a new install; an install from before gets them once, from the first prompt
// hook after the update (commands/hooks.js), and only when the installer had changed PATH there already:
// a machine installed with --no-modify-path has thinker's line in no file and is left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { thinkerHome } from './update.js';

const exportLine = dir => `export PATH="${dir}:$PATH"`;

// [{ rc, line }]: the startup files that should put `dir` on PATH, the login shell's first.
export function pathFiles(dir, { shell = path.basename(process.env.SHELL || ''), home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const files = [];
  if (shell === 'zsh') files.push({ rc: path.join(env.ZDOTDIR || home, '.zshrc'), line: exportLine(dir) });
  if (shell === 'fish') files.push({ rc: path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'conf.d', 'thinker.fish'), line: `fish_add_path "${dir}"` });
  // a login bash (`bash -l`, what Codex and macOS terminals start) reads the first of these it finds, and
  // creating .bash_profile would hide an existing .profile. On Linux the end of .bashrc is not enough: the
  // distributions' .bashrc returns early when not interactive (2026-10-15, a Debian container: `bash -ic`
  // found thinker, `bash -lc` did not), so the login file gets the line too, where there is one.
  const login = ['.bash_profile', '.bash_login', '.profile'].map(f => path.join(home, f)).find(f => fs.existsSync(f));
  if (login || platform === 'darwin') files.push({ rc: login || path.join(home, '.bash_profile'), line: exportLine(dir) });
  files.push({ rc: path.join(home, '.bashrc'), line: exportLine(dir) });
  return files.filter((f, i, all) => all.findIndex(g => g.rc === f.rc) === i);
}

// whether a startup file has thinker's bin directory on PATH: the installer's line, with the home spelled
// out, or the person's own with $HOME
const has = (rc, dir, home = os.homedir()) => {
  let text = ''; try { text = fs.readFileSync(rc, 'utf8'); } catch { return false; }
  return text.includes(dir) || (dir.startsWith(home + path.sep) && text.includes('$HOME' + dir.slice(home.length)));
};

// The files of `pathFiles` that lack the line.
export function missingPathFiles(dir, opts = {}) { return pathFiles(dir, opts).filter(f => !has(f.rc, dir, opts.home)); }

// Append the line to each file that lacks it. Returns the files written.
export function addToPath(dir, opts) {
  const done = [];
  for (const f of missingPathFiles(dir, opts)) {
    try { fs.mkdirSync(path.dirname(f.rc), { recursive: true }); fs.appendFileSync(f.rc, `\n# thinker\n${f.line}\n`); done.push(f.rc); } catch {}
  }
  return done;
}

// Once per startup file (THINKER_HOME/state/shell-path, the files already seen): bring an install from
// before up to date, when thinker's bin directory exists and the installer put it on PATH in some file
// already. A file is seen once, so a line the person took out stays out; a file the list gains later (Linux's
// .profile, 2026-10-15) is still seen. Until then the mark was a date and stopped every later run: a machine
// that ran a prompt on 0.1.51 never got the .profile line. Such a mark counts as having seen the files of
// that version: the login shell's, .bashrc, and the login bash file on macOS only.
export function ensureShellPath({ thinker = thinkerHome(), ...opts } = {}) {
  const mark = path.join(thinker, 'state', 'shell-path');
  const dir = path.join(thinker, 'bin');
  const files = pathFiles(dir, opts);
  let seen = null, text = null;
  try { text = fs.readFileSync(mark, 'utf8'); } catch {}
  if (text !== null) {
    try { seen = JSON.parse(text).files; } catch {}
    if (!Array.isArray(seen)) {
      const home = opts.home || os.homedir(), login = ['.bash_profile', '.bash_login', '.profile'].map(f => path.join(home, f));
      seen = files.map(f => f.rc).filter(rc => (opts.platform || process.platform) === 'darwin' || !login.includes(rc));
    }
  }
  const fresh = seen ? files.filter(f => !seen.includes(f.rc)) : files;
  if (seen && !fresh.length) return null;
  let done = [];
  if (fs.existsSync(path.join(dir, 'thinker')) && files.some(f => has(f.rc, dir, opts.home))) {
    for (const f of fresh.filter(f => !has(f.rc, dir, opts.home))) {
      try { fs.mkdirSync(path.dirname(f.rc), { recursive: true }); fs.appendFileSync(f.rc, `\n# thinker\n${f.line}\n`); done.push(f.rc); } catch {}
    }
  }
  try { fs.mkdirSync(path.dirname(mark), { recursive: true }); fs.writeFileSync(mark, JSON.stringify({ files: [...new Set([...(seen || []), ...files.map(f => f.rc)])] }) + '\n'); } catch {}
  return done;
}
