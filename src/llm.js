// LLM backend for distilling, verifying and mining. Providers:
//   anthropic  Anthropic SDK (ANTHROPIC_API_KEY)
//   claude     `claude -p`, Claude Code's headless mode
//   codex      `codex exec`
//   cursor     `agent -p` (Cursor's CLI)
//   gemini     `gemini -p`
//   command    THINKER_LLM_CMD: any shell command that reads the prompt on
//              stdin and prints the answer
// Each uses the login that agent already has. THINKER_LLM picks one; otherwise
// the first that is available, preferring THINKER_LLM_PREFER (set by the hooks
// to the agent that is running). All return a parsed JSON object when a
// schema is given.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { logModelUsage } from './model-usage.js';
const ALIASES = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' };
export const BINS = { claude: ['claude'], gemini: ['agy', 'gemini'], codex: ['codex'], cursor: ['agent', 'cursor-agent'] };
export const FALLBACK_ORDER = ['claude', 'gemini', 'codex', 'cursor'];

export const TIER_MODELS = {
  sonnet: {
    claude: 'sonnet',
    gemini: 'gemini-3.8-flash-high',
    codex: 'gpt-6-luna',
    cursor: 'sonnet',
  },
  haiku: {
    claude: 'haiku',
    gemini: 'gemini-3.8-flash-high',
    codex: 'gpt-6-luna',
    cursor: 'haiku',
  },
  opus: {
    claude: 'opus',
    gemini: 'gemini-3.8-flash-high',
    codex: 'gpt-6-luna',
    cursor: 'opus',
  },
};

export function resolveModel(provider, model) {
  if (process.env.THINKER_LLM_MODEL) return process.env.THINKER_LLM_MODEL;
  const tier = model || 'sonnet';
  if (TIER_MODELS[tier] && TIER_MODELS[tier][provider]) return TIER_MODELS[tier][provider];
  if (model && !['haiku', 'sonnet', 'opus', 'fable'].includes(model)) return model;
  if (provider === 'gemini') return 'gemini-3.8-flash-high';
  if (provider === 'codex') return 'gpt-6-luna';
  return model || 'sonnet';
}

// Hooks run with a short PATH; also look where these tools install themselves.
export function findBin(names) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean);
  for (const n of names) for (const d of dirs) { const f = path.join(d, n); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} }
  return null;
}
export function available() {
  const out = [];
  if (process.env.THINKER_LLM_CMD) out.push('command');
  if (process.env.ANTHROPIC_API_KEY && process.env.THINKER_BACKEND !== 'cli') out.push('anthropic');
  for (const p of ['claude', 'gemini', 'codex', 'cursor']) if (findBin(BINS[p])) out.push(p);
  return out;
}

let activeFallback = null;

export function resetFallback() {
  activeFallback = null;
}

export function getFallbackOrder() {
  const want = process.env.THINKER_LLM;
  if (want) {
    if (want === 'anthropic' || want === 'command' || BINS[want]) return [want];
    throw new Error(`unknown THINKER_LLM: ${want}`);
  }
  const have = available();
  const list = [];
  const prefer = process.env.THINKER_LLM_PREFER;
  if (activeFallback && have.includes(activeFallback)) {
    list.push(activeFallback);
  } else if (prefer && have.includes(prefer) && !have.includes('command') && !have.includes('anthropic')) {
    list.push(prefer);
  }
  for (const p of ['command', 'anthropic', 'claude', 'gemini', 'codex', 'cursor']) {
    if (have.includes(p) && !list.includes(p)) list.push(p);
  }
  return list;
}

export function provider() {
  return getFallbackOrder()[0] || null;
}

async function executeProvider(p, opts) {
  let reported = false;
  const resolved = resolveModel(p === 'anthropic' ? 'claude' : p, opts.model);
  const model = ['claude', 'anthropic'].includes(p) ? ALIASES[resolved] || resolved : resolved;
  let response = { provider: p, model, usage: null, cost: null };
  // Capture counters before parsing the model's JSON, so unusable answers still count.
  const o = { ...opts,
    onUsage: fields => { response = { ...response, ...fields }; reported = true; },
    onRetry: () => {
      if (opts.accounting) logModelUsage(opts.accounting.store, opts.accounting, { ...response, failed: true });
      response = { provider: p, model, usage: null, cost: null }; reported = false;
    },
  };
  try {
    const res = await (p === 'anthropic' ? viaSdk(o) : p === 'claude' ? viaCli(o) : viaOther(p, o));
    if (!reported) response = { ...response, ...res };
    if (opts.accounting) logModelUsage(opts.accounting.store, opts.accounting, response);
    return { ...res, model: response.model };
  } catch (err) {
    if (opts.accounting) logModelUsage(opts.accounting.store, opts.accounting, { ...response, failed: true });
    throw err;
  }
}

