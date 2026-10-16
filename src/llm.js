// LLM backend for distilling, verifying and mining. Providers:
//   anthropic  Anthropic SDK (ANTHROPIC_API_KEY)
//   claude     `claude -p`, Claude Code's headless mode
//   codex      `codex exec`
//   cursor     `agent -p` (Cursor's CLI)
//   gemini     `gemini -p`
//   openai     THINKER_LLM_BASE_URL: any OpenAI-compatible /chat/completions
//              endpoint (a corporate gateway, a local server); the token comes
//              from the variable THINKER_LLM_API_KEY_ENV names, else
//              THINKER_LLM_API_KEY, else OPENAI_API_KEY; THINKER_LLM_MODEL or
//              the repository's distillModel/verifyModel name the model
//   command    THINKER_LLM_CMD: any shell command that reads the prompt on
//              stdin and prints the answer; THINKER_TIER, THINKER_MODEL and
//              THINKER_SCHEMA in its environment say what was asked for
// Each agent uses the login it already has. THINKER_LLM picks one; otherwise
// the first that is available, preferring THINKER_LLM_PREFER (set by the hooks
// to the agent that is running). All return a parsed JSON object when a
// schema is given.

// The model distillation and mining fall back to when neither the call nor the repository's config names
// one; the warm-up page shows the same default (test/cli-ui-sync.test.js).
export const DEFAULT_DISTILL_MODEL = 'sonnet';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { logModelUsage, normalizeModelUsage } from './model-usage.js';
import { viaSession } from './session-llm.js';
const ALIASES = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };
export const BINS = { claude: ['claude'], gemini: ['agy', 'gemini'], codex: ['codex'], cursor: ['agent', 'cursor-agent'] };
export const FALLBACK_ORDER = ['claude', 'gemini', 'codex', 'cursor'];
export const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];

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
  if (model && !TIERS.includes(model)) return model;
  if (provider === 'gemini') return 'gemini-3.8-flash-high';
  if (provider === 'codex') return 'gpt-6-luna';
  return model || 'sonnet';
}

// The login side of the user's Claude Code settings: of the env block, the entries that say where
// the model is and how to authenticate (a gateway's ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN, the
// Bedrock, Vertex and Foundry switches and their cloud credentials, proxies and certificates), with
// apiKeyHelper and the AWS credential helpers. A call runs with --setting-sources '' so that hooks,
// permissions, plugins and skills stay out of it; without this the login configured there was out
// too, and every call failed to authenticate. Claude Code reads --settings on top of the sources, so
// the login goes back in that way. Telemetry exporters, model aliases and the per-call limits
// thinker sets itself are not login and stay out.
const LOGIN_ENV = /^(ANTHROPIC_(BASE_URL|AUTH_TOKEN|API_KEY|CUSTOM_HEADERS|BEDROCK_|VERTEX_|FOUNDRY_)|CLAUDE_CODE_(USE_|SKIP_|CLIENT_)|AWS_|GOOGLE_|GCLOUD_|CLOUD_ML_REGION$|AZURE_|HTTPS?_PROXY$|NO_PROXY$|NODE_EXTRA_CA_CERTS$|SSL_CERT_|NODE_TLS_)/;
export function claudeLoginSettings(dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')) {
  let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return null; }
  const out = {};
  if (s.env && typeof s.env === 'object') {
    const env = Object.fromEntries(Object.entries(s.env).filter(([k]) => LOGIN_ENV.test(k)));
    if (Object.keys(env).length) out.env = env;
  }
  for (const k of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport']) if (s[k] !== undefined) out[k] = s[k];
  return Object.keys(out).length ? out : null;
}

