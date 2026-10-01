// Shared pieces of the thinker vs codebase-memory-mcp (CBM) comparisons (cbm-compare.js,
// cbm-pr-compare.js, cbm-preflight.js). Three arms run the same Claude Code prompt in a clean
// worktree with a strict MCP config:
//   thinker  thinker's notes, with git grep behind drilldown and the blast-radius counts
//   cbm      CBM's graph alone, as its own MCP server
//   both     thinker with CBM as its code-graph engine (THINKER_CODEGRAPH=cbm)
// CBM indexes a worktree by its real path, so each worktree is indexed once before its first run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cbmBin, cbmIndex, cbmProject, CBM_VERSION } from '../src/cbm.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARMS = ['thinker', 'cbm', 'both'];

export function cbmBinary() {
  const bin = process.env.THINKER_CBM_BIN || cbmBin() || path.join(ROOT, 'eval-support/cbm/codebase-memory-mcp');
  if (!fs.existsSync(bin)) throw new Error(`codebase-memory-mcp not found (${bin}); thinker cbm install, or THINKER_CBM_BIN`);
  process.env.THINKER_CBM_BIN = bin;
  return bin;
}
export const cbmVersion = () => { try { return execFileSync(cbmBinary(), ['--version'], { encoding: 'utf8' }).trim().split(/\s+/).pop(); } catch { return CBM_VERSION; } };

// The CBM project of a worktree, indexed now when it is not yet (or when `force`).
export function ensureIndexed(wt, { force = false, log = console.log } = {}) {
  cbmBinary();
  const have = cbmProject(wt, { fresh: true });
  if (have && !force) return have;
  log(`[INDEX] codebase-memory-mcp indexing ${wt}…`);
  const t0 = Date.now();
  const r = cbmIndex(wt, { stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.error) throw new Error(`index_repository failed: ${r.error}`);
  log(`[INDEX] ${r.project}: ${r.nodes} nodes, ${r.edges} edges in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return r.project;
}

export const THINKER_GUIDANCE = `This repository has a "thinker" knowledge cache from previous sessions, exposed as MCP tools (mcp__thinker__orient, mcp__thinker__lookup, mcp__thinker__drilldown). Before exploring the codebase, call mcp__thinker__orient with the task to get the relevant notes and file:symbol pointers; use mcp__thinker__drilldown on a pointer for its code, callers and callees. Rely on grep/read only to verify or fill gaps.`;

export const cbmGuidance = project => `This repository is indexed by the "codebase-memory-mcp" code-graph server, exposed as MCP tools (mcp__codebase-memory-mcp__search_graph, get_code_snippet, trace_path, get_file_outline, get_architecture, search_code, detect_changes, query_graph). The project is already indexed under the name "${project}"; pass project="${project}" and do not re-index. Before manually grepping or reading files, use these tools to find symbol definitions, call hierarchies and the blast radius of a change.`;

export const bothGuidance = project => `${THINKER_GUIDANCE} The notes' pointers and the drilldown tool are backed by a code graph of this repository (codebase-memory-mcp, project "${project}"), so caller and callee lists are resolved, not grepped.`;

export function guidanceFor(arm, project) { return arm === 'thinker' ? THINKER_GUIDANCE : arm === 'cbm' ? cbmGuidance(project) : bothGuidance(project); }

export function mcpConfigFor(arm, cwd) {
  const thinker = {
    command: 'node',
    args: [path.join(ROOT, 'src/mcp.js')],
    env: { THINKER_REPO: cwd, THINKER_NOTES_DIR: path.join(cwd, '.thinker/notes'), THINKER_NO_LEARN: '1', THINKER_LOG: 'local', THINKER_TELEMETRY: 'off', THINKER_CODEGRAPH: arm === 'both' ? 'cbm' : 'git', ...(arm === 'both' ? { THINKER_CBM_BIN: cbmBinary() } : {}) },
  };
  const cbm = { command: cbmBinary(), args: [] };
  return { mcpServers: arm === 'thinker' ? { thinker } : arm === 'cbm' ? { 'codebase-memory-mcp': cbm } : { thinker } };
}

export function transcriptPath(sessionId, cwd) {
  const enc = cwd.replace(/[\/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', enc, sessionId + '.jsonl');
}

export function toolStats(file) {
  const stats = { calls: 0, byTool: {}, thinkerCalls: 0, cbmCalls: 0, filesRead: new Set(), edits: 0, greps: 0, bash: 0 };
  if (!fs.existsSync(file)) return { ...stats, filesRead: 0 };
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type !== 'assistant' || !Array.isArray(j.message?.content)) continue;
    for (const b of j.message.content) {
      if (b.type !== 'tool_use') continue;
      stats.calls++;
      stats.byTool[b.name] = (stats.byTool[b.name] || 0) + 1;
      if (b.name.startsWith('mcp__thinker')) stats.thinkerCalls++;
      if (b.name.startsWith('mcp__codebase-memory-mcp')) stats.cbmCalls++;
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
export const mcpCalls = (arm, stats) => arm === 'cbm' ? stats.cbmCalls : stats.thinkerCalls;

// One Claude Code run: `claude -p` with the arm's MCP config, parsed JSON output plus wall time.
export function runClaude({ prompt, cwd, arm, maxTurns = 30, disallowed, timeoutMs = 15 * 60_000 }) {
  const args = ['-p', prompt, '--model', 'sonnet', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfigFor(arm, cwd)), '--max-turns', String(maxTurns)];
  if (disallowed) args.push('--disallowedTools', disallowed);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: { ...process.env, THINKER_TELEMETRY: 'off', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch {} }, timeoutMs);
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer);
      let j; try { j = JSON.parse(stdout); } catch { return reject(new Error(`Failed to parse Claude output (${code}): ${stderr.slice(0, 300)} ${stdout.slice(0, 300)}`)); }
      resolve({ ...j, wall_ms: Date.now() - t0, stderr, timedOut });
    });
  });
}

