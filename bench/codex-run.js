#!/usr/bin/env node
// Run the PostHog hard-task benchmark with Codex CLI, preserving the same
// task prompts, cache notes, paired arms, and output schema used by bench/run.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installClient } from '../src/clients.js';
import { CACHE_USAGE_GUIDE } from '../src/cache-guidance.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.join(HERE, 'repos', 'posthog');
const TASKS = path.join(HERE, 'tasks', 'posthog-hard.json');
const NOTESET = path.join(HERE, 'notesets', 'posthog-v2');
const NOTES = path.join(NOTESET, 'notes');
const TAG = process.argv[2] || 'posthog-codex-gpt56';
const REPS = Number(process.argv[3]) || 2;
const CONC = Number(process.argv[4]) || 3;
const MODEL = process.argv[5] || 'gpt-5.6-terra';
const OUT = path.join(HERE, 'runs', TAG);
const CLI = path.join(ROOT, 'src', 'cli.js');
// Worktrees are cut from a clone that ends at the base commit, so the merged fixes are not in its history
const WT_REPO = fs.existsSync(path.join(HERE, 'repos', 'posthog-base')) ? path.join(HERE, 'repos', 'posthog-base') : REPO;
const BUDGET = Number(process.env.BENCH_BUDGET) || 750;
// Arms: nocache | full (hooks, MCP tools and the AGENTS.md instruction, as installed) | hook (notes pasted above the request)
const ARMS = (process.env.BENCH_ARMS || 'nocache,full').split(',');
// A Codex home for the benchmark: the login, the hooks (reviewed and trusted there once) and the
// worktrees marked trusted. The hooks say nothing in a worktree that has no notes.
const CODEX_HOME = path.join(HERE, 'codex-home');
const AGENTS_BLOCK = `<!-- thinker:start (managed by thinker, do not edit) -->
## Cache of notes about this repository

${CACHE_USAGE_GUIDE}
<!-- thinker:end -->

`;
// BENCH_ONLY=id,id limits the run to those tasks
const ONLY = (process.env.BENCH_ONLY || '').split(',').filter(Boolean);
const tasks = JSON.parse(fs.readFileSync(TASKS, 'utf8')).tasks.filter(t => !ONLY.length || ONLY.includes(t.id));
fs.mkdirSync(path.join(OUT, 'events'), { recursive: true });

