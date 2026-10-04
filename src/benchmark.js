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
import { orient } from './ops.js';

const BINS = { claude: ['claude'], codex: ['codex'], cursor: ['agent', 'cursor-agent'], gemini: ['agy', 'gemini'] };

export function benchmarkDir(store) { return path.join(store.dir, 'benchmarks'); }

// Turn the cache itself into an onboarding menu when the user's first question
// is not covered. Structural notes make better read-only benchmark questions
// than narrow rules, so prefer them, then confidence and freshness.
export function benchmarkSuggestions(store, limit = 3) {
  const kind = { map: 3, howto: 2, rule: 1, behavior: 0 }; // questions about where things are make the best benchmark tasks
  const seen = new Set();
  return store.list()
    .filter(note => note.status !== 'invalid')
    .sort((a, b) => (kind[b.kind] || 0) - (kind[a.kind] || 0) || (b.status === 'fresh') - (a.status === 'fresh') || (b.confidence || 0) - (a.confidence || 0))
    .map(note => [...(note.answers || []), note.title].map(text => String(text || '').trim()).find(text => text.length >= 12 && text.length <= 180) || '')
    .filter(text => text.length >= 12 && text.length <= 180)
    .filter(text => { const key = text.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, limit);
}

// Suggestions the benchmark would actually run: orient must serve a note for
// each, so a first-time user can pick one without guessing what is covered.
// No reranking here: listing questions must not spend model usage.
export async function coveredBenchmarkQuestions(store, limit = 3) {
  const covered = [];
  for (const question of benchmarkSuggestions(store, limit * 4)) {
    const oriented = await orient(store, { task: question, budget: 1000, recordUsage: false, backgroundVerify: false, rerankModel: null });
    if (oriented.included.length) covered.push(question);
    if (covered.length >= limit) break;
  }
  return covered;
}

export function isAuthError(err) {
  if (!err) return false;
  if (err.isAuth) return true;
  const msg = (err.message || String(err)).toLowerCase();
  return (
    msg.includes('not logged in') ||
    msg.includes('please run /login') ||
    msg.includes('please login') ||
    msg.includes('please sign in') ||
    msg.includes('unauthenticated') ||
    msg.includes('unauthorized') ||
    msg.includes('api_error_status":401') ||
    msg.includes('status": 401') ||
    msg.includes('status 401') ||
    msg.includes('401 unauthorized') ||
    msg.includes('invalid api key') ||
    msg.includes('api_key_invalid') ||
    msg.includes('oauth token has expired') ||
    msg.includes('token expired')
  );
}

export function cleanErrorMessage(err) {
  if (!err) return '';
  const msg = err.message || String(err);
  try {
    const resultMatch = msg.match(/"result"\s*:\s*"([^"]+)"/);
    if (resultMatch) return resultMatch[1];
    const errorMatch = msg.match(/"(?:error|message)"\s*:\s*"([^"]+)"/);
    if (errorMatch) return errorMatch[1];
    const jsonMatch = msg.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.result) return String(parsed.result);
      if (parsed.error?.message) return String(parsed.error.message);
      if (parsed.error) return typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error);
      if (parsed.message) return String(parsed.message);
    }
  } catch {}
  return msg;
}

