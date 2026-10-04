#!/usr/bin/env node
// Grok 4.7 through the Cursor agent CLI, on the same PostHog jobs Fable recorded.
// Cache arm uses the installed Cursor setup (rule, approved MCP, hooks). No pasted bundle:
// the guidance in grok-cache.md is put above the notes that `orient` returns.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installClient, uninstallClients } from '../src/clients.js';
import { findSessions } from '../src/transcripts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const POSTHOG = path.join(HERE, 'repos', 'posthog');
const NOTESET = path.join(HERE, 'notesets', 'posthog-v2');
const CLI = path.join(ROOT, 'src', 'cli.js');
const MCP = path.join(ROOT, 'src', 'mcp.js');
const TAG = process.env.TAG || 'posthog-grok-fable';
const OUT = path.join(HERE, 'runs', TAG);
const MODEL = 'grok-4.7-high-fast';
const CONC = Number(process.env.CONC || 3);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map(s => s.trim()).filter(Boolean)) : null;
const TIMEOUT_MS = 30 * 60_000;
const SANDBOX = process.env.SANDBOX || 'enabled';
// Both arms: the agent runs unattended with the user's permissions, so keep it in the worktree.
const SCOPE = '\n\nWork only inside this repository. Do not search, list or read anything outside it (no home directory, no system or package-cache paths).';
const GUIDE = path.join(OUT, 'orient-guide.txt');
fs.mkdirSync(OUT, { recursive: true });

const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks', 'posthog-hard.json'), 'utf8'));
const byId = Object.fromEntries(spec.tasks.map(t => [t.id, t]));
const jobs = fs.readdirSync(path.join(HERE, 'runs', 'posthog-fable'))
  .filter(f => f.endsWith('.json') && f !== 'summary.json')
  .map(f => {
    const m = f.match(/^(.*)-(nocache|hook)-(\d+)\.json$/);
    return { task: byId[m[1]], arm: m[2], rep: Number(m[3]), id: f.slice(0, -5) };
  })
  .filter(j => j.task && (!ONLY || ONLY.has(j.id)));

// the guidance block of grok-cache.md, as a file the MCP server reads
{
  const m = fs.readFileSync(path.join(HERE, 'grok-cache.md'), 'utf8').match(/```\n([\s\S]*?)```/);
  if (!m) throw new Error('grok-cache.md: no guidance block');
  fs.writeFileSync(GUIDE, m[1]);
}

function log(s) { fs.appendFileSync(path.join(OUT, 'progress.log'), s + '\n'); console.log(s); }

function makeWorktree(i) {
  const wt = path.join(HERE, 'worktrees', `posthog-grok-fable-${i}`);
  if (fs.existsSync(wt)) { try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: POSTHOG }); } catch { fs.rmSync(wt, { recursive: true, force: true }); } }
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, 'a3b3c3685bcffcf273f0d27ffb6a669239200e30'], { cwd: POSTHOG });
  return wt;
}
function resetWorktree(wt) {
  try { execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: wt }); execFileSync('git', ['clean', '-qfd'], { cwd: wt }); } catch {}
  // git clean leaves excluded .cursor files, which would leak the cache into a later nocache job.
  try { uninstallClients(wt); } catch {}
  fs.rmSync(path.join(wt, '.thinker'), { recursive: true, force: true });
}

