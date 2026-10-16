#!/usr/bin/env node
// Run the PostHog hard-task benchmark with Codex CLI, preserving the same
// task prompts, cache notes, paired arms, and output schema used by bench/run.js.
import fs from 'node:fs';
import path from 'node:path';
import { createWorktree, removeWorktree, spawn } from './worktrees.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installClient } from '../src/clients.js';
import { CACHE_USAGE_GUIDE } from '../src/cache-guidance.js';
import { complete } from '../src/llm.js';
import { GRADE_SCHEMA, JUDGE_SYSTEM_PROMPT, srcOnly, computeGradeScores } from './judge-protocol.js';
import { runOracle, goldTouched, codexLoopStats, listCost, resetWorktree as resetBase, goldTestsSeen } from './oracle.js';
import { loopLimits, acceptanceOf, criteriaBlock, CHECKER_SCHEMA, checkerPrompt, verdict, feedback, usageDelta, stopReason } from './loop.js';

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
// absolute: the hook runs with the repository as its cwd, where a relative path found no notes
// (mlflow-astra-v1, 2026-10-11: the hook arms were served nothing and recorded it as such)
const NOTESET = path.resolve(flags.noteset || path.join(HERE, 'notesets', `${repoName}-v2`));
const NOTES = path.resolve(flags['notes-dir'] || path.join(NOTESET, 'notes'));
const TAG = flags.tag || (args[0] && !args[0].startsWith('--') ? args[0] : `${repoName}-codex-gpt56`);
const REPS = Number(flags.reps || (args[1] && !args[1].startsWith('--') ? args[1] : 2));
const CONC = Number(flags.conc || (args[2] && !args[2].startsWith('--') ? args[2] : 3));
const MODEL = flags.model || (args[3] && !args[3].startsWith('--') ? args[3] : 'gpt-5.6-terra');
const OUT = path.join(HERE, 'runs', TAG);
const CLI = path.join(ROOT, 'src', 'cli.js');
// the thinker the hooks and tools ran from, on every record: an arm added later runs today's checkout
const THINKER_REV = (() => { try { const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src'], { cwd: ROOT, encoding: 'utf8' }).trim(); return dirty ? `${rev}+dirty` : rev; } catch { return null; } })();
// Worktrees are cut from a clone that ends at the base commit, so the merged fixes are not in its history
const baseClone = path.join(HERE, 'repos', `${repoName}-base`);
const WT_REPO = fs.existsSync(baseClone) ? baseClone : REPO;
const BUDGET = Number(flags.budget || process.env.BENCH_BUDGET) || 750;
// What every hook and tool call of a cache arm runs with: the product holds notes back on a share of turns
// (src/ops.js:holdoutRate, 15% since 2026-10-14) to measure itself, which in a benchmark arm would serve
// nothing on about one session in seven; --ce-views multi scores notes by their best text (src/dense.js)
const HOOK_ENV = { THINKER_HOLDOUT: '0', ...(flags['ce-views'] ? { THINKER_CE_VIEWS: String(flags['ce-views']) } : {}) };
// Arms: nocache | full (hooks, MCP tools and the AGENTS.md instruction, as installed) | hook (notes pasted above the request)
const ARMS = (flags.arm || process.env.BENCH_ARMS || 'nocache,full').split(',').map(a => a === 'cache' ? 'full' : a);
// An arm under its own name that runs as a built-in one (`--arm-like understanding=hook`): an arm added to an
// experiment whose `hook` arm already ran (Artemis: jobs.js, add_to) is served another cache the same way,
// and its results are recorded under its own name beside the experiment's.
const LIKE = Object.fromEntries(String(flags['arm-like'] || '').split(',').filter(Boolean).map(p => p.split('=')));
const like = arm => LIKE[arm] || arm;
// A Codex home for the benchmark: the login, the hooks (reviewed and trusted there once) and the
// worktrees marked trusted. The hooks say nothing in a worktree that has no notes.
const CODEX_HOME = path.join(HERE, 'codex-home');
// Arms defined as data (Artemis: evals/arms.js), handed over by the plan as --arm-defs <file>: MCP
// servers written into the worktree's .codex/config.toml (each may name its enabled_tools), text put at
// the top of AGENTS.md, env for the session, a command run in the worktree before and after it, and
// paths kept out of the graded diff. `{cwd}` in any string is the session's worktree.
const ARM_DEFS = flags['arm-defs'] ? JSON.parse(fs.readFileSync(flags['arm-defs'], 'utf8')) : {};
const withCwd = (v, cwd) => typeof v === 'string' ? v.replaceAll('{cwd}', cwd) : Array.isArray(v) ? v.map(x => withCwd(x, cwd)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withCwd(x, cwd)])) : v;
const toml = v => JSON.stringify(v);  // strings and arrays of strings: JSON's quoting is TOML's
function armDefined(wt, arm) {
  const def = withCwd(ARM_DEFS[arm], wt);
  const servers = Object.entries(def.mcpServers || {}).map(([name, m]) => [
    `[mcp_servers.${name}]`, `command = ${toml(m.command)}`, `args = ${toml(m.args || [])}`,
    ...(m.enabled_tools ? [`enabled_tools = ${toml(m.enabled_tools)}`] : []),
    ...(m.env ? [`[mcp_servers.${name}.env]`, ...Object.entries(m.env).map(([k, v]) => `${k} = ${toml(String(v))}`)] : []),
  ].join('\n'));
  if (servers.length) { fs.mkdirSync(path.join(wt, '.codex'), { recursive: true }); fs.writeFileSync(path.join(wt, '.codex', 'config.toml'), servers.join('\n\n') + '\n'); }
  if (def.system) { const agents = path.join(wt, 'AGENTS.md'); fs.writeFileSync(agents, def.system + '\n\n' + (fs.existsSync(agents) ? fs.readFileSync(agents, 'utf8') : '')); }
  return def;
}
function armStep(arm, step, cwd) {
  const st = ARM_DEFS[arm]?.[step];
  if (!st?.command?.length) return null;
  const [bin, ...rest] = withCwd(st.command, cwd);
  const t0 = Date.now();
  let out;
  try { out = execFileSync(bin, rest, { cwd, env: { ...process.env, ...withCwd(ARM_DEFS[arm].env || {}, cwd) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24, timeout: st.timeoutMs || 600_000 }); }
  catch (e) { if (step === 'after') return { ms: Date.now() - t0, error: e.message.slice(0, 300) }; throw new Error(`${arm} ${step}: ${e.message.slice(0, 300)}`); }
  if (st.failIf && new RegExp(st.failIf).test(out)) throw new Error(`${arm} ${step}: output matches ${st.failIf}: ${out.slice(0, 300)}`);
  return { ms: Date.now() - t0, tail: out.slice(-400) };
}
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
// --loop (bench/loop.js): iterate to the task's acceptance criteria, judged by a named --checker model
const LOOP = Boolean(flags.loop);
const LIMITS = LOOP ? loopLimits(flags) : null;
const CHECKER = LOOP ? flags.checker : null;
if (LOOP && (!CHECKER || CHECKER === true)) throw new Error('--loop needs --checker <model>: the checker is a judge and is named');
const noCriteria = LOOP ? tasks.filter(t => !acceptanceOf(t).length).map(t => t.id) : [];
if (noCriteria.length) throw new Error(`--loop needs acceptance criteria on every task; missing: ${noCriteria.join(', ')}`);

function makeWorktree(i) {
  // BENCH_WT keeps the path stable for Codex trust; existing work is never removed.
  const wt = createWorktree(WT_REPO, path.join(HERE, 'worktrees', `${process.env.BENCH_WT || TAG}-${i}`), spec.base || 'HEAD');
  ensureCodexTrust(wt);
  return wt;
}
function resetWorktree(wt) {
  resetBase(wt);  // a hard reset: the oracle stages the gold tests (bench/oracle.js)
  fs.rmSync(path.join(wt, '.thinker'), { recursive: true, force: true });
  fs.rmSync(path.join(wt, '.codex'), { recursive: true, force: true });
}
// The cache as a Codex install has it. Each run serves its own copy of the noteset, so use
// counters stay in the worktree; remember and feedback are off, so no run writes a note.
function armCache(wt) {
  const own = path.join(wt, '.thinker');
  fs.cpSync(NOTES, path.join(own, 'notes'), { recursive: true });
  // mlflow keeps AGENTS.md as a symlink; the installer refuses to edit one, so the arm gets a plain copy
  const agentsFile = path.join(wt, 'AGENTS.md');
  try { if (fs.lstatSync(agentsFile).isSymbolicLink()) { const text = fs.readFileSync(agentsFile, 'utf8'); fs.rmSync(agentsFile); fs.writeFileSync(agentsFile, text); } } catch {}
  installClient('codex', {
    repo: wt, cli: CLI, hooks: false, learn: false, late: true, shared: false, mcp: true,
    mcpEntry: { command: 'node', args: [path.join(ROOT, 'src', 'mcp.js')], env: { THINKER_REPO: wt, THINKER_NO_LEARN: '1', THINKER_NO_BG_VERIFY: '1', THINKER_LOG: 'local', ...HOOK_ENV } },
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
// hook-bm25: the lexical ranking with two notes, as the hook served before 2026-10-04
// hook: the cross-encoder at floor 0 with two notes, the default since PR #199 (2026-10-11); this
// branch's src still carries the one-note default, so the arm pins it
const ARM_ENV = { hook: { THINKER_CE_MAX: '2' }, 'hook-bm25': { THINKER_CE: 'off' } };
function contextFor(task, session, arm = 'hook') {
  const env = {
    ...process.env,
    THINKER_NOTES_DIR: NOTES,
    THINKER_NO_BG_VERIFY: '1',
    ...HOOK_ENV,
    ...(ARM_ENV[arm] || {}),
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
// One `codex exec` (or, with `resume`, `codex exec resume <thread>`) call: its events, exit and timing.
// `ephemeral: false` keeps the session on disk so a loop can resume it; resume takes no --cd, so it runs
// with the worktree as cwd. No sandbox (2026-10-12, the user's call): Codex's seatbelt forbade the sysctl
// mlflow's conftest makes in its terminal summary, so every green pytest run exited 1 and the agent read its
// passing tests as failing; the benchmark worktree is disposable and the agent gets a local user's access.
function codexCall(prompt, cwd, { model = MODEL, resume = null, ephemeral = true, timeoutMin = Number(process.env.BENCH_TIMEOUT_MIN) || 20, schemaFile = null, env: armEnv = {} } = {}) {
  const args = resume
    ? ['exec', 'resume', '--json', '--ignore-rules', '--model', model, '--dangerously-bypass-approvals-and-sandbox', resume, '-']
    : ['exec', '--json', ...(ephemeral ? ['--ephemeral'] : []), '--ignore-rules', '--model', model, '--dangerously-bypass-approvals-and-sandbox', '--cd', cwd,
      ...(schemaFile ? ['--output-schema', schemaFile] : []), '-'];
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd, env: { ...process.env, CODEX_HOME, CODEX_DISABLE_PROJECT_DOCS: '0', ...HOOK_ENV, ...armEnv } });
    let stdout = '', stderr = '', timedOut = false;
    // a session that stalls would hold its worker for the rest of the run
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMin * 60_000);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      const events = [];
      for (const line of stdout.split('\n')) {
        try { events.push(JSON.parse(line)); } catch {}
      }
      resolve({ code, stderr, timedOut, events, failure: events.find(e => e.type === 'turn.failed' || e.type === 'error'), wall_ms: Date.now() - started });
    });
    child.stdin.end(prompt);
  });
}
// The record fields a call's events give (usage summed over its turns).
function summarize(events, wall_ms) {
  const usage = events.filter(e => e.type === 'turn.completed').map(e => e.usage || {});
  const msg = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text || '').join('\n');
  const calls = events.filter(e => e.type === 'item.started' && e.item && !['agent_message', 'reasoning'].includes(e.item.type));
  const byTool = {};
  for (const e of calls) byTool[e.item.type] = (byTool[e.item.type] || 0) + 1;
  // MCP calls by server and tool (thinker.find, thinker.drilldown, …): what a defined arm's tools were used for
  const mcp = {};
  for (const e of calls) if (e.item.type === 'mcp_tool_call') { const k = `${e.item.server || '?'}.${e.item.tool || '?'}`; mcp[k] = (mcp[k] || 0) + 1; }
  return {
    session_id: events.find(e => e.type === 'thread.started')?.thread_id,
    turns: usage.length,
    // Codex counts cached tokens inside input_tokens
    in_tokens: usage.reduce((s, u) => s + (u.input_tokens || 0), 0),
    cached_tokens: usage.reduce((s, u) => s + (u.cached_input_tokens || 0), 0),
    out_tokens: usage.reduce((s, u) => s + (u.output_tokens || 0), 0),
    wall_ms,
    result: msg,
    tools: { calls: calls.length, byTool, mcp, thinkerCalls: 0, filesRead: 0, greps: 0, injected: [] },
    raw_events: events,
  };
}
async function runCodex(prompt, cwd, opts = {}) {
  const c = await codexCall(prompt, cwd, opts);
  if (c.timedOut) throw new Error('timed out');
  if (c.code !== 0 || c.failure) throw new Error(`Codex exited ${c.code}: ${JSON.stringify(c.failure || c.stderr).slice(0, 900)}`);
  return summarize(c.events, c.wall_ms);
}

