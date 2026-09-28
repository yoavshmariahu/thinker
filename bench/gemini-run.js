#!/usr/bin/env node
// Benchmark harness for Gemini 3.8 Flash (via agy CLI).
// Evaluates tasks with and without the thinker cache on calibrated acceptance criteria.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { complete } from '../src/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    flags[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
}

const repoName = flags.repo || 'posthog';
const repo = path.join(HERE, 'repos', repoName);
const tasksFile = flags.tasks || path.join(HERE, 'tasks', `${repoName}-hard.json`);
const arms = (flags.arm || 'nocache,cache').split(',');
const model = flags.model || 'gemini-3.8-flash-high';
const reps = Number(flags.reps) || 1;
const tag = flags.tag || 'posthog-gemini-3.8';
const only = flags.only ? flags.only.split(',') : null;
const outDir = path.join(HERE, 'runs', tag);
fs.mkdirSync(outDir, { recursive: true });

const CLI = path.join(HERE, '..', 'src', 'cli.js');
const notesDir = path.resolve(flags['notes-dir'] || path.join(HERE, 'notesets', `${repoName}-v2`, 'notes'));

function makeWorktree(i) {
  const wt = path.join(HERE, 'worktrees', `${repoName}-${tag}-${i}`);
  if (fs.existsSync(wt)) {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo }); }
    catch { fs.rmSync(wt, { recursive: true, force: true }); }
  }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], { cwd: repo });

  return wt;
}

// The MCP server agy starts reads <worktree>/.thinker/notes. The cache arm gets a copy of the noteset
// (a copy: the agent calls remember, which must not write into the shared noteset); the nocache arm gets none.
function setNotes(wt, arm) {
  const dotThinker = path.join(wt, '.thinker');
  fs.rmSync(dotThinker, { recursive: true, force: true });
  if (arm !== 'cache') return;
  fs.mkdirSync(dotThinker, { recursive: true });
  fs.cpSync(notesDir, path.join(dotThinker, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dotThinker, 'config.json'), JSON.stringify({ version: 1 }, null, 2) + '\n');
}

function resetWorktree(wt) {
  try {
    execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: wt });
    execFileSync('git', ['clean', '-qfd', '-e', '.thinker'], { cwd: wt });
  } catch {}
}

// The merged PR's test files are put over the agent's edits and the task's test command is run.
// `build`: the tests did not compile, which also happens when a correct patch names things differently.
function runTests(task, cwd) {
  try {
    // taken from the stored gold diff: the repository the agent works in holds no commit after the base
    const files = new Set(task.testFiles || []);
    const gold = fs.readFileSync(path.join(HERE, '..', task.goldDiff), 'utf8').split(/^(?=diff --git )/m)
      .filter(c => files.has((c.match(/^diff --git a\/(\S+) /) || [])[1])).join('');
    for (const f of files) {
      try { execFileSync('git', ['checkout', '-q', 'HEAD', '--', f], { cwd, stdio: 'ignore' }); } catch { fs.rmSync(path.join(cwd, f), { force: true }); }
    }
    if (gold) execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd, input: gold, stdio: ['pipe', 'ignore', 'pipe'] });
    const t0 = Date.now();
    let status = 'pass', text = '';
    try { text = execFileSync(task.testCmd[0], task.testCmd.slice(1), { cwd, encoding: 'utf8', timeout: 900000, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { text = String(e.stdout || '') + String(e.stderr || ''); status = /\[build failed\]|\[setup failed\]/.test(text) ? 'build' : e.killed ? 'timeout' : 'fail'; }
    return { status, secs: Math.round((Date.now() - t0) / 1000), tail: text.split('\n').filter(l => /^(ok|FAIL|--- FAIL|#)|\.go:\d+:\d+:/.test(l)).slice(0, 12) };
  } catch (e) { return { status: 'error', error: String(e.message).slice(0, 200) }; }
}

function toolStats(transcriptFile) {
  const stats = { calls: 0, byTool: {}, thinkerCalls: 0, filesRead: 0, edits: 0 };
  if (!fs.existsSync(transcriptFile)) return stats;
  try {
    const lines = fs.readFileSync(transcriptFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    for (const l of lines) {
      if (l.tool_calls) {
        for (const tc of l.tool_calls) {
          stats.calls++;
          stats.byTool[tc.name] = (stats.byTool[tc.name] || 0) + 1;
          const isThinkerMcp = tc.name === 'call_mcp_tool' && (tc.args?.ServerName === 'thinker' || tc.args?.ServerName === '"thinker"');
          if (tc.name.startsWith('mcp__thinker') || tc.name === 'orient' || tc.name === 'lookup' || isThinkerMcp) stats.thinkerCalls++;
          if (tc.name === 'view_file' || tc.name === 'read_file') stats.filesRead++;
          if (tc.name === 'replace_file_content' || tc.name === 'write_to_file') stats.edits++;
        }
      }
    }
  } catch {}
  return stats;
}

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['met', 'not_met', 'unclear'] },
          evidence: { type: 'string' }
        },
        required: ['id', 'verdict', 'evidence']
      }
    }
  },
  required: ['results']
};

