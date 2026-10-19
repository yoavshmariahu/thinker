// Unmined direct commits: a cache whose warm-up read merged pull requests alone has never read the commits
// pushed straight to the default branch (until 2026-10-19 neither the warm-up nor maintenance listed them on a
// GitHub repository, prs.js:listMergedChanges), and in a repository developed mostly by direct commits that
// leaves the cache small. Maintenance counts them, without a model call; when enough wait, the prompt hook
// asks the person once whether to mine them, and a yes mines them in the background through their own
// agent's login, or through the session in a desktop app (2026-10-19, the user's call).
//
//   unminedCommits         the direct commits of the recent first-parent history the cache has not read
//   scheduleCommitsOffer   maintenance: at most weekly, a question queued when COMMITS.min of them wait
//   commitsOffer           the prompt hook: the question, once, for the agent to put to the person
//   answerCommits          the answer (MCP `commits`, `thinker commits --answer`): mine, no, or never
//
// Local state: <cache>/state/commits.json (the pending question, answers); THINKER_HOME/state/commits-never.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { thinkerHome } from './update.js';
import { minedPrs } from './prs.js';
import { githubSlug } from './setup/agents.js';
import { isWarm, minedCount, QUESTION_TOOLS, MCP_CLIENTS, SUBAGENT_TOOLS, subagentHarness, desktopApp, SESSION_PRS } from './repo-onboard.js';
import { QUEUE_ENV, queueDir, markBuild, buildRunning, subagentPrompt } from './session-llm.js';
import { selectAndAuthenticateAgent, getAgentLoginCommand } from './setup/agents.js';
import { formatTokens } from './model-usage.js';
import { TOKENS_PER_PR, DEFAULT_PRS } from './setup/estimate.js';

export const COMMITS = {
  scan: 500,       // first-parent commits read, newest first
  min: 20,         // unmined direct commits before anything is asked
  everyDays: 7,    // a check at most this often
  declineDays: 30, // a "no" is not asked again for this long
  answerDays: 3,   // a question left unanswered this long is dropped
  limit: DEFAULT_PRS, // commits one yes mines, as many as a warm-up's changes
};
const DAY = 86_400_000;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const stateDir = store => path.join(store.dir, 'state');
const stateFile = store => path.join(stateDir(store), 'commits.json');
const neverFile = (home = thinkerHome()) => path.join(home, 'state', 'commits-never');
export const commitsNever = home => fs.existsSync(neverFile(home));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v) + '\n'); };
export const readCommitsState = store => readJson(stateFile(store)) || {};
const saveState = (store, st) => writeJson(stateFile(store), st);
// what mining passes over whatever its size (prs.js:mineable), and merges of other branches
const SKIP = /^(chore|deps|docs|revert|ci|build|test)\b|\bbump\b|dependabot|renovate|snapshot|^Merge (branch|remote-tracking branch)\b/i;

