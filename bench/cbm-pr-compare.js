#!/usr/bin/env node
// thinker vs codebase-memory-mcp on the PostHog hard change tasks (bench/tasks/posthog-hard.json):
// each arm makes the change in its own worktree at the pinned base through Claude Code; the
// patch is graded against the task's acceptance criteria (bench/judge-protocol.js). Costs model
// calls; run on purpose.
//
//   THINKER_TELEMETRY=off node bench/cbm-pr-compare.js [--arms thinker,cbm,both] [--tasks PR106936-hard,…] [--reindex] [--out dir] [--judge fable]
//
// Arms: thinker (notes + git grep), cbm (the graph alone), both (notes with the graph as engine).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { complete } from '../src/llm.js';
import { GRADE_SCHEMA, JUDGE_SYSTEM_PROMPT, srcOnly, computeGradeScores } from './judge-protocol.js';
import { ROOT, parseArgs, alternate, armWorktree, resetWorktree, ensureIndexed, armsNeedingCbm, guidanceFor, runClaude, transcriptPath, toolStats, mcpCalls, cbmVersion } from './cbm-arms.js';

const opts = parseArgs(process.argv.slice(2));
const OUT = opts.out ? path.resolve(opts.out) : path.join(ROOT, 'bench/runs/posthog-thinker-vs-cbm');
fs.mkdirSync(OUT, { recursive: true });
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/tasks/posthog-hard.json'), 'utf8'));
const IDS = opts.tasks || ['PR106936-hard', 'PR106672-hard', 'PR106522-hard'];
const NOTES = path.join(ROOT, 'bench/notesets/posthog-v2/notes');
const JUDGE = opts.judge || 'claude-sonnet-5'; // --judge fable: bench/RESULTS.md reports Fable-judged numbers
const MAX_TURNS = Number(process.env.CBM_PR_MAX_TURNS) || 60; // 35 capped two of three Qartez-study runs before any edit

const worktrees = {};
function worktreeFor(arm) {
  if (!worktrees[arm]) {
    worktrees[arm] = armWorktree(SPEC.repo, arm, { base: SPEC.base, notes: NOTES });
    if (arm !== 'thinker') worktrees[arm + ':project'] = ensureIndexed(worktrees[arm], { force: opts.reindex });
  } else resetWorktree(worktrees[arm], { base: SPEC.base, notes: arm === 'cbm' ? null : NOTES });
  return { cwd: worktrees[arm], project: worktrees[arm + ':project'] };
}

// The code around the patch after it was applied, for the judge.
function contextFor(wt, diff) {
  const ranges = new Map(); let file;
  for (const line of srcOnly(diff).split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/); if (f) file = f[1];
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) { const n = Number(h[1]); const r = ranges.get(file) || []; r.push([Math.max(1, n - 80), n + Number(h[2] ?? 1) + 80]); ranges.set(file, r); }
  }
  let context = '';
  for (const [f, rs] of ranges) {
    const abs = path.join(wt, f); if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, 'utf8'), lines = source.split('\n');
    if (lines.length <= 300) context += `\n--- ${f} (full file after patch) ---\n${source}\n`;
    else {
      const merged = [];
      for (const r of rs.sort((a, b) => a[0] - b[0])) { const last = merged.at(-1); if (last && r[0] <= last[1] + 5) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
      for (const [a, b] of merged) context += `\n--- ${f} lines ${a}-${Math.min(b, lines.length)} after patch ---\n${lines.slice(a - 1, b).join('\n')}\n`;
    }
  }
  return context.slice(0, 80000);
}

