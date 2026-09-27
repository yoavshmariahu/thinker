#!/usr/bin/env node
// Benchmark harness: run tasks with/without the thinker cache and record
// turns, tool calls, tokens, wall-clock, cost and graded success.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { complete } from '../src/llm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) { const k = args[i].slice(2); flags[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; }

const repoName = flags.repo || 'click';
const repo = path.join(HERE, 'repos', repoName);
const tasksFile = flags.tasks || path.join(HERE, 'tasks', `${repoName}.json`);
const arms = (flags.arm || 'nocache,cache').split(',');
const model = flags.model || 'sonnet';
const reps = Number(flags.reps) || 1;
const tag = flags.tag || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const only = flags.only ? flags.only.split(',') : null;
const outDir = path.join(HERE, 'runs', tag);
fs.mkdirSync(outDir, { recursive: true });

const CACHE_PROMPT = `This repository has a "thinker" cache of understanding from previous sessions, exposed as MCP tools. Before exploring the codebase, call mcp__thinker__orient with the task. Follow the file:symbol pointers it returns instead of re-deriving them; only grep/read to confirm or to fill gaps. Use mcp__thinker__lookup for specific questions mid-task. Treat notes marked STALE as unverified.`;

function transcriptPath(sessionId, cwd = repo) {
  const enc = cwd.replace(/[\/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', enc, sessionId + '.jsonl');
}

// Each concurrent worker gets its own git worktree so change tasks cannot see
// or clobber each other's edits. Notes stay shared (read from the main repo).
function makeWorktree(i) {
  const wt = path.join(HERE, "worktrees", `${repoName}-${tag}-${i}`);
  if (fs.existsSync(wt)) { try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: repo }); } catch { fs.rmSync(wt, { recursive: true, force: true }); } }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], { cwd: repo });
  return wt;
}
function resetWorktree(wt) {
  try { execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: wt }); execFileSync('git', ['clean', '-qfd'], { cwd: wt }); } catch {}
}

function toolStats(file) {
  const stats = { calls: 0, byTool: {}, thinkerCalls: 0, filesRead: new Set(), greps: 0 };
  if (!fs.existsSync(file)) return { ...stats, filesRead: 0 };
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    for (const b of j.message.content) {
      if (b.type !== 'tool_use') continue;
      stats.calls++; stats.byTool[b.name] = (stats.byTool[b.name] || 0) + 1;
      if (b.name.startsWith('mcp__thinker')) stats.thinkerCalls++;
      if (b.name === 'Read') stats.filesRead.add(b.input?.file_path);
      if (b.name === 'Grep' || b.name === 'Glob') stats.greps++;
      if (b.name === 'Bash' && /\b(grep|rg|find|cat|sed|head|tail|ls)\b/.test(b.input?.command || '')) stats.greps++;
    }
  }
  return { ...stats, filesRead: stats.filesRead.size };
}

const CLI = path.join(HERE, '..', 'src', 'cli.js');
const HOOK_PROMPT = `Context injected as <thinker-cache> comes from a cache of notes about this repository whose code dependencies are verified against the current code when served. Use it to skip re-deriving what it states.`;