export async function complete(opts) {
  const o = { model: 'sonnet', maxTokens: 8000, timeoutMs: 300_000, ...opts };
  const providers = getFallbackOrder();
  if (!providers.length) throw new Error('no model available: install one of the claude, gemini, or codex CLIs, or set ANTHROPIC_API_KEY or THINKER_LLM_CMD');
  if (process.env.THINKER_LLM) return executeProvider(providers[0], o);

  let lastError = null;
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    try {
      const res = await executeProvider(p, o);
      if (i > 0) activeFallback = p;
      return res;
    } catch (err) {
      lastError = err;
      const next = providers[i + 1];
      if (next && !process.env.THINKER_QUIET) {
        process.stderr.write(`[thinker] ${p} failed (${String(err.message || err).slice(0, 100)}), falling back to ${next}...\n`);
      }
    }
  }
  if (!process.env.THINKER_QUIET) {
    process.stderr.write(`[thinker] ❌ All model providers failed (${providers.join(' -> ')}). Last error: ${String(lastError?.message || lastError).slice(0, 160)}\n`);
  }
  throw lastError || new Error(`all model providers failed (${providers.join(' -> ')})`);
}

// Find the JSON object in a model's reply (it may be fenced or have text around it).
export function extractJson(text) {
  const t = String(text || '').trim();
  const tries = [t, (t.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1]];
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const c of tries) { if (!c) continue; try { const j = JSON.parse(c); if (j && typeof j === 'object') return j; } catch {} }
  throw new Error('no JSON in the reply: ' + t.slice(0, 300));
}

