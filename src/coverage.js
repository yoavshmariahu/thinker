// Coverage suggestions: about once a week, the directories a person's sessions keep working in that the
// cache covers little, put to them as one question (up to five, each with its build estimate). The ones they
// pick are read into understanding notes in the background (understand.js, every code file of the directory),
// through their own agent's login (2026-10-16, the user's call: a note in every directory
// costs too much to build, but a person may well want one where they work).
//
//   recordAccess   the tool hook: which directories (areas.js:areaOf, two levels) a session read or edited, per day
//   scheduleSuggestion   maintenance: at most weekly, once there is enough activity, picks up to five directories
//   coverageOffer  the prompt hook: the question, once, for the agent to put to the person
//   answerCoverage the answer (MCP `coverage`, `thinker coverage --answer`): builds the chosen directories, or
//                  leaves them alone for a month, or stops suggestions on this machine
//
// Local state: <cache>/state/access.json (28 days of counts) and coverage.json (the pending question, answers);
// THINKER_HOME/state/coverage-never. Counts only reach the telemetry (telemetry.js:coverageMetrics).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { areaOf } from './areas.js';
import { thinkerHome } from './update.js';
import { codeFiles, batchFiles, filesRead } from './understand.js';
import { QUESTION_TOOLS, MCP_CLIENTS, SUBAGENT_TOOLS, subagentHarness, desktopApp, askThrough, askInChat } from './repo-onboard.js';
import { QUEUE_ENV, queueDir, markBuild, buildRunning, subagentPrompt } from './session-llm.js';
import { selectAndAuthenticateAgent, getAgentLoginCommand } from './setup/agents.js';
import { formatTokens } from './model-usage.js';

export const COVERAGE = {
  windowDays: 28,  // days of access counts kept and read
  minSessions: 5,  // sessions in the window before anything is suggested
  minDays: 3,      // on this many different days
  everyDays: 7,    // a suggestion at most this often
  max: 5,          // directories in one suggestion
  halfLife: 7,     // days after which a session counts half toward a directory's activity
  maxCovered: 0.5, // a directory is suggested while less than this share of its code files have a note
  minFiles: 3,     // code files a directory needs to be worth a build
  declineDays: 30, // a directory the person passed on, or had built, is not suggested again for this long
  answerDays: 3,   // a question left unanswered this long is dropped
  // what a build spends beyond the code it reads, per model call: the instructions, the notes it writes and a search
  // text per note (mlflow top 200: 3.4M tokens of code over 112 calls spent about 5.8M, 3.4M + 112 × 20k ≈ 5.6M)
  perCall: 20_000,
  // a build read through the session (a desktop app, or no agent CLI signed in) goes through one subagent's context:
  // the most changed code first, in smaller calls, up to this much; what is left is built on a later suggestion
  sessionCode: 100_000,
  sessionBatch: 20_000,
};
const DAY = 86_400_000;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js');
const stateDir = store => path.join(store.dir, 'state');
const accessFile = store => path.join(stateDir(store), 'access.json');
const stateFile = store => path.join(stateDir(store), 'coverage.json');
const neverFile = (home = thinkerHome()) => path.join(home, 'state', 'coverage-never');
export const coverageNever = home => fs.existsSync(neverFile(home));
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v) + '\n'); };
export const readCoverageState = store => readJson(stateFile(store)) || {};
const saveState = (store, st) => writeJson(stateFile(store), st);
const dayOf = t => new Date(t).toISOString().slice(0, 10);

// The tool hook: the directories of the files a tool call read or wrote, counted for this session and day.
// The session is kept as a short hash, only to count distinct sessions.
export function recordAccess(store, session, files, { now = Date.now() } = {}) {
  if (!session || session === 'unknown' || !files?.length) return;
  const dirs = [...new Set(files.map(f => areaOf(f)).filter(Boolean))];
  if (!dirs.length) return;
  const f = accessFile(store), a = readJson(f) || {};
  const sid = createHash('sha256').update(String(session)).digest('hex').slice(0, 10);
  const today = (a[dayOf(now)] ||= {});
  for (const d of dirs) { const e = (today[d] ||= { s: [], n: 0 }); e.n++; if (!e.s.includes(sid) && e.s.length < 200) e.s.push(sid); }
  const oldest = dayOf(now - COVERAGE.windowDays * DAY);
  for (const k of Object.keys(a)) if (k < oldest) delete a[k];
  try { writeJson(f, a); } catch {}
}