// arms: nocache | cache (MCP tools) | hook (UserPromptSubmit injection, no tool call)
//       | irrelevant (hook injection of unrelated notes, forced) | naive (hook, invalidation disabled)
function injectedIds(file) {
  if (!fs.existsSync(file)) return [];
  const txt = fs.readFileSync(file, 'utf8');
  const ids = new Set();
  for (const m of txt.matchAll(/\(id: ([\w-]+), confidence/g)) ids.add(m[1]);
  return [...ids];
}

function runClaude(prompt, { arm, allowEdit, cwd }) {
  const a = ['-p', '--model', model, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--max-turns', String(flags['max-turns'] || 60)];
  if (!allowEdit) a.push('--disallowedTools', 'Edit,Write,NotebookEdit,mcp__thinker__remember,mcp__thinker__feedback');
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const notesDir = path.resolve(flags['notes-dir'] || path.join(repo, '.thinker', 'notes'));
  if (arm === 'cache') { a.push('--mcp-config', JSON.stringify({ mcpServers: { thinker: { command: 'node', args: [path.join(HERE, '..', 'src', 'mcp.js')], env: { THINKER_REPO: cwd, THINKER_NOTES_DIR: notesDir } } } }), '--append-system-prompt', CACHE_PROMPT); }
  else a.push('--mcp-config', '{"mcpServers":{}}');
  // Hook-based arms. early: what the UserPromptSubmit hook injects; late: PostToolUse
  // file-keyed notes; nudge: Stop-hook completeness check.
  const ARMS = {
    hook:       { early: 'full' },
    rerank:     { early: 'full', env: 'THINKER_RERANK=haiku ' },
    naive:      { early: 'full', env: 'THINKER_NAIVE=1 ' },
    live:       { early: 'full' },
    irrelevant: { early: 'full', env: `THINKER_FORCE=1 THINKER_NAIVE=1 THINKER_NO_COCHANGE=1 THINKER_NO_GUARD=1 `, notes: flags['irrelevant-notes'] || path.join(HERE, 'irrelevant-notes') },
    prompt:     { early: 'full', notes: (() => { const e = path.join(HERE, 'runs', 'empty-notes'); fs.mkdirSync(e, { recursive: true }); return e; })() },
    pointers:   { early: 'pointers' },
    late:       { early: 'none', late: true },
    'pointers+late': { early: 'pointers', late: true },
    'late+nudge':    { early: 'none', late: true, nudge: true },
    all:        { early: 'auto', late: true, nudge: true },
    router:     { early: 'router' },
    'router+late': { early: 'router', late: true, nudge: true },
  };
  const cfg = ARMS[arm];
  if (cfg) {
    const nd = cfg.notes || notesDir;
    const hookEnv = `${cfg.env || ''}THINKER_NOTES_DIR=${nd} THINKER_EARLY=${cfg.early} THINKER_NO_BG_VERIFY=1 `;
    const budget = flags.budget ? ` --budget ${Number(flags.budget)}` : '';
    const hooks = { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `${hookEnv}node ${CLI} hook prompt --repo ${cwd}${budget}`, timeout: 60 }] }] };
    if (cfg.late) hooks.PostToolUse = [{ matcher: 'Read|Bash|Grep', hooks: [{ type: 'command', command: `${hookEnv}node ${CLI} hook tool --repo ${cwd}`, timeout: 15 }] }];
    if (cfg.nudge) hooks.Stop = [{ matcher: '', hooks: [{ type: 'command', command: `${hookEnv}node ${CLI} hook stop --nudge --no-distill --repo ${cwd}`, timeout: 20 }] }];
    a.push('--settings', JSON.stringify({ hooks }), '--append-system-prompt', HOOK_PROMPT);
  }
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const p = spawn('claude', a, { cwd, env });
    let o = '', e = '';
    p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
    p.on('close', code => {
      let j; try { j = JSON.parse(o); } catch { return reject(new Error(`bad output (${code}): ${e.slice(0, 300)} ${o.slice(0, 300)}`)); }
      resolve({ ...j, wall_ms: Date.now() - t0 });
    });
    p.stdin.end(prompt);
  });
}

const JUDGE_SCHEMA = { type: 'object', properties: { score: { type: 'number' }, missing: { type: 'array', items: { type: 'string' } }, wrong: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } }, required: ['score', 'missing', 'wrong', 'reason'] };

async function judge(task, answer) {
  const must = (task.must || []);
  const mustHit = must.filter(m => new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(answer));
  const res = await complete({
    model: flags.judge || 'sonnet',
    system: 'You grade a coding agent\'s answer about a codebase against a reference answer written by an expert. Score 1.0 if every key fact in the reference is present and nothing in the answer contradicts the reference or the code; 0.5 if the main point is right but important specifics are missing or one detail is wrong; 0 if the answer is wrong, evasive, or contradicts the reference on the main point. List missing key facts and wrong claims. Extra correct detail is fine and not penalized. Do not penalize wording, ordering, or formatting.',
    prompt: `TASK:\n${task.prompt}\n\nREFERENCE ANSWER:\n${task.gold}\n\nAGENT ANSWER:\n${answer}`,
    schema: JUDGE_SCHEMA,
  });
  return { ...res.json, mustHit: mustHit.length, mustTotal: must.length };
}