async function runArm(task, arm) {
  const id = `${task.id}-${arm}-0`;
  const outFile = path.join(OUT, `${id}.json`);
  if (fs.existsSync(outFile)) { console.log(`skip ${id} (already completed)`); return JSON.parse(fs.readFileSync(outFile, 'utf8')); }
  const { cwd, project } = worktreeFor(arm);
  const prompt = `${guidanceFor(arm, project)}\n\n${task.prompt}`;
  console.log(`[START] ${id} at ${new Date().toISOString()}`);
  const run = await runClaude({ prompt, cwd, arm, maxTurns: MAX_TURNS, disallowed: 'Agent,Task', timeoutMs: 40 * 60_000 }); // no subagents: their replies end up as the run's summary
  execFileSync('git', ['add', '-A', '--', '.', ':!.thinker', ':!AGENTS.md'], { cwd });
  const diff = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd, encoding: 'utf8' });
  const tools = toolStats(transcriptPath(run.session_id, cwd));
  const record = { id, task: task.id, arm, wall_ms: run.wall_ms, duration_api_ms: run.duration_api_ms, turns: run.num_turns, cost_usd: run.total_cost_usd, usage: run.usage, tools, diff, context: contextFor(cwd, diff), summary: run.result || '', session_id: run.session_id, timedOut: run.timedOut };
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
  console.log(`[DONE] ${id}: ${(record.wall_ms / 1000).toFixed(1)}s, ${record.turns} turns, ${tools.calls} calls (${mcpCalls(arm, tools)} MCP), diff: ${diff.length} chars, cost $${record.cost_usd?.toFixed(4)}`);
  return record;
}

async function grade(task, record) {
  const judgeFile = path.join(OUT, `${record.id}.judge.json`);
  if (fs.existsSync(judgeFile)) return JSON.parse(fs.readFileSync(judgeFile, 'utf8'));
  console.log(`[JUDGING] ${record.id}…`);
  const prompt = `REQUEST:\n${task.prompt}\n\nCRITERIA:\n${task.criteria.map(c => `${c.id}${c.essential ? ' (essential)' : ''}: ${c.behavior}`).join('\n')}\n\nPATCH:\n${(srcOnly(record.diff) || '(empty patch)').slice(0, 40000)}\n\nCODE AFTER PATCH:\n${record.context}\n\nAUTHOR SUMMARY:\n${(record.summary || '').slice(0, 3000)}`;
  const res = await complete({ model: JUDGE, system: JUDGE_SYSTEM_PROMPT, prompt, schema: GRADE_SCHEMA });
  const scores = computeGradeScores(task.criteria, res.json?.results || []);
  const g = { ...scores, cost_usd: res.cost, model: res.model };
  fs.writeFileSync(judgeFile, JSON.stringify(g, null, 2) + '\n');
  console.log(`[GRADED] ${record.id}: essential=${(scores.essential * 100).toFixed(0)}%, all=${(scores.all * 100).toFixed(0)}%, pass=${scores.pass}`);
  return g;
}

async function main() {
  const protocol = {
    created: new Date().toISOString(),
    thinkerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    cbmVersion: armsNeedingCbm(opts.arms) ? cbmVersion() : null,
    base: SPEC.base, model: 'claude-sonnet-5', judge: JUDGE, maxTurns: MAX_TURNS, tasks: IDS, arms: opts.arms,
    controls: [
      'Identical symptom-only task prompts from the PostHog hard set',
      `Worktrees reset to the pinned base ${SPEC.base} before every run, one per arm`,
      'thinker arms serve the frozen posthog-v2 noteset with learning off; CBM arms use a graph of the base indexed before the first run',
      'All arms run with claude-sonnet-5 and a strict MCP config; arm order alternates across tasks',
      'LLM judge with the standardized acceptance criteria, blind to the arm',
    ],
  };
  fs.writeFileSync(path.join(OUT, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n');
  const records = [];
  for (const { task: taskId, arm } of alternate(IDS, opts.arms)) {
    const task = SPEC.tasks.find(t => t.id === taskId); if (!task) throw new Error(`no task ${taskId}`);
    records.push(await runArm(task, arm));
  }
  for (const rec of records) rec.grade = await grade(SPEC.tasks.find(t => t.id === rec.task), rec);
  const summary = { protocol, runs: records.map(r => ({ task: r.task, arm: r.arm, wall_s: (r.wall_ms / 1000).toFixed(1), api_s: (r.duration_api_ms / 1000).toFixed(1), turns: r.turns, calls: r.tools.calls, mcp_calls: mcpCalls(r.arm, r.tools), reads: r.tools.filesRead, edits: r.tools.edits, greps: r.tools.greps, bash: r.tools.bash, patch_chars: r.diff?.length || 0, cost_usd: r.cost_usd,
    essential: r.grade ? (r.grade.essential * 100).toFixed(1) + '%' : 'N/A', all: r.grade ? (r.grade.all * 100).toFixed(1) + '%' : 'N/A', pass: r.grade?.pass })) };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('\n================ PR BENCHMARK COMPLETE ================');
  console.log(JSON.stringify(summary, null, 2));
}

await main();
