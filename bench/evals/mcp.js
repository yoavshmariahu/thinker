#!/usr/bin/env node
// MCP server for the evals app: an agent lists and reads experiments (cache off against cache on,
// every arm, per PR), follows progress, and plans and starts experiments. It is a client of the
// running app's HTTP API, so a run an agent starts goes through the same validation, plan and job
// tracking as one started from the page.
//
//   claude mcp add evals -- node bench/evals/mcp.js        (EVALS_URL=http://127.0.0.1:<port> to pin it)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

// The app's address: EVALS_URL, else the port the reservation tool holds for it.
function baseUrl() {
  if (process.env.EVALS_URL) return process.env.EVALS_URL.replace(/\/$/, '');
  try {
    const out = execFileSync(path.join(os.homedir(), '.claude', 'bin', 'claude-port'), ['list', 'thinker'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const row = out.split('\n').map(l => l.trim().split(/\s+/)).find(c => c[2] === 'evals');
    if (row) return `http://127.0.0.1:${row[0]}`;
  } catch {}
  return null;
}

export async function call(pathname, body, base = baseUrl()) {
  if (!base) throw new Error('The evals app is not running. Start it with: PORT=$(~/.claude/bin/claude-port reserve thinker evals) npm run evals — or set EVALS_URL.');
  let r;
  try { r = await fetch(base + pathname, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); }
  catch (e) { throw new Error(`The evals app at ${base} did not answer (${e.cause?.code || e.message}). Is it running?`); }
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
  cache: z.string().describe('Cache module: the mined cache the cache-on arm is served (list_caches; plan_cache/build_cache to build one). It must be mined by the agent\'s model at or before the PR set\'s base.'),
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
  const server = new McpServer({ name: 'thinker-evals', version: '0.1.0' }, {
    instructions: 'Benchmark experiments for the thinker cache, following the run-evals skill. An experiment is built from modules: a PR set (create_pr_set), a mined cache (plan_cache, build_cache), the arms, the agent, and the grader; it runs the PRs with the cache off and with it on. Results are paired by PR and rep, with 90% bootstrap intervals, invalid sessions excluded. Read with list_experiments, get_experiment, get_pr, get_session (transcripts); follow runs and builds with get_progress. Building a cache and starting an experiment spend model tokens: plan, show the user the plan, and build or start only after the user approves it.',
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
    description: 'One experiment in full: its definition, every arm compared against the cache-off arm (all metrics with paired differences, 90% intervals, verdicts, and the same over only the pairs where the cache served a note), PR outcome counts, a per-PR table across arms, and the invalid sessions with reasons.',
    inputSchema: { tag: z.string().describe('The experiment tag (its folder under bench/runs)'), per_pr: z.boolean().optional().describe('Include the per-PR table (default true)') },
    annotations: { readOnlyHint: true },
  }, guard(async a => {
    const x = await call('/api/experiment?dir=' + encodeURIComponent(a.tag));
    return text({
      tag: x.run.dir, definition: { name: x.meta.name, question: x.meta.question, kind: x.meta.kind, off: x.meta.off, on: x.meta.on, other_arms: x.meta.others, recorded: x.meta.defined },
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
    inputSchema: { name: z.string(), tasks: z.string().describe('Task set file under bench/tasks (list_task_sets)'), ids: z.array(z.string()).optional().describe('Task ids; all of the set when omitted'), rule: z.string().describe('How the PRs were chosen, e.g. "every PR merged after 2026-09-20 with tests"'), description: z.string().optional(), draft: z.boolean().optional() },
  }, guard(async a => text(await call('/api/prsets', a))));

  server.registerTool('update_pr_set', {
    description: 'Change a draft PR set: its task set, PR ids, rule or description. A frozen set cannot change.',
    inputSchema: { name: z.string(), tasks: z.string().optional(), ids: z.array(z.string()).optional(), rule: z.string().optional(), description: z.string().optional() },
  }, guard(async a => text(await call('/api/prsets/update', a))));

  server.registerTool('freeze_pr_set', {
    description: 'Freeze a draft PR set so experiments can run it. From then on it never changes.',
    inputSchema: { name: z.string() },
  }, guard(async a => text(await call('/api/prsets/freeze', a))));

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
    llm: z.enum(['claude', 'codex', 'gemini']).describe('Agent CLI that does the mining'), model: z.string().describe('Mining model: the model the experiment\'s agent will run'),
    effort: z.string().optional(), limit: z.number().int().min(5).max(200).optional().describe('Merged changes to mine (default 60)'),
    resume: z.boolean().optional().describe('Continue an unfinished build of this name (same parameters): the steps it finished are not repeated'),
  };
  server.registerTool('plan_cache', {
    description: 'Validate a cache build without starting it: the anchor commit, the mining model, the steps (snapshot, mine-prs --git, phrase, relink). Show it to the user before build_cache.',
    inputSchema: cacheShape, annotations: { readOnlyHint: true },
  }, guard(async a => text(await call('/api/cache/plan', a))));

  server.registerTool('build_cache', {
    description: 'Build a planned cache. Mining calls the model and spends tokens: only after the user approved the plan from plan_cache. Follow it with get_progress or get_cache.',
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
    description: 'The task sets (PRs) that can be run, the repository checkouts available, and each runner\'s default model, arms and switches.',
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, guard(async () => {
    const c = await call('/api/catalog');
    return text({ runners: c.runners, repos: c.repos, task_sets: c.taskSets.map(t => ({ file: t.file, repo: t.repo, tasks: t.tasks.map(x => ({ id: x.id, pr: x.pr, title: x.title, has_tests: x.tests })) })) });
  }));

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
