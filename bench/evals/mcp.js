#!/usr/bin/env node
// MCP server for Artemis, the evals platform: an agent lists and reads experiments (cache off against cache on,
// every arm, per PR), follows progress, and plans and starts experiments. It is a client of the
// running app's HTTP API, so a run an agent starts goes through the same validation, plan and job
// tracking as one started from the page.
//
//   claude mcp add artemis -- node bench/evals/mcp.js        (ARTEMIS_URL=http://127.0.0.1:<port> to pin it)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runningServer } from './db.js';

// The app's address: ARTEMIS_URL, else the running server's lock, else the port the reservation tool holds for it.
function baseUrl() {
  const pinned = process.env.ARTEMIS_URL ?? process.env.EVALS_URL;
  if (pinned) return pinned.replace(/\/$/, '');
  // the server that holds the database's lock (db.js lockServer)
  const running = runningServer();
  if (running) return `http://127.0.0.1:${running.port}`;
  try {
    const out = execFileSync(path.join(os.homedir(), '.claude', 'bin', 'claude-port'), ['list', 'thinker'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // the live reservation (it was labelled evals before the platform had a name)
    const rows = out.split('\n').map(l => l.trim().split(/\s+/)).filter(c => c[2] === 'artemis' || c[2] === 'evals');
    const row = rows.find(c => c[4] === 'yes') || rows[0];
    if (row) return `http://127.0.0.1:${row[0]}`;
  } catch {}
  return null;
}

export async function call(pathname, body, base = baseUrl()) {
  if (!base) throw new Error('Artemis is not running. Start it with: artemis-up (or set ARTEMIS_URL).');
  let r;
  try { r = await fetch(base + pathname, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); }
  catch (e) { throw new Error(`Artemis at ${base} did not answer (${e.cause?.code || e.message}). Is it running?`); }
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// ---------- compact shapes for an agent to read ----------
const r2 = v => (v == null ? null : Math.round(v * 100) / 100);
const r0 = v => (v == null ? null : Math.round(v));
const VERDICT = (d, better) => d?.mean == null ? null : d.lo == null ? 'too few pairs' : d.lo <= 0 && d.hi >= 0 ? 'no clear difference' : (better === 'up') === (d.mean > 0) ? 'cache better' : 'cache worse';

function metricRows(c, metrics, served = false) {
  const off = served ? c.servedOffSide : c.offSide, on = served ? c.servedOnSide : c.onSide, d = served ? c.deltaServed : c.delta;
  return Object.fromEntries(metrics.map(m => {
    const k = m.key === 'pass' ? 'pass_rate' : m.key;
    if (m.key === 'pass' && !off.graded) return [m.key, null];
    if (m.loop && off[k] == null && on[k] == null) return [m.key, null];  // not a loop experiment
    const x = d[m.key];
    return [m.key, { off: r2(off[k]), on: r2(on[k]), delta: r2(x.mean), ci90: x.lo == null ? null : [r2(x.lo), r2(x.hi)], pairs: x.n, verdict: VERDICT(x, m.better) }];
  }).filter(([, v]) => v));
}

function comparisonOut(c, metrics, meta) {
  return {
    arm: c.on, role: c.on === meta.on ? 'cache on' : 'other arm', against: c.off,
    pairs: c.pairs, served_pairs: c.served,
    pass: c.offSide.graded ? { off: `${c.offSide.passed}/${c.offSide.graded}`, on: `${c.onSide.passed}/${c.onSide.graded}` } : null,
    graded_by: c.graders, prs: c.counts,
    metrics: metricRows(c, metrics), metrics_when_served: c.served ? metricRows(c, metrics, true) : null,
    unpaired: c.unpaired,
  };
}

function prsOut(all, meta) {
  const tasks = [...new Set(all.flatMap(c => c.prs.map(p => p.task)))].sort();
  return tasks.map(t => {
    const ps = all.map(c => [c.on, c.prs.find(p => p.task === t)]).filter(([, p]) => p);
    const p0 = ps[0][1];
    const pass = s => (s.graded ? `${s.passed}/${s.graded}` : s.score != null ? `score ${r2(s.score)}` : null);
    return {
      task: t, pr: p0.pr, title: p0.title,
      [meta.off]: { pass: pass(p0.off), in_tokens: r0(p0.off.in_tokens), tool_calls: p0.off.tool_calls },
      ...Object.fromEntries(ps.map(([arm, p]) => [arm, { pass: pass(p.on), change: p.change, in_tokens: r0(p.on.in_tokens), d_in_tokens: r0(p.d_in_tokens), d_tool_calls: r2(p.d_tool_calls), served: `${p.on.served}/${p.on.valid}` }])),
    };
  });
}

const text = obj => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) }] });
const guard = fn => async args => { try { return await fn(args); } catch (e) { return { ...text(`Error: ${e.message}`), isError: true }; } };