// Hooks run with a short PATH; also look where these tools install themselves. The Codex desktop app
// ships its CLI inside ChatGPT.app, off PATH, signed in with the app (they share ~/.codex).
export function findBin(names) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
    ...(process.platform === 'darwin' ? ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin'] : [])].filter(Boolean);
  for (const n of names) for (const d of dirs) { const f = path.join(d, n); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch {} }
  return null;
}
export function available() {
  const out = [];
  if (process.env.THINKER_LLM_CMD) out.push('command');
  if (process.env.THINKER_LLM_BASE_URL) out.push('openai');
  if (process.env.ANTHROPIC_API_KEY && process.env.THINKER_BACKEND !== 'cli') out.push('anthropic');
  for (const p of ['claude', 'gemini', 'codex', 'cursor']) if (findBin(BINS[p])) out.push(p);
  return out;
}

let activeFallback = null;

export function resetFallback() {
  activeFallback = null;
}

// The provider a model id belongs to, when the id names one; null for a tier name or anything else.
export function providerOfModel(model) {
  const m = String(model || '');
  if (/^(gpt-|o\d|codex)/i.test(m)) return 'codex';
  if (/^gemini-/i.test(m)) return 'gemini';
  if (/^claude-/i.test(m)) return 'claude';
  return null;
}

export function getFallbackOrder() {
  const want = process.env.THINKER_LLM;
  if (want) {
    // session: the person's agent session answers (session-llm.js); only ever pinned, never detected
    if (want === 'anthropic' || want === 'command' || want === 'openai' || want === 'session' || BINS[want]) return [want];
    throw new Error(`unknown THINKER_LLM: ${want}`);
  }
  const have = available();
  const list = [];
  const prefer = process.env.THINKER_LLM_PREFER;
  if (activeFallback && have.includes(activeFallback)) {
    list.push(activeFallback);
  } else if (prefer && have.includes(prefer) && !have.includes('command') && !have.includes('openai') && !have.includes('anthropic')) {
    list.push(prefer);
  }
  for (const p of ['command', 'openai', 'anthropic', 'claude', 'gemini', 'codex', 'cursor']) {
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
  // the session's own model answers a session call, whichever it is: no tier picks it
  const model = p === 'session' ? 'session' : ['claude', 'anthropic'].includes(p) ? ALIASES[resolved] || resolved : resolved;
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
    const res = await (p === 'anthropic' ? viaSdk(o) : p === 'openai' ? viaOpenai(o) : p === 'claude' ? viaCli(o) : p === 'session' ? viaSession(o) : viaOther(p, o));
    if (!reported) response = { ...response, ...res };
    if (opts.accounting) logModelUsage(opts.accounting.store, opts.accounting, response);
    // every answer carries its normalized counters, so a caller can say what the run used in tokens
    return { ...res, model: response.model, tokens: normalizeModelUsage(p, response.usage) };
  } catch (err) {
    if (opts.accounting) logModelUsage(opts.accounting.store, opts.accounting, { ...response, failed: true });
    throw err;
  }
}