// --loop: the solver works, a checker in a copy of the worktree judges the acceptance criteria, the
// unmet ones go back to the same (resumed) solver session, until done or a limit (bench/loop.js).
async function runLoop(task, prompt, cwd, checkCwd) {
  const acceptance = acceptanceOf(task);
  const started = Date.now();
  const iterations = [], solverEvents = [];
  let thread = null, prevTotal = null, stop = null, doneAt = null, checkerError = null;
  let message = prompt + criteriaBlock(acceptance);
  for (let n = 1; !stop; n++) {
    const left = LIMITS.sessionMin - (Date.now() - started) / 60_000;
    const c = await codexCall(message, cwd, { resume: thread, ephemeral: false, timeoutMin: Math.max(1, Math.min(LIMITS.iterationMin, left)) });
    if (!c.timedOut && (c.code !== 0 || c.failure)) throw new Error(`Codex exited ${c.code} in iteration ${n}: ${JSON.stringify(c.failure || c.stderr).slice(0, 900)}`);
    solverEvents.push(...c.events);
    thread ||= c.events.find(e => e.type === 'thread.started')?.thread_id;
    if (!thread) throw new Error(`no thread id in iteration ${n}`);
    const total = c.events.filter(e => e.type === 'turn.completed').map(e => e.usage).pop();
    const u = total ? (n === 1 ? usageDelta(null, total) : usageDelta(prevTotal, total)) : { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    if (total) prevTotal = total;
    const it = { n, in_tokens: u.input_tokens, cached_tokens: u.cached_input_tokens, out_tokens: u.output_tokens, usage_missing: !total || undefined,
      calls: summarize(c.events, 0).tools.calls, wall_ms: c.wall_ms, timed_out: c.timedOut || undefined };
    iterations.push(it);
    let done = false;
    if (!c.timedOut) {
      const chk = await runChecker(task, acceptance, cwd, checkCwd, n);
      it.checker = chk;
      if (chk.error) { checkerError = chk.error; break; }
      done = chk.done;
    }
    stop = stopReason({ done, n, limits: LIMITS, elapsedMs: Date.now() - started, solverInTokens: iterations.reduce((s, x) => s + x.in_tokens, 0), timedOut: c.timedOut });
    if (stop === 'done') doneAt = n;
    if (!stop) message = feedback(acceptance, it.checker);
  }
  const run = summarize(solverEvents, iterations.reduce((s, x) => s + x.wall_ms, 0));
  // resumed turns report cumulative usage, so the per-iteration differences are the session's own
  Object.assign(run, { session_id: thread, turns: iterations.length,
    in_tokens: iterations.reduce((s, x) => s + x.in_tokens, 0), cached_tokens: iterations.reduce((s, x) => s + x.cached_tokens, 0),
    out_tokens: iterations.reduce((s, x) => s + x.out_tokens, 0) });
  run.loop = { limits: LIMITS, checker: CHECKER, acceptance: acceptance.map(c => c.id), iterations, stop: checkerError ? 'checker_error' : stop, doneAt,
    checkerError, wall_ms: Date.now() - started, checker_in_tokens: iterations.reduce((s, x) => s + (x.checker?.in_tokens || 0), 0) };
  return run;
}
// The checker: a fresh, ephemeral session in a copy of the solver's tree (base + the solver's change,
// without the cache files), so it can run tests and the app without touching the solver's work.
async function runChecker(task, acceptance, cwd, checkCwd, n) {
  syncCopy(cwd, checkCwd);
  // beside the checker's events, not in the run directory, where every .json is read as a result
  fs.mkdirSync(path.join(OUT, 'events', 'checker'), { recursive: true });
  const schemaFile = path.join(OUT, 'events', 'checker', 'schema.json');
  if (!fs.existsSync(schemaFile)) fs.writeFileSync(schemaFile, JSON.stringify(CHECKER_SCHEMA));
  const c = await codexCall(checkerPrompt(task.prompt, acceptance), checkCwd, { model: CHECKER, schemaFile, timeoutMin: LIMITS.iterationMin });
  fs.writeFileSync(path.join(OUT, 'events', 'checker', `${task.id}-${n}-${Date.now()}.jsonl`), c.events.map(e => JSON.stringify(e)).join('\n'));
  const s = summarize(c.events, c.wall_ms);
  const base = { model: CHECKER, in_tokens: s.in_tokens, cached_tokens: s.cached_tokens, out_tokens: s.out_tokens, wall_ms: c.wall_ms };
  if (c.timedOut || c.code !== 0 || c.failure) return { ...base, error: c.timedOut ? 'checker timed out' : `checker exited ${c.code}: ${JSON.stringify(c.failure || c.stderr).slice(0, 300)}` };
  let parsed = null; try { parsed = JSON.parse(s.result.split('\n').filter(Boolean).pop()); } catch {}
  if (!parsed || !Array.isArray(parsed.results)) return { ...base, error: 'checker returned no results' };
  resetBase(checkCwd);
  return { ...base, ...verdict(acceptance, parsed.results) };
}
function syncCopy(src, dst) {
  resetBase(dst);
  execFileSync('git', ['add', '-A', '--', '.', ':!.thinker', ':!.codex', ':!AGENTS.md'], { cwd: src });
  const diff = execFileSync('git', ['diff', '--cached', '--binary', '--no-color'], { cwd: src, maxBuffer: 1 << 26 });
  execFileSync('git', ['reset', '-q'], { cwd: src });
  if (diff.length) execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: dst, input: diff });
}
function getDiff(cwd, exclude = []) {
  execFileSync('git', ['add', '-A', '--', '.', ':!.thinker', ':!.codex', ':!AGENTS.md', ...exclude.map(p => ':!' + p)], { cwd });
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
  const checkCwd = LOOP ? makeWorktree(`${wi}-check`) : null;
  try { await runWorker(cwd, checkCwd); }
  finally { removeWorktree(cwd); if (checkCwd) removeWorktree(checkCwd); }
}
async function runWorker(cwd, checkCwd) {
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
    if (like(arm) === 'hook' || like(arm) === 'hook-bm25') {
      injected = contextFor(task, session, like(arm));
      // the notes carry their own preamble; no second instruction around them
      prompt = `${injected}\n\n${task.prompt}`;
    }
    let armBefore = null, armAfter = null, def = null;
    try {
      if (like(arm) === 'full') armCache(cwd);  // inside the try: a failure here is one errored record, not a dead worker
      if (ARM_DEFS[arm]) { if (LOOP) throw new Error('a defined arm does not run in --loop yet'); armBefore = armStep(arm, 'before', cwd); def = armDefined(cwd, arm); }
      let run;
      try { run = LOOP ? await runLoop(task, prompt, cwd, checkCwd) : await runCodex(prompt, cwd, { env: def?.env || {} }); }
      finally { if (ARM_DEFS[arm]) armAfter = armStep(arm, 'after', cwd); }
      if (ARM_DEFS[arm]) run.armSteps = { before: armBefore, after: armAfter };  // a defined arm's own steps, not in wall_ms
      run.tools.injected = [...new Set([...injected.matchAll(/\(id: ([\w-]+), confidence/g)].map(m => m[1]))];
      if (like(arm) === 'full') { const use = cacheUse(cwd); run.tools.injected = use.injected; run.tools.cache = use; run.tools.thinkerCalls = use.orientCalls + use.lookupCalls; }
      run.model = MODEL;
      run.budget = like(arm) === 'nocache' ? null : BUDGET;
      if (LIKE[arm]) run.armLike = LIKE[arm];
      run.thinker = THINKER_REV;
      run.arm = arm;
      run.task = task.id;
      run.rep = rep;
      run.area = task.area;
      run.id = id;
      run.session = run.session_id;
      run.cost = null;
      run.api_ms = null;
      run.diff = task.type === 'change' ? getDiff(cwd, ARM_DEFS[arm]?.exclude || []) : null;
      // the executable oracle where the task has one; the model judge otherwise (or on request)
      run.grade = task.testCmd ? runOracle(task, cwd) : null;
      if (!flags['no-judge'] && !task.testCmd) run.grade = await gradePatch(task, run.diff, run.result);
      Object.assign(run.tools, codexLoopStats(run.raw_events));
      run.goldTouched = run.diff ? goldTouched(task, run.diff) : null;
      run.leak = goldTestsSeen(task, JSON.stringify(run.raw_events || []));  // gold test names the events show: the session had the answer key
      if (run.leak.length) console.log(`${id} LEAK: the events name gold tests ${run.leak.join(', ')}`);
      run.fresh_in_tokens = run.in_tokens - (run.cached_tokens || 0);
      run.cost = listCost(MODEL, { inTokens: run.in_tokens, cachedTokens: run.cached_tokens, outTokens: run.out_tokens });
      run.costBasis = run.cost != null ? 'list price from token classes' : null;
      // the session is ephemeral, so this stream is the only record of what the agent did
      fs.writeFileSync(path.join(OUT, 'events', `${id}.jsonl`), run.raw_events.map(e => JSON.stringify(e)).join('\n'));
      delete run.raw_events;
      fs.writeFileSync(file, JSON.stringify(run, null, 2));
      console.log(`${id}: turns=${run.turns} tools=${run.tools.calls} injected=${run.tools.injected.length} ${(run.wall_ms / 1000).toFixed(0)}s in=${run.in_tokens} out=${run.out_tokens}${run.grade ? ' pass=' + run.grade.pass + ' ess=' + run.grade.essential : ''}${run.loop ? ` loop=${run.loop.stop}@${run.loop.iterations.length}` : ''}`);
    } catch (e) {
      console.error(`${id} ERROR ${e.message}`);
      fs.writeFileSync(file, JSON.stringify({ id, task: task.id, arm, rep, model: MODEL, turns: 0, error: e.message }, null, 2));
    }
    resetWorktree(cwd);
  }
}
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));

const records = fs.readdirSync(OUT).filter(f => f.endsWith('.json') && f !== 'summary.json' && f !== 'tasks.json').map(f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')));
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(records, null, 2));
console.log(`\nSaved ${records.length} records in ${OUT}`);