// Which directories the sessions of the window worked in: each with its distinct sessions, the days it was
// worked on, and a weight in which a session counts less the older it is.
export function directoryActivity(store, { now = Date.now() } = {}) {
  const a = readJson(accessFile(store)) || {};
  const oldest = dayOf(now - COVERAGE.windowDays * DAY), all = new Set(), days = new Set(), by = {};
  for (const [day, dirs] of Object.entries(a)) {
    if (day < oldest) continue;
    const w = Math.pow(0.5, Math.max(0, now - Date.parse(day)) / DAY / COVERAGE.halfLife);
    for (const [dir, e] of Object.entries(dirs)) {
      const d = (by[dir] ||= { dir, sessions: new Set(), days: 0, weight: 0, touches: 0 });
      for (const s of e.s) { d.sessions.add(s); all.add(s); }
      d.days++; d.weight += w * e.s.length; d.touches += e.n; days.add(day);
    }
  }
  const dirs = Object.values(by).map(d => ({ ...d, sessions: d.sessions.size })).sort((x, y) => y.weight - x.weight || x.dir.localeCompare(y.dir));
  return { sessions: all.size, days: days.size, dirs };
}

// How much of a directory the cache covers: its code files (understand.js:codeFiles, every age), and those a
// note points at or an understanding build read.
export function directoryCoverage(store, dir, { noted = null } = {}) {
  const files = codeFiles(store.repo, [dir]);
  noted ||= notedFiles(store);
  return { files: files.length, covered: files.filter(f => noted.has(f)).length };
}
function notedFiles(store) {
  const s = filesRead(store);
  for (const n of store.list()) if (n.status !== 'invalid' && !n.archived) for (const d of n.deps || []) if (d.path) s.add(d.path);
  return s;
}
// What a whole-directory build of `dir` would read and spend, before anything is spent
export function buildEstimate(store, dir) {
  const files = codeFiles(store.repo, [dir], { skip: filesRead(store) });
  const batches = batchFiles(store.repo, files), code = batches.reduce((t, b) => t + b.t, 0);
  return { files: files.length, codeTokens: code, calls: batches.length, tokens: code + batches.length * COVERAGE.perCall };
}

// The directories to suggest now: the most worked-in ones of the window that the cache covers little, not
// passed on or built in the last month, up to five. null while there is not yet enough activity.
export function pickSuggestions(store, { now = Date.now() } = {}) {
  const act = directoryActivity(store, { now });
  if (act.sessions < COVERAGE.minSessions || act.days < COVERAGE.minDays) return null;
  const st = readCoverageState(store), recent = t => t && now - Date.parse(t) < COVERAGE.declineDays * DAY;
  const noted = notedFiles(store), out = [];
  for (const d of act.dirs) {
    if (out.length >= COVERAGE.max) break;
    if (recent(st.declined?.[d.dir]) || recent(st.built?.[d.dir])) continue;
    if (!fs.existsSync(path.join(store.repo, d.dir))) continue;
    const cov = directoryCoverage(store, d.dir, { noted });
    if (cov.files < COVERAGE.minFiles || cov.covered / cov.files >= COVERAGE.maxCovered) continue;
    const est = buildEstimate(store, d.dir);
    if (!est.files) continue;
    out.push({ dir: d.dir, sessions: d.sessions, days: d.days, files: cov.files, covered: cov.covered, tokens: est.tokens });
  }
  return out;
}

