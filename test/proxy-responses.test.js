import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proxyConfig, startProxy, transformRequest, proxyReport } from '../src/proxy.js';
import { CLEARED_OUTPUT, responsesUsageTap } from '../src/proxy-responses.js';

const cfg = extra => proxyConfig({ protocol: 'responses', upstream: 'http://127.0.0.1:1/v1', trigger: '1', 'clear-at-least': '1', 'keep-min': '1', ...extra }, {});
const user = text => ({ role: 'user', content: [{ type: 'input_text', text }] });
const call = id => ({ type: 'function_call', call_id: id, name: 'exec_command', arguments: '{}' });
const result = (id, output = 'old file contents '.repeat(200)) => ({ type: 'function_call_output', call_id: id, output });
const history = () => [user('first task'), call('a'), result('a'), { type: 'reasoning', encrypted_content: 'opaque' }, user('second task'), call('b'), result('b')];
const raw = (input = history(), extra = {}) => Buffer.from(JSON.stringify({ model: 'test-model', input, stream: true, store: false, ...extra }));
const transform = (body = raw(), config = cfg(), headers = {}) => transformRequest('POST', '/responses', headers, body, config);

test('Responses clearing is opt-in and validates its routing and thresholds', () => {
  const body = raw();
  assert.equal(transform(body, proxyConfig({}, {})).body, body);
  assert.throws(() => proxyConfig({ protocol: 'responses' }, {}), /explicit --upstream/);
  for (const flags of [{ protocol: 'bogus' }, { keep: 2 }, { trigger: -1 }, { trigger: true }, { trigger: 'bad' }, { 'keep-min': -1 }, { 'clear-at-least': 0 }, { holdout: 2 }, { upstream: 'file:///tmp/no' }]) assert.throws(() => cfg(flags));
  assert.equal(proxyConfig({}, { THINKER_PROXY_PROTOCOL: 'responses', THINKER_PROXY_UPSTREAM: 'https://api.openai.com/v1' }).protocol, 'responses');
});

test('only old text outputs change; current turn, IDs, calls, instructions and reasoning survive', () => {
  const input = history();
  input.splice(3, 0, { type: 'custom_tool_call_output', call_id: 'custom', output: [{ type: 'input_text', text: 'x'.repeat(4000) }] });
  input.splice(4, 0, result('image', [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }]));
  const original = raw(input, { instructions: 'keep this', tools: [{ type: 'function', name: 'exec_command', parameters: {} }] });
  const t = transform(original);
  const sent = JSON.parse(t.body), before = JSON.parse(original);
  assert.equal(t.injected, true);
  assert.equal(t.clearedUses, 2);
  assert.ok(t.removedBytes > 4000);
  assert.deepEqual(sent, { ...before, input: before.input.map((item, i) => i === 2 ? { ...item, output: CLEARED_OUTPUT } : i === 3 ? { ...item, output: [{ type: 'input_text', text: CLEARED_OUTPUT }] } : item) });
  assert.equal(transform(t.body).body, t.body, 'idempotent if a client sends the shortened history');
  assert.deepEqual(transform(original).body, t.body, 'retries reconstruct exactly the same prefix without session state');
  const next = transform(raw([...input, call('c'), result('c')]));
  assert.deepEqual(JSON.parse(next.body).input.slice(0, input.length), sent.input, 'a follow-up keeps the rewritten prefix and the current turn');
});

test('native compaction, linked histories, unknown shapes and encoded bodies pass through', () => {
  for (const body of [raw(history(), { previous_response_id: 'r1' }), raw(history(), { conversation: 'c1' }), raw([{ type: 'item_reference', id: 'previous' }, ...history()]), raw(history(), { context_management: [{ type: 'compaction', compact_threshold: 1000 }] }), raw([...history(), { type: 'compaction_trigger' }]), raw('hello'), Buffer.from('null'), Buffer.from('{')]) assert.equal(transform(body).body, body);
  for (const endpoint of ['/responses/compact', '/v1/responses/compact', '/models', '/v1/messages']) { const body = raw(); assert.equal(transformRequest('POST', endpoint, {}, body, cfg()).body, body); }
  const body = raw();
  assert.equal(transform(body, cfg(), { 'content-encoding': 'zstd' }).reason, 'encoded-request');
  assert.equal(transformRequest('POST', '/v1/responses?x=y', {}, body, cfg()).injected, true);
});

