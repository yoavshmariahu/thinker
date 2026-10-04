import fs from 'node:fs';
import path from 'node:path';
import { gitHookPath } from './store.js';
import { postCommitHook } from './maintain.js';

const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
export const HOOKS = ['pre-commit', 'post-commit', 'post-merge', 'pre-push'];
export function preCommitHook(cli) {
  return `#!/bin/sh\n# thinker: repair staged shared notes before commit\n` +
    `case "$THINKER_NO_LEARN" in 1|true|yes) exit 0 ;; esac\n` +
    `repo="$(git rev-parse --show-toplevel 2>/dev/null)"\n` +
    `node ${quote(cli)} share --repair-staged --repo "$repo"\n` +
    `exit 0\n`;
}
export function prePushHook(cli) {
  // A pushed commit is already fixed in Git's ref list; this hook only reports.
  return `#!/bin/sh\n# thinker: report shared-note issues without blocking a push\n` +
    `node ${quote(cli)} share --check --pre-push --remote "$1"\n` +
    `exit 0\n`;
}
export function installGitHooks(repo, cli, learn, out = () => {}) {
  for (const name of HOOKS) {
    const file = gitHookPath(repo, name);
    if (!file) { out(`skipped git ${name} hook: not a git checkout`); continue; }
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('# thinker:')) {
      out(`skipped git ${name} hook: existing hook is not ours`); continue;
    }
    const text = name === 'pre-push' ? prePushHook(cli) : name === 'pre-commit' ? preCommitHook(cli) : postCommitHook(cli, repo, learn);
    let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    if (cur === text) { out(`git ${name} hook already in place`); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    out(`installed git ${name} hook`);
  }
}
export function uninstallGitHooks(repo) {
  for (const name of HOOKS) {
    const file = gitHookPath(repo, name);
    if (file && fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('# thinker:')) fs.unlinkSync(file);
  }
}
