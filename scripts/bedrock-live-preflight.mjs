// Paid compatibility preflight, deliberately separate from the default/mock tests.
// THINKER_TEST=1 node scripts/bedrock-live-preflight.mjs --live --token-file PRIVATE_FILE --output DIR [--client-only]
// Fixed Haiku model, three small synthetic requests (64 output tokens each), then one bounded CLI turn.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serviceArgs, serviceState, disableProxyService } from '../src/proxy-service.js';
import { bedrockState, bedrockToken } from '../src/proxy-bedrock.js';
import { cutPlaceholder } from '../src/proxy.js';

const value = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
assert.equal(process.env.THINKER_TEST, '1');
assert.ok(process.argv.includes('--live'), 'Paid test requires --live');
assert.ok(value('--token-file'), '--token-file is required');
const tokenFile = path.resolve(value('--token-file'));
bedrockToken(tokenFile);
const output = path.resolve(value('--output') || fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-bedrock-live-evidence-')));
assert.ok(!fs.existsSync(output) || fs.readdirSync(output).length === 0, '--output must be empty; never mix requests from separate attempts');
fs.mkdirSync(output, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-bedrock-live-'));
const home = path.join(root, 'thinker'), cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const model = 'us.anthropic.claude-haiku-4-5-20251001-v1:0', region = 'us-east-1';
const env = { ...process.env, THINKER_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_HOME: path.join(root, 'codex'), PI_CODING_AGENT_DIR: path.join(root, 'pi'), XDG_CONFIG_HOME: path.join(root, 'config'),
  THINKER_ROUTE_HOME: root, CLAUDE_CODE_USE_BEDROCK: '1', CODEX_SANDBOX_NETWORK_DISABLED: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  THINKER_TELEMETRY: 'off', THINKER_PROXY_LOG: path.join(output, 'proxy.jsonl'), THINKER_PROXY_DUMP: path.join(output, 'dumps'),
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64', MAX_THINKING_TOKENS: '0' };
for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
const savedEnv = { ...process.env };
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
const results = [];
let proxy, client;
const clientOnly = process.argv.includes('--client-only');
const report = { model, region, clientOnly, startedAt: new Date().toISOString(), results, passed: false };
const record = result => { results.push(result); fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(result)); };
async function stopProxy() {
  if (!proxy || proxy.exitCode !== null) return;
  const done = new Promise(resolve => proxy.once('exit', resolve));
  proxy.kill('SIGTERM'); await done; proxy = null;
}
async function start(holdout, refuseNew = false) {
  await stopProxy();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout, trigger: refuseNew ? 1e9 : 1, clearAtLeast: refuseNew ? 1e9 : 1 } }));
  proxy = spawn(process.execPath, [cli, ...serviceArgs(home)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Proxy startup timed out')), 10000);
    proxy.stdout.on('data', c => { if (c.toString().includes('thinker proxy on')) { clearTimeout(timer); resolve(); } });
    proxy.once('error', e => { clearTimeout(timer); reject(e); });
    proxy.once('exit', code => { clearTimeout(timer); reject(Error(`Proxy exited ${code}`)); });
  });
}
const messages = [{ role: 'user', content: 'Read ten records.' }];
for (let i = 0; i < 10; i++) messages.push(
  { role: 'assistant', content: [{ type: 'tool_use', id: `read_${i}`, name: 'Read', input: { file_path: `/fixture/${i}` } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `read_${i}`, content: `Record ${i}: synthetic compatibility fixture.\n`.repeat(100) }] },
);
messages.push({ role: 'assistant', content: 'The records have been read.' }, { role: 'user', content: 'Reply with exactly READY. Do not use tools.' });
const body = { model, max_tokens: 64, stream: true,
  tools: [{ name: 'Read', description: 'Read a record.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }], messages };
assert.ok(Buffer.byteLength(JSON.stringify(body)) < 60000);
async function send(label) {
  const local = bedrockState(home), port = serviceState(home).port;
  const response = await fetch(`http://127.0.0.1:${port}/bedrock/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${local.localToken}`, 'x-claude-code-session-id': 'live-bedrock-preflight' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  const events = text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  const answer = events.filter(e => e.type === 'content_block_delta').map(e => e.delta?.text || '').join('');
  const usage = { ...events.find(e => e.type === 'message_start')?.message?.usage, ...events.find(e => e.type === 'message_delta')?.usage };
  record({ label, status: response.status, requestId: response.headers.get('x-amzn-requestid'), answer, usage, ...(response.ok ? {} : { error: text.slice(0, 2000) }) });
  assert.equal(response.status, 200, text.slice(0, 2000));
  assert.ok(events.some(e => e.type === 'message_stop'), 'completed stream');
  assert.equal(answer.trim(), 'READY');
  const dir = path.join(output, 'dumps', 'live-bedrock-preflight');
  const files = fs.readdirSync(dir).sort();
  return JSON.parse(fs.readFileSync(path.join(dir, files.at(-1))));
}
try {
  execFileSync(process.execPath, [cli, 'proxy', 'on', '--bedrock', '--region', region, '--model', model, '--token-file', tokenFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  if (!clientOnly) {
  await start(1);
  const baseline = await send('unchanged');
  assert.deepEqual(baseline.sent, body);
  await start(0);
  const cut = await send('cut');
  const expected = structuredClone(body);
  for (let i = 0; i < 7; i++) {
    const result = expected.messages[2 + i * 2].content[0];
    result.content = [{ type: 'text', text: cutPlaceholder(result.content.length) }];
  }
  assert.equal(cut.injected, true);
  assert.deepEqual(cut.sent, expected, 'only seven old tool results change');
  await start(0, true);
  const restarted = await send('restart');
  assert.deepEqual(restarted.sent, cut.sent);
  } else await start(0, true);
  const args = ['-p', 'Reply with exactly READY.', '--system-prompt', 'You are a compatibility test assistant. Follow the user request.', '--output-format', 'json', '--max-turns', '1', '--max-budget-usd', '0.25', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user', '--tools', ''];
  let stdout = '', stderr = '';
  client = spawn('claude', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => client.kill('SIGTERM'), 60000);
  client.stdout.on('data', c => { stdout += c; }); client.stderr.on('data', c => { stderr += c; });
  const code = await new Promise((resolve, reject) => { client.once('error', reject); client.once('exit', resolve); }).finally(() => clearTimeout(timer));
  let answer;
  try { answer = JSON.parse(stdout.trim()); } catch { throw Error(`Claude did not return JSON (exit ${code}): ${stderr.slice(-1000)}`); }
  record({ label: 'installed-claude', exitCode: code, result: answer.result, usage: answer.usage, modelUsage: answer.modelUsage, clientReportedCostUSD: answer.total_cost_usd });
  assert.equal(code, 0, answer.result);
  assert.equal(answer.result.trim(), 'READY');
  assert.ok(Object.keys(answer.modelUsage || {}).includes(model));
  report.passed = true;
} finally {
  client?.kill('SIGTERM');
  await stopProxy();
  disableProxyService({ home, manage: false });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, output }));