// A clean worktree per arm under bench/worktrees/<repo>-eval-<arm>, from bench/repos/<repo> at
// `base` (or its HEAD), reused across runs (CBM's index is keyed by the path). Notes for the
// thinker arms are copied in from the noteset.
export function armWorktree(repoName, arm, { base, notes } = {}) {
  const repo = path.join(ROOT, 'bench/repos', repoName);
  if (!fs.existsSync(repo)) throw new Error(`clone the target first: bench/repos/${repoName}`);
  const wt = path.join(ROOT, 'bench/worktrees', `${repoName}-eval-${arm}`);
  if (!fs.existsSync(wt)) {
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-q', '--detach', wt, base || 'HEAD'], { cwd: repo, stdio: 'ignore' });
  }
  resetWorktree(wt, { base, notes: arm === 'cbm' ? null : notes });
  return wt;
}
export function resetWorktree(wt, { base, notes } = {}) {
  execFileSync('git', ['reset', '-q', '--hard', base || 'HEAD'], { cwd: wt, stdio: 'ignore' });
  execFileSync('git', ['clean', '-fdq', '-e', '.thinker'], { cwd: wt, stdio: 'ignore' });
  fs.rmSync(path.join(wt, '.thinker'), { recursive: true, force: true });
  if (notes) { fs.mkdirSync(path.join(wt, '.thinker'), { recursive: true }); fs.cpSync(notes, path.join(wt, '.thinker/notes'), { recursive: true }); }
}

// --arms a,b  --tasks id,id  --reindex ; the arms alternate across tasks so neither always goes first.
export function parseArgs(argv, { defaultArms = ['thinker', 'cbm'] } = {}) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; } }
  const arms = String(flags.arms || defaultArms.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  for (const a of arms) if (!ARMS.includes(a)) throw new Error(`unknown arm ${a}; arms: ${ARMS.join(', ')}`);
  return { arms, tasks: flags.tasks ? String(flags.tasks).split(',') : null, reindex: !!flags.reindex, out: flags.out };
}
export function alternate(taskIds, arms) {
  const order = [];
  taskIds.forEach((task, i) => { const rot = arms.slice(i % arms.length).concat(arms.slice(0, i % arms.length)); for (const arm of rot) order.push({ task, arm }); });
  return order;
}
export const armsNeedingCbm = arms => arms.some(a => a !== 'thinker');