const srcOnly = d => (d || '').split(/^(?=diff --git )/m).filter(c => !/^diff --git a\/\S*(test_|\.test\.|\/tests?\/|__tests__|__snapshots__|\.ambr|\.snap)/.test(c)).join('');

async function gradePatch(task, patch, summary = '') {
  const judgeProvider = flags['judge-llm'] || 'claude';
  const judgeModel = flags.judge || 'fable';
  const system = 'You check a patch against acceptance criteria. For each criterion decide whether the code after the patch would exhibit that behaviour: met, not_met, or unclear when what you are shown is not enough to tell. Any design that produces the behaviour counts; do not require a particular file, layer or approach. The author\'s summary is a claim, not evidence. Quote the code that decides each verdict.';
  const prompt = `REQUEST:\n${task.prompt}\n\nCRITERIA:\n${task.criteria.map(c => `${c.id}${c.essential ? ' (essential)' : ''}: ${c.behavior}`).join('\n')}\n\nPATCH:\n${(srcOnly(patch) || '(empty patch)').slice(0, 40000)}\n\nAUTHOR SUMMARY:\n${(summary || '').slice(0, 3000)}`;

  try {
    process.env.THINKER_LLM = judgeProvider;
    const res = await complete({ model: judgeModel, system, prompt, schema: GRADE_SCHEMA });
    const results = res.json?.results || [];
    const by = Object.fromEntries(results.map(x => [x.id, x.verdict]));
    const usable = task.criteria.filter(c => c.calibrated !== false);
    const ess = usable.filter(c => c.essential);
    const frac = cs => cs.length ? cs.filter(c => by[c.id] === 'met').length / cs.length : 1;
    return {
      essential: frac(ess),
      all: frac(usable),
      pass: ess.every(c => by[c.id] === 'met'),
      results
    };
  } catch (err) {
    return { error: err.message, essential: 0, all: 0, pass: false };
  }
}

// A stopped run prints no conversation id: take the conversation started after t0 whose transcript names this worktree.
function lastConversation(t0, cwd) {
  const brain = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
  try {
    for (const id of fs.readdirSync(brain)) {
      const f = path.join(brain, id, '.system_generated', 'logs', 'transcript.jsonl');
      try { if (fs.statSync(path.join(brain, id)).birthtimeMs >= t0 - 5000 && (!cwd || fs.readFileSync(f, 'utf8').includes(cwd))) return id; } catch {}
    }
  } catch {}
  return null;
}