test('size gates, newest-output floor, first turn and session holdouts are conservative', () => {
  const body = raw();
  assert.equal(transform(body, cfg({ trigger: 999999 })).reason, 'below-trigger');
  assert.equal(transform(body, cfg({ 'clear-at-least': 999999 })).reason, 'below-clear-minimum');
  assert.equal(transform(body, cfg({ 'keep-min': 10 })).injected, undefined);
  assert.equal(transform(raw(history().slice(0, 4)), cfg({ 'keep-min': 0 })).injected, undefined, 'never clears the current turn even with a zero floor');
  assert.equal(transform(raw([call('a'), result('a')])).reason, 'no-user-turn');
  assert.equal(transform(body, cfg({ holdout: 1 }), { session_id: 's1' }).reason, 'holdout');
  assert.equal(transform(body, cfg({ holdout: 1 })).reason, 'missing-session');
  assert.equal(transform(raw(history(), { prompt_cache_key: 's2' }), cfg({ holdout: 1 })).reason, 'holdout');
  assert.equal(transform(body, cfg({ holdout: 0 })).injected, true);
});

const usage = { input_tokens: 250, input_tokens_details: { cached_tokens: 200 }, output_tokens: 7 };
const answer = `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r1', usage, output: [] } })}\n\n`;
test('Responses usage reads split SSE and JSON without Anthropic cache weights', () => {
  for (const data of [answer, JSON.stringify({ usage })]) {
    const tap = responsesUsageTap();
    for (let i = 0; i < data.length; i += 3) tap.push(Buffer.from(data.slice(i, i + 3)));
    assert.deepEqual(tap.result(), { input: 250, read: 200, out: 7 });
  }
  const r = proxyReport([{ op: 'proxy', protocol: 'responses', injected: true, input: 250, read: 200, out: 7, removedBytes: 400, status: 200 }, { op: 'proxy', protocol: 'responses', reason: 'encoded-request', status: 200 }]);
  assert.deepEqual(Object.keys(r), ['responses']);
  assert.equal(r.responses.clearing.input, 250);
  assert.equal(r.responses.clearing.cachedInput, 200);
  assert.equal(r.responses.clearing.billedInput, undefined);
  assert.deepEqual(r.responses.unchanged.reasons, { 'encoded-request': 1 });
});