export async function complete(opts) {
  const o = { model: 'sonnet', maxTokens: 8000, timeoutMs: 300_000, ...opts };
  // a model id that names its provider is answered by that provider or not at all: falling back hands
  // the id to a CLI that does not have it, or answers with another model under its name (a benchmark
  // judge named gpt-6-luna was mostly graded through the Claude CLI, 2026-10-16). Tier names (sonnet,
  // haiku, …) keep the fallback order.
  const pinned = process.env.THINKER_LLM ? null : providerOfModel(o.model);
  const serves = p => p === pinned || p === 'command' || (pinned === 'claude' && p === 'anthropic') || (pinned === 'codex' && p === 'openai');
  const providers = pinned ? getFallbackOrder().filter(serves) : getFallbackOrder();
  if (pinned && !providers.length) throw new Error(`model ${o.model} is answered by ${pinned}, which is not available here`);
  if (!providers.length) throw new Error('no model available: install one of the claude, gemini, or codex CLIs, or set ANTHROPIC_API_KEY, THINKER_LLM_BASE_URL (an OpenAI-compatible endpoint) or THINKER_LLM_CMD');
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

// Find the JSON object in a model's reply (fenced, chatty, raw control characters, trailing commas, or truncated).
export function extractJson(text, schema) {
  const t = String(text || '').trim();
  if (!t) throw new Error('no JSON in the reply: (empty string)');

  function postProcess(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj) && schema?.properties) {
      const keys = Object.keys(schema.properties);
      if (keys.length === 1 && schema.properties[keys[0]]?.type === 'array') {
        return { [keys[0]]: obj };
      }
      if (schema.properties.notes?.type === 'array') {
        return { notes: obj };
      }
    }
    return obj;
  }

  // 1. Direct try and standard fence/slice extraction
  const tries = [
    t,
    (t.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1],
  ];

  const firstBrace = t.indexOf('{');
  const lastBrace = t.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    tries.push(t.slice(firstBrace, lastBrace + 1));
  }
  const firstBracket = t.indexOf('[');
  const lastBracket = t.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket && (firstBrace === -1 || firstBracket < firstBrace)) {
    tries.push(t.slice(firstBracket, lastBracket + 1));
  }

  for (const c of tries) {
    if (!c) continue;
    try {
      const j = JSON.parse(c);
      if (j && typeof j === 'object') return postProcess(j);
    } catch {}
  }

  // 2. Lenient repair functions for LLM formatting quirks
  function escapeControlsInStrings(s) {
    let inString = false;
    let escaped = false;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) { escaped = false; out += ch; }
        else if (ch === '\\') { escaped = true; out += ch; }
        else if (ch === '"') { inString = false; out += ch; }
        else if (ch === '\n') { out += '\\n'; }
        else if (ch === '\r') { out += '\\r'; }
        else if (ch === '\t') { out += '\\t'; }
        else {
          const code = ch.charCodeAt(0);
          if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
          else out += ch;
        }
      } else {
        if (ch === '"') inString = true;
        out += ch;
      }
    }
    return out;
  }

  function stripComments(s) {
    let inString = false;
    let escaped = false;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        out += ch;
      } else {
        if (ch === '"') {
          inString = true;
          out += ch;
        } else if (ch === '/' && s[i + 1] === '/') {
          i += 2;
          while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
          if (i < s.length) out += s[i];
        } else if (ch === '/' && s[i + 1] === '*') {
          i += 2;
          while (i < s.length - 1 && !(s[i] === '*' && s[i + 1] === '/')) i++;
          i++;
        } else {
          out += ch;
        }
      }
    }
    return out;
  }

  function stripTrailingCommas(s) {
    let inString = false;
    let escaped = false;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        out += ch;
      } else {
        if (ch === '"') { inString = true; out += ch; }
        else if (ch === ',') {
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j++;
          if (j < s.length && (s[j] === '}' || s[j] === ']')) continue;
          out += ch;
        } else {
          out += ch;
        }
      }
    }
    return out;
  }

  function normalizeLiterals(s) {
    let inString = false;
    let escaped = false;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        out += ch;
      } else {
        if (ch === '"') {
          inString = true;
          out += ch;
        } else if (s.slice(i, i + 4) === 'True' && !/[a-zA-Z0-9_$]/.test(s[i - 1] || '') && !/[a-zA-Z0-9_$]/.test(s[i + 4] || '')) {
          out += 'true'; i += 3;
        } else if (s.slice(i, i + 5) === 'False' && !/[a-zA-Z0-9_$]/.test(s[i - 1] || '') && !/[a-zA-Z0-9_$]/.test(s[i + 5] || '')) {
          out += 'false'; i += 4;
        } else if (s.slice(i, i + 4) === 'None' && !/[a-zA-Z0-9_$]/.test(s[i - 1] || '') && !/[a-zA-Z0-9_$]/.test(s[i + 4] || '')) {
          out += 'null'; i += 3;
        } else {
          out += ch;
        }
      }
    }
    return out;
  }

  function convertSingleQuotes(s) {
    let inDouble = false;
    let inSingle = false;
    let escaped = false;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inDouble) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inDouble = false;
        out += ch;
      } else if (inSingle) {
        if (escaped) { escaped = false; out += ch; }
        else if (ch === '\\') { escaped = true; out += ch; }
        else if (ch === "'") { inSingle = false; out += '"'; }
        else if (ch === '"') { out += '\\"'; }
        else { out += ch; }
      } else {
        if (ch === '"') { inDouble = true; out += ch; }
        else if (ch === "'") { inSingle = true; out += '"'; }
        else { out += ch; }
      }
    }
    return out;
  }

  function quoteKeys(s) {
    let inString = false;
    let escaped = false;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        out += ch;
      } else {
        if (ch === '"') {
          inString = true;
          out += ch;
        } else if (ch === '{' || ch === ',') {
          out += ch;
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) { out += s[j]; j++; }
          if (j < s.length && /[a-zA-Z0-9_$]/.test(s[j])) {
            let k = j;
            while (k < s.length && /[a-zA-Z0-9_$]/.test(s[k])) k++;
            let m = k;
            while (m < s.length && /\s/.test(s[m])) m++;
            if (m < s.length && s[m] === ':') {
              const key = s.slice(j, k);
              out += '"' + key + '"' + s.slice(k, m + 1);
              i = m;
            }
          }
        } else {
          out += ch;
        }
      }
    }
    return out;
  }

  function tryParse(s) {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === 'object') return postProcess(j);
    } catch {}
    return null;
  }

  const startIdx = firstBrace !== -1 && (firstBracket === -1 || firstBrace <= firstBracket) ? firstBrace : firstBracket;
  const rawCandidate = startIdx !== -1 ? t.slice(startIdx) : t;

  let cleaned = stripComments(rawCandidate);
  cleaned = escapeControlsInStrings(cleaned);
  cleaned = stripTrailingCommas(cleaned);
  let res = tryParse(cleaned);
  if (res) return res;

  cleaned = normalizeLiterals(cleaned);
  res = tryParse(cleaned);
  if (res) return res;

  let withQuotedKeys = quoteKeys(cleaned);
  withQuotedKeys = stripTrailingCommas(withQuotedKeys);
  res = tryParse(withQuotedKeys);
  if (res) return res;

  let withDoubleQuotes = convertSingleQuotes(cleaned);
  withDoubleQuotes = stripTrailingCommas(withDoubleQuotes);
  res = tryParse(withDoubleQuotes);
  if (res) return res;

  res = tryParse(quoteKeys(withDoubleQuotes));
  if (res) return res;

  // 3. Truncated JSON recovery
  function tryClose(text) {
    let inString = false;
    let escaped = false;
    const stack = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else {
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
        else if (ch === '}' || ch === ']') {
          if (stack.length && stack[stack.length - 1] === ch) stack.pop();
        }
      }
    }
    let r = text;
    if (inString) r += '"';
    r = stripTrailingCommas(r);
    while (stack.length) r += stack.pop();
    return tryParse(r);
  }

  function tryRecoverCutoff(text) {
    let lastObj = text.lastIndexOf('}');
    while (lastObj > (startIdx !== -1 ? 0 : -1)) {
      const sub = text.slice(0, lastObj + 1);
      const repaired = tryClose(sub);
      if (repaired) return repaired;
      lastObj = text.lastIndexOf('}', lastObj - 1);
    }
    return null;
  }

  const trunc1 = tryClose(cleaned);
  if (trunc1) return trunc1;

  const trunc2 = tryRecoverCutoff(cleaned);
  if (trunc2) return trunc2;

  throw new Error('no JSON in the reply: ' + t.slice(0, 300));
}