function armCache(wt) {
  // Each job serves its own copy of the noteset: what the agent saves with `remember`, and the
  // use counters, stay in the worktree and go with it. Nothing reaches the historical set.
  const own = path.join(wt, '.thinker');
  fs.cpSync(path.join(NOTESET, 'notes'), path.join(own, 'notes'), { recursive: true });
  const env = { THINKER_REPO: wt, THINKER_NO_BG_VERIFY: '1' };
  installClient('cursor', {
    repo: wt, cli: CLI, hooks: true, learn: false, late: true, shared: false, mcp: true,
    mcpEntry: { command: 'node', args: [MCP], env },
  });
  const file = path.join(wt, '.cursor', 'hooks.json');
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  const pre = 'THINKER_NO_BG_VERIFY=1 ';
  for (const ev of Object.values(h.hooks || {})) for (const entry of ev) if (entry.command && !entry.command.includes('THINKER_EARLY')) entry.command = pre + entry.command;
  fs.writeFileSync(file, JSON.stringify(h, null, 2));
  const r = spawnSyncEnable(wt);
  if (r.status !== 0) log(`mcp enable failed in ${path.basename(wt)}: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
}
function spawnSyncEnable(wt) {
  try {
    execFileSync('agent', ['mcp', 'enable', 'thinker'], { cwd: wt, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout: '', stderr: '' };
  } catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message) }; }
}

function runAgent(prompt, wt, arm) {
  const args = ['-p', '--output-format', 'stream-json', '--model', MODEL, '--force', '--trust', '--sandbox', SANDBOX, '--workspace', wt];
  if (arm === 'hook') args.push('--approve-mcps');
  args.push(prompt);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const p = spawn('agent', args, { cwd: wt, env: { ...process.env, THINKER_IN_LLM: '' } });
    let o = '', e = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); e += '\nTIMEOUT'; }, TIMEOUT_MS);
    p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
    p.on('close', code => { clearTimeout(timer); resolve({ out: o, err: e, code, wall_ms: Date.now() - t0 }); });
    p.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function fromStream(text) {
  let result = '', usage = null, session = null, cost = null;
  let toolUse = 0, toolDone = 0;
  const byTool = {};
  const ids = new Set();
  for (const m of text.matchAll(/\(id: ([\w-]+), confidence/g)) ids.add(m[1]);
  for (const line of text.split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    session = j.session_id || j.sessionId || session;
    if (j.type === 'result') { result = j.result || result; usage = j.usage || usage; cost = j.total_cost_usd ?? usage?.total_cost_usd ?? cost; session = j.session_id || session; }
    if (j.type === 'tool_call' && (j.subtype === 'completed' || j.subtype === 'success')) {
      toolDone++;
      const name = Object.keys(j.tool_call || {})[0] || 'tool';
      byTool[name] = (byTool[name] || 0) + 1;
    }
    const content = j.message?.content;
    if (Array.isArray(content)) for (const b of content) if (b?.type === 'tool_use') { toolUse++; byTool[b.name] = (byTool[b.name] || 0) + 1; }
  }
  const calls = toolUse || toolDone;
  return { result, usage, session, cost, calls, byTool, injected: [...ids] };
}

function transcriptStats(wt, since) {
  const sessions = findSessions(wt, { sinceMs: Date.now() - since + 120_000 }).filter(s => s.client === 'cursor');
  const s = sessions[0];
  if (!s) return null;
  const tools = {}; let calls = 0, turns = 0;
  const ids = new Set();
  for (const line of fs.readFileSync(s.file, 'utf8').split('\n')) {
    for (const m of line.matchAll(/\(id: ([\w-]+), confidence/g)) ids.add(m[1]);
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.role !== 'assistant') continue;
    turns++;
    const content = j.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) if (b?.type === 'tool_use') { calls++; tools[b.name] = (tools[b.name] || 0) + 1; }
  }
  return { session: s.session, file: s.file, calls, byTool: tools, turns, injected: [...ids] };
}

function diffOf(wt) {
  execFileSync('git', ['add', '-A', '--', '.', ':!.thinker', ':!.cursor'], { cwd: wt });
  const diff = execFileSync('git', ['diff', '--cached', '--no-color'], { cwd: wt, maxBuffer: 16 * 1024 * 1024 }).toString();
  execFileSync('git', ['reset', '-q'], { cwd: wt });
  return diff;
}

async function worker(wi) {
  const wt = makeWorktree(wi);
  while (jobs.length) {
    const job = jobs.shift();
    const file = path.join(OUT, job.id + '.json');
    if (fs.existsSync(file)) { log(`skip ${job.id}`); continue; }
    resetWorktree(wt);
    if (job.arm === 'hook') armCache(wt);
    log(`start ${job.id}`);
    const t0 = Date.now();
    let ran;
    try { ran = await runAgent(job.task.prompt + SCOPE, wt, job.arm); }
    catch (e) { log(`${job.id} ERROR ${e.message}`); continue; }
    fs.writeFileSync(path.join(OUT, job.id + '.stream.jsonl'), ran.out);
    const stream = fromStream(ran.out);
    const tx = transcriptStats(wt, t0);
    const calls = tx?.calls || stream.calls;
    let diff = '';
    try { diff = diffOf(wt); } catch (e) { diff = 'DIFF ERROR ' + e.message; }
    const rec = {
      id: job.id, task: job.task.id, area: job.task.area, arm: job.arm, rep: job.rep,
      model: 'grok-4.7', session: tx?.session || stream.session, turns: tx?.turns || null,
      wall_ms: ran.wall_ms, api_ms: null, cost: stream.cost, usage: stream.usage,
      in_tokens: stream.usage?.input_tokens ?? stream.usage?.inputTokens ?? null,
      out_tokens: stream.usage?.output_tokens ?? stream.usage?.outputTokens ?? null,
      tools: { calls, byTool: tx?.calls ? tx.byTool : stream.byTool, injected: tx?.injected?.length ? tx.injected : stream.injected },
      grade: null, result: stream.result, is_error: ran.code !== 0, diff,
      harness: 'cursor-agent', setup: job.arm === 'hook' ? 'cursor-hooks-mcp' : 'nocache', sandbox: SANDBOX,
    };
    fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    log(`${job.id}: calls=${calls} wall=${(ran.wall_ms / 1000).toFixed(0)}s cost=${stream.cost ?? '-'} exit=${ran.code} diff=${diff.length}`);
    resetWorktree(wt);
  }
}

log(`jobs ${jobs.length}: ${jobs.map(j => j.id).join(' ')}`);
await Promise.all(Array.from({ length: CONC }, (_, i) => worker(i)));
log('RUN_DONE');