test('HTTP transport preserves auth, streaming, errors and compact requests without logging content', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(req.url.includes('error') ? 429 : 200, { 'content-type': 'text/event-stream', 'x-request-id': 'test-id' });
      res.write(answer.slice(0, 20)); res.end(answer.slice(20));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-responses-'));
  const logFile = path.join(dir, 'proxy.jsonl');
  const proxy = startProxy({ ...cfg(), upstream: `http://127.0.0.1:${upstream.address().port}/v1` }, { logFile });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.close(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = async endpoint => {
    const r = await fetch(`http://127.0.0.1:${proxy.address().port}${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer mock-only', 'chatgpt-account-id': 'fixture-account', session_id: 'session-test' }, body: raw() });
    assert.equal(r.headers.get('x-request-id'), 'test-id');
    assert.equal(await r.text(), answer); return r.status;
  };
  assert.equal(await send('/responses'), 200);
  assert.equal(await send('/responses?error=1'), 429);
  assert.equal(await send('/responses/compact'), 200);
  assert.deepEqual(seen.map(x => x.url), ['/v1/responses', '/v1/responses?error=1', '/v1/responses/compact']);
  assert.equal(seen[0].headers.authorization, 'Bearer mock-only');
  assert.equal(seen[0].headers['chatgpt-account-id'], 'fixture-account');
  assert.equal(seen[0].headers['anthropic-beta'], undefined);
  assert.equal(JSON.parse(seen[0].body).input[2].output, CLEARED_OUTPUT);
  assert.equal(seen[2].body, raw().toString());
  const log = fs.readFileSync(logFile, 'utf8');
  assert.doesNotMatch(log, /mock-only|fixture-account|old file contents|opaque/);
  const rows = log.trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].session, 'session-test'); assert.equal(rows[0].input, 250);
  const upgrade = await new Promise((resolve, reject) => {
    const socket = net.connect(proxy.address().port, '127.0.0.1', () => socket.write('GET /responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));
    let output = ''; socket.on('data', c => output += c); socket.on('end', () => resolve(output)); socket.on('error', reject);
  });
  assert.match(upgrade, /426.*[\s\S]*supports_websockets = false/);
});

test('Codex closing SSE on response.completed still logs clearing and usage once', async t => {
  const upstream = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(answer); // deliberately keep HTTP open after the completion event
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-responses-close-'));
  const logFile = path.join(dir, 'proxy.jsonl');
  const proxy = startProxy({ ...cfg(), upstream: `http://127.0.0.1:${upstream.address().port}` }, { logFile });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.address().port, path: '/responses', method: 'POST' }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.includes('\n\n')) res.destroy(); });
      res.on('close', resolve);
    });
    req.on('error', reject); req.end(raw());
  });
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(logFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].injected, true);
  assert.ok(rows[0].removedBytes > 0);
  assert.deepEqual([rows[0].input, rows[0].read, rows[0].out], [250, 200, 7]);
  assert.equal(rows[0].status, 200);
});

test('managed service routes Codex by its existing auth without changing the Anthropic route', async t => {
  const seen = { anthropic: [], chatgpt: [], api: [] }, servers = {};
  for (const name of Object.keys(seen)) {
    const server = http.createServer((req, res) => {
      const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
        seen[name].push({ path: req.url, auth: req.headers.authorization, beta: req.headers['anthropic-beta'], body: Buffer.concat(chunks).toString() });
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(answer);
      });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); servers[name] = server;
    t.after(() => { server.closeAllConnections(); server.close(); });
  }
  const base = name => `http://127.0.0.1:${servers[name].address().port}`;
  const proxy = startProxy({ ...cfg(), protocol: 'anthropic', codex: true, upstream: base('anthropic'), codexUpstreams: { chatgpt: base('chatgpt') + '/backend-api/codex', api: base('api') + '/v1' } });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  const send = async (endpoint, headers = {}, data = raw()) => {
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer fixture', ...headers }, body: data });
    assert.equal(res.status, 200); await res.text();
  };
  await send('/codex/responses', { 'chatgpt-account-id': 'fixture-account' });
  await send('/codex/responses');
  await send('/codex/responses/compact', { 'chatgpt-account-id': 'fixture-account' });
  await send('/v1/messages', {}, JSON.stringify({ model: 'claude', messages: [{ role: 'user', content: 'hello' }] }));
  assert.equal(seen.chatgpt[0].path, '/backend-api/codex/responses');
  assert.equal(seen.api[0].path, '/v1/responses');
  for (const name of ['chatgpt', 'api']) {
    assert.equal(JSON.parse(seen[name][0].body).input[2].output, CLEARED_OUTPUT);
    assert.equal(seen[name][0].auth, 'Bearer fixture');
    assert.equal(seen[name][0].beta, undefined);
  }
  assert.equal(seen.chatgpt[1].path, '/backend-api/codex/responses/compact');
  assert.equal(seen.chatgpt[1].body, raw().toString());
  assert.equal(seen.anthropic[0].path, '/v1/messages');
  assert.ok(JSON.parse(seen.anthropic[0].body).context_management.edits.length);
});
