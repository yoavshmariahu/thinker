#!/usr/bin/env node
// Three matched, isolated PostHog implementation tasks; no gold data enters agent prompts.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installClient, trustCodex } from '../src/clients.js';
import { CACHE_USAGE_GUIDE } from '../src/cache-guidance.js';
import { complete } from '../src/llm.js';
import { GRADE_SCHEMA, JUDGE_SYSTEM_PROMPT, srcOnly, computeGradeScores } from './judge-protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORT = path.join(ROOT, 'bench/worktrees/eval-support');
const OUT = path.join(ROOT, 'bench/runs/posthog-thinker-vs-codegraph-3');
const SPEC = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench/tasks/posthog-hard.json')));
const IDS = ['PR106936-hard', 'PR106672-hard', 'PR106522-hard'];
const MODEL = process.env.EVAL_MODEL || 'gpt-6-sol';
const NOTES = path.join(ROOT, 'bench/notesets/posthog-v2');
const CG = path.join(SUPPORT, 'node_modules/@colbymchenry/codegraph/npm-shim.js');
const cgLib = path.join(SUPPORT, `node_modules/@colbymchenry/codegraph-${process.platform}-${process.arch}/lib/dist`);
const { CODEGRAPH_INSTRUCTIONS_BLOCK } = createRequire(import.meta.url)(path.join(cgLib, 'installer/instructions-template.js'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 128 << 20 });
const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2) + '\n');
const hash = text => createHash('sha256').update(text).digest('hex');
const wtFor = arm => path.join(ROOT, 'bench/worktrees', `posthog-${arm}`);
const homeFor = arm => path.join(SUPPORT, `codex-${arm}`);
const common = `Evaluation workspace: work only in this checkout. Do not inspect parent or sibling directories, other runs, external note stores, or other checkouts. Use the configured repository tool through MCP, not through a shell CLI. Do not access the other repository tool. The task prompt controls whether to run tests.\n\n`;
fs.mkdirSync(path.join(OUT, 'events'), { recursive: true });

function envFor(arm) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('THINKER_') && !k.startsWith('CODEGRAPH_') && !k.startsWith('BENCH_')));
  return { ...env, CODEX_HOME: homeFor(arm), CODEX_DISABLE_PROJECT_DOCS: '0', THINKER_NO_LEARN: '1', THINKER_NO_BG_VERIFY: '1', THINKER_LOG: 'local', THINKER_EARLY: 'full', CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS: '0' };
}

function prepareArm(arm) {
  const wt = wtFor(arm), home = homeFor(arm);
  if (git(wt, 'rev-parse', 'HEAD').trim() !== SPEC.base) throw new Error('wrong base');
  // These two disposable worktrees belong solely to this harness.
  git(wt, 'reset', '--hard', SPEC.base);
  git(wt, 'clean', '-fd', '-e', '.codegraph/');
  fs.rmSync(path.join(wt, '.thinker'), { recursive: true, force: true });
  // Remove upstream MCP/runtime config from the disposable checkout in both arms.
  fs.rmSync(path.join(wt, '.codex'), { recursive: true, force: true });
  fs.mkdirSync(path.join(wt, '.codex'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const auth = path.join(home, 'auth.json');
  if (!fs.existsSync(auth)) fs.symlinkSync(process.env.EVAL_AUTH || path.join(process.env.HOME, '.codex/auth.json'), auth);
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_reasoning_effort = "high"\n');
  const original = fs.readFileSync(path.join(wt, 'AGENTS.md'), 'utf8');
  if (arm === 'thinker') {
    fs.cpSync(NOTES, path.join(wt, '.thinker'), { recursive: true });
    installClient('codex', { repo: wt, cli: path.join(ROOT, 'src/cli.js'), hooks: true, late: true, learn: false, shared: true, mcp: true,
      mcpEntry: { command: process.execPath, args: [path.join(ROOT, 'src/mcp.js')], env: { THINKER_REPO: wt, THINKER_NO_LEARN: '1', THINKER_NO_BG_VERIFY: '1', THINKER_LOG: 'local' } } });
    const config = path.join(wt, '.codex/config.toml');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('[mcp_servers.thinker]\n', '[mcp_servers.thinker]\nenabled_tools = ["orient", "lookup"]\n'));
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), common + CACHE_USAGE_GUIDE + '\n\n' + original);
  } else {
    if (fs.existsSync(path.join(wt, '.thinker'))) throw new Error('Thinker leaked into CodeGraph');
    const config = `[mcp_servers.codegraph]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([CG, 'serve', '--mcp', '--path', wt])}\ndefault_tools_approval_mode = "approve"\nstartup_timeout_sec = 180\ntool_timeout_sec = 180\n[mcp_servers.codegraph.env]\nCODEGRAPH_TELEMETRY = "0"\nCODEGRAPH_NO_DAEMON = "1"\n`;
    fs.writeFileSync(path.join(wt, '.codex/config.toml'), config);
    // Keep the shipped MCP guidance, omitting the CLI alternative in this MCP-only experiment.
    fs.writeFileSync(path.join(wt, 'AGENTS.md'), common + CODEGRAPH_INSTRUCTIONS_BLOCK.replace(/^- \*\*Shell\*\*.*\n/m, '') + '\n\n' + original);
  }
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  trustCodex(wt);
  if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
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

