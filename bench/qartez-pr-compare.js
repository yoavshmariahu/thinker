#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { complete } from '../src/llm.js';
import { GRADE_SCHEMA, JUDGE_SYSTEM_PROMPT, srcOnly, computeGradeScores } from './judge-protocol.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'bench/runs/posthog-thinker-vs-qartez-3');
fs.mkdirSync(OUT, { recursive: true });

const TASKS_FILE = path.join(ROOT, '../../bench/tasks/posthog-hard.json');
const SPEC = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
const IDS = ['PR106936-hard', 'PR106672-hard', 'PR106522-hard'];

const QARTEZ_BIN = path.join(ROOT, 'eval-support/qartez-0.11.0-aarch64-apple-darwin/qartez');
const QARTEZ_BASE_DB = '/tmp/qartez-posthog-test.db';
const WT_THINKER = path.join(ROOT, 'bench/worktrees/posthog-eval-thinker');
const WT_QARTEZ = path.join(ROOT, 'bench/worktrees/posthog-eval-qartez');
const NOTES_DIR = path.join(ROOT, '../../bench/notesets/posthog-v2/notes');

const THINKER_GUIDANCE = `This repository has a "thinker" knowledge cache from previous sessions, exposed as MCP tools (mcp__thinker__orient and mcp__thinker__lookup). Call orient/lookup to fetch relevant architectural notes and pointers before exploring or modifying files.`;

const QARTEZ_GUIDANCE = `This repository has a "qartez" code intelligence server exposed as MCP tools (qartez_find, qartez_grep, qartez_read, qartez_outline, qartez_impact, qartez_deps, qartez_refs, qartez_map). Query the Qartez tools to inspect symbol definitions, call hierarchies, and blast radius before modifying files.`;

function transcriptPath(sessionId, cwd) {
  const enc = cwd.replace(/[\/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', enc, sessionId + '.jsonl');
}

function toolStats(file) {
  const stats = { calls: 0, byTool: {}, thinkerCalls: 0, qartezCalls: 0, filesRead: new Set(), edits: 0, greps: 0, bash: 0 };
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
      if (b.name === 'Edit' || b.name === 'Write') stats.edits++;
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

function contextFor(wt, diff) {
  const ranges = new Map(); let file;
  for (const line of srcOnly(diff).split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.+)$/); if (f) file = f[1];
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) { const n = Number(h[1]); const r = ranges.get(file) || []; r.push([Math.max(1, n - 80), n + Number(h[2] ?? 1) + 80]); ranges.set(file, r); }
  }
  let context = '';
  for (const [file, rs] of ranges) {
    const abs = path.join(wt, file); if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, 'utf8'), lines = source.split('\n');
    if (lines.length <= 300) context += `\n--- ${file} (full file after patch) ---\n${source}\n`;
    else {
      const merged = [];
      for (const r of rs.sort((a,b) => a[0]-b[0])) { const last = merged.at(-1); if (last && r[0] <= last[1]+5) last[1] = Math.max(last[1], r[1]); else merged.push([...r]); }
      for (const [a,b] of merged) context += `\n--- ${file} lines ${a}-${Math.min(b, lines.length)} after patch ---\n${lines.slice(a-1,b).join('\n')}\n`;
    }
  }
  return context.slice(0, 80000);
}

function resetArm(arm) {
  const wt = arm === 'thinker' ? WT_THINKER : WT_QARTEZ;
  execFileSync('git', ['reset', '--hard', SPEC.base], { cwd: wt, stdio: 'ignore' });
  execFileSync('git', ['clean', '-fd', '-e', '.thinker', '-e', '.qartez'], { cwd: wt, stdio: 'ignore' });
  if (arm === 'thinker') {
    fs.rmSync(path.join(wt, '.thinker'), { recursive: true, force: true });
    fs.mkdirSync(path.join(wt, '.thinker'), { recursive: true });
    fs.cpSync(NOTES_DIR, path.join(wt, '.thinker/notes'), { recursive: true });
  } else {
    fs.rmSync(path.join(wt, '.thinker'), { recursive: true, force: true });
    fs.mkdirSync(path.join(wt, '.qartez'), { recursive: true });
    try {
      execFileSync('cp', ['-c', QARTEZ_BASE_DB, path.join(wt, '.qartez/index.db')]);
    } catch {
      fs.copyFileSync(QARTEZ_BASE_DB, path.join(wt, '.qartez/index.db'));
    }
  }
}