// Maintenance: once a week at most, a new question when there is something to ask; a question nobody answered
// in three days is dropped. Returns the directories queued, or null.
export function scheduleSuggestion(store, { now = Date.now(), home } = {}) {
  if (coverageNever(home)) return null;
  const st = readCoverageState(store);
  if (st.pending) {
    if (st.pending.offeredAt && now - Date.parse(st.pending.offeredAt) > COVERAGE.answerDays * DAY) {
      store.log({ op: 'coverage-answer', choice: 'unanswered', dirs: st.pending.dirs.length });
      delete st.pending; saveState(store, st);
    }
    return null;
  }
  if (st.checkedAt && now - Date.parse(st.checkedAt) < COVERAGE.everyDays * DAY) return null;
  const picks = pickSuggestions(store, { now });
  if (picks == null) return null;  // not enough activity yet: look again on the next run
  st.checkedAt = new Date(now).toISOString();
  if (picks.length) { st.pending = { at: st.checkedAt, dirs: picks }; store.log({ op: 'coverage-suggest', dirs: picks.length, tokens: picks.reduce((t, p) => t + p.tokens, 0) }); }
  saveState(store, st);
  return picks.length ? picks : null;
}

// Whether a question waits for its answer here: thinker's `coverage` MCP tool is offered while one does.
export function coveragePending(store, { home } = {}) {
  return !coverageNever(home) && Boolean(readCoverageState(store).pending);
}

const answerCommand = (repo, via, client) => `"${process.execPath}" "${CLI}" coverage --answer <directories|none|never> --via ${via}${client ? ` --client ${client}` : ''} --repo "${repo}"`;
const optionOf = p => `"${p.dir}": about ${formatTokens(p.tokens)} tokens; ${p.covered} of ${p.files} code files covered; worked in by ${p.sessions} session${p.sessions === 1 ? '' : 's'} over ${p.days} day${p.days === 1 ? '' : 's'}`;
// The prompt hook: the pending question, said once, as an instruction to the agent to put it to the person.
export function coverageOffer(store, { client, home, now = Date.now() } = {}) {
  if (['windsurf', 'goose', 'augment'].includes(client) || coverageNever(home)) return '';
  const st = readCoverageState(store);
  if (!st.pending || st.pending.offeredAt) return '';
  st.pending.offeredAt = new Date(now).toISOString(); st.pending.client = client || null;
  saveState(store, st);
  store.log({ op: 'coverage-offer', client, dirs: st.pending.dirs.length });
  const dirs = st.pending.dirs, options = dirs.map((p, i) => `${i + 1}. ${optionOf(p)}`).join('\n');
  const lead = `Your sessions in this repository keep working in ${dirs.length === 1 ? 'a directory' : 'directories'} thinker's cache covers little. It can read ${dirs.length === 1 ? 'it' : 'them'} into notes on how the code there works, in the background, through the user's own agent login, at about the tokens shown.`;
  const tool = QUESTION_TOOLS[client];
  const reply = `No directory chosen means not now (thinker does not suggest those for a month); "never" stops these suggestions on this machine.`;
  const after = MCP_CLIENTS.has(client)
    ? `Then call thinker's \`coverage\` tool with choice set to the chosen directories, comma-separated (or none, or never) and asked "${tool ? 'picker' : 'chat'}"; if that tool is not available, run \`${answerCommand(store.repo, tool ? 'picker' : 'text', client)}\`. thinker builds the chosen ones in the background. Then go on with the task.`
    : `Then run \`${answerCommand(store.repo, 'text', client)}\` with the answer: thinker builds the chosen ones in the background. Then go on with the task.`;
  const ask = tool && client !== 'codex'
    ? `Before you start on the request, ${askThrough(tool, "Build more of thinker's cache for these directories?")}: a multiple-choice question whose options are the directories below, in this order, each with its line as the description. If the tool takes at most four options in a question, ask them over two such questions. ${reply}`
    : `Before you start on the request, ${askInChat('which of these directories (any, none, or never) to build cache notes for.')} ${reply}`;
  return `<thinker-coverage-suggestion>\n${lead}\n${ask}\n${options}\n${after}\n</thinker-coverage-suggestion>`;
}

