#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { complete } from '../src/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'bench/runs/click-thinker-vs-qartez-3');
fs.mkdirSync(OUT, { recursive: true });

const TASKS_FILE = path.join(ROOT, '../../bench/tasks/click.json');
const SPEC = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
const IDS = ['E1-flag-parsing', 'E2-option-kwarg', 'E5-runner-exit'];

const QARTEZ_BIN = path.join(ROOT, 'eval-support/qartez-0.11.0-aarch64-apple-darwin/qartez');
const WT_THINKER = path.join(ROOT, 'bench/worktrees/click-eval-thinker');
const WT_QARTEZ = path.join(ROOT, 'bench/worktrees/click-eval-qartez');

const THINKER_GUIDANCE = `This repository has a "thinker" knowledge cache from previous sessions, exposed as MCP tools (mcp__thinker__orient and mcp__thinker__lookup). Before exploring the codebase, call mcp__thinker__orient or mcp__thinker__lookup with the task/query to inspect relevant notes. Follow the file:symbol pointers returned to answer the task. Rely on grep/read only to verify or fill gaps.`;

const QARTEZ_GUIDANCE = `This repository has a "qartez" code intelligence server exposed as MCP tools (e.g. qartez_find, qartez_grep, qartez_read, qartez_outline, qartez_impact, qartez_deps, qartez_refs, qartez_map). Before manually grepping or reading files, query the Qartez tools to inspect symbol definitions, call hierarchies, and dependencies to answer the task.`;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '1.0 if every key fact in the reference is present; 0.5 if the main point is right but important specifics are missing; 0 if the answer is wrong, evasive, or contradicts the reference' },
    missing: { type: 'array', items: { type: 'string' } },
    wrong: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' }
  },
  required: ['score', 'missing', 'wrong', 'reason']
};

function transcriptPath(sessionId, cwd) {
  const enc = cwd.replace(/[\/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', enc, sessionId + '.jsonl');
}

function toolStats(file) {
  const stats = { calls: 0, byTool: {}, thinkerCalls: 0, qartezCalls: 0, filesRead: new Set(), greps: 0, bash: 0 };
  if (!fs.existsSync(file)) return { ...stats, filesRead: 0 };
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    for (const b of j.message.content) {
      if (b.type !== 'tool_use') continue;
      stats.calls++;
      stats.byTool[b.name] = (stats.byTool[b.name] || 0) + 1;
      if (b.name.startsWith('mcp__thinker')) stats.thinkerCalls++;
      if (b.name.startsWith('mcp__qartez')) stats.qartezCalls++;
      if (b.name === 'Read') stats.filesRead.add(b.input?.file_path);
      if (b.name === 'Grep' || b.name === 'Glob') stats.greps++;
      if (b.name === 'Bash') {
        stats.bash++;
        if (/\b(grep|rg|find|cat|sed|head|tail|ls)\b/.test(b.input?.command || '')) stats.greps++;
      }
    }
  }
  stats.filesRead = stats.filesRead.size;
  return stats;
}

async function runArm(task, arm) {
  const id = `${task.id}-${arm}-0`;
  const outFile = path.join(OUT, `${id}.json`);
  if (fs.existsSync(outFile)) {
    console.log(`skip ${id} (already completed)`);
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  }

  const cwd = arm === 'thinker' ? WT_THINKER : WT_QARTEZ;
  const prompt = `${arm === 'thinker' ? THINKER_GUIDANCE : QARTEZ_GUIDANCE}\n\nTASK:\n${task.prompt}`;

  const mcpConfig = arm === 'thinker' ? {
    mcpServers: {
      thinker: {
        command: 'node',
        args: [path.join(ROOT, '../../src/mcp.js')],
        env: {
          THINKER_REPO: cwd,
          THINKER_NOTES_DIR: path.join(cwd, '.thinker/notes'),
          THINKER_NO_LEARN: '1',
          THINKER_LOG: 'local',
          THINKER_TELEMETRY: 'off'
        }
      }
    }
  } : {
    mcpServers: {
      qartez: {
        command: QARTEZ_BIN,
        args: ['--root', cwd, '--no-watch']
      }
    }
  };

  const args = [
    '-p', prompt,
    '--model', 'sonnet',
    '--output-format', 'json',
    '--permission-mode', 'bypassPermissions',
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify(mcpConfig),
    '--disallowedTools', 'Edit,Write,NotebookEdit',
    '--max-turns', '30'
  ];

  console.log(`[START] ${id} (${arm}) at ${new Date().toISOString()}`);
  const t0 = Date.now();

  const runResult = await new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, THINKER_TELEMETRY: 'off', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      let j;
      try {
        j = JSON.parse(stdout);
      } catch (err) {
        return reject(new Error(`Failed to parse Claude JSON output (${code}): ${stderr.slice(0, 300)} ${stdout.slice(0, 300)}`));
      }
      resolve({ ...j, wall_ms: Date.now() - t0, stderr });
    });
  });

  const tPath = transcriptPath(runResult.session_id, cwd);
  const tStats = toolStats(tPath);

  const must = task.must || [];
  const answer = runResult.result || '';
  const mustHits = must.filter(m => new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(answer));

  const record = {
    id,
    task: task.id,
    arm,
    wall_ms: runResult.wall_ms,
    duration_api_ms: runResult.duration_api_ms,
    turns: runResult.num_turns,
    cost_usd: runResult.total_cost_usd,
    usage: runResult.usage,
    tools: tStats,
    must: { total: must.length, hit: mustHits.length, hits: mustHits, missing: must.filter(m => !mustHits.includes(m)) },
    answer,
    session_id: runResult.session_id
  };

  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
  console.log(`[DONE] ${id}: ${(record.wall_ms / 1000).toFixed(1)}s, ${record.turns} turns, ${record.tools.calls} calls (${arm === 'thinker' ? record.tools.thinkerCalls + ' thinker' : record.tools.qartezCalls + ' qartez'}), cost $${record.cost_usd?.toFixed(4)}, must: ${record.must.hit}/${record.must.total}`);
  return record;
}