async function run(task, arm) {
  const id = `${task.id}-${arm}-0`, wt = wtFor(arm);
  if (fs.existsSync(path.join(OUT, `${id}.json`))) { console.log(`skip ${id}`); return; }
  // A direct MCP writer can take time to drain after Codex exits. Never replace
  // its database while that process is still alive.
  if (arm === 'codegraph') {
    const lock = path.join(wt, '.codegraph/writer.pid');
    for (let attempt = 0; attempt < 60; attempt++) {
      let pid;
      try { pid = JSON.parse(fs.readFileSync(lock, 'utf8')).pid; } catch { break; }
      try { process.kill(pid, 0); } catch { break; }
      if (attempt === 59) throw new Error(`CodeGraph writer ${pid} has not stopped; refusing to replace its database`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  prepareArm(arm);
  if (arm === 'codegraph') {
    // Restore the graph built from pristine source, avoiding state transfer between tasks.
    fs.rmSync(path.join(wt, '.codegraph'), { recursive: true, force: true });
    fs.cpSync(path.join(SUPPORT, 'codegraph-base'), path.join(wt, '.codegraph'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  }
  console.log(`START ${id} ${new Date().toISOString()}`);
  const args = ['exec', '--json', '--ephemeral', '--ignore-rules', '--model', MODEL, '--sandbox', 'workspace-write', '--cd', wt, '-c', 'model_reasoning_effort="high"', '-c', `mcp_servers.${arm}.required=true`, '-'];
  const start = Date.now(), events = [];
  const stream = fs.createWriteStream(path.join(OUT, 'events', `${id}.jsonl`));
  const errstream = fs.createWriteStream(path.join(OUT, 'events', `${id}.stderr.log`));
  let pending = '', timedOut = false;
  const code = await new Promise((resolve, reject) => {
    const child = spawn('codex', args, { cwd: wt, env: envFor(arm), detached: true });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 25 * 60_000);
    child.stdout.on('data', b => { stream.write(b); pending += b; const lines = pending.split('\n'); pending = lines.pop(); for (const l of lines) { try { events.push(JSON.parse(l)); } catch {} } });
    child.stderr.on('data', b => errstream.write(b));
    child.on('error', reject);
    child.on('close', c => { clearTimeout(timer); try { process.kill(-child.pid, 'SIGTERM'); } catch {} resolve(c); });
    child.stdin.end(task.prompt);
  });
  await Promise.all([new Promise(r => stream.end(r)), new Promise(r => errstream.end(r))]);
  const wall_ms = Date.now()-start;
  const failures = events.filter(e => ['turn.failed', 'error'].includes(e.type));
  const usage = events.filter(e => e.type === 'turn.completed').map(e => e.usage || {});
  const items = events.filter(e => e.type === 'item.completed').map(e => e.item);
  const calls = items.filter(i => i && !['agent_message', 'reasoning'].includes(i.type));
  const byTool = {}; for (const c of calls) { const k = c.type === 'mcp_tool_call' ? `${c.server}.${c.tool}` : c.type; byTool[k] = (byTool[k] || 0)+1; }
  const wrongTool = calls.filter(i => i.type === 'mcp_tool_call' && i.server !== arm && i.server !== 'codex');
  const commands = calls.filter(i => i.type === 'command_execution').map(i => i.command || '');
  const suspect = commands.filter(s => /codegraph|thinker|bench\/runs|gold|git\s+(show|log).*PR/i.test(s));
  git(wt, 'add', '-A', '--', '.', ':!.thinker', ':!.codegraph', ':!.codex', ':!AGENTS.md');
  const diff = git(wt, 'diff', '--cached', '--no-color');
  const result = items.filter(i => i?.type === 'agent_message').map(i => i.text || '').join('\n');
  let thinkerLog = [];
  try { thinkerLog = fs.readFileSync(path.join(wt, '.thinker/log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse); } catch {}
  if (arm === 'thinker') write(`${id}.usage.json`, thinkerLog);
  const record = { id, task: task.id, arm, rep: 0, model: MODEL, effort: 'high', base: SPEC.base, prompt_sha256: hash(task.prompt), wall_ms,
    in_tokens: usage.reduce((s,u)=>s+(u.input_tokens||0),0), cached_tokens: usage.reduce((s,u)=>s+(u.cached_input_tokens||0),0), out_tokens: usage.reduce((s,u)=>s+(u.output_tokens||0),0),
    tools: { calls: calls.length, byTool, mcpCalls: calls.filter(i=>i.type==='mcp_tool_call').length },
    audit: { wrongTool, suspectCommands: suspect, thinkerServings: thinkerLog.filter(l=>l.served?.length).length, thinkerNoteIds: [...new Set(thinkerLog.flatMap(l=>l.served||[]))], exitCode: code, failures, timedOut },
    result, diff, context: contextFor(wt,diff), cost: null,
    ...(code || failures.length || timedOut ? { error: JSON.stringify({code, failures, timedOut}) } : {}) };
  write(`${id}.json`, record);
  console.log(`DONE ${id}: ${calls.length} calls ${(wall_ms/1000).toFixed(0)}s ${record.in_tokens} input / ${record.out_tokens} output tokens, MCP=${record.tools.mcpCalls}, servings=${record.audit.thinkerServings}, patch=${diff.length} chars`);
  const assignedCalls = calls.filter(i => i.type === 'mcp_tool_call' && i.server === arm).length;
  if (record.error || wrongTool.length || !diff.trim() || (arm === 'codegraph' && !assignedCalls) || (arm === 'thinker' && !record.audit.thinkerServings && !assignedCalls)) throw new Error(`Invalid run ${id}; inspect before continuing`);
}

async function grade() {
  process.env.THINKER_LLM = 'gemini';
  for (const taskId of IDS) for (const arm of ['thinker','codegraph']) {
    const name = `${taskId}-${arm}-0.json`, file = path.join(OUT,name);
    if (!fs.existsSync(file)) continue;
    const r = JSON.parse(fs.readFileSync(file)); if ((r.error && !r.audit?.timedOut) || r.grade) continue;
    const task = SPEC.tasks.find(t=>t.id===taskId);
    // Neither treatment label nor author summary is shown to the judge.
    const prompt = `REQUEST:\n${task.prompt}\n\nCRITERIA:\n${task.criteria.map(c=>`${c.id}${c.essential?' (essential)':''}: ${c.behavior}`).join('\n')}\n\nPATCH:\n${(srcOnly(r.diff)||'(empty)').slice(0,40000)}\n\nCODE AFTER PATCH:\n${r.context}`;
    const answer = await complete({model:'gemini-3.8-flash-high', schema:GRADE_SCHEMA, system:JUDGE_SYSTEM_PROMPT, prompt});
    write(`${r.id}.judge-output.json`,answer);
    const results = answer.json?.results;
    if (!Array.isArray(results) || task.criteria.some(c => !results.some(x=>x.id===c.id))) throw new Error('Incomplete judge results');
    r.grade = { ...computeGradeScores(task.criteria,results), judge: 'gemini-3.8-flash-high', cost: answer.cost, usage: answer.usage,
      ...(r.audit?.timedOut ? { partial_patch_at_timeout: true } : {}) };
    write(name,r); console.log(`GRADED ${taskId} ${arm}: essential=${r.grade.essential} all=${r.grade.all} pass=${r.grade.pass}`);
  }
}

const action = process.argv[2] || 'run';
if (action === 'prepare') {
  for (const arm of ['thinker','codegraph']) prepareArm(arm);
  const noteFiles = fs.readdirSync(path.join(NOTES,'notes')).sort();
  write('protocol.json', { created: new Date().toISOString(), thinkerCommit: git(ROOT,'rev-parse','HEAD').trim(), codegraphVersion: '1.6.1', base: SPEC.base, model: MODEL, effort: 'high', tasks: IDS,
    repetitions: 1, concurrency: 1, judge: 'gemini-3.8-flash-high', notes: noteFiles.length, notes_sha256: hash(noteFiles.map(f=>f+'\n'+fs.readFileSync(path.join(NOTES,'notes',f),'utf8')).join('\n')),
    order: IDS.flatMap((task,i)=>(i%2 ? ['codegraph','thinker']:['thinker','codegraph']).map(arm=>({task,arm}))),
    controls: ['same task prompts and source base','isolated Codex homes; only assigned MCP','Thinker prompt+late hooks, orient/lookup, frozen v2 notes','CodeGraph pinned release; pristine prebuilt graph per task; live watcher; direct MCP mode','ulimit -n 65536 for both arms; CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0 waits for initial sync','shipped tool guidance, CodeGraph shell alternative removed','no dependencies or task test suite','blinded grading with same calibrated criteria and post-patch context','indexing and grading excluded from task wall time','no model cost estimate: Codex CLI does not report dollars'] });
} else if (action === 'run') {
  for (let i=0;i<IDS.length;i++) for (const arm of (i%2 ? ['codegraph','thinker']:['thinker','codegraph'])) await run(SPEC.tasks.find(t=>t.id===IDS[i]),arm);
} else if (action === 'grade') await grade();
else throw new Error('usage: codegraph-compare.js prepare|run|grade');