function run(bin, args, { input, cwd, timeoutMs, shell = false, env = {} }) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, shell, env: { ...process.env, THINKER_IN_LLM: '1', ...env } });
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
    if (p === 'command') {
      // The command gets the prompt on stdin, and in its environment what the call asked for: the
      // tier (a cheap verification or a costly distillation), the model name resolved for it, and the
      // schema on its own, so a shim can use its backend's structured output instead of parsing the prompt.
      const env = { THINKER_MODEL: resolvedModel };
      if (TIERS.includes(model)) env.THINKER_TIER = model;
      if (schema) env.THINKER_SCHEMA = JSON.stringify(schema);
      text = await run(process.env.THINKER_LLM_CMD, [], { input: full, cwd, timeoutMs, shell: true, env });
    }
    else if (p === 'codex') {
      // The user's config.toml stays loaded: it holds model_providers (a gateway's base URL and key
      // variable), without which codex has no model at all. What the call must not inherit is
      // switched off by name: MCP servers, plugins, hooks and project instructions.
      const args = ['exec', '--json', '--ephemeral', '-c', 'mcp_servers={}', '-c', 'plugins={}', '-c', 'features.hooks=false', '-c', 'project_doc_max_bytes=0', '--ignore-rules', '--skip-git-repo-check', '--sandbox', 'read-only'];
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
        const args = ['--output-format', 'json', '--model', resolvedModel || 'gemini-3.8-flash-high', '--mode=plan', '--disable-slash-commands', '-p', full];
        const j = JSON.parse(await run(bin, args, { cwd, timeoutMs }));
        cost = j.total_cost_usd ?? null;
        onUsage({ usage: j.usage, cost, model: j.model || resolvedModel });
        text = j.response || ''; usage = j.usage || null;
      } else {
        // no extensions and no MCP servers in a call; the login (settings, GEMINI_API_KEY, a base URL) stays
        const args = ['--output-format', 'json', '-e', 'none', '--allowed-mcp-server-names', 'none'];
        if (resolvedModel) args.push('-m', resolvedModel);
        const j = JSON.parse(await run(bin, args, { input: full, cwd, timeoutMs }));
        onUsage({ usage: j.stats, cost, model: j.model || resolvedModel });
        if (j.error) throw new Error('gemini: ' + JSON.stringify(j.error).slice(0, 400));
        text = j.response || ''; usage = j.stats || null;
      }
    }
    onUsage({ usage, cost });
    return { text, json: schema ? extractJson(text, schema) : null, usage, cost, provider: p };
  } finally { if (p !== 'cursor') try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} }
}

