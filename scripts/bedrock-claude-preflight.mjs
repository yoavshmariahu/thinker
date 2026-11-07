// Optional installed-client preflight. Fake credentials, local HTTP only, no AWS account.
// THINKER_TEST=1 node scripts/bedrock-claude-preflight.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { disableProxyService, serviceArgs } from '../src/proxy-service.js';
import { bedrockState, commitBedrock } from '../src/proxy-bedrock.js';

assert.equal(process.env.THINKER_TEST, '1');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-bedrock-claude-'));
const home = path.join(root, 'thinker');
const model = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const tokenFile = path.join(root, 'token');
fs.writeFileSync(tokenFile, 'fake-bedrock-api-token', { mode: 0o600 });
// Test settings directories prevent service/config writes from reaching the real machine.
const env = { ...process.env, THINKER_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
  CODEX_HOME: path.join(root, 'codex'), PI_CODING_AGENT_DIR: path.join(root, 'pi'), XDG_CONFIG_HOME: path.join(root, 'config'),
  THINKER_ROUTE_HOME: root, CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  CODEX_SANDBOX_NETWORK_DISABLED: '1', // setup must not launch a detached service; the fixture owns its child
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', THINKER_TELEMETRY: 'off' };
for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
const saved = { ...process.env };
for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
Object.assign(process.env, env);
let proxy, child;
const seen = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  seen.push({ url: req.url, body, auth: req.headers['x-api-key'], authorization: req.headers.authorization });
  if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return; }
  const message = { id: 'msg_mock_bedrock', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'READY' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } };
  if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'READY' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
try {
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  execFileSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'proxy', 'on', '--bedrock', '--region', 'us-east-1', '--model', model, '--token-file', tokenFile],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  const state = bedrockState(home);
  // Only this isolated fixture changes the fixed AWS destination to a loopback mock.
  commitBedrock(home, { ...state, upstream: `http://127.0.0.1:${upstream.address().port}/anthropic` });
  proxy = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), ...serviceArgs(home)], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Proxy did not start')), 10000);
    proxy.stdout.on('data', c => { if (c.toString().includes('thinker proxy on')) { clearTimeout(timer); resolve(); } });
    proxy.once('error', e => { clearTimeout(timer); reject(e); });
    proxy.once('exit', code => { clearTimeout(timer); reject(Error(`Proxy exited: ${code}`)); });
  });
  const args = ['-p', 'Reply READY.', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user', '--tools', ''];
  let stdout = '', stderr = '';
  child = spawn('claude', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0, `Claude failed: ${stderr.slice(-2000)} ${stdout.slice(-2000)}`);
  const answer = JSON.parse(stdout.trim());
  assert.equal(answer.result.trim(), 'READY');
  assert.ok(seen.length > 0, 'the installed Claude client reached the mock through the proxy');
  for (const req of seen) {
    assert.match(req.url, /^\/anthropic\/v1\/messages/);
    assert.equal(req.auth, 'fake-bedrock-api-token');
    assert.equal(req.authorization, undefined);
    assert.equal(req.body.model, model);
  }
  console.log(JSON.stringify({ passed: true, client: 'installed Claude Code', upstream: 'local Bedrock mock', requests: seen.length, model, nativeBedrockEnvOverridden: true, result: answer.result }));
} finally {
  child?.kill('SIGTERM');
  if (proxy && proxy.exitCode === null) {
    const exited = new Promise(resolve => proxy.once('exit', resolve));
    proxy.kill('SIGTERM');
    await exited;
  }
  await close(upstream);
  disableProxyService({ home, manage: false });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(root, { recursive: true, force: true });
}