const launchShape = {
  tag: z.string().describe('Folder under bench/runs for this experiment, e.g. posthog-opus-hook-2026-10-15. Reusing a tag resumes it: results already there are skipped.'),
  name: z.string().describe('Short name, e.g. "Prompt hook · Opus · PostHog"'),
  question: z.string().describe('What the experiment tests, as a question'),
  kind: z.enum(['behavior', 'model']).describe('behavior: a cache feature, prompt or wiring; model: how one model does with the cache'),
  prset: z.string().describe('PR set module: which PRs, at which base (list_pr_sets; create_pr_set to make one)'),
  cache: z.string().optional().describe('Cache module: the cache the cache-on arm is served, mined or understanding (list_caches; plan_cache/build_cache to build one). It must be built by the agent\'s model at or before the PR set\'s base. Left out only when no arm is served notes (the cache off against a defined arm such as another tool).'),
  runner: z.enum(['claude', 'codex', 'gemini']).describe('Agent module: which harness runs the agent (bench/run.js, codex-run.js or gemini-run.js)'),
  model: z.string().describe('Agent model, e.g. sonnet, opus, gpt-6-sol; must be the cache\'s mining model'),
  off: z.string().optional().describe('Cache-off arm; default nocache'),
  on: z.string().optional().describe('Cache-on arm; default cache (full for codex)'),
  extra: z.string().optional().describe('Further arms, comma-separated, e.g. irrelevant (placebo notes)'),
  reps: z.number().int().min(1).max(10).optional().describe('Reps per PR × arm; default 1'),
  conc: z.number().int().min(1).max(8).optional().describe('Concurrent sessions; default 1'),
  judge: z.string().optional().describe('Grading module: the judge model. Required unless every PR in the set has its own tests.'),
  flags: z.record(z.string(), z.boolean()).optional().describe('Runner switches, e.g. {"strict-model": true}'),
  values: z.record(z.string(), z.string()).optional().describe('Runner options with a value, e.g. {"effort": "high"}'),
};

