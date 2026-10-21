// The first session in a repository. Every git repository has a cache from its first session (the
// hooks start it), and nobody is asked to run `thinker setup` there: what setup would write for the
// repository is written here instead, once (`setupRepo`). The cache grows from the sessions alone: the
// warm-up that read a repository's merged changes into it, and the offer of one, were removed on
// 2026-10-21 (the owner's decision).
import fs from 'node:fs';
import path from 'node:path';
import { installGitHooks } from './git-hooks.js';
import { trustCodex, installCursorRule } from './clients.js';
import { excludeFromGit } from './store.js';
import { isTestMode } from './test-mode.js';
import { SUBAGENT_TOOLS, subagentHarness, desktopApp } from './app-host.js';
export { SUBAGENT_TOOLS, subagentHarness, desktopApp };

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
  const done = [];
  // The old repo-setup marker covers the shared git hooks only. Each agent still needs its own
  // first-use setup, including in caches that another agent already visited. Failed writes retry.
  const step = (name, label, fn) => {
    if (fs.existsSync(mark(store, name))) return;
    try { fn(); once(store, name); done.push(label); } catch {}
  };
  step('repo-setup', 'git hooks', () => installGitHooks(store.repo, cli, learn));
  if (client === 'codex' && !isTestMode()) step('repo-setup-codex', 'codex trust', () => trustCodex(store.repo));
  if (client === 'cursor') step('repo-setup-cursor', 'cursor rule', () => {
    installCursorRule(store.repo, { learn }); excludeFromGit(store.repo, ['.cursor/rules/thinker.mdc']);
  });
  if (!done.length) return null;
  store.log({ op: 'repo-setup', client, done });
  return done;
}

// Each agent's own multiple-choice tool (2026-10-15: AskUserQuestion in Claude Code, ask_user in the Gemini
// and Copilot CLIs, AskQuestion in Cursor, question in opencode), for the questions thinker has the agent put
// to the person (coverage.js). Codex has request_user_input, but outside plan mode it is behind a feature that
// is off (default_mode_request_user_input), so Codex gets thinker's MCP tool, which asks through elicitation.
export const QUESTION_TOOLS = { claude: 'AskUserQuestion', gemini: 'ask_user', copilot: 'ask_user', cursor: 'AskQuestion', opencode: 'question' };
// The answer goes back through thinker's MCP tool where the agent has thinker's server (it took the answer
// where the shell did not find `thinker`, 2026-10-15), else through the command line, named by path.
export const MCP_CLIENTS = new Set(['claude', 'codex', 'gemini', 'cursor', 'opencode', 'copilot']); // Copilot's in .github/mcp.json (clients.js:MCP_FILES)
