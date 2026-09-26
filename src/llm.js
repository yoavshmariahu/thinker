// LLM backend. Uses the Anthropic SDK when ANTHROPIC_API_KEY is set, else
// shells out to `claude -p` (Claude Code's headless mode, which uses the
// user's existing login). Both return a parsed JSON object when a schema is
// given.
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const ALIASES = { haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5', fable: 'claude-fable-5-1' };

export async function complete({ system, prompt, model = 'sonnet', schema, maxTokens = 8000, timeoutMs = 300_000 }) {
  if (process.env.ANTHROPIC_API_KEY && process.env.THINKER_BACKEND !== 'cli') return viaSdk({ system, prompt, model, schema, maxTokens, timeoutMs });
  return viaCli({ system, prompt, model, schema, timeoutMs });
}

async function viaSdk({ system, prompt, model, schema, maxTokens, timeoutMs }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ timeout: timeoutMs });
  const req = { model: ALIASES[model] || model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] };
  if (schema) req.output_config = { format: { type: 'json_schema', schema } };
  const res = await client.messages.create(req);
  if (res.stop_reason === 'refusal') throw new Error('model refused');
  const text = res.content.filter(c => c.type === 'text').map(c => c.text).join('');
  return { text, json: schema ? JSON.parse(text) : null, usage: res.usage, cost: null };
}

async function viaCli({ system, prompt, model, schema, timeoutMs }) {
  // Run in an empty temp cwd so no project CLAUDE.md / MCP servers leak in.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-llm-'));
  const args = ['-p', '--model', ALIASES[model] || model, '--output-format', 'json', '--no-session-persistence',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
  if (system) args.push('--append-system-prompt', system);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  try {
    const stdout = await new Promise((resolve, reject) => {
      const p = spawn('claude', args, { cwd, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } });
      let o = '', e = '';
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('claude -p timed out')); }, timeoutMs);
      p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
      p.on('error', reject);
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(o) : reject(new Error(`claude -p exited ${code}: ${e.slice(0, 500)} ${o.slice(0, 500)}`)); });
      p.stdin.end(prompt);
    });
    const j = JSON.parse(stdout);
    if (j.is_error) throw new Error('claude -p error: ' + (j.result || '').slice(0, 500));
    let json = j.structured_output ?? null;
    if (schema && json == null) { try { json = JSON.parse(j.result); } catch { throw new Error('no structured output: ' + String(j.result).slice(0, 300)); } }
    return { text: j.result, json, usage: j.usage, cost: j.total_cost_usd };
  } finally { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} }
}