function run(bin, args, { input, cwd, timeoutMs, shell = false }) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, shell, env: { ...process.env, THINKER_IN_LLM: '1' } });
    let o = '', e = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${path.basename(bin)} timed out`)); }, timeoutMs);
    p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
    p.on('error', err => { clearTimeout(timer); reject(err); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(o) : reject(new Error(`${path.basename(bin)} exited ${code}: ${e.slice(0, 500)} ${o.slice(0, 500)}`)); });
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}

// Agents other than Claude Code: one prompt in, the final message out.
async function viaOther(p, { system, prompt, schema, timeoutMs, model, onUsage }) {
  const resolvedModel = resolveModel(p, model);
  let full = (system ? system + '\n\n' : '') + prompt;
  if (schema) full += `\n\nReply with one JSON object and nothing else: no prose, no code fence. It must match this JSON Schema:\n${JSON.stringify(schema)}`;
  full += '\n\nEverything you need is in this message. Do not run tools or read files.';
  if (BINS[p] && !findBin(BINS[p])) throw new Error(`the ${BINS[p][0]} CLI was not found (THINKER_LLM=${p})`);
  // Cursor keeps a project folder per working directory: use one fixed directory for it
  const cwd = p === 'cursor' ? path.join(os.tmpdir(), 'thinker-llm') : fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-llm-'));
  fs.mkdirSync(cwd, { recursive: true });
  try {
    let text, usage = null, cost = null;
    if (p === 'command') text = await run(process.env.THINKER_LLM_CMD, [], { input: full, cwd, timeoutMs, shell: true });
    else if (p === 'codex') {
      const args = ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only'];
      if (resolvedModel) args.push('--model', resolvedModel);
      const out = await run(findBin(BINS.codex), [...args, '-'], { input: full, cwd, timeoutMs });
      const evs = out.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      usage = evs.filter(e => e.type === 'turn.completed').map(e => e.usage || null);
      if (!usage.length) usage = null;
      onUsage({ usage, cost });
      const fail = evs.find(e => e.type === 'turn.failed' || e.type === 'error');
      if (fail) throw new Error('codex: ' + JSON.stringify(fail).slice(0, 400));
      text = evs.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text || '').pop() || '';

    } else if (p === 'cursor') {
      const args = ['-p', '--output-format', 'json', '--mode', 'ask', '--trust'];
      if (resolvedModel) args.push('--model', resolvedModel);
      const j = JSON.parse(await run(findBin(BINS.cursor), [...args, full], { cwd, timeoutMs }));
      cost = j.total_cost_usd ?? null;
      onUsage({ usage: j.usage, cost, model: j.model || resolvedModel });
      if (j.is_error) throw new Error('cursor: ' + String(j.result).slice(0, 400));
      text = j.result || ''; usage = j.usage || null;
    } else if (p === 'gemini') {
      const bin = findBin(BINS.gemini);
      const isAgy = path.basename(bin) === 'agy';
      if (isAgy) {
        const args = ['--output-format', 'json', '--model', resolvedModel || 'gemini-3.8-flash-high', '--mode=plan', '-p', full];
        const j = JSON.parse(await run(bin, args, { cwd, timeoutMs }));
        cost = j.total_cost_usd ?? null;
        onUsage({ usage: j.usage, cost, model: j.model || resolvedModel });
        text = j.response || ''; usage = j.usage || null;
      } else {
        const args = ['--output-format', 'json'];
        if (resolvedModel) args.push('-m', resolvedModel);
        const j = JSON.parse(await run(bin, args, { input: full, cwd, timeoutMs }));
        onUsage({ usage: j.stats, cost, model: j.model || resolvedModel });
        if (j.error) throw new Error('gemini: ' + JSON.stringify(j.error).slice(0, 400));
        text = j.response || ''; usage = j.stats || null;
      }
    }
    onUsage({ usage, cost });
    return { text, json: schema ? extractJson(text) : null, usage, cost, provider: p };
  } finally { if (p !== 'cursor') try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

async function viaSdk({ system, prompt, model, schema, maxTokens, timeoutMs, onUsage }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ timeout: timeoutMs });
  const resolved = resolveModel('claude', model);
  const req = { model: ALIASES[resolved] || resolved, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] };
  if (schema) req.output_config = { format: { type: 'json_schema', schema } };
  const res = await client.messages.create(req);
  onUsage({ usage: res.usage, model: res.model });
  if (res.stop_reason === 'refusal') throw new Error('model refused');
  const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('');
  return { text, json: schema ? JSON.parse(text) : null, usage: res.usage, cost: null, provider: 'anthropic' };
}

const LIMIT_RE = /session limit|usage limit|rate limit|limit reached|hit your .*limit/i;

async function viaCli(opts) {
  // usage limits: wait and retry instead of failing the caller, unless other fallbacks exist
  const hasFallback = getFallbackOrder().length > 1;
  const maxAttempts = hasFallback ? 1 : 18;
  for (let attempt = 0; ; attempt++) {
    try { return await viaCliOnce(opts); }
    catch (e) {
      if (!LIMIT_RE.test(String(e.message)) || attempt >= maxAttempts || process.env.THINKER_NO_LIMIT_WAIT === '1') throw e;
      opts.onRetry();
      await new Promise(r => setTimeout(r, 10 * 60_000));
    }
  }
}

async function viaCliOnce({ system, prompt, model, schema, timeoutMs, onUsage }) {
  // Run in an empty temp cwd so no project CLAUDE.md / MCP servers leak in.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-llm-'));
  const resolved = resolveModel('claude', model);
  const args = ['-p', '--model', ALIASES[resolved] || resolved, '--output-format', 'json', '--no-session-persistence',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  if (system) args.push('--append-system-prompt', system);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  try {
    const stdout = await new Promise((resolve, reject) => {
      const p = spawn(findBin(BINS.claude) || 'claude', args, { cwd, env: { ...process.env, THINKER_IN_LLM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
      let o = '', e = '';
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('claude -p timed out')); }, timeoutMs);
      p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
      p.on('error', reject);
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(o) : reject(new Error(`claude -p exited ${code}: ${e.slice(0, 500)} ${o.slice(0, 500)}`)); });
      p.stdin.end(prompt);
    });
    const j = JSON.parse(stdout);
    onUsage({ usage: j.usage, cost: j.total_cost_usd, model: j.model || ALIASES[resolved] || resolved });
    if (j.is_error || (LIMIT_RE.test(String(j.result || '').slice(0, 200)) && (j.num_turns || 0) <= 1)) throw new Error('claude -p error: ' + (j.result || '').slice(0, 500));
    let json = j.structured_output ?? null;
    if (schema && json == null) { try { json = JSON.parse(j.result); } catch { throw new Error('no structured output: ' + String(j.result).slice(0, 300)); } }
    return { text: j.result, json, usage: j.usage, cost: j.total_cost_usd, provider: 'claude' };
  } finally { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} }
}