// An OpenAI-compatible endpoint, reached directly: one POST to /chat/completions. The schema goes
// in the prompt rather than response_format, which gateways support unevenly; the reply is parsed
// as the CLI replies are. The model must be named: a gateway has no tier names of its own.
export function openaiModel(model) {
  const resolved = resolveModel('openai', model);
  if (TIERS.includes(resolved)) {
    throw new Error(`THINKER_LLM_BASE_URL is set but no model is named for it: set THINKER_LLM_MODEL, or distillModel and verifyModel in .thinker/config.json (got the tier "${resolved}")`);
  }
  return resolved;
}
export function openaiKey() {
  const named = process.env.THINKER_LLM_API_KEY_ENV;
  if (named) {
    if (!process.env[named]) throw new Error(`THINKER_LLM_API_KEY_ENV names ${named}, which is not set`);
    return process.env[named];
  }
  return process.env.THINKER_LLM_API_KEY || process.env.OPENAI_API_KEY || null;
}
async function viaOpenai({ system, prompt, model, schema, maxTokens, timeoutMs, onUsage }) {
  const base = process.env.THINKER_LLM_BASE_URL.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const key = openaiKey();
  const resolved = openaiModel(model);
  let user = prompt;
  if (schema) user += `\n\nReply with one JSON object and nothing else: no prose, no code fence. It must match this JSON Schema:\n${JSON.stringify(schema)}`;
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }];
  const body = JSON.stringify({ model: resolved, messages, max_tokens: maxTokens, stream: false });
  const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res, text;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
    text = await res.text();
  } catch (err) {
    throw new Error(`openai: ${err.name === 'AbortError' ? `no answer from ${url} in ${Math.round(timeoutMs / 1000)}s` : `${url}: ${err.cause?.message || err.message}`}`);
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`openai: ${url} answered ${res.status}${res.status === 401 || res.status === 403 ? ' (check the token: THINKER_LLM_API_KEY_ENV, THINKER_LLM_API_KEY or OPENAI_API_KEY)' : ''}: ${text.slice(0, 300)}`);
  let j; try { j = JSON.parse(text); } catch { throw new Error(`openai: ${url} did not answer JSON: ${text.slice(0, 300)}`); }
  const usage = j.usage || null;
  onUsage({ usage, cost: null, model: j.model || resolved });
  if (j.error) throw new Error('openai: ' + JSON.stringify(j.error).slice(0, 400));
  const choice = j.choices?.[0];
  if (choice?.message?.refusal) throw new Error('model refused');
  const c = choice?.message?.content;
  const reply = Array.isArray(c) ? c.map(x => x.text || '').join('') : (c || '');
  return { text: reply, json: schema ? extractJson(reply, schema) : null, usage, cost: null, provider: 'openai' };
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
      // the model tried to call a tool although none is offered (seen with long code prompts): try again at once, twice
      if (/"stop_reason":"tool_use"/.test(String(e.message)) && attempt < 2) { opts.onRetry(); continue; }
      // A selected harness stays selected. Retry short-lived process/API failures twice before
      // handing the failure to the caller (or to the existing provider fallback, when unpinned).
      if (e.retryable && attempt < 2) {
        opts.onRetry();
        await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      if (!LIMIT_RE.test(String(e.message)) || attempt >= maxAttempts || process.env.THINKER_NO_LIMIT_WAIT === '1') throw e;
      opts.onRetry();
      await new Promise(r => setTimeout(r, 10 * 60_000));
    }
  }
}