export function benchmarkAgent(requested) {
  if (requested) {
    if (!BINS[requested]) throw new Error(`unknown benchmark agent: ${requested} (known: ${Object.keys(BINS).join(', ')})`);
    if (!findBin(BINS[requested])) throw new Error(`the ${requested} CLI was not found`);
    return requested;
  }
  if (BINS[process.env.THINKER_LLM] && findBin(BINS[process.env.THINKER_LLM])) return process.env.THINKER_LLM;
  if (BINS[process.env.THINKER_LLM_PREFER] && findBin(BINS[process.env.THINKER_LLM_PREFER])) return process.env.THINKER_LLM_PREFER;
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
      if (code !== 0) {
        const rawOutput = (stderr || stdout).slice(0, 500);
        let errorDetail = rawOutput;
        try {
          const parsed = JSON.parse(stderr || stdout);
          if (parsed.result) errorDetail = String(parsed.result);
          else if (parsed.error?.message) errorDetail = String(parsed.error.message);
          else if (parsed.message) errorDetail = String(parsed.message);
        } catch {}
        const err = new Error(`${path.basename(bin)} exited ${code}: ${errorDetail}`);
        if (isAuthError(err)) err.isAuth = true;
        return reject(err);
      }
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
  if (j.is_error) {
    const err = new Error(String(j.result || 'Claude run failed').slice(0, 500));
    if (isAuthError(err)) err.isAuth = true;
    throw err;
  }
  return { answer: j.result || '', turns: n(j.num_turns), toolCalls: null, cost: j.total_cost_usd ?? null, ...normalizeUsage(j.usage), wallMs };
}

function parseCodex(stdout, wallMs) {
  const events = lines(stdout);
  const failure = events.find(e => e.type === 'turn.failed' || e.type === 'error');
  if (failure) {
    const err = new Error(`Codex run failed: ${JSON.stringify(failure).slice(0, 500)}`);
    if (isAuthError(err)) err.isAuth = true;
    throw err;
  }
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
  if (j.is_error) {
    const err = new Error(String(j.result || 'Cursor run failed').slice(0, 500));
    if (isAuthError(err)) err.isAuth = true;
    throw err;
  }
  return { answer: j.result || '', turns: n(j.num_turns || j.turns) || null, toolCalls: n(j.tool_calls) || null, cost: j.total_cost_usd ?? null, ...normalizeUsage(j.usage), wallMs };
}

function parseGemini(stdout, wallMs) {
  const j = JSON.parse(stdout);
  if (j.error) {
    const err = new Error(`Gemini run failed: ${JSON.stringify(j.error).slice(0, 500)}`);
    if (isAuthError(err)) err.isAuth = true;
    throw err;
  }
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
    args = ['-p', '--output-format', 'json', '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
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
    args = agy ? ['--output-format', 'json', '--mode=plan'] : ['--output-format', 'json', '--approval-mode=plan'];
    if (model) args.push(agy ? '--model' : '-m', model);
    if (agy) args.push('-p', prompt);
  }
  // Installed project hooks must not leak thinker notes into the baseline.
  // Point them at an empty notes directory for both arms; the cache arm gets
  // only the explicit bundle in `prompt`.
  const emptyNotes = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-benchmark-empty-'));
  try {
    const r = await exec(bin, args, { cwd: repo, input: agent === 'cursor' || path.basename(bin) === 'agy' ? '' : prompt, timeoutMs, env: { ...process.env, THINKER_NOTES_DIR: emptyNotes, THINKER_MCP: 'off', THINKER_NO_LEARN: '1', THINKER_LOG: 'off', IS_SANDBOX: '1' } });
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
    a.targetFilesFound != null && b.targetFilesFound != null
      ? metric('target files', `${a.targetFilesFound}/${a.targetFilesTotal}`, `${b.targetFilesFound}/${b.targetFilesTotal}`)
      : null,
  ].filter(Boolean);
  const prLine = record.pr?.number
    ? `Pull Request: #${record.pr.number}: ${record.pr.title}`
    : (record.pr?.title ? `Recent Change: ${record.pr.title}` : '');
  return [
    `Repository benchmark: ${record.task}`,
    prLine,
    `Agent: ${record.agent}${record.model ? ` (${record.model})` : ''}; cached run received ${record.notes.length} note${record.notes.length === 1 ? '' : 's'}.`,
    '',
    'metric           no cache       thinker      change',
    ...rows,
    '',
    'This single pair is indicative, not statistically conclusive, and measures exploration efficiency rather than correctness. Review baseline.md and thinker.md before drawing a conclusion.',
    `Artifacts: ${record.dir}`,
  ].filter(Boolean).join('\n');
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
