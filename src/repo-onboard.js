// The first session in a repository. Every git repository has a cache from its first session (the
// hooks start it), and nobody is asked to run `thinker setup` there: what setup would write for the
// repository is written here instead, once (`setupRepo`). The cache grows from the sessions alone: the
// warm-up that read a repository's merged changes into it, and the offer of one, were removed on
// 2026-10-21 (the owner's decision).
import fs from 'node:fs';
import path from 'node:path';
import { installGitHooks } from './git-hooks.js';
import { trustCodex } from './clients.js';
import { isTestMode } from './test-mode.js';
import { SUBAGENT_TOOLS, subagentHarness, desktopApp } from './app-host.js';
import { SIGNATURE } from './harness.js';
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
  // Cursor's always-applied rule, which a step here wrote until 2026-10-22, is taken out by the prompt hook's
  // wiring check (clients.js:removeCursorRule)
  if (!done.length) return null;
  store.log({ op: 'repo-setup', client, done });
  return done;
}

// Each agent's own multiple-choice tool (2026-10-15: AskUserQuestion in Claude Code, ask_user in the Gemini
// and Copilot CLIs, AskQuestion in Cursor, question in opencode), for the questions thinker has the agent put
// to the person (coverage.js). Codex has request_user_input, but outside plan mode it is behind a feature that
// is off (default_mode_request_user_input), so Codex gets thinker's MCP tool, which asks through elicitation.
export const QUESTION_TOOLS = { claude: 'AskUserQuestion', gemini: 'ask_user', agy: 'ask_question', copilot: 'ask_user', cursor: 'AskQuestion', opencode: 'question' };
// Every question thinker has an agent ask says, in the question itself, that it is thinker asking (2026-10-29,
// the owner's ask). The person sees their own agent's picker, so a question that reads as the agent's own idea
// leaves them deciding what to cut out of their context without knowing who asked or what will act on the
// answer -- and the one question that cuts waste was the one that never said so ("Cut what loads into every
// session here?", header "Context"). The header is the chip beside the question and Claude Code caps it at 12
// characters, so the name goes there alone and the topic stays in the question text.
export const QUESTION_HEADER = 'thinker';
// The clause each offer builds its instruction from, so the label cannot be forgotten by one of them: the tool,
// the question as thinker wrote it, the header, and the reason the agent may not reword either.
export const askThrough = (tool, question) =>
  `ask the user with your ${tool} tool, not in prose: "${question}" (header "${QUESTION_HEADER}"), the question and the header exactly as written here so they can see thinker is asking and not you`;
// Where there is no such tool, the question goes in the chat, and the agent says whose question it is the same way
// it says anything else from thinker (harness.js:SIGNATURE).
export const askInChat = what => `ask the user in chat, in a line opening "${SIGNATURE}:" so they can see the question comes from thinker, ${what}`;
// The answer goes back through thinker's MCP tool where the agent has thinker's server (it took the answer
// where the shell did not find `thinker`, 2026-10-15), else through the command line, named by path.
export const MCP_CLIENTS = new Set(['devin', 'claude', 'codex', 'gemini', 'agy', 'cursor', 'opencode', 'copilot']); // Copilot's in .github/mcp.json (clients.js:MCP_FILES)