function makeWorktree(i) {
  // BENCH_WT names worktrees the benchmark's Codex home already trusts
  const wt = path.join(HERE, 'worktrees', `${process.env.BENCH_WT || TAG}-${i}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  if (fs.existsSync(wt)) {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: WT_REPO }); }
    catch { fs.rmSync(wt, { recursive: true, force: true }); }
  }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], { cwd: WT_REPO });
  return wt;
}
function resetWorktree(wt) {
  try {
    execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: wt });
    execFileSync('git', ['clean', '-qfd'], { cwd: wt });
  } catch {}
  fs.rmSync(path.join(wt, '.thinker'), { recursive: true, force: true });
}
// The cache as a Codex install has it. Each run serves its own copy of the noteset, so use
// counters stay in the worktree; remember and feedback are off, so no run writes a note.
function armCache(wt) {
  const own = path.join(wt, '.thinker');
  fs.cpSync(NOTES, path.join(own, 'notes'), { recursive: true });
  const cc = path.join(NOTESET, 'cochange.json');
  if (fs.existsSync(cc)) fs.copyFileSync(cc, path.join(own, 'cochange.json'));
  installClient('codex', {
    repo: wt, cli: CLI, hooks: false, learn: false, late: true, shared: false, mcp: true,
    mcpEntry: { command: 'node', args: [path.join(ROOT, 'src', 'mcp.js')], env: { THINKER_REPO: wt, THINKER_NO_LEARN: '1', THINKER_NO_BG_VERIFY: '1', THINKER_LOG: 'local' } },
  });
  // codex exec refuses an MCP call that has no approval
  const cfg = path.join(wt, '.codex', 'config.toml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('[mcp_servers.thinker]\n', '[mcp_servers.thinker]\ndefault_tools_approval_mode = "approve"\nenabled_tools = ["orient", "lookup"]\n'));
  // at the top: Codex reads a limited length of AGENTS.md, and PostHog's is longer
  const agents = path.join(wt, 'AGENTS.md');
  fs.writeFileSync(agents, AGENTS_BLOCK + (fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : ''));
}
// What the cache did in a run, from its own log in the worktree
function cacheUse(wt) {
  const use = { injected: [], hookServed: 0, lateServed: 0, orientCalls: 0, lookupCalls: 0 };
  let lines = []; try { lines = fs.readFileSync(path.join(wt, '.thinker', 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  const ids = new Set();
  for (const l of lines) {
    for (const id of l.served || []) ids.add(id);
    if (l.op === 'orient' && l.session) use.hookServed += (l.served || []).length;
    else if (l.op === 'orient') use.orientCalls++;
    else if (l.op === 'lookup') use.lookupCalls++;
    else if (l.op === 'late') use.lateServed += (l.served || []).length;
  }
  use.injected = [...ids];
  return use;
}
function contextFor(task, session) {
  const env = {
    ...process.env,
    THINKER_NOTES_DIR: NOTES,
    THINKER_EARLY: 'full',
    THINKER_NO_BG_VERIFY: '1',
  };
  try {
    const text = execFileSync('node', [CLI, 'hook', 'prompt', '--client', 'codex', '--repo', REPO, '--budget', String(BUDGET)], {
      cwd: REPO,
      env,
      input: JSON.stringify({ prompt: task.prompt, session_id: session }),
      encoding: 'utf8',
      maxBuffer: 1 << 24,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    // the list of notes not shown asks for a lookup call, and this harness gives Codex no MCP tools
    return text.replace(/\n\nAlso in the cache, not shown[\s\S]*?(?=\n<\/thinker-cache>)/, '');
  } catch (e) {
    throw new Error(`cache orientation failed: ${e.message}`);
  }
}
function runCodex(prompt, cwd) {
  const args = [
    'exec', '--json', '--ephemeral', '--ignore-rules',
    '--model', MODEL, '--sandbox', 'workspace-write', '--cd', cwd,
  ];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env: { ...process.env, CODEX_HOME, CODEX_DISABLE_PROJECT_DOCS: '0' } });
    let stdout = '', stderr = '', timedOut = false;
    // a session that stalls would hold its worker for the rest of the run
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, (Number(process.env.BENCH_TIMEOUT_MIN) || 20) * 60_000);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('timed out'));
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
        // Codex counts cached tokens inside input_tokens
        in_tokens: usage.reduce((s, u) => s + (u.input_tokens || 0), 0),
        cached_tokens: usage.reduce((s, u) => s + (u.cached_input_tokens || 0), 0),
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
  execFileSync('git', ['add', '-A', '--', '.', ':!.thinker', ':!.codex', ':!AGENTS.md'], { cwd });
  const diff = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd, maxBuffer: 1 << 26 }).toString();
  execFileSync('git', ['reset', '-q'], { cwd });
  return diff;
}

const jobs = [];
for (let rep = 0; rep < REPS; rep++) for (const task of tasks) for (const arm of ARMS) jobs.push({ task, arm, rep });
async function worker(wi) {
  const cwd = makeWorktree(wi);
  while (jobs.length) {
    const { task, arm, rep } = jobs.shift();
    const id = `${task.id}-${arm}-${rep}`;
    const file = path.join(OUT, `${id}.json`);
    // a run that ended in an error is run again
    if (fs.existsSync(file) && !JSON.parse(fs.readFileSync(file, 'utf8')).error) { console.log(`skip ${id}`); continue; }
    resetWorktree(cwd);
    const session = `codex-${TAG}-${task.id}-${rep}`;
    let prompt = task.prompt;
    let injected = '';
    if (arm === 'hook') {
      injected = contextFor(task, session);
      // the notes carry their own preamble; no second instruction around them
      prompt = `${injected}\n\n${task.prompt}`;
    }
    if (arm === 'full') armCache(cwd);
    try {
      const run = await runCodex(prompt, cwd);
      run.tools.injected = [...new Set([...injected.matchAll(/\(id: ([\w-]+), confidence/g)].map(m => m[1]))];
      if (arm === 'full') { const use = cacheUse(cwd); run.tools.injected = use.injected; run.tools.cache = use; run.tools.thinkerCalls = use.orientCalls + use.lookupCalls; }
      run.model = MODEL;
      run.budget = arm === 'nocache' ? null : BUDGET;
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
