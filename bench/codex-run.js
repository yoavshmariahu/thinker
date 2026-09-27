#!/usr/bin/env node
// Run the PostHog hard-task benchmark with Codex CLI, preserving the same
// task prompts, cache notes, paired arms, and output schema used by bench/run.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.join(HERE, 'repos', 'posthog');
const TASKS = path.join(HERE, 'tasks', 'posthog-hard.json');
const NOTES = path.join(HERE, 'notesets', 'posthog-v2', 'notes');
const TAG = process.argv[2] || 'posthog-codex-gpt56';
const REPS = Number(process.argv[3]) || 2;
const CONC = Number(process.argv[4]) || 3;
const MODEL = process.argv[5] || 'gpt-5.6-terra';
const OUT = path.join(HERE, 'runs', TAG);
const CLI = path.join(ROOT, 'src', 'cli.js');
const CACHE_GUIDANCE = 'Context injected as <thinker-cache> comes from a cache of notes about this repository whose code dependencies are verified against the current code when served. Use it to skip re-deriving what it states.';
const CACHE_ARM_GUIDANCE = 'This repository has a thinker knowledge cache from previous sessions. Use the supplied <thinker-cache> notes to skip re-deriving what they state; only search/read to confirm or fill gaps. Treat notes marked STALE as unverified.';
// BENCH_ONLY=id,id limits the run to those tasks
const ONLY = (process.env.BENCH_ONLY || '').split(',').filter(Boolean);
const tasks = JSON.parse(fs.readFileSync(TASKS, 'utf8')).tasks.filter(t => !ONLY.length || ONLY.includes(t.id));
fs.mkdirSync(path.join(OUT, 'events'), { recursive: true });

function makeWorktree(i) {
  const wt = path.join(HERE, 'worktrees', `${TAG}-${i}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  if (fs.existsSync(wt)) {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: REPO }); }
    catch { fs.rmSync(wt, { recursive: true, force: true }); }
  }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], { cwd: REPO });
  return wt;
}
function resetWorktree(wt) {
  try {
    execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: wt });
    execFileSync('git', ['clean', '-qfd'], { cwd: wt });
  } catch {}
}
function contextFor(task, session) {
  const env = {
    ...process.env,
    THINKER_NOTES_DIR: NOTES,
    THINKER_EARLY: 'full',
    THINKER_NO_BG_VERIFY: '1',
  };
  try {
    return execFileSync('node', [CLI, 'hook', 'prompt', '--client', 'codex', '--repo', REPO], {
      cwd: REPO,
      env,
      input: JSON.stringify({ prompt: task.prompt, session_id: session }),
      encoding: 'utf8',
      maxBuffer: 1 << 24,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    throw new Error(`cache orientation failed: ${e.message}`);
  }
}
function runCodex(prompt, cwd) {
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--model', MODEL, '--sandbox', 'workspace-write', '--cd', cwd,
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env: { ...process.env, CODEX_DISABLE_PROJECT_DOCS: '0' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('error', reject);
    child.on('close', code => {
      const events = [];
      for (const line of stdout.split('\n')) {
        try { events.push(JSON.parse(line)); } catch {}
      }
      const failure = events.find(e => e.type === 'turn.failed' || e.type === 'error');
      if (code !== 0 || failure) return reject(new Error(`Codex exited ${code}: ${JSON.stringify(failure || stderr).slice(0, 900)}`));
      const usage = events.filter(e => e.type === 'turn.completed').map(e => e.usage || {});
      const msg = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text || '').join('\n');
      const calls = events.filter(e => e.type === 'item.started' && e.item && !['agent_message', 'reasoning'].includes(e.item.type));
      const byTool = {};
      for (const e of calls) byTool[e.item.type] = (byTool[e.item.type] || 0) + 1;
      return resolve({
        session_id: events.find(e => e.type === 'thread.started')?.thread_id,
        turns: usage.length,
        in_tokens: usage.reduce((s, u) => s + (u.input_tokens || 0) + (u.cached_input_tokens || 0) + (u.cache_write_input_tokens || 0), 0),
        out_tokens: usage.reduce((s, u) => s + (u.output_tokens || 0), 0),
        wall_ms: Date.now() - started,
        result: msg,
        tools: { calls: calls.length, byTool, thinkerCalls: 0, filesRead: 0, greps: 0, injected: [] },
        raw_events: events,
      });
    });
    child.stdin.end(prompt);
  });
}
function getDiff(cwd) {
  execFileSync('git', ['add', '-A', '--', '.', ':!.thinker'], { cwd });
  const diff = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd, maxBuffer: 1 << 26 }).toString();
  execFileSync('git', ['reset', '-q'], { cwd });
  return diff;
}

const jobs = [];
for (let rep = 0; rep < REPS; rep++) for (const task of tasks) for (const arm of ['nocache', 'hook']) jobs.push({ task, arm, rep });
async function worker(wi) {
  const cwd = makeWorktree(wi);
  while (jobs.length) {
    const { task, arm, rep } = jobs.shift();
    const id = `${task.id}-${arm}-${rep}`;
    const file = path.join(OUT, `${id}.json`);
    if (fs.existsSync(file)) { console.log(`skip ${id}`); continue; }
    resetWorktree(cwd);
    const session = `codex-${TAG}-${task.id}-${rep}`;
    let prompt = task.prompt;
    let injected = '';
    if (arm === 'hook') {
      injected = contextFor(task, session);
      prompt = `${CACHE_ARM_GUIDANCE}\n\n${injected}\n\n${task.prompt}\n\n${CACHE_GUIDANCE}`;
    }
    try {
      const run = await runCodex(prompt, cwd);
      run.tools.injected = [...new Set([...injected.matchAll(/\(id: ([\w-]+), confidence/g)].map(m => m[1]))];
      run.model = MODEL;
      run.arm = arm;
      run.task = task.id;
      run.rep = rep;
      run.area = task.area;
      run.id = id;
      run.session = run.session_id;
      run.cost = null;
      run.api_ms = null;
      run.grade = null;
      run.diff = task.type === 'change' ? getDiff(cwd) : null;
      // the session is ephemeral, so this stream is the only record of what the agent did
      fs.writeFileSync(path.join(OUT, 'events', `${id}.jsonl`), run.raw_events.map(e => JSON.stringify(e)).join('\n'));
      delete run.raw_events;
      fs.writeFileSync(file, JSON.stringify(run, null, 2));
      console.log(`${id}: turns=${run.turns} tools=${run.tools.calls} injected=${run.tools.injected.length} ${(run.wall_ms / 1000).toFixed(0)}s in=${run.in_tokens} out=${run.out_tokens}`);
    } catch (e) {
      console.error(`${id} ERROR ${e.message}`);
      fs.writeFileSync(file, JSON.stringify({ id, task: task.id, arm, rep, model: MODEL, turns: 0, error: e.message }, null, 2));
    }
    resetWorktree(cwd);
  }
}
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));

const records = fs.readdirSync(OUT).filter(f => f.endsWith('.json') && f !== 'summary.json').map(f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(records, null, 2));
console.log(`\nSaved ${records.length} records in ${OUT}`);
