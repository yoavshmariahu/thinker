// A small, repository-local paired benchmark for onboarding. It deliberately
// measures a read-only question: one run gets no thinker context and the other
// gets the exact bundle orient() would serve. This is not a correctness judge;
// both answers are saved so the user can check quality before trusting the
// efficiency numbers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBin } from './llm.js';

const BINS = { claude: ['claude'], codex: ['codex'], cursor: ['agent', 'cursor-agent'], gemini: ['agy', 'gemini'] };

export function benchmarkDir(store) { return path.join(store.dir, 'benchmarks'); }

export function benchmarkAgent(requested) {
  if (requested) {
    if (!BINS[requested]) throw new Error(`unknown benchmark agent: ${requested} (known: ${Object.keys(BINS).join(', ')})`);
    if (!findBin(BINS[requested])) throw new Error(`the ${requested} CLI was not found`);
    return requested;
  }
  if (BINS[process.env.THINKER_LLM] && findBin(BINS[process.env.THINKER_LLM])) return process.env.THINKER_LLM;
  return Object.keys(BINS).find(a => findBin(BINS[a])) || null;
}

function exec(bin, args, { cwd, input, timeoutMs = 20 * 60_000, env = {} }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(bin, args, { cwd, env: { ...process.env, THINKER_IN_LLM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ...env } });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', b => stdout += b);
    child.stderr.on('data', b => stderr += b);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${path.basename(bin)} timed out`));
      if (code !== 0) return reject(new Error(`${path.basename(bin)} exited ${code}: ${(stderr || stdout).slice(0, 500)}`));
      resolve({ stdout, stderr, wallMs: Date.now() - started });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

const lines = text => String(text).split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;

function normalizeUsage(u = {}) {
  return {
    inputTokens: n(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokenCount),
    cachedInputTokens: n(u.cache_read_input_tokens ?? u.cached_input_tokens ?? u.cachedInputTokens ?? u.cachedContentTokenCount),
    outputTokens: n(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.candidatesTokenCount),
  };
}

function parseClaude(stdout, wallMs) {
  const j = JSON.parse(stdout);
  if (j.is_error) throw new Error(String(j.result || 'Claude run failed').slice(0, 500));
  return { answer: j.result || '', turns: n(j.num_turns), toolCalls: null, cost: j.total_cost_usd ?? null, ...normalizeUsage(j.usage), wallMs };
}

function parseCodex(stdout, wallMs) {
  const events = lines(stdout);
  const failure = events.find(e => e.type === 'turn.failed' || e.type === 'error');
  if (failure) throw new Error(`Codex run failed: ${JSON.stringify(failure).slice(0, 500)}`);
  const completed = events.filter(e => e.type === 'turn.completed');
  const usage = completed.map(e => e.usage || {}).reduce((a, u) => ({
    input_tokens: a.input_tokens + n(u.input_tokens), cached_input_tokens: a.cached_input_tokens + n(u.cached_input_tokens), output_tokens: a.output_tokens + n(u.output_tokens),
  }), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
  const answer = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text || '').join('\n');
  const toolCalls = events.filter(e => e.type === 'item.started' && e.item && !['agent_message', 'reasoning'].includes(e.item.type)).length;
  return { answer, turns: completed.length, toolCalls, cost: null, ...normalizeUsage(usage), wallMs };
}

function parseCursor(stdout, wallMs) {
  const j = JSON.parse(stdout);
  if (j.is_error) throw new Error(String(j.result || 'Cursor run failed').slice(0, 500));
  return { answer: j.result || '', turns: n(j.num_turns || j.turns) || null, toolCalls: n(j.tool_calls) || null, cost: j.total_cost_usd ?? null, ...normalizeUsage(j.usage), wallMs };
}

function parseGemini(stdout, wallMs) {
  const j = JSON.parse(stdout);
  if (j.error) throw new Error(`Gemini run failed: ${JSON.stringify(j.error).slice(0, 500)}`);
  const usage = j.usage || (j.stats?.models ? Object.values(j.stats.models).reduce((a, m) => {
    const u = m.tokens || m.usage || m;
    a.input_tokens += n(u.input ?? u.input_tokens ?? u.prompt);
    a.output_tokens += n(u.output ?? u.output_tokens ?? u.candidates);
    a.cached_input_tokens += n(u.cached ?? u.cached_input_tokens);
    return a;
  }, { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }) : j.stats || {});
  return { answer: j.response || j.result || '', turns: n(j.stats?.turns) || null, toolCalls: n(j.stats?.toolCalls) || null, cost: null, ...normalizeUsage(usage), wallMs };
}

export async function runBenchmarkAgent(agent, { repo, prompt, model, timeoutMs }) {
  const bin = findBin(BINS[agent]);
  if (!bin) throw new Error(`the ${agent} CLI was not found`);
  let args;
  if (agent === 'claude') {
    args = ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    if (model) args.push('--model', model);
  } else if (agent === 'codex') {
    args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', repo];
    if (model) args.push('--model', model);
    args.push('-');
  } else if (agent === 'cursor') {
    args = ['-p', '--output-format', 'json', '--mode', 'ask', '--trust', '--workspace', repo];
    if (model) args.push('--model', model);
    args.push(prompt);
  } else {
    const agy = path.basename(bin) === 'agy';
    args = agy ? ['--output-format', 'json', '--dangerously-skip-permissions'] : ['--output-format', 'json'];
    if (model) args.push(agy ? '--model' : '-m', model);
    if (agy) args.push('-p', prompt);
  }
  // Installed project hooks must not leak thinker notes into the baseline.
  // Point them at an empty notes directory for both arms; the cache arm gets
  // only the explicit bundle in `prompt`.
  const emptyNotes = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-benchmark-empty-'));
  try {
    const r = await exec(bin, args, { cwd: repo, input: agent === 'cursor' || path.basename(bin) === 'agy' ? '' : prompt, timeoutMs, env: { THINKER_NOTES_DIR: emptyNotes, THINKER_MCP: 'off', THINKER_NO_LEARN: '1', THINKER_LOG: 'off' } });
    if (agent === 'claude') return parseClaude(r.stdout, r.wallMs);
    if (agent === 'codex') return parseCodex(r.stdout, r.wallMs);
    if (agent === 'cursor') return parseCursor(r.stdout, r.wallMs);
    return parseGemini(r.stdout, r.wallMs);
  } finally { fs.rmSync(emptyNotes, { recursive: true, force: true }); }
}

const pct = (before, after) => before ? Math.round(((after - before) / before) * 100) : null;
const metric = (label, base, cache, suffix = '') => {
  if (base == null || cache == null) return null;
  const change = pct(base, cache);
  return `${label.padEnd(14)} ${String(base).padStart(10)}${suffix}  ${String(cache).padStart(10)}${suffix}  ${change > 0 ? '+' : ''}${change}%`;
};

export function renderBenchmarkReport(record) {
  if (!record?.runs?.baseline || !record?.runs?.cache) return 'No complete benchmark run found.';
  const a = record.runs.baseline, b = record.runs.cache;
  const rows = [
    metric('wall time', Math.round(a.wallMs / 1000), Math.round(b.wallMs / 1000), 's'),
    metric('turns', a.turns, b.turns),
    metric('tool calls', a.toolCalls, b.toolCalls),
    metric('input tokens', a.inputTokens, b.inputTokens),
    metric('output tokens', a.outputTokens, b.outputTokens),
  ].filter(Boolean);
  return [
    `Repository benchmark: ${record.task}`,
    `Agent: ${record.agent}${record.model ? ` (${record.model})` : ''}; cached run received ${record.notes.length} note${record.notes.length === 1 ? '' : 's'}.`,
    '',
    'metric           no cache       thinker      change',
    ...rows,
    '',
    'This single pair is indicative, not statistically conclusive, and measures exploration efficiency rather than correctness. Review baseline.md and thinker.md before drawing a conclusion.',
    `Artifacts: ${record.dir}`,
  ].join('\n');
}

export function latestBenchmark(store) {
  const dir = benchmarkDir(store);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse();
  for (const f of files) { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch {} }
  return null;
}

export function saveBenchmark(store, record) {
  const root = benchmarkDir(store);
  fs.mkdirSync(root, { recursive: true });
  const ignore = path.join(store.dir, '.gitignore');
  const ignored = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  if (!ignored.split('\n').includes('benchmarks/')) fs.writeFileSync(ignore, ignored + (ignored && !ignored.endsWith('\n') ? '\n' : '') + 'benchmarks/\n');
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  record.dir = dir;
  fs.writeFileSync(path.join(dir, 'baseline.md'), record.runs.baseline.answer.trim() + '\n');
  fs.writeFileSync(path.join(dir, 'thinker.md'), record.runs.cache.answer.trim() + '\n');
  const file = path.join(root, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'report.txt'), renderBenchmarkReport(record) + '\n');
  return file;
}
