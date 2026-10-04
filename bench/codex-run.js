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
import { complete } from '../src/llm.js';
import { GRADE_SCHEMA, JUDGE_SYSTEM_PROMPT, srcOnly, computeGradeScores } from './judge-protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--') continue;
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    flags[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
}

const repoName = flags.repo || 'posthog';
const REPO = path.join(HERE, 'repos', repoName);
const TASKS = flags.tasks || path.join(HERE, 'tasks', `${repoName}-hard.json`);
const NOTESET = flags.noteset || path.join(HERE, 'notesets', `${repoName}-v2`);
const NOTES = flags['notes-dir'] || path.join(NOTESET, 'notes');
const TAG = flags.tag || (args[0] && !args[0].startsWith('--') ? args[0] : `${repoName}-codex-gpt56`);
const REPS = Number(flags.reps || (args[1] && !args[1].startsWith('--') ? args[1] : 2));
const CONC = Number(flags.conc || (args[2] && !args[2].startsWith('--') ? args[2] : 3));
const MODEL = flags.model || (args[3] && !args[3].startsWith('--') ? args[3] : 'gpt-5.6-terra');
const OUT = path.join(HERE, 'runs', TAG);
const CLI = path.join(ROOT, 'src', 'cli.js');
// Worktrees are cut from a clone that ends at the base commit, so the merged fixes are not in its history
const baseClone = path.join(HERE, 'repos', `${repoName}-base`);
const WT_REPO = fs.existsSync(baseClone) ? baseClone : REPO;
const BUDGET = Number(flags.budget || process.env.BENCH_BUDGET) || 750;
// Arms: nocache | full (hooks, MCP tools and the AGENTS.md instruction, as installed) | hook (notes pasted above the request)
const ARMS = (flags.arm || process.env.BENCH_ARMS || 'nocache,full').split(',').map(a => a === 'cache' ? 'full' : a);
// A Codex home for the benchmark: the login, the hooks (reviewed and trusted there once) and the
// worktrees marked trusted. The hooks say nothing in a worktree that has no notes.
const CODEX_HOME = path.join(HERE, 'codex-home');
const AGENTS_BLOCK = `<!-- thinker:start (managed by thinker, do not edit) -->
## Cache of notes about this repository

${CACHE_USAGE_GUIDE}
<!-- thinker:end -->

`;

function ensureCodexTrust(p) {
  const cfgFile = path.join(CODEX_HOME, 'config.toml');
  let text = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
  const header = `[projects."${p}"]`;
  if (!text.includes(header)) {
    text = text.trimEnd() + `\n\n${header}\ntrust_level = "trusted"\n`;
    fs.writeFileSync(cfgFile, text);
  }
}
ensureCodexTrust(WT_REPO);
ensureCodexTrust(REPO);

// BENCH_ONLY=id,id limits the run to those tasks
const ONLY = (flags.only ? flags.only.split(',') : (process.env.BENCH_ONLY || '').split(',')).filter(Boolean);
const spec = JSON.parse(fs.readFileSync(TASKS, 'utf8'));
const tasks = (spec.tasks || spec).filter(t => !ONLY.length || ONLY.includes(t.id));
fs.mkdirSync(path.join(OUT, 'events'), { recursive: true });