async function runArm(task, arm) {
  const id = `${task.id}-${arm}-0`;
  const outFile = path.join(OUT, `${id}.json`);
  if (fs.existsSync(outFile)) {
    console.log(`skip ${id} (already completed)`);
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  }

  resetArm(arm);
  const cwd = arm === 'thinker' ? WT_THINKER : WT_QARTEZ;
  const prompt = `${arm === 'thinker' ? THINKER_GUIDANCE : QARTEZ_GUIDANCE}\n\n${task.prompt}`;

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
    '--max-turns', '35'
  ];

  console.log(`[START] ${id} (${arm}) at ${new Date().toISOString()}`);
  const t0 = Date.now();

  const runResult = await new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
      env: { ...process.env, THINKER_TELEMETRY: 'off', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
    });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, 15 * 60_000);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      let j;
      try {
        j = JSON.parse(stdout);
      } catch (err) {
        return reject(new Error(`Failed to parse Claude output (${code}): ${stderr.slice(0, 300)} ${stdout.slice(0, 300)}`));
      }
      resolve({ ...j, wall_ms: Date.now() - t0, stderr, timedOut });
    });
  });

  // Collect git diff of changes
  execFileSync('git', ['add', '-A', '--', '.', ':!.thinker', ':!.qartez', ':!AGENTS.md'], { cwd });
  const diff = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd, encoding: 'utf8' });

  const tPath = transcriptPath(runResult.session_id, cwd);
  const tStats = toolStats(tPath);
  const context = contextFor(cwd, diff);

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
    diff,
    context,
    summary: runResult.result || '',
    session_id: runResult.session_id
  };

  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + '\n');
  console.log(`[DONE] ${id}: ${(record.wall_ms / 1000).toFixed(1)}s, ${record.turns} turns, ${record.tools.calls} calls (${arm === 'thinker' ? record.tools.thinkerCalls + ' thinker' : record.tools.qartezCalls + ' qartez'}), diff: ${diff.length} chars, cost $${record.cost_usd?.toFixed(4)}`);
  return record;
}

async function grade(task, record) {
  const judgeFile = path.join(OUT, `${record.id}.judge.json`);
  if (fs.existsSync(judgeFile)) {
    return JSON.parse(fs.readFileSync(judgeFile, 'utf8'));
  }

  console.log(`[JUDGING] ${record.id}...`);
  const prompt = `REQUEST:\n${task.prompt}\n\nCRITERIA:\n${task.criteria.map(c => `${c.id}${c.essential ? ' (essential)' : ''}: ${c.behavior}`).join('\n')}\n\nPATCH:\n${(srcOnly(record.diff) || '(empty patch)').slice(0, 40000)}\n\nCODE AFTER PATCH:\n${record.context}\n\nAUTHOR SUMMARY:\n${(record.summary || '').slice(0, 3000)}`;

  const res = await complete({
    model: 'claude-sonnet-5',
    system: JUDGE_SYSTEM_PROMPT,
    prompt,
    schema: GRADE_SCHEMA
  });

  const scores = computeGradeScores(task.criteria, res.json?.results || []);
  const gradeResult = {
    ...scores,
    cost_usd: res.cost,
    model: res.model
  };

  fs.writeFileSync(judgeFile, JSON.stringify(gradeResult, null, 2) + '\n');
  console.log(`[GRADED] ${record.id}: essential=${(scores.essential * 100).toFixed(0)}%, all=${(scores.all * 100).toFixed(0)}%, pass=${scores.pass}`);
  return gradeResult;
}

async function main() {
  const protocol = {
    created: new Date().toISOString(),
    thinkerCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    qartezVersion: '0.11.0',
    base: SPEC.base,
    model: 'claude-sonnet-5',
    tasks: IDS,
    controls: [
      'Identical symptom-only task prompts from PostHog hard set',
      'Base clone at pinned commit a3b3c3685bcffcf273f0d27ffb6a669239200e30',
      'Thinker frozen posthog-v2 noteset; Qartez pre-indexed offline graph',
      'Both arms run with claude-sonnet-5 and strict MCP config',
      'Double-blind LLM judge using standardized calibrated acceptance criteria'
    ]
  };
  fs.writeFileSync(path.join(OUT, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n');

  // Alternating task order:
  // PR106936: Thinker then Qartez
  // PR106672: Qartez then Thinker
  // PR106522: Thinker then Qartez
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
  for (const rec of records) {
    const task = SPEC.tasks.find(t => t.id === rec.task);
    rec.grade = await grade(task, rec);
  }

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
      edits: r.tools.edits,
      greps: r.tools.greps,
      bash: r.tools.bash,
      patch_chars: r.diff?.length || 0,
      cost_usd: r.cost_usd,
      essential: r.grade ? (r.grade.essential * 100).toFixed(1) + '%' : 'N/A',
      all: r.grade ? (r.grade.all * 100).toFixed(1) + '%' : 'N/A',
      pass: r.grade?.pass
    }))
  };

  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log('\n================ PR BENCHMARK COMPLETE ================');
  console.log(JSON.stringify(summary, null, 2));
}

await main();
