#!/usr/bin/env node
// thinker vs codebase-memory-mcp on the click comprehension tasks (bench/tasks/click.json):
// each arm answers the same questions in its own clean worktree through Claude Code, and a
// judge scores the answers against the expert reference. Costs model calls; run on purpose.
//
//   THINKER_TELEMETRY=off node bench/cbm-compare.js [--arms thinker,cbm,both] [--tasks E1-flag-parsing,…] [--reindex] [--out dir] [--judge fable]
//
// Arms: thinker (notes + git grep), cbm (the graph alone), both (notes with the graph as engine).
// Completed runs are kept and skipped on rerun (delete a record to redo it).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { complete } from '../src/llm.js';
import { ROOT, parseArgs, alternate, armWorktree, ensureIndexed, armsNeedingCbm, guidanceFor, runClaude, transcriptPath, toolStats, mcpCalls, cbmVersion } from './cbm-arms.js';

const opts = parseArgs(process.argv.slice(2));
const OUT = opts.out ? path.resolve(opts.out) : path.join(ROOT, 'bench/runs/click-thinker-vs-cbm');
fs.mkdirSync(OUT, { recursive: true });
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/tasks/click.json'), 'utf8'));
const IDS = opts.tasks || ['E1-flag-parsing', 'E2-option-kwarg', 'E5-runner-exit'];
const NOTES = path.join(ROOT, 'bench/notesets/click-systematic/notes');
const JUDGE = opts.judge || 'claude-sonnet-5'; // --judge fable grades with Fable (bench/RESULTS.md reports Fable-judged numbers)

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '1.0 if every key fact in the reference is present; 0.5 if the main point is right but important specifics are missing; 0 if the answer is wrong, evasive, or contradicts the reference' },
    missing: { type: 'array', items: { type: 'string' } },
    wrong: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
  required: ['score', 'missing', 'wrong', 'reason'],
};

const worktrees = {};
function worktreeFor(arm) {
  if (!worktrees[arm]) {
    worktrees[arm] = armWorktree(SPEC.repo, arm, { base: SPEC.base, notes: NOTES });
    if (arm !== 'thinker') worktrees[arm + ':project'] = ensureIndexed(worktrees[arm], { force: opts.reindex });
  }
  return { cwd: worktrees[arm], project: worktrees[arm + ':project'] };
}

async function runArm(task, arm) {
  const id = `${task.id}-${arm}-0`;
  const outFile = path.join(OUT, `${id}.json`);
  if (fs.existsSync(outFile)) { console.log(`skip ${id} (already completed)`); return JSON.parse(fs.readFileSync(outFile, 'utf8')); }
  const { cwd, project } = worktreeFor(arm);
  const prompt = `${guidanceFor(arm, project)}\n\nTASK:\n${task.prompt}`;
  console.log(`[START] ${id} at ${new Date().toISOString()}`);
  const run = await runClaude({ prompt, cwd, arm, maxTurns: 30, disallowed: 'Edit,Write,NotebookEdit,Agent,Task' }); // no subagents: their replies end up as the run's answer
  const tools = toolStats(transcriptPath(run.session_id, cwd));
  const must = task.must || [];
  const answer = run.result || '';
  const hits = must.filter(m => new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(answer));
  const record = { id, task: task.id, arm, wall_ms: run.wall_ms, duration_api_ms: run.duration_api_ms, turns: run.num_turns, cost_usd: run.total_cost_usd, usage: run.usage, tools,
    must: { total: must.length, hit: hits.length, hits, missing: must.filter(m => !hits.includes(m)) }, answer, session_id: run.session_id };
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
  console.log(`[DONE] ${id}: ${(record.wall_ms / 1000).toFixed(1)}s, ${record.turns} turns, ${tools.calls} calls (${mcpCalls(arm, tools)} MCP), cost $${record.cost_usd?.toFixed(4)}, must: ${record.must.hit}/${record.must.total}`);
  return record;
}

async function grade(task, record) {
  const judgeFile = path.join(OUT, `${record.id}.judge.json`);
  if (fs.existsSync(judgeFile)) return JSON.parse(fs.readFileSync(judgeFile, 'utf8'));
  console.log(`[JUDGING] ${record.id}…`);
  const res = await complete({
    model: JUDGE,
    system: 'You grade a coding agent\'s answer about a codebase against a reference answer written by an expert. Score 1.0 if every key fact in the reference is present and nothing in the answer contradicts the reference or the code; 0.5 if the main point is right but important specifics are missing or one detail is wrong; 0 if the answer is wrong, evasive, or contradicts the reference on the main point. List missing key facts and wrong claims. Extra correct detail is fine and not penalized. Do not penalize wording, ordering, or formatting.',
    prompt: `TASK:\n${task.prompt}\n\nREFERENCE ANSWER:\n${task.gold}\n\nAGENT ANSWER:\n${record.answer}`,
    schema: JUDGE_SCHEMA,
  });
  const g = { ...res.json, cost_usd: res.cost, model: res.model };
  fs.writeFileSync(judgeFile, JSON.stringify(g, null, 2) + '\n');
  console.log(`[GRADED] ${record.id}: score=${g.score}, ${String(g.reason).slice(0, 100)}`);
  return g;
}

async function main() {
  const protocol = {
    created: new Date().toISOString(),
    thinkerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    cbmVersion: armsNeedingCbm(opts.arms) ? cbmVersion() : null,
    model: 'claude-sonnet-5', judge: JUDGE, tasks: IDS, arms: opts.arms, repetitions: 1,
    controls: [
      'Identical task prompts and clean git worktrees for Click, one per arm',
      'thinker arms serve the frozen click-systematic noteset with learning off; CBM arms use a graph indexed before the first run',
      'All arms run with claude -p --model sonnet --strict-mcp-config and no edit tools',
      'Arm order alternates across tasks',
      'LLM judge against expert gold reference answers, blind to the arm',
    ],
  };
  fs.writeFileSync(path.join(OUT, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n');
  const records = [];
  for (const { task: taskId, arm } of alternate(IDS, opts.arms)) {
    const task = SPEC.tasks.find(t => t.id === taskId); if (!task) throw new Error(`no task ${taskId}`);
    records.push(await runArm(task, arm));
  }
  for (const rec of records) rec.grade = await grade(SPEC.tasks.find(t => t.id === rec.task), rec);
  const summary = { protocol, runs: records.map(r => ({ task: r.task, arm: r.arm, wall_s: (r.wall_ms / 1000).toFixed(1), api_s: (r.duration_api_ms / 1000).toFixed(1), turns: r.turns, calls: r.tools.calls, mcp_calls: mcpCalls(r.arm, r.tools), reads: r.tools.filesRead, greps: r.tools.greps, bash: r.tools.bash,
    input_tokens: r.usage?.input_tokens, cache_read: r.usage?.cache_read_input_tokens, cache_creation: r.usage?.cache_creation_input_tokens, output_tokens: r.usage?.output_tokens, cost_usd: r.cost_usd, must_hit: `${r.must.hit}/${r.must.total}`, score: r.grade?.score, judge_reason: r.grade?.reason })) };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('\n================ BENCHMARK COMPLETE ================');
  console.log(JSON.stringify(summary, null, 2));
}

await main();
