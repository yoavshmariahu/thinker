// The first session in a repository. Every git repository has a cache from its first session (the
// hooks start it), and nobody is asked to run `thinker setup` there: what setup would write for the
// repository is written here instead, once (`setupRepo`), and when the repository has history worth
// reading, the agent is told once to offer the person a warm-up, with the command to run on a yes
// (`warmupOffer`). Once means once per repository on this machine, not per clone or worktree, and
// nothing else repeats it: a second mention is a nag (2026-10-13, the user's call).
import fs from 'node:fs';
import path from 'node:path';
import { repoId } from './store.js';
import { thinkerHome } from './update.js';
import { installGitHooks } from './git-hooks.js';
import { trustCodex, installCursorRule } from './clients.js';
import { excludeFromGit } from './store.js';
import { estimateCacheBuild, DEFAULT_PRS } from './setup/estimate.js';
import { githubSlug } from './setup/agents.js';
import { formatDuration } from './setup/ui.js';
import { isTestMode } from './test-mode.js';

const mark = (store, name) => path.join(store.dir, 'state', name);
// true the first time a mark is set
const once = (store, name) => {
  const f = mark(store, name);
  if (fs.existsSync(f)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString() + '\n');
  return true;
};

// The per-repository pieces of `thinker setup`, once per cache: the git hooks that keep the cache fresh
// after a commit or a merge (a hook that is not thinker's is left alone), Codex's trust in the project
// (its hooks run nowhere else; never from the test suite, whose home is the real one), and Cursor's
// always-on rule, kept out of git status as the cache is. Returns what was done, or null when done before.
export function setupRepo(store, { client, cli, learn = true }) {
  if (!once(store, 'repo-setup')) return null;
  const done = [];
  try { installGitHooks(store.repo, cli, learn); done.push('git hooks'); } catch {}
  if (client === 'codex' && !isTestMode()) { try { trustCodex(store.repo); done.push('codex trust'); } catch {} }
  if (client === 'cursor') { try { installCursorRule(store.repo, { learn }); excludeFromGit(store.repo, ['.cursor/rules/thinker.mdc']); done.push('cursor rule'); } catch {} }
  store.log({ op: 'repo-setup', client, done });
  return done;
}

// The repositories offered a warm-up on this machine, by repository id (the origin, so every clone and
// worktree of one counts as it): THINKER_HOME/state/warmup-offered.json. Returns true the first time.
function offeredOnce(repo, home = thinkerHome()) {
  const file = path.join(home, 'state', 'warmup-offered.json');
  let done = {}; try { done = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const id = repoId(repo);
  if (done[id]) return false;
  done[id] = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(done, null, 2) + '\n');
  return true;
}

// Whether a warm-up is worth offering: a cache that is new (no notes yet, no pull requests read) in a
// repository with history to read (setup/estimate.js: merged pull requests through gh, or more than a
// few commits). Said to the agent once per repository on this machine, as an instruction to ask the
// person at a fitting moment and to run the warm-up itself on a yes: the command names this checkout,
// takes the defaults and asks nothing (warmup.js: --repos, --yes, --terminal), and reads through the
// agent's own login.
export function warmupOffer(store, { client, home } = {}) {
  if (['windsurf'].includes(client)) return '';
  if (fs.existsSync(mark(store, 'warmup-offered')) || fs.existsSync(path.join(store.dir, 'prs.json')) || store.list().length) return '';
  let est; try { est = estimateCacheBuild(store.repo, { prs: DEFAULT_PRS, slug: githubSlug(store.repo), fileCount: 0 }); } catch { return ''; }
  if (!est.canMine) return '';
  if (!once(store, 'warmup-offered') || !offeredOnce(store.repo, home)) return '';
  store.log({ op: 'warmup-offer', client, source: est.mineSource, seconds: est.timing.totalSeconds });
  const what = est.mineSource === 'github' ? 'merged pull requests' : 'commit history';
  return `<thinker-new-repository>\nthinker's cache for this repository is new and empty. Every git repository has one; it grows from your sessions, and this repository has ${what} it could be warmed up from, about ${formatDuration(est.timing.totalSeconds)} through your own login. Once, when it fits the conversation, ask the user whether they would like that. If they say yes, run \`thinker warmup --repos "${store.repo}" --yes --terminal\` from this directory in the background and go on with the task; if they say no or do not answer, go on and never ask again.\n</thinker-new-repository>`;
}
