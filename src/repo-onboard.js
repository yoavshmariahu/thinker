// The first session in a repository. Every git repository has a cache from its first session (the
// hooks start it), and nobody is asked to run `thinker setup` there: what setup would write for the
// repository is written here instead, once (`setupRepo`), and when the repository has history worth
// reading and the cache has not read it yet, the agent is told once to offer the person a warm-up, with
// the command to run on a yes (`warmupOffer`). Once means once per repository on this machine, not per
// clone or worktree, and nothing else repeats it: a second mention is a nag (2026-10-13, the user's call).
// Since 2026-10-15 the offer is a choice the person makes, not a sentence the agent may soften or skip:
// the agent's own question tool shows three options (warm up, no, don't ask again), and in Codex, whose
// question tool is off outside plan mode, thinker's MCP tool shows them through elicitation (mcp.js:warmup).
// Either way the answer comes back to `answerWarmup`, which acts on it and logs it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, repoId } from './store.js';
import { thinkerHome } from './update.js';
import { installGitHooks, mainCheckout } from './git-hooks.js';
import { trustCodex, installCursorRule } from './clients.js';
import { excludeFromGit } from './store.js';
import { estimateCacheBuild, DEFAULT_PRS } from './setup/estimate.js';
import { githubSlug, selectAndAuthenticateAgent, getAgentLoginCommand } from './setup/agents.js';
import { formatDuration } from './setup/ui.js';
import { isTestMode } from './test-mode.js';
import { WARMUP_CHOICES } from './warmup-choices.js';
import { QUEUE_ENV, queueDir, markBuild, subagentPrompt } from './session-llm.js';
export { WARMUP_CHOICES };

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

// The repositories offered a warm-up on this machine, by repository id (the origin, so every clone and
// worktree of one counts as it): THINKER_HOME/state/warmup-suggested.json. Returns true the first time.
// Until 2026-10-14 the offer went only to an empty cache and was recorded in warmup-offered.json; install
// problems left many of those caches cold after it (the telemetry: devices in daily use with 2 to 25 notes
// and no request answered), so a new record asks every cold cache once more.
function offeredOnce(repo, home = thinkerHome(), { peek = false } = {}) {
  const file = path.join(home, 'state', 'warmup-suggested.json');
  let done = {}; try { done = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const id = repoId(repo);
  if (done[id]) return false;
  if (peek) return true;
  done[id] = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(done, null, 2) + '\n');
  return true;
}