export function buildServer() {
  const server = new McpServer({ name: 'artemis', version: '0.1.0' }, {
    instructions: 'Artemis: benchmark experiments for the thinker cache, following the run-evals skill. An experiment is built from modules: a PR set (create_pr_set), a cache, mined or read from the code (plan_cache, build_cache), the arms, the agent, and the grader; it runs the PRs with the cache off and with it on. Results are paired by PR and rep, with 90% bootstrap intervals, invalid sessions excluded. Read with list_experiments, get_experiment, get_pr, get_session (transcripts); follow runs and builds with get_progress. Building a cache and starting an experiment spend model tokens: plan, show the user the plan, and build or start only after the user approves it.',
  });

  server.registerTool('list_experiments', {
    description: 'Every experiment with its cache-off vs cache-on headline: pass rate, input tokens, tool calls, wall time, each as a paired difference with a 90% interval and a verdict. Filter by repo, model, kind or text.',
    inputSchema: { repo: z.string().optional(), model: z.string().optional(), kind: z.enum(['behavior', 'model']).optional(), query: z.string().optional().describe('Matches tag, name or question'), only_compared: z.boolean().optional().describe('Only experiments with a cache-off arm (default true)') },
    annotations: { readOnlyHint: true },
  }, guard(async a => {
    const s = await call('/api/experiments');
    const q = (a.query || '').toLowerCase();
    const rows = s.experiments.filter(e => (!a.repo || (e.repo || '').split(',').includes(a.repo)) && (!a.model || (e.models || '').split(',').includes(a.model))
      && (!a.kind || e.meta.kind === a.kind) && (a.only_compared === false || e.meta.off)
      && (!q || `${e.dir} ${e.meta.name || ''} ${e.meta.question || ''}`.toLowerCase().includes(q)));
    return text(rows.map(e => ({
      tag: e.dir, name: e.meta.name, question: e.meta.question, kind: e.meta.kind, repo: e.repo, model: e.models, runner: e.runner, date: e.first_at ? new Date(e.first_at).toISOString().slice(0, 10) : null,
      prs: e.prs, off: e.meta.off, on: e.meta.on, other_arms: e.meta.others, results: e.results, invalid: e.invalid,
      headline: e.cmp?.pairs ? { pairs: e.cmp.pairs, served_pairs: e.cmp.served, pass: e.cmp.off.graded ? `${e.cmp.off.passed}/${e.cmp.off.graded} → ${e.cmp.on.passed}/${e.cmp.on.graded}` : null,
        ...Object.fromEntries(['pass', 'in_tokens', 'tool_calls', 'wall_ms'].filter(k => k !== 'pass' || e.cmp.off.graded).map(k => { const d = e.cmp.delta[k], m = s.metrics.find(x => x.key === k); return [`d_${k}`, { mean: r2(d.mean), ci90: d.lo == null ? null : [r2(d.lo), r2(d.hi)], verdict: VERDICT(d, m.better) }]; })) } : null,
    })));
  }));

  server.registerTool('get_experiment', {
    description: 'One experiment in full: its definition, every arm compared against the cache-off arm, or against the arm named by ref (head to head, e.g. thinker against another tool), with all metrics as paired differences, 90% intervals, verdicts, and the same over only the pairs where the cache served a note; PR outcome counts, a per-PR table across arms, and the invalid sessions with reasons.',
    inputSchema: { tag: z.string().describe('The experiment tag (its folder under bench/runs)'), ref: z.string().optional().describe('Compare every other arm against this arm instead of the cache-off arm'), per_pr: z.boolean().optional().describe('Include the per-PR table (default true)') },
    annotations: { readOnlyHint: true },
  }, guard(async a => {
    const x = await call('/api/experiment?dir=' + encodeURIComponent(a.tag) + (a.ref ? '&ref=' + encodeURIComponent(a.ref) : ''));
    return text({
      tag: x.run.dir, definition: { name: x.meta.name, question: x.meta.question, kind: x.meta.kind, off: x.meta.cacheOff || x.meta.off, on: x.meta.on, other_arms: x.meta.others, recorded: x.meta.defined },
      compared_against: x.meta.ref,
      repo: x.run.repo, model: x.run.models, runner: x.run.runner, results: x.run.results, invalid: x.run.invalid,
      comparisons: x.all.filter(c => c.pairs).map(c => comparisonOut(c, x.metrics, x.meta)),
      per_pr: a.per_pr === false ? undefined : prsOut(x.all, x.meta),
      invalid_sessions: x.invalid.map(i => ({ id: i.id, task: i.task, arm: i.arm, rep: i.rep, reason: i.reason })),
      note: x.meta.off ? undefined : 'No cache-off arm: set one with define_experiment to get a comparison.',
    });
  }));

  server.registerTool('get_pr', {
    description: 'One PR (task) across every experiment that ran it: cache-off and cache-on outcome, tokens and tool calls in each.',
    inputSchema: { task: z.string().describe('Task id, e.g. PR106466-hard') },
    annotations: { readOnlyHint: true },
  }, guard(async a => {
    const x = await call('/api/pr?id=' + encodeURIComponent(a.task));
    return text({ task: x.task, ...x.info, experiments: x.experiments.map(e => ({ tag: e.dir, name: e.meta.name, model: e.models, off: e.meta.off, on: e.meta.on,
      result: e.pr && { change: e.pr.change, off: { pass: `${e.pr.off.passed}/${e.pr.off.graded}`, in_tokens: r0(e.pr.off.in_tokens) }, on: { pass: `${e.pr.on.passed}/${e.pr.on.graded}`, in_tokens: r0(e.pr.on.in_tokens), served: `${e.pr.on.served}/${e.pr.on.valid}` }, d_in_tokens: r0(e.pr.d_in_tokens), d_tool_calls: r2(e.pr.d_tool_calls) } })) });
  }));

  server.registerTool('list_pr_sets', {
    description: 'PR set modules: frozen lists of PRs (from a task set, at its base commit) with the rule they were chosen by, and their checks (checkout at base, fixes absent).',
    inputSchema: { repo: z.string().optional() }, annotations: { readOnlyHint: true },
  }, guard(async a => {
    const { prsets } = await call('/api/prsets');
    return text(prsets.filter(p => !a.repo || p.repo === a.repo).map(p => ({ name: p.name, status: p.status || 'frozen', repo: p.repo, tasks: p.tasks, base: p.base, hash: p.hash, rule: p.rule, prs: p.prs.map(x => ({ id: x.id, pr: x.pr, title: x.title, oracle: x.oracle })), checks: p.checks })));
  }));

  server.registerTool('create_pr_set', {
    description: 'Make a PR set from a task set: the PR ids and the selection rule, written before any result is seen. With draft: true it can still be changed (update_pr_set) and is frozen later (freeze_pr_set); otherwise it is frozen now. Only a frozen set can be run; a frozen set never changes.',
    inputSchema: { name: z.string(), tasks: z.string().describe('Task set name (list_task_sets; import_task_set to add one)'), ids: z.array(z.string()).optional().describe('Task ids; all of the set when omitted'), rule: z.string().describe('How the PRs were chosen, e.g. "every PR merged after 2026-09-20 with tests"'), description: z.string().optional(), draft: z.boolean().optional() },
  }, guard(async a => text(await call('/api/prsets', a))));

  server.registerTool('update_pr_set', {
    description: 'Change a draft PR set: its task set, PR ids, rule or description. A frozen set cannot change.',
    inputSchema: { name: z.string(), tasks: z.string().optional(), ids: z.array(z.string()).optional(), rule: z.string().optional(), description: z.string().optional() },
  }, guard(async a => text(await call('/api/prsets/update', a))));

  server.registerTool('freeze_pr_set', {
    description: 'Freeze a draft PR set so experiments can run it. From then on it never changes.',
    inputSchema: { name: z.string() },
  }, guard(async a => text(await call('/api/prsets/freeze', a))));

  server.registerTool('list_arms', {
    description: 'Arms defined as data (define_arm): another tool run as an arm against the cache off — its MCP servers, hooks, system-prompt text, env, the command run before and after each session — with the hash a plan records.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, guard(async () => text(await call('/api/arms'))));

  server.registerTool('define_arm', {
    description: 'Define (or redefine) an arm as data, kept in the evals database, for the Claude Code runner. `{cwd}` in any string is the session\'s worktree. Name it in an experiment\'s on/extra arms; a plan records its whole definition. A tool that is not thinker sets notes: false, and an experiment with no arm served notes takes no cache.',
    inputSchema: {
      name: z.string().describe('Arm name, e.g. vexp; never one of the runners\' own arms'), description: z.string(),
      notes: z.boolean().describe("true when the arm is served thinker's notes"),
      mcpServers: z.record(z.string(), z.any()).optional().describe('Claude Code --mcp-config mcpServers'),
      hooks: z.record(z.string(), z.any()).optional().describe('Claude Code settings hooks'),
      system: z.string().optional().describe('Text appended to the system prompt (the tool\'s own agent instructions)'),
      env: z.record(z.string(), z.string()).optional().describe('Env for the agent and the before/after commands'),
      before: z.object({ command: z.array(z.string()), failIf: z.string().optional(), timeoutMs: z.number().optional() }).optional().describe('Run in the worktree before each session (e.g. an index build); failIf: a pattern over its output that fails the session'),
      after: z.object({ command: z.array(z.string()), timeoutMs: z.number().optional() }).optional().describe('Run in the worktree after each session'),
      exclude: z.array(z.string()).optional().describe('Paths kept out of the graded diff (the tool\'s index directory)'),
    },
  }, guard(async a => text(await call('/api/arms', a))));

  server.registerTool('list_caches', {
    description: 'Cache modules: caches built by mining (anchor commit, mining model, notes, status) and which PR sets each passes the checks for.',
    inputSchema: { repo: z.string().optional() }, annotations: { readOnlyHint: true },
  }, guard(async a => {
    const { caches } = await call('/api/caches');
    return text(caches.filter(c => !a.repo || c.repo === a.repo).map(c => ({ name: c.name, repo: c.repo, anchor: c.anchor, anchor_date: c.anchor_date, model: c.model, llm: c.llm, limit: c.limit, status: c.status, error: c.error, notes: c.notes, sources: c.sources, usage: c.usage, fits: c.fits })));
  }));

  server.registerTool('get_cache', {
    description: 'One cache: its receipt (how it was built), its checks, its checks against every PR set of its repository, and the experiments that used it.',
    inputSchema: { name: z.string() }, annotations: { readOnlyHint: true },
  }, guard(async a => text(await call('/api/cache?name=' + encodeURIComponent(a.name)))));

  const cacheShape = {
    name: z.string().describe('New cache name, e.g. posthog-sonnet-a3b3c36'), repo: z.string().describe('Checkout under bench/repos'),
    anchor: z.string().optional().describe('Commit the cache is built at: at or before the PR set\'s base (default the checkout HEAD)'),
    kind: z.enum(['mined', 'understanding']).optional().describe('mined (default): notes distilled from merged changes before the anchor (thinker mine-prs --git). understanding: notes on how the most changed code works at the anchor, read from the code (thinker understand)'),
    llm: z.enum(['claude', 'codex', 'gemini']).describe('Agent CLI that builds the notes'), model: z.string().describe('Building model: the model the experiment\'s agent will run'),
    effort: z.string().optional(), limit: z.number().int().min(5).max(200).optional().describe('mined: merged changes to mine (default 60)'),
    top: z.number().int().min(10).max(1000).optional().describe('understanding: files read whole, the top by recency-weighted commits (default 200)'),
    areas: z.array(z.string()).optional().describe('understanding: only files in these directories (a developer\'s focus areas); default the whole repository'),
    resume: z.boolean().optional().describe('Continue an unfinished build of this name (same parameters): the steps it finished are not repeated'),
  };
  server.registerTool('plan_cache', {
    description: 'Validate a cache build without starting it: the kind, the anchor commit, the building model, the steps (snapshot, mine-prs --git or understand, phrase, relink). Show it to the user before build_cache.',
    inputSchema: cacheShape, annotations: { readOnlyHint: true },
  }, guard(async a => text(await call('/api/cache/plan', a))));

  server.registerTool('build_cache', {
    description: 'Build a planned cache. Mining or reading the code calls the model and spends tokens: only after the user approved the plan from plan_cache. Follow it with get_progress or get_cache.',
    inputSchema: cacheShape, annotations: { destructiveHint: false, openWorldHint: true },
  }, guard(async a => text(await call('/api/cache/build', { ...a, confirm: true }))));

  server.registerTool('get_session', {
    description: 'One agent session in full: the high-level figures (outcome and grader, tokens by class, turns, tool calls by tool, calls before the first edit, notes served, wall time), the same PR and rep in the other arms, and the transcript as steps (user, agent, thinking, tool calls with their results, thinker steps marked).',
    inputSchema: { id: z.string().describe('Session id: <tag>/<task>-<arm>-<rep> (from get_experiment per_pr or invalid_sessions)'),
      filter: z.enum(['all', 'agent', 'tools', 'thinker', 'errors']).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional().describe('Steps to return (default 40)'),
      diff: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, guard(async a => {
    const x = await call('/api/session?id=' + encodeURIComponent(a.id));
    const keep = { all: () => true, agent: s => s.kind === 'assistant', tools: s => s.kind === 'tool', thinker: s => s.thinker, errors: s => s.error }[a.filter || 'all'];
    const steps = (x.transcript?.steps || []).map((s, i) => ({ n: i + 1, ...s })).filter(keep);
    const off = a.offset || 0, lim = a.limit || 40;
    const r = x.row;
    return text({
      id: r.id, task: r.task, pr: x.task?.pr, title: x.task?.title, arm: r.arm, rep: r.rep, model: r.model, invalid: r.invalid,
      outcome: { pass: r.pass == null ? null : Boolean(r.pass), score: r.score, graded_by: r.outcome_source, judge: r.judge, reason: x.raw?.grade?.reason },
      figures: { turns: r.turns, wall_ms: r.wall_ms, tokens: { input: r.in_tokens, fresh: r.fresh_in, cache_read: r.cache_read, cache_write: r.cache_write, output: r.out_tokens }, spend: r.cost, notes_served: r.injected, thinker_calls: r.thinker_calls, ...(x.stats || {}) },
      other_arms: x.partners,
      transcript: x.transcript ? { format: x.transcript.format, archived: x.transcript.archived, total_steps: x.transcript.steps.length, matching: steps.length, offset: off, steps: steps.slice(off, off + lim) } : 'not archived: the agent CLI removed it before it was copied',
      final_message: x.result ? String(x.result).slice(0, 4000) : null,
      diff: a.diff && x.diff ? String(x.diff).slice(0, 20000) : undefined,
    });
  }));

  server.registerTool('list_task_sets', {
    description: 'The task sets Artemis holds (each with its version), the repository checkouts available, and each runner\'s default model, arms and switches.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, guard(async () => {
    const c = await call('/api/catalog');
    return text({ runners: c.runners, repos: c.repos, task_sets: c.taskSets.map(t => ({ name: t.name, version: t.version, repo: t.repo, base: t.base, tasks: t.tasks.map(x => ({ id: x.id, pr: x.pr, title: x.title, has_tests: x.tests, acceptance: x.acceptance })) })) });
  }));

  server.registerTool('import_task_set', {
    description: 'Import a task set into Artemis, the system of record: from a JSON file (path from the repository root, or a name under bench/tasks) or from a file at a git ref (ref + file). Every gold diff is read from the same place and stored; a task whose gold diff is missing or lacks its test files fails the import. Importing changed content writes a new version; PR sets keep the version they froze.',
    inputSchema: { name: z.string().describe('Task set name, e.g. mlflow-b2-hard'), file: z.string().optional().describe('JSON file: a path from the repository root, or with ref, the path at that ref'), ref: z.string().optional().describe('A git ref of this repository to read the file and gold diffs from'), repo: z.string().optional().describe('The checkout under bench/repos the tasks run in, when the file does not name it') },
  }, guard(async a => text(await call('/api/tasksets/import', a))));

  server.registerTool('get_task_set', {
    description: 'One task set: its tasks (request, base, test command, acceptance criteria; gold diffs by size only), its source, and every version it had.',
    inputSchema: { name: z.string(), version: z.number().int().optional() }, annotations: { readOnlyHint: true },
  }, guard(async a => text(await call('/api/taskset?name=' + encodeURIComponent(a.name) + (a.version ? '&version=' + a.version : '')))));

  server.registerTool('set_acceptance', {
    description: 'Set a task\'s acceptance criteria for loop experiments: behavior a reviewer can observe, written from the request and the base code, never from the gold diff or tests, naming no file, function or class the request does not. Writes a new version of the task set.',
    inputSchema: { name: z.string(), task: z.string(), acceptance: z.array(z.object({ id: z.string(), criterion: z.string(), command: z.string().optional(), essential: z.boolean().optional() })) },
  }, guard(async a => text(await call('/api/taskset/acceptance', a))));

  server.registerTool('define_experiment', {
    description: 'Record or correct what an experiment tests: its name, question, kind, and which arm is cache off and which cache on. Saved in the evals database.',
    inputSchema: { tag: z.string(), name: z.string().optional(), question: z.string().optional(), kind: z.enum(['behavior', 'model']).optional(), off: z.string().optional(), on: z.string().optional() },
    annotations: { idempotentHint: true },
  }, guard(async a => {
    const { tag, ...rest } = a;
    return text(await call('/api/experiment', { dir: tag, ...rest }));
  }));

  server.registerTool('plan_experiment', {
    description: 'Validate and price an experiment without starting anything: the exact command, how many agent sessions it starts, what grades them, and a token, spend and time estimate from past results of the same model. Show this plan to the user before start_experiment.',
    inputSchema: launchShape, annotations: { readOnlyHint: true },
  }, guard(async a => {
    const p = await call('/api/plan', a);
    return text({ sessions: p.sessions, already_on_disk: p.resumed, question: p.experiment, modules: p.modules,
      checks: p.checks, blocked: p.blocked, estimate: p.estimate, output: `bench/runs/${p.tag}/`, command: p.command,
      next: p.blocked ? 'Blocked: a module check failed. Fix the module it names (a new PR set or cache) and plan again.'
        : p.sessions ? `To start, call start_experiment with the same arguments and sessions: ${p.sessions}, after the user approves.` : 'Nothing to run: every result for this tag is already on disk.' });
  }));

  server.registerTool('start_experiment', {
    description: 'Start an experiment planned with plan_experiment. It starts real agent sessions that spend model tokens. Only call it after the user has seen the plan and approved it. Pass the same arguments as the plan and its session count; if the plan changed since, the app refuses and you must plan again.',
    inputSchema: { ...launchShape, sessions: z.number().int().min(1).describe('The session count plan_experiment returned') },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, guard(async a => {
    const r = await call('/api/launch', { ...a, confirm: true });
    return text({ started: true, job_id: r.id, tag: r.tag, follow: 'get_progress with this tag; results appear in get_experiment as sessions finish.' });
  }));

  const addShape = {
    add_to: z.string().describe('The experiment (its tag) whose sessions the new arms are paired with; its cache-off and cache-on arms are not run again'),
    arms: z.string().describe('The arms to add, comma-separated, each a name the experiment has not used, e.g. understanding'),
    like: z.record(z.string(), z.enum(['hook', 'full', 'nocache', 'hook-bm25'])).optional().describe('Run an added arm as a built-in one under its own name (codex runner), e.g. {"understanding": "hook"}'),
    prset: z.string().describe('A PR set holding exactly the experiment\'s PRs (list_pr_sets; create_pr_set and freeze_pr_set to make one)'),
    cache: z.string().optional().describe('The cache the added arms are served (list_caches); its checks are those of any experiment'),
    runner: z.enum(['claude', 'codex', 'gemini']).optional().describe('Only when the experiment records no runner'),
    conc: z.number().int().min(1).max(8).optional().describe('Concurrent sessions; default 1'),
    judge: z.string().optional().describe('Grading module, as for plan_experiment'),
    flags: z.record(z.string(), z.boolean()).optional().describe('Runner switches; they apply to the added arms only'),
    values: z.record(z.string(), z.string()).optional().describe('Runner options with a value, e.g. {"ce-views": "multi", "budget": "1500"}; they apply to the added arms only'),
  };
  server.registerTool('plan_add_arms', {
    description: 'Plan new arms for an experiment that already ran, without starting anything: only the new arms run, on the experiment\'s own PRs, reps and model, and each session is paired with the ones already recorded, so the cache-off and cache-on arms are not repeated. Returns the checks (same PRs, same model, task set version, the cache\'s own checks), the command, the session count and an estimate. Show it to the user before add_arms.',
    inputSchema: addShape, annotations: { readOnlyHint: true },
  }, guard(async a => {
    const p = await call('/api/plan', a);
    return text({ sessions: p.sessions, already_on_disk: p.resumed, adds: p.add, modules: p.modules, checks: p.checks, blocked: p.blocked, estimate: p.estimate, command: p.command,
      next: p.blocked ? 'Blocked: a check failed. Fix what it names and plan again.'
        : p.sessions ? `To start, call add_arms with the same arguments and sessions: ${p.sessions}, after the user approves.` : 'Nothing to run: every result of these arms is already on disk.' });
  }));
  server.registerTool('add_arms', {
    description: 'Start the arms planned with plan_add_arms. It starts real agent sessions that spend model tokens. Only call it after the user has seen the plan and approved it, with the same arguments and its session count.',
    inputSchema: { ...addShape, sessions: z.number().int().min(1).describe('The session count plan_add_arms returned') },
    annotations: { destructiveHint: false, openWorldHint: true },
  }, guard(async a => {
    const r = await call('/api/launch', { ...a, confirm: true });
    return text({ started: true, job_id: r.id, tag: r.tag, follow: 'get_progress with this tag; get_experiment compares each added arm with the cache-off arm, and ref names another arm to compare against.' });
  }));

  server.registerTool('get_progress', {
    description: 'What is in progress: running and recent experiments (sessions finished out of planned, each running session\'s live activity, errors, time left) and cache builds (step, mining progress), with the log tail. Includes runs started from a terminal.',
    inputSchema: { tag: z.string().optional().describe('One experiment; all when omitted'), log: z.boolean().optional().describe('Include the last lines of the log') },
    annotations: { readOnlyHint: true },
  }, guard(async a => {
    const { jobs } = await call('/api/jobs');
    return text(jobs.filter(j => !a.tag || j.tag === a.tag).map(j => ({ job_id: j.id, tag: j.tag, name: j.name, status: j.status, waiting_on_limit: j.limit_wait || undefined, source: j.source,
      kind: j.kind || 'experiment', model: j.model, repo: j.repo, arms: j.arms, done: j.done, planned: j.expected, errors: j.errors,
      step: j.step, mining: j.progress || undefined, live: j.live?.length ? j.live : undefined,
      started: j.started_at ? new Date(j.started_at).toISOString() : null, elapsed_min: r2(j.elapsed / 60000), eta_min: j.eta == null ? null : r2(j.eta / 60000),
      log: a.log ? j.log : undefined })));
  }));

  server.registerTool('regrade_experiment', {
    description: 'Regrade an experiment\'s recorded answers to questions with a named judge, without running any agent session again; the earlier grades are kept. Without sessions it only plans: how many answers, and which judges graded them. Calling the judge spends tokens: show the user the plan, then call again with sessions from the plan once they approve. The run is reimported when the job ends; follow it with get_progress.',
    inputSchema: { tag: z.string(), judge: z.string().describe('The judge model, e.g. gpt-6-luna; its provider answers, with no fallback to another'), conc: z.number().int().min(1).max(8).optional(), sessions: z.number().int().optional().describe('The planned count, to start it') },
  }, guard(async a => text(await call('/api/regrade', { dir: a.tag, judge: a.judge, conc: a.conc, ...(a.sessions != null ? { confirm: true, sessions: a.sessions } : {}) }))));

  server.registerTool('cancel_experiment', {
    description: 'Stop an experiment started from the app (its whole process group). Results already written stay; starting it again with the same tag resumes.',
    inputSchema: { job_id: z.number().int().describe('job_id from get_progress (runs started from a terminal cannot be cancelled here)') },
    annotations: { destructiveHint: true },
  }, guard(async a => text(await call('/api/cancel', { id: a.job_id }))));

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  await buildServer().connect(new StdioServerTransport());
}