const CLI_SYSTEM = 'Answer the request directly. No tools are available.';

// The CLI counts thinking against CLAUDE_CODE_MAX_OUTPUT_TOKENS, and no switch turns thinking off any
// more: on claude 2.1.296 with Haiku 5.5, MAX_THINKING_TOKENS=0, CLAUDE_CODE_DISABLE_THINKING=1,
// CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1 and CLAUDE_CODE_EFFORT_LEVEL=low each left 6,600-9,300 thinking
// tokens on an eight-note phrasing call whose answer is under 3,000. A caller's maxTokens is the room its
// answer needs, so the cap handed to the CLI adds this much for thinking. A cap is a ceiling, not spend;
// a cap that thinking exhausts is the expensive case: the CLI retries the request up to four times,
// burning the whole cap in thinking each time, then exits 1 with nothing saved (a third of the week's
// phrasing and design-document calls on this machine, ~/.thinker/log.jsonl, 2026-10-13).
export const THINKING_HEADROOM = 16_000;
export const cliOutputCap = maxTokens => (maxTokens || 0) + THINKING_HEADROOM;

// claude -p exits 1 with nothing on stderr when the answer (its thinking included) reaches the output
// cap. Current versions say so in api_error and result (stop_reason stays "stop_sequence", iterations
// is empty); older ones only carried the counters. '' when that is not it. `cap` is the cap the CLI
// enforced (cliOutputCap), the number the message names.
export function overCap(stdout, cap) {
  try {
    const j = JSON.parse(stdout);
    const last = (j.usage?.iterations || []).at(-1);
    const hit = j.stop_reason === 'max_tokens' || j.api_error === 'max_output_tokens'
      || /exceeded the \d+ output token maximum/.test(String(j.result || ''))
      || (cap && last?.output_tokens >= cap);
    return hit ? `the answer ran past the ${cap}-token output cap (ask for less in one call)` : '';
  } catch { return ''; }
}