// The cache a warm-up offer is about: a checkout's own, but for a linked worktree (`git worktree add`) the
// main checkout's. A worktree has a cache of its own, which starts cold however warm the repository's is
// (2026-10-15: a detached worktree of a warm checkout was offered a warm-up as a new repository), so the
// offer, the judgement that the cache is cold and the warm-up follow the repository the worktree belongs to.
// null when that has no cache (a worktree of a bare repository, or of a checkout no session ran in): no offer.
export function offerStore(store) {
  try { if (!fs.statSync(path.join(store.repo, '.git')).isFile()) return store; } catch { return store; }
  // .git is a file in a linked worktree and in a submodule; only a worktree's git directory is not its common one
  let dirs; try { dirs = execFileSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], { cwd: store.repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').map(d => path.resolve(store.repo, d)); } catch { return store; }
  if (dirs[0] === dirs[1]) return store;
  const main = mainCheckout(store.repo);
  if (main === store.repo) return null;
  const s = new Store(main);
  return s.exists() ? s : null;
}

// A cache is warm once it has read some of its repository's history: a warm-up reads up to 50 merged
// changes, maintenance a few at a time. Notes from sessions alone do not make it warm.
export const WARM_MINED = 10;
// The merged changes a cache has read: the record beside the notes (prs.js:recordMinedPrs, one entry per
// repository and per area), and the notes that name the change they came from (caches older than the record).
export function minedCount(store) {
  let rec = {}; try { rec = JSON.parse(fs.readFileSync(path.join(store.dir, 'prs.json'), 'utf8')); } catch {}
  const ids = new Set();
  for (const r of Object.values(rec || {})) for (const id of r?.mined || []) ids.add(String(id));
  for (const n of store.list()) if (n.source?.type === 'pr' && n.source.ref) ids.add(String(n.source.ref).split('#').pop());
  return ids.size;
}

// Whether a warm-up is worth offering: a cold cache (fewer than WARM_MINED merged changes read, whatever its
// sessions saved) in a repository with history to read (setup/estimate.js: merged pull requests through gh,
// or more than a few commits). Said to the agent once per repository on this machine, as an instruction to
// put three choices to the person before the request (`askText`) and hand the answer to thinker
// (`answerWarmup`), which runs the warm-up on a yes: it names this checkout, takes the defaults and asks
// nothing (warmup.js: --repos, --yes, --terminal), and reads through the agent's own login. Nothing is
// offered on a machine where the person chose "Don't ask again".
export function warmupOffer(store, { client, home } = {}) {
  if (['windsurf'].includes(client)) return '';
  store = offerStore(store);
  if (!store) return '';
  const est = warmupDue(store, { home });
  if (!est || !markOffered(store, est, { client, home })) return '';
  const notes = store.list().length;
  const what = est.mineSource === 'github' ? 'merged pull requests' : 'commit history';
  const state = notes
    ? `thinker's cache for this repository is cold: it holds ${notes} note${notes === 1 ? '' : 's'} from sessions and has not read the repository's history yet, so most requests find nothing in it`
    : `thinker's cache for this repository is new and empty. Every git repository has one; it grows from your sessions`;
  const lead = `${state}. This repository has ${what} it could be warmed up from, about ${formatDuration(est.timing.totalSeconds)} through the user's own login.`;
  return `<thinker-new-repository>\n${lead}\n${askText(client, store.repo, formatDuration(est.timing.totalSeconds))}\n</thinker-new-repository>`;
}

// Whether an offer is due here, marking nothing: the build estimate when it is, else null. An answered
// offer counts as made.
function warmupDue(store, { home } = {}) {
  if (warmupNever(home) || fs.existsSync(mark(store, 'warmup-answered'))) return null;
  if (fs.existsSync(mark(store, 'warmup-suggested')) || minedCount(store) >= WARM_MINED) return null;
  if (!offeredOnce(store.repo, home, { peek: true })) return null;
  let est; try { est = estimateCacheBuild(store.repo, { prs: DEFAULT_PRS, slug: githubSlug(store.repo), fileCount: 0 }); } catch { return null; }
  return est.canMine ? est : null;
}
// The offer made: once per cache and once per repository on this machine, logged for the telemetry.
function markOffered(store, est, { client, home } = {}) {
  if (!once(store, 'warmup-suggested') || !offeredOnce(store.repo, home)) return false;
  store.log({ op: 'warmup-offer', client, source: est.mineSource, seconds: est.timing.totalSeconds, notes: store.list().length });
  return true;
}

// Each agent's own multiple-choice tool (2026-10-15: AskUserQuestion in Claude Code, ask_user in the Gemini
// and Copilot CLIs, AskQuestion in Cursor, question in opencode). Codex has request_user_input, but outside
// plan mode it is behind a feature that is off (default_mode_request_user_input), so Codex gets thinker's
// MCP tool, which asks through elicitation. pi has none: its extension shows the choices itself
// (integrations/pi.js), and without a UI the agent asks in chat.
export const QUESTION_TOOLS = { claude: 'AskUserQuestion', gemini: 'ask_user', copilot: 'ask_user', cursor: 'AskQuestion', opencode: 'question' };
// The answer goes back through thinker's `warmup` MCP tool where the agent has thinker's server (it took
// the answer where the shell did not find `thinker`, 2026-10-15), else through the command line, named by
// path: `thinker` is on the PATH of the person's own shells, not always of the agent's.
const MCP_CLIENTS = new Set(['claude', 'codex', 'gemini', 'cursor', 'opencode', 'copilot']); // Copilot's in .github/mcp.json (clients.js:MCP_FILES)
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const answerCommand = (repo, via, client) => `"${process.execPath}" "${CLI}" warmup --answer <warm|no|never> --via ${via}${client ? ` --client ${client}` : ''} --repos "${repo}"`;
function askText(client, repo, duration) {
  const options = WARMUP_CHOICES.map((c, i) => `${i + 1}. "${c.label}"${c.value === 'warm' ? ` (about ${duration} in the background)` : ''}: ${c.description}`).join('\n');
  const command = via => `run \`${answerCommand(repo, via, client)}\` from this directory with the answer (warm, no or never; anything else is no)`;
  const after = via => MCP_CLIENTS.has(client)
    ? `Then call thinker's \`warmup\` tool with choice warm, no or never (anything else is no) and asked "${via === 'picker' ? 'picker' : 'chat'}"; if that tool is not available, ${command(via)}. thinker records the answer and, on warm, starts the warm-up in the background itself. Then go on with the task.`
    : `Then ${command(via)}: thinker records it and, on warm, starts the warm-up in the background itself. Then go on with the task.`;
  if (client === 'codex') return `Before you start on the request, call thinker's \`warmup\` tool with no arguments: it shows the user a picker with three choices and acts on the answer. Then go on with the task. If the tool is not available, ask the user in chat with these three numbered choices:\n${options}\n${after('text')}`;
  const tool = QUESTION_TOOLS[client];
  if (tool) return `Before you start on the request, ask the user with your ${tool} tool, not in prose: one question, "Warm up thinker's cache for this repository?" (header "Warm-up"), with exactly these three options in this order:\n${options}\n${after('picker')}`;
  return `Before you start on the request, ask the user in chat with these three numbered choices:\n${options}\n${after('text')}`;
}

// "Don't ask again": no warm-up offer in any repository on this machine, THINKER_HOME/state/warmup-never.
const neverFile = (home = thinkerHome()) => path.join(home, 'state', 'warmup-never');
export const warmupNever = home => fs.existsSync(neverFile(home));

// Whether thinker's `warmup` MCP tool is worth offering in a session (mcp.js): an offer may be waiting for
// its answer in this repository. A cache that answered, a warm one, or a machine that said never has none.
export function warmupPending(store, { home } = {}) {
  store = offerStore(store);
  if (!store || warmupNever(home) || fs.existsSync(mark(store, 'warmup-answered'))) return false;
  try { return minedCount(store) < WARM_MINED; } catch { return false; }
}

// How each client's agent starts a subagent that keeps running while it goes on: the clients a warm-up can
// read through when no agent CLI is signed in (session-llm.js). Codex's spawn_agent does not block; Cursor's
// Task tool and Claude Code's Agent tool run one in the background when asked.
export const SUBAGENT_TOOLS = { claude: 'your Agent tool, with run_in_background: true', codex: 'spawn_agent (do not call wait_agent for it)', cursor: 'your Task tool, in the background' };
// The harness behind a client name: the hooks' and the CLI's (claude, codex, cursor) or an MCP client's own
// (claude-code, codex-mcp-client, cursor-vscode). Claude's chat apps (claude-ai) start no subagents.
export const subagentHarness = client => { const n = String(client || '').toLowerCase(); return n === 'claude' || n.startsWith('claude-code') ? 'claude' : n.includes('codex') ? 'codex' : n.includes('cursor') ? 'cursor' : null; };
// The desktop app this session runs in, for a harness: Claude Desktop says so in the env it starts Claude Code
// with (CLAUDE_CODE_ENTRYPOINT=claude-desktop, seen 2026-10-16); the Codex app (inside ChatGPT.app) and Cursor
// set nothing, so their app is found among this process's ancestors. A CLI in a terminal has neither.
const APPS = {
  claude: { name: 'Claude Desktop', env: e => e.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop', bundle: /\/Claude\.app\/Contents\// },
  codex: { name: 'the Codex app', bundle: /\/(ChatGPT|Codex)\.app\/Contents\// },
  cursor: { name: 'Cursor', bundle: /\/Cursor\.app\/Contents\// },
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
export function desktopApp(harness, { env = process.env, ancestry = processAncestry } = {}) {
  const a = APPS[harness]; if (!a) return null;
  if (a.env?.(env)) return a.name;
  return (typeof ancestry === 'function' ? ancestry() : ancestry).some(c => a.bundle.test(c)) ? a.name : null;
}
// A session warm-up is sized to one subagent's context: a merged change's evidence is up to ~10k tokens.
export const SESSION_PRS = 12;

// The build, started detached with the session provider; its model calls wait in the queue for the subagent.
export function startSessionWarmup(store, { spawnFn = spawn } = {}) {
  const dir = queueDir(store), logFile = path.join(store.dir, 'state', 'warmup.log');
  try {
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const p = spawnFn(process.execPath, [CLI, 'setup', '--build', '--yes', '--no-ui', '--no-benchmark', '--no-docs', '--prs', String(SESSION_PRS), '--agent', 'session', '--repo', store.repo],
      { cwd: store.repo, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, [QUEUE_ENV]: dir } });
    p.unref?.(); fs.closeSync(fd);
    markBuild(dir, p.pid);
    return { dir, logFile };
  } catch (e) { return { error: e.message.slice(0, 120) }; }
}

// The person's answer to the offer, from their agent's question tool (`thinker warmup --answer`) or
// thinker's picker (mcp.js:warmup): warm starts the warm-up detached, through the agent's own login, with
// its output in the cache's state directory; no leaves the offer made once, as it is; never stops every
// offer on this machine. Logged as warmup-answer (choice, client, via: picker, or text when the person
// answered in chat) for the telemetry (telemetry.js:warmupMetrics). Returns the line to tell the agent.
export async function answerWarmup(store, choice, { client, via = 'picker', home, spawnFn = spawn, selectAgentFn = selectAndAuthenticateAgent, appFn = desktopApp } = {}) {
  const value = ['warm', 'no', 'never', 'dismissed'].includes(choice) ? choice : 'no';
  store = offerStore(store) || store;   // asked in a worktree: the answer is about its repository's cache
  once(store, 'warmup-answered');
  if (value === 'never') {
    store.log({ op: 'warmup-answer', choice: value, client, via });
    const f = neverFile(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString() + '\n');
    return 'Recorded: thinker will not offer a warm-up again in any repository on this machine (thinker warmup still warms one up). Go on with the task.';
  }
  if (value !== 'warm') { store.log({ op: 'warmup-answer', choice: value, client, via }); return 'Recorded: no warm-up for this repository; thinker will not ask again here. Go on with the task.'; }
  // Inside a desktop app (Claude Desktop, the Codex app, Cursor) the warm-up goes through the app's own
  // session, whatever CLIs are signed in: a subagent reads, on the app's login and model.
  const harness = subagentHarness(client), app = harness && appFn(harness);
  // Elsewhere: the agent the warm-up reads through, chosen as the warm-up chooses it, and signed in: checked
  // here, since the background run fails where nobody sees it (2026-10-15: in a container with Claude Code
  // signed out the answer said "started" and the log said "Authentication required").
  let auth = null;
  if (!app) {
    try { auth = await selectAgentFn({ requestedAgent: process.env.THINKER_LLM || null, yes: true, out: () => {}, purpose: 'warm up this repository', allowSkip: false }); }
    catch (e) { auth = { ok: false, error: e.message }; }
  }
  // in an app, or with no CLI login in a client whose agent can start a subagent: the session reads (session-llm.js)
  if (app || (!auth?.ok && harness)) {
    const r = startSessionWarmup(store, { spawnFn });
    store.log({ op: 'warmup-answer', choice: value, client, via, started: !r.error, agent: 'session', ...(app ? { app } : {}), ...(r.error ? { reason: r.error } : {}) });
    if (r.error) return `The warm-up did not start (${r.error}). The user can run \`thinker warmup\` in this repository. Go on with the task.`;
    const why = app ? `This session runs in ${app}, so the warm-up reads through it` : `No agent CLI is signed in on this machine${auth?.agent ? ` (${auth.agent})` : ''}, so the warm-up reads through this session`;
    return `${why}: it started in the background and waits for a subagent to answer its model calls (about ${SESSION_PRS} merged pull requests; output in ${path.relative(store.repo, r.logFile)}). Start one now with ${SUBAGENT_TOOLS[harness]}, and do not wait for it: give it exactly the prompt below. Tell the user in one line that the warm-up runs in a background subagent of this session, then go on with the task.\n\n${subagentPrompt(store.repo)}`;
  }
  if (!auth?.ok) {
    store.log({ op: 'warmup-answer', choice: value, client, via, started: false, reason: auth?.error || 'no agent' });
    const why = auth?.error === 'no_agent' ? 'no agent CLI that thinker reads through is installed (Claude Code, Gemini, Codex or Cursor)'
      : auth?.agent ? `${auth.agent} is not signed in` : 'no signed-in agent was found';
    return `The warm-up did not start: ${why}. Tell the user, and that once ${auth?.agent ? `they sign in (\`${getAgentLoginCommand(auth.agent)}\`)` : 'one is set up'}, \`thinker warmup\` in this repository warms it up. Go on with the task.`;
  }
  const logFile = path.join(store.dir, 'state', 'warmup.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const p = spawnFn(process.execPath, [CLI, 'warmup', '--repos', store.repo, '--yes', '--terminal', '--agent', auth.agent], { cwd: store.repo, detached: true, stdio: ['ignore', fd, fd] });
    p.unref?.(); fs.closeSync(fd);
  } catch (e) {
    store.log({ op: 'warmup-answer', choice: value, client, via, started: false, reason: e.message.slice(0, 120) });
    return `The warm-up did not start (${e.message}). The user can run \`thinker warmup\` in this repository. Go on with the task.`;
  }
  store.log({ op: 'warmup-answer', choice: value, client, via, started: true, agent: auth.agent });
  return `The warm-up started in the background through ${auth.agent} (output in ${path.relative(store.repo, logFile)}); notes reach the cache as it reads. Go on with the task.`;
}
