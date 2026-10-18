// Model calls answered by the person's own agent session. A desktop app's login (Claude Desktop, the
// Codex app, Cursor) does not sign in its CLI, so a background `claude -p` fails "not signed in"
// (2026-10-15), and no Claude client offers MCP sampling. In its place the build (provider `session`,
// llm.js) writes each request to a queue in the cache's state directory and waits; a subagent of the
// session takes them through thinker's warmup_next and answers through warmup_answer (mcp.js).
// The pipeline is unchanged: the same prompts, gates and saving as a CLI build, only the login differs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { extractJson } from './llm.js';

export const QUEUE_ENV = 'THINKER_SESSION_QUEUE';
export const queueDir = store => path.join(store.dir, 'state', 'session-llm');
// a request nobody took in this long means no subagent is working the queue; a taken one gets as long again
export const UNCLAIMED_MS = 15 * 60_000, CLAIMED_MS = 15 * 60_000;

const file = (dir, id, state) => path.join(dir, `${id}.${state}.json`);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeAtomic = (f, v) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The build that fills the queue: its pid, written when it is started (repo-onboard.js:answerWarmup).
export function markBuild(dir, pid) { fs.mkdirSync(dir, { recursive: true }); writeAtomic(path.join(dir, 'build.json'), { pid, started: new Date().toISOString() }); }
export function buildRunning(dir) {
  const b = readJson(path.join(dir, 'build.json'));
  if (!b?.pid) return false;
  try { process.kill(b.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A warm-up asked for by the session's shell (repo-onboard.js:answerWarmup) and started by thinker's MCP
// server when the session's subagent first calls warmup_next (mcp-server.js): Cursor runs its agent's commands
// in a sandbox with no network and no writes outside the workspace (2026-10-16, photocraft: `gh pr list`
// failed, ~/.codex refused), and a build started there inherits it; the server runs outside it.
const REQUEST = 'build-request.json';
export function requestBuild(dir) { fs.mkdirSync(dir, { recursive: true }); writeAtomic(path.join(dir, REQUEST), { t: new Date().toISOString() }); }
// asked for and not yet started, within the time a subagent has to come for it
export function buildRequested(dir, { maxAgeMs = UNCLAIMED_MS } = {}) {
  const r = readJson(path.join(dir, REQUEST));
  return !!r?.t && Date.now() - Date.parse(r.t) < maxAgeMs;
}

// provider `session`: one request in, its answer out, or an error once nobody took it in time
export async function viaSession({ system, prompt, schema }, { dir = process.env[QUEUE_ENV], pollMs = 1000, unclaimedMs = UNCLAIMED_MS, claimedMs = CLAIMED_MS } = {}) {
  if (!dir) throw new Error(`the session provider needs ${QUEUE_ENV}: it is started by a warm-up answered in an agent session`);
  fs.mkdirSync(dir, { recursive: true });
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  writeAtomic(file(dir, id, 'req'), { id, system: system || '', prompt, schema: schema || null, t: new Date().toISOString() });
  const start = Date.now(); let claimedAt = null;
  for (;;) {
    const res = readJson(file(dir, id, 'res'));
    if (res) {
      fs.rmSync(file(dir, id, 'res'), { force: true });
      return { text: res.text, json: res.json ?? null, usage: null, cost: null, provider: 'session' };
    }
    if (!claimedAt && fs.existsSync(file(dir, id, 'claimed'))) claimedAt = Date.now();
    if (claimedAt ? Date.now() - claimedAt > claimedMs : Date.now() - start > unclaimedMs) {
      for (const s of ['req', 'claimed']) fs.rmSync(file(dir, id, s), { force: true });
      throw new Error(claimedAt ? 'the agent session took this request and did not answer it' : 'no agent session answered: nothing is working the warm-up queue (warmup_next)');
    }
    await sleep(pollMs);
  }
}

// warmup_next: the oldest waiting request, taken (an atomic rename, so two takers never share one);
// { done } once the build has ended with nothing waiting; { waiting } when none came within waitMs.
// start: called while a build is asked for and not running (it starts one). A subagent may call before the
// session's shell has asked (Cursor started its subagent first, 2026-10-16), so a queue that never had a
// build waits out waitMs before it reads as done.
export async function nextRequest(dir, { waitMs = 45_000, pollMs = 500, start: startBuild } = {}) {
  const start = Date.now();
  for (;;) {
    if (startBuild && buildRequested(dir) && !buildRunning(dir)) { const r = startBuild(); if (r?.error) return { error: r.error }; }
    let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.req.json')).sort(); } catch {}
    for (const n of names) {
      const id = n.slice(0, -'.req.json'.length);
      try { fs.renameSync(file(dir, id, 'req'), file(dir, id, 'claimed')); } catch { continue; }
      const claimed = new Date();
      try { fs.utimesSync(file(dir, id, 'claimed'), claimed, claimed); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      const r = readJson(file(dir, id, 'claimed'));
      if (r) return { request: r };
    }
    const never = !fs.existsSync(path.join(dir, 'build.json'));
    if (!buildRunning(dir) && !(never && Date.now() - start < waitMs)) return { done: true };
    if (Date.now() - start >= waitMs) return { waiting: true };
    await sleep(pollMs);
  }
}

// warmup_answer: the answer to a taken request; one that does not parse to the request's schema is
// refused with the reason, so the subagent can answer again.
export function answerRequest(dir, id, answer) {
  const req = readJson(file(dir, String(id), 'claimed'));
  if (!req) return { error: `no request ${id} is waiting for an answer (take one with warmup_next)` };
  let json = null;
  if (req.schema) {
    try { json = typeof answer === 'object' && answer ? answer : extractJson(String(answer), req.schema); }
    catch (e) { return { error: `the answer is not JSON: ${String(e.message).slice(0, 160)}` }; }
    const missing = (req.schema.required || []).filter(k => !(k in (json || {})));
    if (!json || typeof json !== 'object' || missing.length) return { error: `the answer must be one JSON object with ${missing.length ? missing.join(', ') : 'the schema\'s fields'}` };
  }
  writeAtomic(file(dir, req.id, 'res'), { text: typeof answer === 'string' ? answer : JSON.stringify(answer), json });
  fs.rmSync(file(dir, req.id, 'claimed'), { force: true });
  // A receipt for doctor, not a model probe: records actual use of the app's queue.
  try { writeAtomic(path.join(dir, 'last-answer.json'), { at: new Date().toISOString() }); } catch {}
  return { ok: true };
}

// The request as the subagent reads it.
export function requestText(r) {
  return `Request ${r.id}.\n\nINSTRUCTIONS:\n${r.system || '(none)'}\n\nINPUT:\n${r.prompt}\n\n` + (r.schema
    ? `Answer with warmup_answer: id "${r.id}" and answer, one JSON object matching this JSON Schema:\n${JSON.stringify(r.schema)}`
    : `Answer with warmup_answer: id "${r.id}" and your answer as plain text.`);
}

// What the session agent is told to start: a subagent that works the queue until the work ends, a warm-up's
// or learning's (session-work.js).
const WORKER_INTRO = "You answer model requests for thinker's background work";
export function subagentPrompt(repo) {
  return `${WORKER_INTRO} (a warm-up, learning or a coverage build) in the repository at ${repo}. Loop: call thinker's warmup_next tool (cwd "${repo}"). It returns a request: instructions, an input (a merged pull request's description and diff, an agent session's record, source code to describe, or notes) and the JSON shape the answer must have. Answer it yourself, from the input alone: do not read files, run commands or use other tools. Call warmup_answer with the request's id and your answer; if it is refused, fix the answer and call again. Repeat. When warmup_next says nothing has come yet, call it again. Stop when warmup_next says the work is done, and reply with one line: how many requests you answered.`;
}

// A background subagent spawned with `subagentPrompt` triggers the host's hooks on its own turns and tool
// calls (Cursor runs `beforeSubmitPrompt`, `postToolUse`, `stop` and `sessionEnd` for subagents too): skip
// orienting, recording or distilling the queue worker itself so it cannot recurse.
// Documentation and normal questions can name both queue tools too. Only our actual worker
// instruction starts with this introduction; matching mentions anywhere suppresses notices and learning.
export const isWorkerPrompt = s => {
  const text = String(s || '').trimStart();
  return text.startsWith(`${WORKER_INTRO} (`) && /\bwarmup_next\b[\s\S]*\bwarmup_answer\b/.test(text);
};
export const isWorkerTool = n => /(?:^|[:_])warmup_(?:next|answer)$/i.test(String(n || ''));