function makeWorktree(i) {
  // BENCH_WT names worktrees the benchmark's Codex home already trusts
  const wt = path.join(HERE, 'worktrees', `${process.env.BENCH_WT || TAG}-${i}`);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  if (fs.existsSync(wt)) {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: WT_REPO }); }
    catch { fs.rmSync(wt, { recursive: true, force: true }); }
  }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, spec.base || 'HEAD'], { cwd: WT_REPO });
  ensureCodexTrust(wt);
  return wt;
}
function resetWorktree(wt) {
  try {
    execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: wt });
    execFileSync('git', ['clean', '-qfd'], { cwd: wt });
  } catch {}
  fs.rmSync(path.join(wt, '.thinker'), { recursive: true, force: true });
  fs.rmSync(path.join(wt, '.codex'), { recursive: true, force: true });
}
// The cache as a Codex install has it. Each run serves its own copy of the noteset, so use
// counters stay in the worktree; remember and feedback are off, so no run writes a note.
function armCache(wt) {
  const own = path.join(wt, '.thinker');
  fs.cpSync(NOTES, path.join(own, 'notes'), { recursive: true });
  installClient('codex', {
    repo: wt, cli: CLI, hooks: false, learn: false, late: true, shared: false, mcp: true,
    mcpEntry: { command: 'node', args: [path.join(ROOT, 'src', 'mcp.js')], env: { THINKER_REPO: wt, THINKER_NO_LEARN: '1', THINKER_NO_BG_VERIFY: '1', THINKER_LOG: 'local' } },
  });
  const cfg = path.join(wt, '.codex', 'config.toml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('[mcp_servers.thinker]\n', '[mcp_servers.thinker]\nenabled_tools = ["orient", "lookup"]\n'));
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
// The hook is shown the request as a person would type it: the benchmark's first paragraph ("Implement the
// following change in this repository. Do not install dependencies…") is harness instruction, and with the
// cross-encoder reading the request's first 120 tokens it crowded the request out (2026-10-04: nothing served
// on four tasks that get a note on the bare request). The agent still receives the whole prompt.
const requestOf = p => /^Implement the following change/.test(p) ? (p.split('\n\n').slice(1).join('\n\n') || p) : p;
function contextFor(task, session) {
  const env = {
    ...process.env,
    THINKER_NOTES_DIR: NOTES,
    THINKER_NO_BG_VERIFY: '1',
  };
  try {
    const text = execFileSync('node', [CLI, 'hook', 'prompt', '--client', 'codex', '--repo', REPO, '--budget', String(BUDGET)], {
      cwd: REPO,
      env,
      input: JSON.stringify({ prompt: requestOf(task.prompt), session_id: session }),
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

async function gradePatch(task, patch, summary = '') {
  if (!task.criteria?.length) return null;
  const judgeProvider = flags['judge-llm'] || 'gemini';
  const judgeModel = flags.judge || 'gemini-3.8-flash-high';
  const prompt = `REQUEST:\n${task.prompt}\n\nCRITERIA:\n${task.criteria.map(c => `${c.id}${c.essential ? ' (essential)' : ''}: ${c.behavior}`).join('\n')}\n\nPATCH:\n${(srcOnly(patch) || '(empty patch)').slice(0, 40000)}\n\nAUTHOR SUMMARY:\n${(summary || '').slice(0, 3000)}`;

  try {
    process.env.THINKER_LLM = judgeProvider;
    const res = await complete({ model: judgeModel, system: JUDGE_SYSTEM_PROMPT, prompt, schema: GRADE_SCHEMA });
    const results = res.json?.results || [];
    return computeGradeScores(task.criteria, results);
  } catch (err) {
    return { error: err.message, essential: 0, all: 0, pass: false };
  }
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
      run.diff = task.type === 'change' ? getDiff(cwd) : null;
      run.grade = await gradePatch(task, run.diff, run.result);
      // the session is ephemeral, so this stream is the only record of what the agent did
      fs.writeFileSync(path.join(OUT, 'events', `${id}.jsonl`), run.raw_events.map(e => JSON.stringify(e)).join('\n'));
      delete run.raw_events;
      fs.writeFileSync(file, JSON.stringify(run, null, 2));
      console.log(`${id}: turns=${run.turns} tools=${run.tools.calls} injected=${run.tools.injected.length} ${(run.wall_ms / 1000).toFixed(0)}s in=${run.in_tokens} out=${run.out_tokens}${run.grade ? ' pass=' + run.grade.pass + ' ess=' + run.grade.essential : ''}`);
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