async function grade(task, record) {
  const judgeFile = path.join(OUT, `${record.id}.judge.json`);
  if (fs.existsSync(judgeFile)) {
    return JSON.parse(fs.readFileSync(judgeFile, 'utf8'));
  }

  console.log(`[JUDGING] ${record.id}...`);
  const res = await complete({
    model: 'claude-sonnet-5',
    system: 'You grade a coding agent\'s answer about a codebase against a reference answer written by an expert. Score 1.0 if every key fact in the reference is present and nothing in the answer contradicts the reference or the code; 0.5 if the main point is right but important specifics are missing or one detail is wrong; 0 if the answer is wrong, evasive, or contradicts the reference on the main point. List missing key facts and wrong claims. Extra correct detail is fine and not penalized. Do not penalize wording, ordering, or formatting.',
    prompt: `TASK:\n${task.prompt}\n\nREFERENCE ANSWER:\n${task.gold}\n\nAGENT ANSWER:\n${record.answer}`,
    schema: JUDGE_SCHEMA
  });

  const gradeResult = {
    ...res.json,
    cost_usd: res.cost,
    model: res.model
  };
  fs.writeFileSync(judgeFile, JSON.stringify(gradeResult, null, 2) + '\n');
  console.log(`[GRADED] ${record.id}: score=${gradeResult.score}, reason: ${gradeResult.reason.slice(0, 100)}...`);
  return gradeResult;
}

async function main() {
  const protocol = {
    created: new Date().toISOString(),
    thinkerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    qartezVersion: '0.11.0',
    model: 'claude-sonnet-5',
    tasks: IDS,
    repetitions: 1,
    controls: [
      'Identical task prompts and clean git worktrees for Click',
      'Thinker frozen click-systematic noteset; Qartez pre-indexed offline',
      'Both arms executed with claude -p --model sonnet --strict-mcp-config',
      'Disallowed edit tools to ensure fair code comprehension focus',
      'Double-blind LLM judge using expert gold reference answers'
    ]
  };
  fs.writeFileSync(path.join(OUT, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n');

  // Alternating task order: Thinker first on task 1 & 3, Qartez first on task 2
  const order = [
    { task: IDS[0], arm: 'thinker' },
    { task: IDS[0], arm: 'qartez' },
    { task: IDS[1], arm: 'qartez' },
    { task: IDS[1], arm: 'thinker' },
    { task: IDS[2], arm: 'thinker' },
    { task: IDS[2], arm: 'qartez' }
  ];

  const records = [];
  for (const { task: taskId, arm } of order) {
    const task = SPEC.tasks.find(t => t.id === taskId);
    const rec = await runArm(task, arm);
    records.push(rec);
  }

  // Grade all runs
  const grades = {};
  for (const rec of records) {
    const task = SPEC.tasks.find(t => t.id === rec.task);
    grades[rec.id] = await grade(task, rec);
    rec.grade = grades[rec.id];
  }

  // Generate summary
  const summary = {
    protocol,
    runs: records.map(r => ({
      task: r.task,
      arm: r.arm,
      wall_s: (r.wall_ms / 1000).toFixed(1),
      api_s: (r.duration_api_ms / 1000).toFixed(1),
      turns: r.turns,
      calls: r.tools.calls,
      mcp_calls: r.arm === 'thinker' ? r.tools.thinkerCalls : r.tools.qartezCalls,
      reads: r.tools.filesRead,
      greps: r.tools.greps,
      bash: r.tools.bash,
      input_tokens: r.usage.input_tokens,
      cache_read: r.usage.cache_read_input_tokens,
      cache_creation: r.usage.cache_creation_input_tokens,
      output_tokens: r.usage.output_tokens,
      cost_usd: r.cost_usd,
      must_hit: `${r.must.hit}/${r.must.total}`,
      score: r.grade?.score,
      judge_reason: r.grade?.reason
    }))
  };

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('\n================ BENCHMARK COMPLETE ================');
  console.log(JSON.stringify(summary, null, 2));
}

await main();
