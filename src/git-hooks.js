import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitHookPath } from './store.js';
import { postCommitHook } from './maintain.js';

const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
export const HOOKS = ['pre-commit', 'post-commit', 'post-merge', 'pre-push'];
export function preCommitHook(cli) {
  return `#!/bin/sh
# thinker: optionally review staged code
[ "$THINKER_TEST" = 1 ] && exit 0
repo="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ "$(git config --bool thinker.reviewBeforeCommit 2>/dev/null)" = true ]; then
  tree=$(git write-tree) || exit 1
  node ${quote(cli)} review --staged --strict --repo "$repo" || exit $?
  if [ "$tree" != "$(git write-tree)" ]; then
    echo 'thinker: staged changes changed during review; run git commit again.' >&2
    exit 1
  fi
fi
exit 0
`;
}
// Worktrees share the main repository's hooks, and the post-commit hook names a checkout as its
// fallback (git names the real one at run time): the main repository's, so that every worktree
// writes the same text and a rewire from one does not rewrite what another wrote.
export function mainCheckout(repo) {
  try {
    const common = path.resolve(repo, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
    return path.basename(common) === '.git' ? path.dirname(common) : repo;
  } catch { return repo; }
}
export function installGitHooks(repo, cli, learn, out = () => {}) {
  const main = mainCheckout(repo);
  for (const name of HOOKS) {
    const file = gitHookPath(repo, name);
    if (!file) { out(`skipped git ${name} hook: not a git checkout`); continue; }
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('# thinker:')) {
      out(`skipped git ${name} hook: existing hook is not ours`); continue;
    }
    if (name === 'pre-push') {
      if (fs.existsSync(file)) { fs.unlinkSync(file); out('removed obsolete git pre-push note check'); }
      continue;
    }
    const text = name === 'pre-commit' ? preCommitHook(cli) : postCommitHook(cli, main, learn);
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
