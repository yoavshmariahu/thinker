// Learning inside a desktop app, through the app's own session (app-host.js). In an app the hooks start no
// agent CLI: what they would have run in the background (a session's distill, catch-up learning, maintenance)
// is queued here as a job instead. On a later prompt in an app session the prompt hook starts one runner,
// `thinker session-work`, with the session provider (session-llm.js), and tells the agent to start the
// background subagent that answers its model calls, as a warm-up does. A run takes a few jobs, what one
// subagent's context holds (a session's distill is ~25k tokens); the rest wait for the next run.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function writeAtomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(value)); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
const retryDelay = attempts => Math.min(24 * 3600_000, RUN_EVERY_MS * 2 ** Math.min(attempts - 1, 6));
const runnable = (job, now) => !job.running && !(Date.parse(job.nextAttemptAt) > now);

// A job: the arguments of a thinker command, keyed so a session's distill or the catch-up run is queued once.
export function enqueueJob(store, key, args) {
  const dir = jobsDir(store); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${safe(key)}.json`);
  // Repeated hooks coalesce, retaining retry backoff. An enqueue while a job is running is
  // a separate pending request: acknowledging the running snapshot must not erase new work.
  const retries = pendingJobs(store).filter(j => j.key === key && j.file.endsWith('.retry'));
  const previous = [readJson(f), ...retries].filter(Boolean).sort((a, b) => (b.attempts || 0) - (a.attempts || 0))[0] || {};
  const { file: ignoredFile, running: ignoredRunning, ...record } = previous;
  writeAtomic(f, { ...record, key, args, t: previous.t || new Date().toISOString() });
  for (const j of retries) fs.rmSync(j.file, { force: true });
}
export function pendingJobs(store) {
  let names = []; try { names = fs.readdirSync(jobsDir(store)).filter(n => /\.(json|retry|running)$/.test(n)); } catch { return []; }
  return names.map(n => {
    const file = path.join(jobsDir(store), n), job = readJson(file);
    // Ownership is in the name, so a crash between the rename and writing attempt metadata
    // still leaves a recoverable job. A live worker's claim is never taken by another runner.
    const pid = n.match(/\.(\d+)\.[^.]+\.running$/)?.[1];
    return job && { ...job, file, running: !!pid && alive(Number(pid)) };
  })
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
  if (!SUBAGENT_TOOLS[harness] || !pendingJobs(store).some(j => runnable(j, now))) return '';
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
// provider pinned (THINKER_LLM=session in the env it was started with). Claim by atomic rename;
// acknowledge only on success. A killed runner leaves its claim for the next app session.
// This is at-least-once delivery: incremental distillation and maintenance own their checkpoints.
export function runSessionWork(store, { cli, limit = JOBS_PER_RUN, spawnFn = spawnSync, out = console.log, now = Date.now } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  let done = 0;
  for (const job of pendingJobs(store).filter(j => runnable(j, clock())).slice(0, limit)) {
    const claim = path.join(jobsDir(store), `${safe(job.key)}.${process.pid}.${randomUUID()}.running`);
    try { fs.renameSync(job.file, claim); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    // An enqueue may have replaced the pending file after the listing; run what we claimed.
    const record = readJson(claim);
    if (!record || !Array.isArray(record.args)) throw new Error(`invalid learning job: ${claim}`);
    record.attempts = (record.attempts || 0) + 1;
    record.lastAttemptAt = new Date(clock()).toISOString();
    writeAtomic(claim, record);
    out(`${record.lastAttemptAt} ${record.args.join(' ')}`);
    let r;
    try { r = spawnFn(process.execPath, [cli, ...record.args], { cwd: store.repo, stdio: 'inherit', env: process.env }); }
    catch (error) { r = { error }; }
    const ok = r.status === 0 && !r.error && !r.signal;
    if (ok) fs.rmSync(claim, { force: true });
    else {
      record.lastError = String(r.error?.message || (r.signal ? `terminated by ${r.signal}` : `exited with ${r.status}`)).slice(0, 300);
      record.nextAttemptAt = new Date(clock() + retryDelay(record.attempts)).toISOString();
      writeAtomic(claim, record);
      fs.renameSync(claim, claim.replace(/\.running$/, '.retry'));
      out(`learning job ${record.key} failed: ${record.lastError}; retained for retry after ${record.nextAttemptAt}`);
    }
    store.log({ op: 'session-job', key: record.key, ok, attempts: record.attempts, ...(ok ? {} : { error: record.lastError, nextAttemptAt: record.nextAttemptAt }) });
    done++;
  }
  return done;
}
