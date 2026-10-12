// `thinker disable` / `thinker enable`: switch thinker off, or back on, for the repository the
// command runs in (or --repo), machine-wide (repo-switch.js). For a repository with sensitive content.
import { setRepoDisabled, disabledRepo, disabledRepos } from '../repo-switch.js';
import { isGitCheckout } from '../store.js';
import { displayName } from '../machine.js';
import { repoId } from '../store.js';

async function disableCommand({ repo, out }) {
  if (!isGitCheckout(repo)) { process.stderr.write(`thinker: ${repo} is not a git repository.\n`); process.exitCode = 1; return; }
  const name = displayName(repoId(repo), repo);
  setRepoDisabled(repo, { disabled: true, name });
  out(`thinker is off for ${name} (${repo}) and every clone or worktree of it: the hooks and the MCP server do nothing there, no session is distilled, no pull request is read, nothing is written into it.`);
  out(`An existing cache stays where it is until you delete the repository's .thinker folder. \`thinker enable\` turns thinker back on.`);
}
async function enableCommand({ repo, out }) {
  if (!isGitCheckout(repo)) { process.stderr.write(`thinker: ${repo} is not a git repository.\n`); process.exitCode = 1; return; }
  const was = disabledRepo(repo);
  setRepoDisabled(repo, { disabled: false });
  out(was ? `thinker is on again for ${was.name || repo}.` : `thinker was not off for ${repo}; nothing changed.`);
  const rest = disabledRepos();
  if (rest.length) out(`Still off: ${rest.map(e => e.name || e.checkout).join(', ')}.`);
}

export const commands = { disable: disableCommand, enable: enableCommand };