function claudeFailure(stdout, stderr, code, cap) {
  let j; try { j = JSON.parse(stdout); } catch {}
  const over = overCap(stdout, cap);
  const detail = [j?.result, ...(Array.isArray(j?.errors) ? j.errors : []), j?.error?.message || j?.error]
    .filter(v => typeof v === 'string' && v.trim()).join('; ');
  // Put the reason before metadata: setup only has room for the first 120 characters.
  const reason = over || detail || stderr.trim() || j?.subtype || stdout.trim() || 'no error details';
  const error = new Error(`claude -p exited ${code}: ${reason.slice(0, 500)}`);
  if (over) error.code = 'MODEL_OUTPUT_LIMIT';
  error.retryable = !over && !LIMIT_RE.test(reason) && (
    j?.stop_reason === 'tool_use'
    || /overloaded|temporarily unavailable|internal server error|\b50[234]\b|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(reason)
    || (!detail && !stderr.trim() && (!j?.subtype || j.subtype === 'error_during_execution'))
  );
  return error;
}

async function viaCliOnce({ system, prompt, model, schema, maxTokens, thinkingTokens, structuredRetries, timeoutMs, cache = true, onUsage }) {
  // Run in an empty temp cwd so no project CLAUDE.md / MCP servers leak in.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-llm-'));
  const resolved = resolveModel('claude', model);
  const args = ['-p', '--model', ALIASES[resolved] || resolved, '--output-format', 'json', '--no-session-persistence',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    // Replace Claude Code's own system prompt rather than append to it: appended, every call sent ~7k
    // tokens of agent instructions, written to the one-hour prompt cache (twice the input price) and
    // never read again. No settings or skills either: neither is used, both add to the prompt.
    '--system-prompt', system || CLI_SYSTEM, '--setting-sources', '', '--disable-slash-commands'];
  const login = claudeLoginSettings();
  if (login) args.push('--settings', JSON.stringify(login));
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  try {
    const { stdout, stderr, code } = await new Promise((resolve, reject) => {
      const p = spawn(findBin(BINS.claude) || 'claude', args, { cwd, env: { ...process.env, THINKER_IN_LLM: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(cliOutputCap(maxTokens)), ...(thinkingTokens === undefined ? {} : { MAX_THINKING_TOKENS: String(thinkingTokens) }), ...(structuredRetries === undefined ? {} : { MAX_STRUCTURED_OUTPUT_RETRIES: String(structuredRetries) }), ...(cache ? {} : { DISABLE_PROMPT_CACHING: '1' }) } });
      let o = '', e = '';
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(Object.assign(new Error('claude -p timed out'), { retryable: true })); }, timeoutMs);
      p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
      p.on('error', err => { clearTimeout(timer); reject(err); });
      p.on('close', code => { clearTimeout(timer); resolve({ stdout: o, stderr: e, code }); });
      p.stdin.end(prompt);
    });
    let j;
    try { j = JSON.parse(stdout); }
    catch (e) { if (code !== 0) throw claudeFailure(stdout, stderr, code, cliOutputCap(maxTokens)); throw e; }
    onUsage({ usage: j.usage, cost: j.total_cost_usd, model: j.model || ALIASES[resolved] || resolved });
    if (code !== 0 || j.is_error || (LIMIT_RE.test(String(j.result || '').slice(0, 200)) && (j.num_turns || 0) <= 1)) throw claudeFailure(stdout, stderr, code, cliOutputCap(maxTokens));
    let json = j.structured_output ?? null;
    if (schema && json == null) { try { json = JSON.parse(j.result); } catch { throw new Error('no structured output: ' + String(j.result).slice(0, 300)); } }
    return { text: j.result, json, usage: j.usage, cost: j.total_cost_usd, provider: 'claude' };
  } finally { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} }
}
