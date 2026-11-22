// Imported first by every test file, before anything from src/. It makes the process safe to run, by `npm test` or
// by hand (`node --test test/x.test.js`).
//
// thinker reads the home directory in dozens of places: the agents' settings, its own config, its logs, the service
// manager's entries. A test that forgot one of them has rewritten the owner's real files before. So the whole
// process gets a throwaway home, test mode, no telemetry, nothing the shell set for thinker or for an agent, no key
// a model call could be made with, and a git that knows nothing of this machine's configuration.
//
// What a test may rely on from here: no THINKER_HOME is set (thinker's test mode then keeps its caches off and its
// log beside the store); a test that needs a home passes one (`home`, `dir`) or sets the variable for itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'thinker-test-'));
export const home = path.join(root, 'home');
fs.mkdirSync(home);

const OURS = /^(THINKER_|CLAUDE_|CLAUDECODE$|CODEX_|CURSOR_|OPENCODE_|DEVIN_|GEMINI_|ANTHROPIC_|OPENAI_|OPENROUTER_|AWS_|XDG_|GIT_)/;
for (const k of Object.keys(process.env)) if (OURS.test(k)) delete process.env[k];
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  THINKER_TEST: '1',
  THINKER_TELEMETRY: 'off',
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
});
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

// A new empty directory, gone when the process exits.
let made = 0;
export function tmp(name = 'dir') {
  const dir = path.join(root, `${name}-${++made}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// A scratch repository with `files` committed on main. `at` dates that commit (thinker reads a section's age from
// it); `origin` adds a bare origin with main pushed and origin/HEAD set, which is all a pull request needs.
export function repo(files = { 'README.md': '# scratch\n' }, { at = null, origin = false } = {}) {
  const dir = tmp('repo');
  git(dir, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  git(dir, 'add', '-A');
  const date = at ? new Date(at).toISOString() : null;
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'start'], {
    cwd: dir, stdio: 'ignore', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
  if (origin) {
    const bare = tmp('origin');
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(dir, 'remote', 'add', 'origin', bare);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'remote', 'set-head', 'origin', 'main');
  }
  return dir;
}
