import fs from 'node:fs';
import path from 'node:path';
import { gitHookPath } from './store.js';
import { postCommitHook } from './maintain.js';

const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
export const HOOKS = ['post-commit', 'post-merge', 'pre-push'];
export function prePushHook(cli) {
  // Exit 2 means validation errors. Missing node/CLI and unexpected failures fail open.
  return `#!/bin/sh\n# thinker: validate shared notes in the commits being pushed\n` +
    `node ${quote(cli)} share --check --pre-push --remote "$1"\n` +
    `result=$?\n[ "$result" -eq 2 ] && exit 1\nexit 0\n`;
}
export function installGitHooks(repo, cli, learn, out = () => {}) {
  for (const name of HOOKS) {
    const file = gitHookPath(repo, name);
    if (!file) { out(`skipped git ${name} hook: not a git checkout`); continue; }
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('# thinker:')) {
      out(`skipped git ${name} hook: existing hook is not ours`); continue;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, name === 'pre-push' ? prePushHook(cli) : postCommitHook(cli, repo, learn), { mode: 0o755 });
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
