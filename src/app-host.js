// The desktop apps a session can run in, and how their agents start a subagent. Inside an app (Claude Desktop,
// the Codex app, Cursor) thinker runs no agent CLI: a desktop app's login does not sign in its CLI, and many
// of their users have none. Every model call goes through the app's own session instead, a background
// subagent answering thinker's queue (session-llm.js): the warm-up (repo-onboard.js:answerWarmup) and
// learning (session-work.js).
import { execFileSync } from 'node:child_process';
import { isTestMode } from './test-mode.js';

// How each client's agent starts a subagent that keeps running while it goes on. Codex's spawn_agent does
// not block; Cursor's Task tool and Claude Code's Agent tool run one in the background when asked.
export const SUBAGENT_TOOLS = { claude: 'your Agent tool, with run_in_background: true', codex: 'spawn_agent (do not call wait_agent for it)', cursor: 'your Task tool, in the background' };
// The harness behind a client name: the hooks' and the CLI's (claude, codex, cursor) or an MCP client's own
// (claude-code, codex-mcp-client, cursor-vscode). Claude's chat apps (claude-ai) start no subagents.
export const subagentHarness = client => { const n = String(client || '').toLowerCase(); return n === 'claude' || n.startsWith('claude-code') ? 'claude' : n.includes('codex') ? 'codex' : n.includes('cursor') ? 'cursor' : null; };

// Claude Desktop says so in the env it starts Claude Code with (CLAUDE_CODE_ENTRYPOINT=claude-desktop, seen
// 2026-10-16), Cursor in its agent's shell (CURSOR_AGENT=1: its sandbox hides the process tree from ps, so
// the ancestry came back empty, 2026-10-16); the Codex app (inside ChatGPT.app) and Cursor's MCP servers get
// HOME, PATH and little else, so their app is found among this process's ancestors. A CLI in a terminal has
// neither; Claude Code's own CLI bundle (~/.local/share/claude/ClaudeCode.app) is not Claude.app.
const APPS = {
  claude: { name: 'Claude Desktop', env: e => e.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop', bundle: /\/Claude\.app\/Contents\// },
  codex: { name: 'the Codex app', bundle: /\/(ChatGPT|Codex)\.app\/Contents\// },
  cursor: { name: 'Cursor', env: e => e.CURSOR_AGENT === '1', bundle: /\/Cursor\.app\/Contents\// },
};
export function processAncestry(pid = process.ppid, { max = 16, execFn = execFileSync } = {}) {
  const out = [];
  if (process.platform === 'win32') return out;
  for (let i = 0; i < max && pid > 1; i++) {
    let line; try { line = execFn('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim(); } catch { break; }
    const m = line.match(/^(\d+)\s+(.*)$/); if (!m) break;
    out.push(m[2]); pid = Number(m[1]);
  }
  return out;
}
// The suite never reads the machine's process tree: run from a desktop app, every test sat under the app's
// bundle and took itself for an app session. A test passes its own ancestry.
const machineAncestry = () => isTestMode() ? [] : processAncestry();
// The app this session runs in, for a harness: its name, or null.
export function desktopApp(harness, { env = process.env, ancestry = machineAncestry } = {}) {
  const a = APPS[harness]; if (!a) return null;
  if (a.env?.(env)) return a.name;
  return (typeof ancestry === 'function' ? ancestry() : ancestry).some(c => a.bundle.test(c)) ? a.name : null;
}
// Any of them, for a process that does not know its client (the MCP server before the client says who it is).
export function anyDesktopApp({ env = process.env, ancestry = machineAncestry } = {}) {
  const chain = typeof ancestry === 'function' ? ancestry() : ancestry;
  for (const h of Object.keys(APPS)) { const n = desktopApp(h, { env, ancestry: chain }); if (n) return n; }
  return null;
}
