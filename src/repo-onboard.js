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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoId } from './store.js';
import { thinkerHome } from './update.js';
import { installGitHooks } from './git-hooks.js';
import { trustCodex, installCursorRule } from './clients.js';
import { excludeFromGit } from './store.js';
import { estimateCacheBuild, DEFAULT_PRS } from './setup/estimate.js';
import { githubSlug, selectAndAuthenticateAgent, getAgentLoginCommand } from './setup/agents.js';
import { formatDuration } from './setup/ui.js';
import { isTestMode } from './test-mode.js';
import { WARMUP_CHOICES } from './warmup-choices.js';
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
  if (warmupNever(home) || fs.existsSync(mark(store, 'warmup-answered'))) return false;
  try { return minedCount(store) < WARM_MINED; } catch { return false; }
}

// The person's answer to the offer, from their agent's question tool (`thinker warmup --answer`) or
// thinker's picker (mcp.js:warmup): warm starts the warm-up detached, through the agent's own login, with
// its output in the cache's state directory; no leaves the offer made once, as it is; never stops every
// offer on this machine. Logged as warmup-answer (choice, client, via: picker, or text when the person
// answered in chat) for the telemetry (telemetry.js:warmupMetrics). Returns the line to tell the agent.
export async function answerWarmup(store, choice, { client, via = 'picker', home, spawnFn = spawn, selectAgentFn = selectAndAuthenticateAgent } = {}) {
  const value = ['warm', 'no', 'never', 'dismissed'].includes(choice) ? choice : 'no';
  once(store, 'warmup-answered');
  if (value === 'never') {
    store.log({ op: 'warmup-answer', choice: value, client, via });
    const f = neverFile(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date().toISOString() + '\n');
    return 'Recorded: thinker will not offer a warm-up again in any repository on this machine (thinker warmup still warms one up). Go on with the task.';
  }
  if (value !== 'warm') { store.log({ op: 'warmup-answer', choice: value, client, via }); return 'Recorded: no warm-up for this repository; thinker will not ask again here. Go on with the task.'; }
  // the agent the warm-up reads through, chosen as the warm-up chooses it, and signed in: checked here, since
  // the background run fails where nobody sees it (2026-10-15: in a container with Claude Code signed out the
  // answer said "started" and the log said "Authentication required")
  let auth;
  try { auth = await selectAgentFn({ requestedAgent: process.env.THINKER_LLM || null, yes: true, out: () => {}, purpose: 'warm up this repository', allowSkip: false }); }
  catch (e) { auth = { ok: false, error: e.message }; }
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