async function runAgy(prompt, { arm, cwd }) {
  let fullPrompt = prompt;
  if (arm === 'cache') {
    // Generate orientation bundle from thinker
    const budget = flags.budget || '750';
    let hookBundle = '';
    try {
      const input = JSON.stringify({ prompt });
      hookBundle = execFileSync('node', [CLI, 'hook', 'prompt', '--repo', cwd, '--budget', budget], {
        encoding: 'utf8',
        input,
        env: { ...process.env, THINKER_NOTES_DIR: notesDir, THINKER_EARLY: 'full' }
      }).trim();
    } catch (e) {
      console.error('hook prompt error:', e.message);
    }

    const guidance = `This repository has a "thinker" knowledge cache from previous sessions, exposed via MCP tools in Antigravity (call_mcp_tool with ServerName="thinker"):
- The most relevant notes for your task have been served above. Additional related notes exist in the cache for this repository.
- Use ToolName="lookup" with Arguments={"query": "<keyword, concept, or note id>"} to fetch additional notes or architectural details as needed.
- Use ToolName="orient" with Arguments={"task": "<task description>"} if you need a broader overview of other areas.
- Use ToolName="remember" to record non-obvious architecture, invariants or rules you discover.
Rely directly on the verified file:symbol pointers above and do not re-explore files merely to confirm them:`;
    fullPrompt = `${hookBundle ? hookBundle + '\n\n' : ''}${guidance}\n\nTASK:\n${prompt}`;
  }

  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const args = [
      '-p', fullPrompt,
      '--model', model,
      '--output-format', 'json',
      '--dangerously-skip-permissions'
    ];
    const p = spawn('agy', args, { cwd, env: { ...process.env, THINKER_LOG: 'local', THINKER_NO_LEARN: '1', ...(arm === 'cache' ? {} : { THINKER_MCP: 'off' }) } });
    let o = '', e = '', timedOut = false;
    // a run that passes the limit is stopped and kept, with its edits so far, as timed_out
    const limit = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, (Number(flags['max-min']) || 20) * 60000);
    p.stdout.on('data', d => o += d);
    p.stderr.on('data', d => e += d);
    p.on('error', err => reject(err));
    p.on('close', code => {
      clearTimeout(limit);
      if (timedOut) return resolve({ timed_out: true, conversation_id: lastConversation(t0, cwd), wall_ms: Date.now() - t0 });
      let j;
      try {
        const start = o.indexOf('{');
        const end = o.lastIndexOf('}');
        if (start >= 0 && end > start) {
          j = JSON.parse(o.slice(start, end + 1));
        } else {
          j = JSON.parse(o);
        }
      } catch {
        return reject(new Error(`bad output (${code}): ${e.slice(0, 300)} ${o.slice(0, 300)}`));
      }
      resolve({ ...j, wall_ms: Date.now() - t0 });
    });
  });
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const tasks = spec.tasks.filter(t => !only || only.includes(t.id));
  const summary = [];
  const jobs = [];

  for (let rep = 0; rep < reps; rep++) {
    for (const task of tasks) {
      for (const arm of arms) {
        jobs.push({ task, arm, rep });
      }
    }
  }

  console.log(`Starting benchmark run on ${repoName} with Gemini 3.8 Flash:`);
  console.log(`Tasks: ${tasks.length} | Arms: ${arms.join(', ')} | Jobs: ${jobs.length} | Tag: ${tag}\n`);

  const conc = Number(flags.conc) || 2;

  async function worker(wi) {
    const cwd = makeWorktree(wi);
    while (jobs.length) {
      const { task, arm, rep } = jobs.shift();
      const id = `${task.id}-${arm}-${rep}`;
      const file = path.join(outDir, `${id}.json`);

      if (fs.existsSync(file) && !flags.force) {
        const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
        summary.push(existing);
        console.log(`[skip] ${id} (already done)`);
        continue;
      }

      console.log(`[start] ${id} (worker ${wi})`);
      let r = null;
      try {
        setNotes(cwd, arm);
        r = await runAgy(task.prompt, { arm, cwd });
      } catch (e) {
        console.log(`[error] ${id}: ${e.message}`);
        resetWorktree(cwd);
        continue;
      }

      const convId = r.conversation_id;
      const transcriptFile = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId || 'none', '.system_generated', 'logs', 'transcript.jsonl');
      const tools = toolStats(transcriptFile);

      // Detect rate limit / quota exhaustion / empty run
      if (!r.timed_out && tools.calls === 0 && (!r.usage?.total_tokens || r.usage?.total_tokens === 0)) {
        console.log(`[rate-limit] ${id}: 0 tools and 0 tokens (quota or API error). Pausing 60s and retrying...`);
        jobs.unshift({ task, arm, rep });
        resetWorktree(cwd);
        await new Promise(res => setTimeout(res, 60000));
        continue;
      }

      // Extract patch
      let diff = '';
      try {
        execFileSync('git', ['add', '-A', '--', '.', ':!.thinker'], { cwd });
        diff = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd, maxBuffer: 16 * 1024 * 1024 }).toString();
        execFileSync('git', ['reset', '-q'], { cwd });
      } catch (e) {
        diff = 'DIFF ERROR: ' + e.message;
      }

      // Run the merged PR's tests against the agent's edits, where the task has them
      const tests = task.testCmd && !flags['no-tests'] ? runTests(task, cwd) : null;

      // Grade patch against calibrated criteria
      let grade = null;
      if (!flags['no-judge']) {
        grade = await gradePatch(task, diff, r.response || '');
      }

      const rec = {
        id,
        task: task.id,
        area: task.area,
        arm,
        rep,
        model,
        session: convId,
        turns: r.num_turns,
        timed_out: !!r.timed_out,
        wall_ms: r.wall_ms,
        wall_sec: (r.wall_ms / 1000).toFixed(1),
        usage: r.usage,
        cost: estimateCost(r.usage),
        tools,
        grade,
        tests,
        diff,
        result: r.response
      };

      fs.writeFileSync(file, JSON.stringify(rec, null, 2));
      summary.push(rec);

      const passStr = grade?.pass ? 'PASS' : 'FAIL';
      const essStr = grade?.essential !== undefined ? (grade.essential * 100).toFixed(0) + '%' : '-';
      console.log(`[done]  ${id}: ${rec.wall_sec}s | tools=${tools.calls} (reads=${tools.filesRead}) | cost=$${rec.cost.toFixed(3)} | ess=${essStr} [${passStr}]`);
      resetWorktree(cwd);
    }
  }

  await Promise.all(Array.from({ length: conc }, (_, i) => worker(i)));
  report(summary);
}