function touchedFiles(diff) {
  return [...new Set([...(diff || '').matchAll(/^diff --git a\/(.+?) b\//gm)].map(m => m[1]))];
}

async function judgeChange(task, diff, summary) {
  const gold = fs.readFileSync(path.join(HERE, '..', task.goldDiff), 'utf8');
  const touched = touchedFiles(diff);
  const goldSrc = task.goldFiles || [];
  const hit = goldSrc.filter(f => touched.includes(f));
  const samplesN = Number(flags['judge-samples']) || 3;
  const prompt = `REQUEST:\n${task.prompt}\n\nMERGED UPSTREAM PATCH:\n${gold.slice(0, 30000)}\n\nAGENT PATCH:\n${(diff || '(empty)').slice(0, 30000)}\n\nAGENT SUMMARY:\n${summary.slice(0, 4000)}`;
  const system = 'You grade a coding agent\'s patch against the patch that was actually merged upstream for the same request. Score 1.0 if the agent changed the right place(s) and the change is functionally equivalent to the merged patch (tests/changelog/formatting differences do not matter); 0.5 if the agent found the right location and the change is in the right direction but incomplete or partly wrong; 0 if the agent changed the wrong place, made no functional change, or the change would not achieve the request. Judge behavior, not style. Use only 0, 0.5 or 1.';
  const samples = [], reasons = [];
  await Promise.all(Array.from({ length: samplesN }, async () => { try { const r = await complete({ model: flags.judge || 'sonnet', system, prompt, schema: JUDGE_SCHEMA }); samples.push(Number(r.json.score)); reasons.push(r.json.reason); } catch (e) { reasons.push('ERR ' + e.message); } }));
  if (!samples.length) throw new Error('judge failed: ' + reasons.join(' | '));
  const sorted = [...samples].sort((a, b) => a - b);
  return { score: sorted[Math.floor(sorted.length / 2)], samples, reasons, reason: reasons[0], mustHit: hit.length, mustTotal: goldSrc.length, touched };
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const tasks = spec.tasks.filter(t => !only || only.includes(t.id));
  const summary = [];
  const jobs = [];
  for (let rep = 0; rep < reps; rep++) for (const task of tasks) for (const arm of arms) jobs.push({ task, arm, rep });
  const conc = Number(flags.conc) || 1;
  async function worker(wi) {
    const cwd = makeWorktree(wi);
    while (jobs.length) {
      const { task, arm, rep } = jobs.shift();
      const id = `${task.id}-${arm}-${rep}`;
      const file = path.join(outDir, id + '.json');
      if (fs.existsSync(file) && !flags.force) { summary.push(JSON.parse(fs.readFileSync(file, 'utf8'))); console.log(`skip ${id} (exists)`); continue; }
      let r;
      for (let attempt = 0; ; attempt++) {
        try { r = await runClaude(task.prompt, { arm, allowEdit: task.type === 'change', cwd }); }
        catch (e) { console.log(`${id} ERROR ${e.message}`); r = null; break; }
        // usage/session limit: do not record garbage; wait and retry
        if ((r.num_turns || 0) <= 1 && /session limit|usage limit|rate limit|limit reached/i.test(r.result || '')) {
          if (attempt >= 12) { console.log(`${id} LIMIT: giving up`); r = null; break; }
          console.log(`${id} LIMIT hit (${(r.result || '').slice(0, 60)}); waiting 10 min`); resetWorktree(cwd);
          await new Promise(res => setTimeout(res, 10 * 60_000)); continue;
        }
        break;
      }
      if (!r) continue;
      let distill = null;
      if (arm === 'live') {
        // the cache learns from this session before the next task runs
        try { distill = execFileSync('node', [CLI, 'distill', transcriptPath(r.session_id, cwd), '--repo', cwd], { encoding: 'utf8', env: { ...process.env, THINKER_NOTES_DIR: path.resolve(flags['notes-dir'] || path.join(repo, '.thinker', 'notes')) } }); }
        catch (e) { distill = 'DISTILL ERROR ' + e.message; }
        process.stdout.write(distill.trim().split('\n').map(l => '    ' + l).join('\n') + '\n');
      }
      const tools = toolStats(transcriptPath(r.session_id, cwd));
      tools.injected = injectedIds(transcriptPath(r.session_id, cwd));
      try { const tx = fs.readFileSync(transcriptPath(r.session_id, cwd), 'utf8'); tools.lateEvents = (tx.match(/Cached notes about /g) || []).length; tools.nudged = /Before finishing, check completeness/.test(tx); } catch {}
      let grade = null, diff = null;
      if (task.type === 'change') {
        try { execFileSync('git', ['add', '-A', '--', '.', ':!.thinker'], { cwd }); diff = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd, maxBuffer: 16 * 1024 * 1024 }).toString(); execFileSync('git', ['reset', '-q'], { cwd }); } catch (e) { diff = 'DIFF ERROR ' + e.message; }
        if (!flags['no-judge']) { try { grade = await judgeChange(task, diff, r.result || ''); } catch (e) { grade = { error: e.message }; } }
        if (task.testCmd) {
          // run the task's test command in the worktree with the agent's edits applied
          try { const t = execFileSync('sh', ['-c', task.testCmd], { cwd, encoding: 'utf8', timeout: 600_000, maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'] }); grade = { ...(grade || {}), tests: 'pass', testTail: t.slice(-800) }; }
          catch (e) { grade = { ...(grade || {}), tests: 'fail', testTail: String(e.stdout || '').slice(-800) + String(e.stderr || '').slice(-400) }; }
        }
      } else if (task.gold && !flags['no-judge']) { try { grade = await judge(task, r.result || ''); } catch (e) { grade = { error: e.message }; } }
      const rec = {
        id, task: task.id, area: task.area, arm, rep, model, session: r.session_id,
        turns: r.num_turns, wall_ms: r.wall_ms, api_ms: r.duration_api_ms, cost: r.total_cost_usd,
        in_tokens: (r.usage?.input_tokens || 0) + (r.usage?.cache_creation_input_tokens || 0) + (r.usage?.cache_read_input_tokens || 0),
        out_tokens: r.usage?.output_tokens || 0, tools, grade, result: r.result, is_error: r.is_error, diff, distill,
      };
      fs.writeFileSync(file, JSON.stringify(rec, null, 2));
      summary.push(rec);
      console.log(`${id}: turns=${rec.turns} tools=${tools.calls} (injected ${tools.injected.length}, late ${tools.lateEvents || 0}${tools.nudged ? ', nudged' : ''}) ${(rec.wall_ms / 1000).toFixed(0)}s $${(rec.cost || 0).toFixed(2)} score=${grade?.score ?? '-'} must=${grade ? grade.mustHit + '/' + grade.mustTotal : '-'}${grade?.tests ? ' tests=' + grade.tests : ''}`);
      resetWorktree(cwd);
    }
  }
  await Promise.all(Array.from({ length: conc }, (_, i) => worker(i)));
  report(summary);
}

function report(rows) {
  const byArm = {};
  for (const r of rows) {
    const a = byArm[r.arm] ||= { n: 0, turns: 0, tools: 0, explore: 0, wall: 0, cost: 0, in: 0, out: 0, score: 0, scored: 0, must: 0, mustT: 0 };
    a.n++; a.turns += r.turns || 0; a.tools += r.tools?.calls || 0; a.explore += (r.tools?.calls || 0) - (r.tools?.thinkerCalls || 0); a.wall += r.wall_ms || 0; a.cost += r.cost || 0; a.in += r.in_tokens || 0; a.out += r.out_tokens || 0;
    if (r.grade && typeof r.grade.score === 'number') { a.score += r.grade.score; a.scored++; a.must += r.grade.mustHit; a.mustT += r.grade.mustTotal; }
  }
  console.log('\narm       n  turns  tools  explore  wall_s   cost   in_tok    out_tok  score  must');
  for (const [arm, a] of Object.entries(byArm)) {
    console.log(`${arm.padEnd(8)} ${String(a.n).padStart(2)}  ${(a.turns / a.n).toFixed(1).padStart(5)}  ${(a.tools / a.n).toFixed(1).padStart(5)}  ${(a.explore / a.n).toFixed(1).padStart(7)}  ${(a.wall / a.n / 1000).toFixed(0).padStart(6)}  ${(a.cost / a.n).toFixed(2).padStart(5)}  ${Math.round(a.in / a.n).toString().padStart(7)}  ${Math.round(a.out / a.n).toString().padStart(7)}  ${a.scored ? (a.score / a.scored).toFixed(2) : '-'}   ${a.mustT ? (a.must / a.mustT).toFixed(2) : '-'}`);
  }
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
