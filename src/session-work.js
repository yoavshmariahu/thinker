// Learning inside a desktop app, through the app's own session (app-host.js). In an app the hooks start no
// agent CLI: what they would have run in the background (a session's distill, catch-up learning, maintenance)
// is queued here as a job instead. On a later prompt in an app session the prompt hook starts one runner,
// `thinker session-work`, with the session provider (session-llm.js), and tells the agent to start the
// background subagent that answers its model calls, as a warm-up does. A run takes a few jobs, what one
// subagent's context holds (a session's distill is ~25k tokens); the rest wait for the next run.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { QUEUE_ENV, queueDir, markBuild, buildRunning, subagentPrompt } from './session-llm.js';
import { SUBAGENT_TOOLS } from './app-host.js';

export const JOBS_PER_RUN = 4;
// a run at most this often: each asks the agent for a subagent
export const RUN_EVERY_MS = 30 * 60_000;
// the repository was worked in an app this recently: maintenance a commit starts waits for an app session
export const APP_RECENT_MS = 24 * 3600_000;

const state = (store, ...p) => path.join(store.dir, 'state', ...p);
const jobsDir = store => state(store, 'session-jobs');
const safe = k => String(k).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);

// A job: the arguments of a thinker command, keyed so a session's distill or the catch-up run is queued once.
export function enqueueJob(store, key, args) {
  const dir = jobsDir(store); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${safe(key)}.json`);
  let t = new Date().toISOString(); try { t = JSON.parse(fs.readFileSync(f, 'utf8')).t || t; } catch {}
  fs.writeFileSync(f, JSON.stringify({ key, args, t }));
}
export function pendingJobs(store) {
  let names = []; try { names = fs.readdirSync(jobsDir(store)).filter(n => n.endsWith('.json')); } catch { return []; }
  return names.map(n => { try { return { file: path.join(jobsDir(store), n), ...JSON.parse(fs.readFileSync(path.join(jobsDir(store), n), 'utf8')) }; } catch { return null; } })
    .filter(j => j && Array.isArray(j.args)).sort((a, b) => String(a.t).localeCompare(String(b.t)));
}

// The repository is worked in an app: written by the hooks of an app session, read by maintenance a commit starts.
export function markAppSession(store, app) { try { fs.mkdirSync(state(store), { recursive: true }); fs.writeFileSync(state(store, 'app-session'), JSON.stringify({ app, t: new Date().toISOString() })); } catch {} }
export function recentAppSession(store, { now = Date.now() } = {}) {
  try { const f = state(store, 'app-session'); if (now - fs.statSync(f).mtimeMs < APP_RECENT_MS) return JSON.parse(fs.readFileSync(f, 'utf8')).app || 'an app'; } catch {}
  return null;
}

// From the prompt hook of an app session: start the runner when jobs wait and none is running (a warm-up's
// build shares the queue), at most every RUN_EVERY_MS. Returns what to tell the agent, or ''.
export function startSessionWork(store, { cli, harness, now = Date.now(), spawnFn = spawn } = {}) {
  if (!SUBAGENT_TOOLS[harness] || !pendingJobs(store).length) return '';
  const dir = queueDir(store);
  if (buildRunning(dir)) return '';
  const last = state(store, 'session-work.last');
  try { if (now - fs.statSync(last).mtimeMs < RUN_EVERY_MS) return ''; } catch {}
  const logFile = state(store, 'session-work.log');
  try {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(last, '');
    for (const n of fs.readdirSync(dir)) if (/\.(req|claimed|res)\.json$/.test(n)) fs.rmSync(path.join(dir, n), { force: true });
    const fd = fs.openSync(logFile, 'a');
    const p = spawnFn(process.execPath, [cli, 'session-work', '--repo', store.repo], { cwd: store.repo, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, THINKER_LLM: 'session', [QUEUE_ENV]: dir } });
    p.unref?.(); fs.closeSync(fd);
    markBuild(dir, p.pid);
  } catch (e) { store.log({ op: 'session-work', started: false, reason: String(e.message).slice(0, 120) }); return ''; }
  store.log({ op: 'session-work', started: true, jobs: Math.min(JOBS_PER_RUN, pendingJobs(store).length) });
  return `<thinker-learning>\nthinker learns from this repository's sessions through this session, not a CLI: it has queued work running in the background, waiting for a subagent to answer its model calls. Start one now with ${SUBAGENT_TOOLS[harness]}, and do not wait for it: give it exactly the prompt below. Say nothing to the user about it unless asked, and go on with the request.\n\n${subagentPrompt(store.repo)}\n</thinker-learning>`;
}

// `thinker session-work`: the oldest jobs, one after another, each a thinker command run with the session
// provider pinned (THINKER_LLM=session in the env it was started with). A job leaves the queue when it starts.
export function runSessionWork(store, { cli, limit = JOBS_PER_RUN, spawnFn = spawnSync, out = console.log } = {}) {
  let done = 0;
  for (const job of pendingJobs(store).slice(0, limit)) {
    fs.rmSync(job.file, { force: true });
    out(`${new Date().toISOString()} ${job.args.join(' ')}`);
    const r = spawnFn(process.execPath, [cli, ...job.args], { cwd: store.repo, stdio: 'inherit', env: process.env });
    store.log({ op: 'session-job', key: job.key, ok: r.status === 0 });
    done++;
  }
  return done;
}