// The answer: never stops suggestions on this machine; none (or nothing that names a pending directory) passes
// on them for a month; directories start one whole-directory build of them, through the agent the person signed
// in with. Logged as coverage-answer and coverage-build. Returns the line to tell the agent.
export async function answerCoverage(store, choice, { client, via = 'picker', home, now = Date.now(), spawnFn = spawn, selectAgentFn = selectAndAuthenticateAgent, appFn = desktopApp } = {}) {
  const st = readCoverageState(store), pending = st.pending?.dirs || [];
  const raw = String(choice || '').trim();
  if (/^never$/i.test(raw)) {
    const f = neverFile(home); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, new Date(now).toISOString() + '\n');
    delete st.pending; saveState(store, st);
    store.log({ op: 'coverage-answer', choice: 'never', client, via, dirs: pending.length });
    return 'Recorded: thinker will not suggest directories to cover again on this machine (thinker understand --areas <dir> --whole still builds one). Go on with the task.';
  }
  const names = raw.split(/[,\n]/).map(s => s.trim().replace(/^["'`]|["'`]$/g, '').replace(/\/+$/, '')).filter(Boolean);
  const chosen = pending.filter(p => names.includes(p.dir));
  const at = new Date(now).toISOString();
  st.declined ||= {};
  for (const p of pending) if (!chosen.includes(p)) st.declined[p.dir] = at;
  delete st.pending;
  if (!chosen.length) { saveState(store, st); store.log({ op: 'coverage-answer', choice: 'none', client, via, dirs: pending.length }); return 'Recorded: no directories built now; thinker will not suggest these again for a month. Go on with the task.'; }
  store.log({ op: 'coverage-answer', choice: 'build', client, via, dirs: pending.length, chosen: chosen.length });
  const names2 = chosen.map(c => c.dir).join(', '), tokens = chosen.reduce((t, c) => t + c.tokens, 0);
  // Inside a desktop app (Claude Desktop, the Codex app, Cursor) the build reads through the app's own session,
  // whatever CLIs are signed in; elsewhere through the agent CLI the person signed in with, and through the
  // session when none is and the client can start a subagent (AGENTS.md: every model-backed feature works there).
  const harness = subagentHarness(client), app = harness && appFn(harness);
  let auth = null;
  if (!app) {
    try { auth = await selectAgentFn({ requestedAgent: process.env.THINKER_LLM || null, yes: true, out: () => {}, purpose: 'build cache notes for directories', allowSkip: false }); }
    catch (e) { auth = { ok: false, error: e.message }; }
  }
  if (app || (!auth?.ok && harness)) {
    const dir = queueDir(store);
    if (buildRunning(dir)) {
      saveState(store, st);
      store.log({ op: 'coverage-build', started: false, dirs: chosen.length, reason: 'session-busy', agent: 'session' });
      return `The build did not start: another build already reads through this session (learning). Tell the user that thinker suggests these directories again next week, or that \`thinker understand --areas ${chosen.map(p => p.dir).join(',')} --whole\` builds them. Go on with the task.`;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      const fd = fs.openSync(path.join(stateDir(store), 'coverage-build.log'), 'a');
      const p = spawnFn(process.execPath, [CLI, 'understand', '--areas', chosen.map(c => c.dir).join(','), '--whole', '--max-code', String(COVERAGE.sessionCode), '--batch', String(COVERAGE.sessionBatch), '--repo', store.repo],
        { cwd: store.repo, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, THINKER_LLM: 'session', [QUEUE_ENV]: dir } });
      p.unref?.(); fs.closeSync(fd);
      markBuild(dir, p.pid);
    } catch (e) {
      saveState(store, st);
      store.log({ op: 'coverage-build', started: false, dirs: chosen.length, reason: 'spawn', agent: 'session' });
      return `The build did not start (${e.message}). The user can run \`thinker understand --areas ${chosen.map(p => p.dir).join(',')} --whole\`. Go on with the task.`;
    }
    st.built ||= {}; for (const c of chosen) st.built[c.dir] = at;
    saveState(store, st);
    store.log({ op: 'coverage-build', started: true, dirs: chosen.length, tokens: Math.min(tokens, COVERAGE.sessionCode * 2), agent: 'session', ...(app ? { app } : {}) });
    const why = app ? `This session runs in ${app}, so the build reads through it` : 'No agent CLI is signed in on this machine, so the build reads through this session';
    return `${why}: notes on how ${names2} work${chosen.length === 1 ? 's' : ''} started in the background, the most changed code first, as much as one subagent's context holds (later suggestions continue it). It waits for a subagent to answer its model calls. Start one now with ${SUBAGENT_TOOLS[harness]}, and do not wait for it: give it exactly the prompt below. Tell the user in one line that the build runs in a background subagent of this session, then go on with the task.\n\n${subagentPrompt(store.repo)}`;
  }
  if (!auth?.ok) {
    saveState(store, st);
    store.log({ op: 'coverage-build', started: false, dirs: chosen.length, reason: auth?.error || 'no_agent' });
    return `The build did not start: ${auth?.agent ? `${auth.agent} is not signed in` : 'no signed-in agent CLI was found (Claude Code, Codex, Gemini or Cursor)'}. Tell the user, and that \`thinker understand --areas ${chosen.map(p => p.dir).join(',')} --whole\` builds them once ${auth?.agent ? `they sign in (\`${getAgentLoginCommand(auth.agent)}\`)` : 'one is set up'}. Go on with the task.`;
  }
  const logFile = path.join(stateDir(store), 'coverage-build.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'a');
    const p = spawnFn(process.execPath, [CLI, 'understand', '--areas', chosen.map(c => c.dir).join(','), '--whole', '--repo', store.repo], { cwd: store.repo, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, THINKER_LLM: auth.agent } });
    p.unref?.(); fs.closeSync(fd);
  } catch (e) {
    saveState(store, st);
    store.log({ op: 'coverage-build', started: false, dirs: chosen.length, reason: 'spawn' });
    return `The build did not start (${e.message}). The user can run \`thinker understand --areas ${chosen.map(p => p.dir).join(',')} --whole\`. Go on with the task.`;
  }
  st.built ||= {};
  for (const c of chosen) st.built[c.dir] = at;
  saveState(store, st);
  store.log({ op: 'coverage-build', started: true, dirs: chosen.length, tokens: chosen.reduce((t, c) => t + c.tokens, 0), agent: auth.agent });
  return `Started in the background through ${auth.agent}: notes on how ${names2} work${chosen.length === 1 ? 's' : ''}, about ${formatTokens(tokens)} tokens. It needs nothing more from you: tell the user in one line, then go on with the task.`;
}

// `thinker coverage`: the table behind the suggestions, or an answer to one
export function renderCoverage(store, { now = Date.now() } = {}) {
  const act = directoryActivity(store, { now }), st = readCoverageState(store), noted = notedFiles(store);
  const L = [`Sessions in the last ${COVERAGE.windowDays} days: ${act.sessions}, on ${act.days} day${act.days === 1 ? '' : 's'}${act.sessions < COVERAGE.minSessions || act.days < COVERAGE.minDays ? ` (suggestions start at ${COVERAGE.minSessions} sessions on ${COVERAGE.minDays} days)` : ''}.`];
  if (!act.dirs.length) return L.concat('No directory access recorded yet: the agent hooks count it as sessions read and edit files.').join('\n');
  L.push('', 'directory'.padEnd(36) + 'sessions  days  covered');
  for (const d of act.dirs.slice(0, 15)) { const c = directoryCoverage(store, d.dir, { noted }); L.push(d.dir.padEnd(36) + String(d.sessions).padStart(8) + String(d.days).padStart(6) + `  ${c.covered}/${c.files}`); }
  if (st.pending) L.push('', `Waiting for an answer: ${st.pending.dirs.map(p => p.dir).join(', ')}`);
  if (coverageNever()) L.push('', 'Suggestions are off on this machine (answered never).');
  return L.join('\n');
}