function estimateCost(usage) {
  if (!usage) return 0;
  const inTokens = usage.input_tokens || 0;
  const cacheTokens = usage.cache_read_tokens || 0;
  const outTokens = usage.output_tokens || 0;
  // Gemini Flash pricing: $0.075 / 1M uncached input, $0.01875 / 1M cached input, $0.30 / 1M output
  return (inTokens * 0.075 + cacheTokens * 0.01875 + outTokens * 0.30) / 1e6;
}

function report(rows) {
  const byArm = {};
  for (const r of rows) {
    const a = byArm[r.arm] ||= { n: 0, turns: 0, tools: 0, reads: 0, wall: 0, in_tok: 0, out_tok: 0, cost: 0, ess: 0, pass: 0 };
    a.n++;
    a.turns += r.turns || 0;
    a.tools += r.tools?.calls || 0;
    a.reads += r.tools?.filesRead || 0;
    a.wall += r.wall_ms || 0;
    a.in_tok += (r.usage?.input_tokens || 0) + (r.usage?.cache_read_tokens || 0);
    a.out_tok += r.usage?.output_tokens || 0;
    a.cost += r.cost || estimateCost(r.usage);
    if (r.grade) {
      a.ess += r.grade.essential || 0;
      if (r.grade.pass) a.pass++;
    }
  }

  console.log('\n================================ BENCHMARK SUMMARY ================================');
  console.log('arm       n   turns   tools   reads   wall_s    in_tok   out_tok    $/run   essential   strict_pass');
  console.log('-----------------------------------------------------------------------------------------------');
  for (const [arm, a] of Object.entries(byArm)) {
    const n = a.n || 1;
    console.log(
      `${arm.padEnd(8)} ` +
      `${String(a.n).padStart(2)}   ` +
      `${(a.turns / n).toFixed(1).padStart(5)}   ` +
      `${(a.tools / n).toFixed(1).padStart(5)}   ` +
      `${(a.reads / n).toFixed(1).padStart(5)}   ` +
      `${(a.wall / n / 1000).toFixed(1).padStart(6)}   ` +
      `${Math.round(a.in_tok / n).toString().padStart(7)}   ` +
      `${Math.round(a.out_tok / n).toString().padStart(7)}   ` +
      `$${(a.cost / n).toFixed(3).padStart(5)}   ` +
      `${((a.ess / n) * 100).toFixed(1).padStart(7)}%   ` +
      `${String(a.pass).padStart(2)}/${n} (${Math.round((a.pass / n) * 100)}%)`
    );
  }
  console.log('===============================================================================================\n');
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
