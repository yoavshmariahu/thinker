// Optional real Claude Code lifecycle check against a loopback Messages API gateway.
// No provider credentials or personal settings are used. The e2e container enables it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { complete, resetFallback } from '../src/llm.js';
import { distillEvents } from '../src/distill.js';
import { Store } from '../src/store.js';
import { createNote, refresh, verifyNote, phraseNotes } from '../src/ops.js';
import { enableProxyService, serviceState } from '../src/proxy-service.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const NOTE = { title: 'Gateway fixture multiplication', kind: 'rule', answers: ['multiplication input'], body: 'math.js:multiply multiplies its two numeric inputs.', deps: [{ path: 'math.js', symbol: 'multiply' }], tags: ['math'], confidence: 0.9, says: ['What happens when I multiply two input numbers?'], search: 'Multiplication of two numeric inputs is implemented by math.js:multiply.' };

test('real Claude gateway preserves settings through connect, calls, proxy opt-in, refusal, off and uninstall', { skip: process.env.THINKER_CLAUDE_GATEWAY_SMOKE !== '1', timeout: 180000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-claude-gateway-'));
  const repo = path.join(dir, 'repo'), cfg = path.join(dir, '.claude'), home = path.join(dir, 'thinker');
  fs.mkdirSync(repo); fs.mkdirSync(cfg); fs.mkdirSync(home);
  let phase = 'plain', rejectEdit = false, fixtureError, token = 'gateway-fixture-token';
  const seen = [], proxyPids = new Set();
  const answer = () => phase === 'distill' ? { notes: [NOTE] } : phase === 'verify' ? { verdict: 'still_valid', reason: 'Multiplication still multiplies two inputs.' } : phase === 'phrase' ? { notes: [{ n: 1, says: NOTE.says, search: NOTE.search }] } : 'READY';
  const gateway = http.createServer((req, res) => {
    let text = ''; req.on('data', c => text += c); req.on('end', () => {
      try {
        if (req.url.includes('count_tokens')) return res.end('{"input_tokens":100}');
        if (!req.url.includes('/v1/messages')) { res.writeHead(404); return res.end('{}'); }
        const body = JSON.parse(text); seen.push({ body, headers: req.headers, phase, url: req.url });
        assert.equal(req.headers.authorization, `Bearer ${token}`);
        assert.equal(req.headers['x-fixture-route'], 'retained');
        if (rejectEdit && body.context_management?.edits?.some(e => e.type === 'clear_tool_uses_20250919')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'context_management is unsupported' } }));
        }
        const value = answer(), tool = (body.tools || []).find(x => x.name === 'StructuredOutput');
        const toolDone = body.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === 'tool_result' && String(c.tool_use_id).startsWith('structured_fixture')));
        const content = tool && typeof value !== 'string' && !toolDone
          ? [{ type: 'tool_use', id: `structured_fixture_${seen.length}`, name: tool.name, input: value }]
          : [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
        const message = { id: `msg_fixture_${seen.length}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
        if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(message)); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        emit({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
        const c = content[0];
        emit({ type: 'content_block_start', index: 0, content_block: c.type === 'tool_use' ? { ...c, input: {} } : { type: 'text', text: '' } });
        emit({ type: 'content_block_delta', index: 0, delta: c.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } : { type: 'text_delta', text: c.text } });
        emit({ type: 'content_block_stop', index: 0 });
        emit({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
        emit({ type: 'message_stop' }); res.end();
      } catch (e) { fixtureError = e; res.writeHead(500); res.end('{}'); }
    });
  });
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  const upstream = `http://127.0.0.1:${gateway.address().port}`;
  const env = { HOME: dir, CLAUDE_CONFIG_DIR: cfg, THINKER_HOME: home, THINKER_ROUTE_HOME: dir, CODEX_HOME: path.join(dir, 'codex'), PI_CODING_AGENT_DIR: path.join(dir, 'pi'), XDG_CONFIG_HOME: path.join(dir, '.config'), THINKER_TEST: '1', THINKER_TELEMETRY: 'off', THINKER_CE: 'off', THINKER_HOOKS: 'on', THINKER_LLM: 'claude', THINKER_QUIET: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  const old = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|THINKER_LLM|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy)/.test(k)) delete process.env[k];
  Object.assign(process.env, env); resetFallback();
  const run = (bin, args, input = '') => new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: repo, env: process.env });
    let out = '', err = ''; const timer = setTimeout(() => p.kill('SIGKILL'), 30000);
    p.stdout.on('data', c => out += c); p.stderr.on('data', c => err += c); p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); if (fixtureError) reject(fixtureError); else if (code !== 0) reject(new Error(`${bin} ${args.slice(0, 3).join(' ')}: ${code}: ${err}\n${out}`)); else resolve(out); }); p.stdin.end(input);
  });
  const cli = async (...args) => {
    const result = await run(process.execPath, [CLI, ...args]);
    const pid = serviceState(home).pid; if (pid) proxyPids.add(pid);
    return result;
  };
  t.after(async () => {
    await cli('proxy', 'off').catch(() => {});
    // Test mode does not manage service processes; terminate only our recorded children.
    for (const pid of proxyPids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    gateway.closeAllConnections(); gateway.close();
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old); resetFallback();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const settings = path.join(cfg, 'settings.json');
  const customHook = { matcher: '', hooks: [{ type: 'command', command: 'true' }] };
  const original = { env: { ANTHROPIC_BASE_URL: upstream, ANTHROPIC_AUTH_TOKEN: 'gateway-fixture-token', ANTHROPIC_CUSTOM_HEADERS: 'X-Fixture-Route: retained', ANTHROPIC_DEFAULT_SONNET_MODEL: 'fixture-sonnet', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fixture-haiku', PERSONAL_SETTING: 'keep' }, permissions: { allow: ['Read'], deny: ['Bash(rm *)'] }, hooks: { Stop: [customHook] }, model: 'sonnet' };
  fs.writeFileSync(settings, JSON.stringify(original, null, 4) + '\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { holdout: 0 } }));
  const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
  const preserved = route => {
    const s = read(); assert.equal(s.env.ANTHROPIC_BASE_URL, route);
    for (const [key, value] of Object.entries(original.env)) if (key !== 'ANTHROPIC_BASE_URL') assert.equal(s.env[key], value, key);
    assert.deepEqual(s.permissions, original.permissions); assert.equal(s.model, original.model);
    assert.ok(s.hooks.Stop.some(h => JSON.stringify(h) === JSON.stringify(customHook)), 'unrelated Stop hook retained');
  };
  await run('git', ['init', '-q']);
  fs.writeFileSync(path.join(repo, 'math.js'), 'export function multiply(a, b) { return a * b; }\n');
  const store = new Store(repo).init();
  await cli('connect', '--clients', 'claude', '--yes'); preserved(upstream);
  // Test mode skips automatic service setup. Exercise that same API explicitly
  // with service-manager writes disabled, keeping test mode and telemetry isolation.
  await enableProxyService({ cli: CLI, home, manage: false }); preserved(upstream);
  const connected = fs.readFileSync(settings, 'utf8');
  await cli('connect', '--clients', 'claude', '--yes'); assert.equal(fs.readFileSync(settings, 'utf8'), connected, 'repeat connect does not rewrite settings');
  const plain = await run('claude', ['-p', '--model', 'sonnet', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], 'Reply READY.');
  assert.equal(JSON.parse(plain).result, 'READY'); preserved(upstream);
  await cli('proxy', 'on', '--gateway');
  const through = read().env.ANTHROPIC_BASE_URL; assert.notEqual(through, upstream); preserved(through);
  assert.match(await cli('proxy', 'status'), /listening/);
  const call = () => complete({ prompt: 'Reply READY.', model: 'sonnet', timeoutMs: 20000, accounting: { store, purpose: 'gateway-smoke' } });
  assert.equal((await call()).text, 'READY');
  assert.ok(seen.some(r => r.body.model === 'fixture-sonnet' && r.body.context_management?.edits?.length), 'gateway mapping and proxy clearing edit reached the host');
  phase = 'distill';
  const distilled = await distillEvents([{ t: 'prompt', text: 'Explain multiplication.' }, { t: 'tool', name: 'Read', input: { file_path: 'math.js' }, result: fs.readFileSync(path.join(repo, 'math.js'), 'utf8') }], { accounting: { store, purpose: 'distill' } });
  assert.equal(distilled.notes[0]?.title, NOTE.title);
  const { note } = createNote(store, distilled.notes[0], { source: { type: 'human' } });
  assert.ok(note, 'the distilled note resolves to the fixture code');
  phase = 'phrase';
  assert.deepEqual((await phraseNotes(store, [note])).done, [note.id]);
  // Change the actual symbol to exercise pending verification, not merely a file-level comment.
  fs.writeFileSync(path.join(repo, 'math.js'), 'export function multiply(a, b) { return Number(a) * Number(b); }\n');
  refresh(store); assert.equal(store.get(note.id).status, 'pending');
  phase = 'verify';
  await verifyNote(store, store.get(note.id)); assert.equal(store.get(note.id).status, 'fresh');
  assert.ok(seen.some(r => r.phase === 'verify' && r.body.model === 'fixture-haiku'));
  phase = 'plain'; rejectEdit = true;
  const beforeRefusal = seen.length;
  assert.equal((await call()).text, 'READY');
  assert.ok(seen.slice(beforeRefusal).some(r => r.body.context_management?.edits?.length), 'fixture refused an injected edit');
  assert.ok(seen.slice(beforeRefusal).some(r => !r.body.context_management?.edits?.some(e => e.type === 'clear_tool_uses_20250919')), 'retry reached the gateway without the edit');
  preserved(through);
  await cli('proxy', 'off'); preserved(upstream);
  assert.equal((await call()).text, 'READY');
  // Project overrides must survive thinker's empty working directory for model calls.
  const projectSettings = path.join(repo, '.claude/settings.local.json');
  fs.mkdirSync(path.dirname(projectSettings), { recursive: true });
  token = 'project-fixture-token';
  fs.writeFileSync(projectSettings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: `${upstream}/project`, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_DEFAULT_SONNET_MODEL: 'project-sonnet' } }));
  assert.equal((await call()).text, 'READY');
  assert.equal(seen.at(-1).body.model, 'project-sonnet');
  assert.ok(seen.at(-1).url.startsWith('/project/v1/messages'));
  preserved(upstream); fs.rmSync(projectSettings); token = 'gateway-fixture-token';

  // A manual route restoration is an opt-out; connect must not put the proxy back.
  rejectEdit = false;
  await cli('proxy', 'on', '--gateway');
  assert.notEqual(read().env.ANTHROPIC_BASE_URL, upstream);
  const manuallyRestored = read(); manuallyRestored.env.ANTHROPIC_BASE_URL = upstream;
  fs.writeFileSync(settings, JSON.stringify(manuallyRestored, null, 2) + '\n');
  await cli('connect', '--clients', 'claude', '--yes'); preserved(upstream);
  await enableProxyService({ cli: CLI, home, manage: false }); preserved(upstream);
  assert.match(await cli('proxy', 'status'), /Context proxy off/);
  assert.equal((await call()).text, 'READY');
  await cli('uninstall', '--user', '--yes');
  assert.deepEqual(read(), original, 'uninstall restores the user settings semantically, including the gateway');
  t.diagnostic(`Claude ${String(await run('claude', ['--version'])).trim()}; ${seen.length} authenticated gateway requests; all settings preservation checks passed`);
});