// The direct commits (naming no pull request) of the newest COMMITS.scan on the first-parent history that the
// cache has not mined and mining would not pass over by their subject. One git process, no diff read.
export function unminedCommits(store, { slug = githubSlug(store.repo), scan = COMMITS.scan } = {}) {
  let raw = '';
  try { raw = execFileSync('git', ['log', '--first-parent', '-n', String(scan), '--format=%H%x1f%s%x1e'], { cwd: store.repo, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return { count: 0, scanned: 0 }; }
  const mined = minedPrs(store, slug).mined, entries = raw.split('\x1e').map(s => s.trim()).filter(Boolean);
  let count = 0;
  for (const e of entries) {
    const [hash, subject = ''] = e.split('\x1f');
    if (!hash || /Merge pull request #\d+|\(#\d+\)/i.test(subject) || SKIP.test(subject)) continue;
    if (!mined.has(hash.slice(0, 8))) count++;
  }
  return { count, scanned: entries.length };
}

// Maintenance: at most weekly, on a GitHub repository whose cache has read some of its history (a cold cache gets
// the warm-up offer, which lists direct commits itself), a question when COMMITS.min unmined direct commits wait.
// A question nobody answered in three days is dropped. Returns the count queued, or null.
export function scheduleCommitsOffer(store, { now = Date.now(), home, slug = githubSlug(store.repo) } = {}) {
  if (commitsNever(home) || !slug) return null;
  const st = readCommitsState(store);
  if (st.pending) {
    if (st.pending.offeredAt && now - Date.parse(st.pending.offeredAt) > COMMITS.answerDays * DAY) {
      store.log({ op: 'commits-answer', choice: 'unanswered', count: st.pending.count });
      delete st.pending; saveState(store, st);
    }
    return null;
  }
  if (st.checkedAt && now - Date.parse(st.checkedAt) < COMMITS.everyDays * DAY) return null;
  if (st.declinedAt && now - Date.parse(st.declinedAt) < COMMITS.declineDays * DAY) return null;
  if (!isWarm(store) && !minedCount(store)) return null;
  const { count, scanned } = unminedCommits(store, { slug });
  st.checkedAt = new Date(now).toISOString();
  if (count >= COMMITS.min) { st.pending = { at: st.checkedAt, count, scanned }; store.log({ op: 'commits-suggest', count, scanned }); }
  saveState(store, st);
  return count >= COMMITS.min ? count : null;
}

// Whether a question waits for its answer here: thinker's `commits` MCP tool is offered while one does.
export function commitsPending(store, { home } = {}) {
  return !commitsNever(home) && Boolean(readCommitsState(store).pending);
}

const answerCommand = (repo, via, client) => `"${process.execPath}" "${CLI}" commits --answer <mine|no|never> --via ${via}${client ? ` --client ${client}` : ''} --repo "${repo}"`;
const mineCommand = n => `thinker mine-prs --direct --limit ${n}`;
// The prompt hook: the pending question, said once, as an instruction to the agent to put it to the person.
export function commitsOffer(store, { client, home, now = Date.now() } = {}) {
  if (['windsurf', 'goose', 'augment'].includes(client) || commitsNever(home)) return '';
  const st = readCommitsState(store);
  if (!st.pending || st.pending.offeredAt) return '';
  st.pending.offeredAt = new Date(now).toISOString(); st.pending.client = client || null;
  saveState(store, st);
  store.log({ op: 'commits-offer', client, count: st.pending.count });
  const { count, scanned } = st.pending, n = Math.min(count, COMMITS.limit);
  const lead = `thinker found ${count} unmined commits in this repository: of its last ${scanned} commits on the default branch, ${count} were pushed straight to it, with no pull request, and its cache has not read them (the warm-up read merged pull requests only). It can mine ${n === count ? 'them' : `the newest ${n}`} into notes in the background, through the user's own agent login, at about ${formatTokens(n * TOKENS_PER_PR)} tokens.`;
  const choices = [`1. "Mine the commits": reads them now, in the background`, `2. "Not now": asks again in a month at the earliest`, `3. "Don't ask again": no such question on this machine`].join('\n');
  const tool = QUESTION_TOOLS[client];
  const via = tool && client !== 'codex' ? 'picker' : 'text';
  const after = MCP_CLIENTS.has(client)
    ? `Then call thinker's \`commits\` tool with choice mine, no or never (anything else is no) and asked "${via === 'picker' ? 'picker' : 'chat'}"; if that tool is not available, run \`${answerCommand(store.repo, via, client)}\` from this directory. thinker mines them in the background on mine. Then go on with the task.`
    : `Then run \`${answerCommand(store.repo, via, client)}\` from this directory with the answer (mine, no or never; anything else is no): thinker mines them in the background on mine. Then go on with the task.`;
  const ask = via === 'picker'
    ? `Before you start on the request, ask the user with your ${tool} tool, not in prose: one question, "Mine the ${count} unmined commits into thinker's cache?" (header "Commits"), with exactly these three options in this order:`
    : `Before you start on the request, ask the user in chat with these three numbered choices:`;
  return `<thinker-unmined-commits>\n${lead}\n${ask}\n${choices}\n${after}\n</thinker-unmined-commits>`;
}

// The answer: never stops these questions on this machine; no passes for a month; mine starts `mine-prs
// --direct` in the background, through the agent the person signed in with, or the session in a desktop app.
// Logged as commits-answer and commits-build. Returns the line to tell the agent.
export async function answerCommits(store, choice, { client, via = 'picker', home, now = Date.now(), spawnFn = spawn, selectAgentFn = selectAndAuthenticateAgent, appFn = desktopApp } = {}) {
  const st = readCommitsState(store), count = st.pending?.count || 0;
  const value = ['mine', 'no', 'never'].includes(String(choice).toLowerCase()) ? String(choice).toLowerCase() : 'no';
  const at = new Date(now).toISOString();
  delete st.pending;
  if (value === 'never') {
    const f = neverFile(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, at + '\n');
    saveState(store, st);
    store.log({ op: 'commits-answer', choice: 'never', client, via, count });
    return `Recorded: thinker will not ask about unmined commits again on this machine (\`${mineCommand(COMMITS.limit)}\` still mines them). Go on with the task.`;
  }
  if (value === 'no') {
    st.declinedAt = at; saveState(store, st);
    store.log({ op: 'commits-answer', choice: 'no', client, via, count });
    return 'Recorded: the commits are not mined now; thinker will not ask again for a month. Go on with the task.';
  }
  store.log({ op: 'commits-answer', choice: 'mine', client, via, count });
  // Inside a desktop app (Claude Desktop, the Codex app, Cursor) the mining reads through the app's own session,
  // whatever CLIs are signed in; elsewhere through the agent CLI the person signed in with, and through the
  // session when none is and the client can start a subagent (AGENTS.md: every model-backed feature works there).
  const harness = subagentHarness(client), app = harness && appFn(harness);
  let auth = null;
  if (!app) {
    try { auth = await selectAgentFn({ requestedAgent: process.env.THINKER_LLM || null, yes: true, out: () => {}, purpose: 'mine this repository\'s commits', allowSkip: false }); }
    catch (e) { auth = { ok: false, error: e.message }; }
  }
  const logFile = path.join(stateDir(store), 'commits-build.log');
  const start = (n, env) => {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const p = spawnFn(process.execPath, [CLI, 'mine-prs', '--direct', '--limit', String(n), '--repo', store.repo], { cwd: store.repo, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
    p.unref?.(); fs.closeSync(fd);
    return p;
  };
  if (app || (!auth?.ok && harness)) {
    const dir = queueDir(store), n = Math.min(count || SESSION_PRS, SESSION_PRS);
    if (buildRunning(dir)) {
      saveState(store, st);
      store.log({ op: 'commits-build', started: false, reason: 'session-busy', agent: 'session' });
      return `The mining did not start: another build already reads through this session (a warm-up or learning). Tell the user that \`${mineCommand(n)}\` mines the commits later. Go on with the task.`;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      markBuild(dir, start(n, { THINKER_LLM: 'session', [QUEUE_ENV]: dir }).pid);
    } catch (e) {
      saveState(store, st);
      store.log({ op: 'commits-build', started: false, reason: 'spawn', agent: 'session' });
      return `The mining did not start (${e.message}). The user can run \`${mineCommand(n)}\`. Go on with the task.`;
    }
    st.minedAt = at; saveState(store, st);
    store.log({ op: 'commits-build', started: true, commits: n, agent: 'session', ...(app ? { app } : {}) });
    const why = app ? `This session runs in ${app}, so the mining reads through it` : 'No agent CLI is signed in on this machine, so the mining reads through this session';
    return `${why}: the newest ${n} unmined commits started in the background (later maintenance and \`${mineCommand(COMMITS.limit)}\` continue it). It waits for a subagent to answer its model calls. Start one now with ${SUBAGENT_TOOLS[harness]}, and do not wait for it: give it exactly the prompt below. Tell the user in one line that the mining runs in a background subagent of this session, then go on with the task.\n\n${subagentPrompt(store.repo)}`;
  }
  const n = Math.min(count || COMMITS.limit, COMMITS.limit);
  if (!auth?.ok) {
    saveState(store, st);
    store.log({ op: 'commits-build', started: false, reason: auth?.error || 'no_agent' });
    return `The mining did not start: ${auth?.agent ? `${auth.agent} is not signed in` : 'no signed-in agent CLI was found (Claude Code, Codex, Gemini or Cursor)'}. Tell the user, and that \`${mineCommand(n)}\` mines the commits once ${auth?.agent ? `they sign in (\`${getAgentLoginCommand(auth.agent)}\`)` : 'one is set up'}. Go on with the task.`;
  }
  try { start(n, { THINKER_LLM: auth.agent }); }
  catch (e) {
    saveState(store, st);
    store.log({ op: 'commits-build', started: false, reason: 'spawn' });
    return `The mining did not start (${e.message}). The user can run \`${mineCommand(n)}\`. Go on with the task.`;
  }
  st.minedAt = at; saveState(store, st);
  store.log({ op: 'commits-build', started: true, commits: n, agent: auth.agent });
  return `Started in the background through ${auth.agent}: the newest ${n} unmined commits, about ${formatTokens(n * TOKENS_PER_PR)} tokens. It needs nothing more from you: tell the user in one line, then go on with the task.`;
}
