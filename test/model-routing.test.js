// Models from other providers (providers.js, wire-chat.js, proxy-routing.js): the registry, the probe, the route
// resolution, the Messages/Chat translation both ways, and the proxy forwarding a `thinker/…` model to its provider
// with the provider's credential and never the agent's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegistry, writeRegistry, addProvider, recordProbe, setRoute, dropRoute, removeProvider, resolveRoute, normalizeBase, parseModelList, probeProvider, readCredential, storeKey, registryPrices, registryReader } from '../src/providers.js';
import { toChat, fromChat, chatStreamToMessages, errorToMessages, usageOf } from '../src/wire-chat.js';
import { routeOf, routedHeaders, routedBody } from '../src/proxy-routing.js';
import { startProxy, PROXY_DEFAULTS, usageTap } from '../src/proxy.js';
import { listPrice } from '../src/prices.js';

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('a base URL is stored without /v1 or a trailing slash, and only http(s)', () => {
  assert.equal(normalizeBase('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api');
  assert.equal(normalizeBase('http://127.0.0.1:4000/v1'), 'http://127.0.0.1:4000');
  assert.equal(normalizeBase('https://gw.example.com/anthropic'), 'https://gw.example.com/anthropic');
  assert.throws(() => normalizeBase('ftp://x'), /http/);
});

test('the models list is read in the shapes the gateways use, prices turned into dollars a million', () => {
  const m = parseModelList({ data: [
    { id: 'openai/gpt-6-sol', pricing: { prompt: '0.000002', completion: '0.000008', input_cache_read: '0.0000005' }, context_length: 400000 },
    { id: 'plain-model' },
    { id: 'litellm-model', model_info: { input_cost_per_token: 0.000001, output_cost_per_token: 0.000004, max_input_tokens: 128000 } },
    'string-id',
  ] });
  assert.deepEqual(m['openai/gpt-6-sol'], { source: 'provider', price: { input: 2, output: 8, cacheRead: 0.5 }, context: 400000 });
  assert.deepEqual(m['plain-model'], { source: 'provider' });
  assert.equal(m['litellm-model'].price.input, 1); assert.equal(m['litellm-model'].context, 128000);
  assert.ok(m['string-id']);
});

test('the probe lists the models and sends one token in each format, recording what answered in the format\'s own shape', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const json = v => ({ status: 200, text: async () => JSON.stringify(v) });
    if (url.endsWith('/v1/models')) return json({ data: [{ id: 'm1' }, { id: 'm2' }] });
    if (url.endsWith('/v1/messages')) return { status: 404, text: async () => 'no such route' };
    if (url.endsWith('/v1/chat/completions')) return json({ choices: [{ message: { role: 'assistant', content: 'hi' } }] });
    throw Error('unexpected ' + url);
  };
  const found = await probeProvider({ url: 'https://gw.example.com/v1', auth: { env: 'GW_KEY' } }, { fetch: fetchFn, env: { GW_KEY: 'sk-1' } });
  assert.deepEqual(found.formats, ['chat']);
  assert.deepEqual(Object.keys(found.models), ['m1', 'm2']);
  assert.equal(found.probeModel, 'm1');
  assert.equal(found.checks.messages, 404); assert.equal(found.checks.chat, 200); assert.equal(found.checks.models, 200);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-1', 'the credential goes as a bearer token');
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-1', 'and as an api key, since a gateway reads one or the other');
  const sent = JSON.parse(calls[2].init.body);
  assert.equal(sent.max_tokens, 1); assert.equal(sent.model, 'm1');
  // a gateway that answers 200 with its own JSON on a path is not speaking that format
  const liar = async url => ({ status: 200, text: async () => JSON.stringify(url.endsWith('/v1/models') ? { data: [{ id: 'x' }] } : { ok: true }) });
  assert.deepEqual((await probeProvider({ url: 'https://l.example.com', auth: { none: true } }, { fetch: liar })).formats, []);
  // a timeout is a check result, not a crash
  const slow = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(Error('aborted'), { name: 'AbortError' }))));
  const f2 = await probeProvider({ url: 'https://s.example.com', auth: { none: true } }, { fetch: slow, timeoutMs: 20 });
  assert.match(String(f2.checks.models), /timed out/);
});

test('a credential comes from the environment or a private file, and never sits in the registry', () => {
  const home = tmp('thinker-providers-');
  assert.equal(readCredential({ env: 'K' }, { K: ' sk-abc ' }), 'sk-abc');
  assert.throws(() => readCredential({ env: 'K' }, {}), /not set/);
  const f = storeKey('gw', 'sk-file', home);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(readCredential({ file: f }), 'sk-file');
  fs.chmodSync(f, 0o644);
  assert.throws(() => readCredential({ file: f }), /private/);
  assert.equal(readCredential({ none: true }), null);
  const reg = readRegistry(home);
  addProvider(reg, { id: 'gw', url: 'https://gw.example.com/v1', auth: { file: f } });
  writeRegistry(reg, home);
  assert.ok(!fs.readFileSync(path.join(home, 'providers.json'), 'utf8').includes('sk-file'));
  assert.equal(fs.statSync(path.join(home, 'providers.json')).mode & 0o777, 0o600);
  assert.throws(() => addProvider(reg, { id: 'Bad Id', url: 'https://x' }), /lowercase/);
});

test('a route resolves to its provider, model and format; an alias moves without touching what names it', () => {
  const reg = readRegistry(tmp('thinker-providers-'));
  addProvider(reg, { id: 'gw', url: 'https://gw.example.com', auth: { env: 'K' } });
  recordProbe(reg, 'gw', { formats: ['chat'], models: { 'openai/gpt-6-sol': { source: 'provider', price: { input: 2, output: 8 } } }, probedAt: 'now', checks: {} });
  assert.equal(resolveRoute('claude-opus-5-5', reg), null, 'not a route');
  assert.throws(() => resolveRoute('thinker/explore', reg), /no route named explore/);
  assert.throws(() => resolveRoute('thinker/nope/model', reg), /no provider named nope/);
  const direct = resolveRoute('thinker/gw/openai/gpt-6-sol', reg);
  assert.equal(direct.providerId, 'gw'); assert.equal(direct.model, 'openai/gpt-6-sol'); assert.equal(direct.format, 'chat'); assert.equal(direct.known, true);
  setRoute(reg, 'explore', 'gw/openai/gpt-6-sol');
  const r = resolveRoute('thinker/explore', reg);
  assert.equal(r.alias, 'explore'); assert.equal(r.model, 'openai/gpt-6-sol'); assert.equal(r.provider.url, 'https://gw.example.com');
  setRoute(reg, 'explore', 'gw/other-model');
  assert.equal(resolveRoute('thinker/explore', reg).model, 'other-model');
  assert.equal(reg.providers.gw.models['other-model'].source, 'manual', 'a model named by hand is kept through the next probe');
  recordProbe(reg, 'gw', { formats: ['chat', 'messages'], models: { 'openai/gpt-6-sol': { source: 'provider' } }, probedAt: 'later', checks: {} });
  assert.ok(reg.providers.gw.models['other-model']);
  assert.equal(resolveRoute('thinker/gw/openai/gpt-6-sol', reg).format, 'messages', 'Messages is preferred where both are spoken: nothing is translated');
  assert.throws(() => setRoute(reg, 'explore', 'gw/m', { format: 'responses' }), /format/);
  assert.throws(() => setRoute(reg, 'gw', 'gw/m'), /provider id/);
  dropRoute(reg, 'explore');
  assert.throws(() => resolveRoute('thinker/explore', reg), /no route/);
  setRoute(reg, 'x', 'gw/m'); removeProvider(reg, 'gw');
  assert.equal(Object.keys(reg.routes).length, 0, 'a provider takes its routes with it');
});

test('a provider\'s reported price reaches prices.js, the one door dollars go through', () => {
  const home = tmp('thinker-providers-');
  const reg = readRegistry(home);
  addProvider(reg, { id: 'gw', url: 'https://gw.example.com', auth: { none: true } });
  recordProbe(reg, 'gw', { formats: ['chat'], models: { 'vendor/some-model-9': { source: 'provider', price: { input: 2, output: 8 } } }, probedAt: 'now', checks: {} });
  writeRegistry(reg, home);
  assert.equal(registryPrices(home)['vendor/some-model-9'].input, 2);
  const p = listPrice('vendor/some-model-9', { home });
  assert.equal(p.input, 2); assert.equal(p.output, 8); assert.equal(p.cacheRead, 0.2, 'the usual fill-in for what the provider did not say');
  assert.equal(listPrice('vendor/some-model-9', { config: { prices: { 'vendor/some-model-9': { input: 1 } } }, home }).input, 1, 'the repository config still wins');
  const reader = registryReader(home);
  assert.equal(reader().providers.gw.url, 'https://gw.example.com');
  const before = reader();
  assert.equal(reader(), before, 'read once while the file stands');
});

test('toChat carries the system prompt, the turns, tools, calls and results, images and the schema; and names what it drops', () => {
  const j = { model: 'thinker/explore', max_tokens: 100, stream: true, system: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' }, context_management: { edits: [] }, metadata: { user_id: 'x' },
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }, { type: 'web_search_20250305', name: 'web_search' }],
    tool_choice: { type: 'auto' }, output_format: { type: 'json_schema', schema: { type: 'object' } },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'find x' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'reading' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'contents' }] }, { type: 'text', text: 'go on' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ] };
  const { body, dropped } = toChat(j, { model: 'gpt-6-sol' });
  assert.equal(body.model, 'gpt-6-sol'); assert.equal(body.stream, true); assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.messages[0], { role: 'system', content: 'be brief' });
  assert.equal(body.messages[1].role, 'user'); assert.equal(body.messages[1].content[1].type, 'image_url');
  assert.equal(body.messages[2].role, 'assistant'); assert.equal(body.messages[2].content, 'reading');
  assert.deepEqual(body.messages[2].tool_calls, [{ id: 'toolu_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }]);
  assert.deepEqual(body.messages[3], { role: 'tool', tool_call_id: 'toolu_1', content: 'contents' }, 'the result directly follows the call that made it');
  assert.deepEqual(body.messages[4], { role: 'user', content: 'go on' });
  assert.equal(body.tools.length, 1, 'a server tool has no Chat equivalent'); assert.equal(body.tools[0].function.name, 'Read');
  assert.equal(body.tool_choice, 'auto'); assert.equal(body.max_tokens, 100);
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(dropped, ['thinking', 'context_management', 'metadata', 'server tools']);
  assert.equal(toChat({ messages: [], tools: [{ name: 'a', input_schema: {} }], tool_choice: { type: 'tool', name: 'a' } }, { model: 'm' }).body.tool_choice.function.name, 'a');
  assert.equal(toChat({ messages: [], tools: [{ name: 'a', input_schema: {} }], tool_choice: { type: 'any' } }, { model: 'm' }).body.tool_choice, 'required');
});

test('a whole Chat answer and a streamed one both come back as the API\'s own events, usage included', () => {
  const whole = fromChat({ id: 'chatcmpl-9', choices: [{ finish_reason: 'tool_calls', message: { content: 'look:', tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }] } }], usage: { prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 } } }, { model: 'gpt-6-sol' });
  assert.equal(whole.type, 'message'); assert.equal(whole.model, 'gpt-6-sol'); assert.equal(whole.stop_reason, 'tool_use');
  assert.deepEqual(whole.content, [{ type: 'text', text: 'look:' }, { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/a' } }]);
  assert.deepEqual(whole.usage, { input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 7 });
  assert.deepEqual(usageOf(null), null);
  const tr = chatStreamToMessages({ model: 'gpt-6-sol' });
  const chunks = [
    'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"hel"}}]}\n\ndata: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_7","function":{"name":"Read","arguments":""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file_path\\""}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"/a\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":9}}\n\ndata: [DONE]\n\n',
  ];
  let sse = ''; for (const c of chunks) sse += tr.push(c); sse += tr.end();
  const events = sse.split('\n\n').filter(Boolean).map(e => JSON.parse(e.split('\ndata: ')[1]));
  const types = events.map(e => e.type);
  assert.deepEqual(types, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.equal(events[0].message.model, 'gpt-6-sol');
  assert.equal(events[2].delta.text + events[3].delta.text, 'hello');
  assert.deepEqual(events[5].content_block, { type: 'tool_use', id: 'call_7', name: 'Read', input: {} });
  assert.equal(events[6].delta.partial_json + events[7].delta.partial_json, '{"file_path":"/a"}');
  assert.equal(events[9].delta.stop_reason, 'tool_use'); assert.equal(events[9].usage.output_tokens, 9); assert.equal(events[9].usage.input_tokens, 50);
  // proxy.js reads the usage off this stream as it reads the API's own
  const tap = usageTap(); tap.push(sse);
  assert.equal(tap.result().out, 9); assert.equal(tap.result().input, 50);
  // a tool call with no arguments still closes as valid JSON
  const t2 = chatStreamToMessages({ model: 'm' });
  const s2 = t2.push('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"Now"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n') + t2.end();
  assert.match(s2, /"partial_json":"\{\}"/);
  assert.equal(errorToMessages(429, '{"error":{"message":"slow down"}}').error.type, 'rate_limit_error');
  assert.equal(errorToMessages(500, 'boom').error.type, 'api_error');
});

const registry = (home, formats = ['chat']) => {
  const reg = readRegistry(home);
  addProvider(reg, { id: 'gw', url: 'http://placeholder', auth: { env: 'GW_KEY' } });
  recordProbe(reg, 'gw', { formats, models: { 'gpt-6-sol': { source: 'provider' } }, probedAt: 'now', checks: {} });
  setRoute(reg, 'explore', 'gw/gpt-6-sol');
  return reg;
};

test('routeOf, routedHeaders and routedBody: the agent\'s credential and betas stay behind, the provider\'s go, Claude-only fields drop', () => {
  const reg = registry(tmp('thinker-providers-'));
  reg.providers.gw.url = 'http://gw.local';
  process.env.GW_KEY = 'sk-gw';
  try {
    const raw = Buffer.from(JSON.stringify({ model: 'thinker/explore', messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'adaptive' }, context_management: { edits: [] }, stream: true }));
    assert.equal(routeOf(Buffer.from('{"model":"claude-opus-5-5","messages":[]}'), '/v1/messages?beta=true', reg), null);
    assert.equal(routeOf(raw, '/v1/complete', reg), null, 'only the Messages path');
    const r = routeOf(raw, '/v1/messages?beta=true', reg);
    assert.equal(r.model, 'gpt-6-sol'); assert.equal(r.format, 'chat');
    const bad = routeOf(Buffer.from(JSON.stringify({ model: 'thinker/nothing', messages: [] })), '/v1/messages', reg);
    assert.equal(bad.error.status, 400); assert.match(bad.error.body.error.message, /no route named nothing/);
    const h = routedHeaders({ authorization: 'Bearer agent-oauth', 'x-api-key': 'agent-key', 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01', 'user-agent': 'claude-code' }, r);
    assert.equal(h.authorization, 'Bearer sk-gw'); assert.equal(h['x-api-key'], 'sk-gw'); assert.equal(h['anthropic-beta'], undefined); assert.equal(h['user-agent'], 'claude-code');
    const b = routedBody(raw, r);
    assert.equal(b.path, '/v1/chat/completions'); assert.equal(b.stream, true);
    const sent = JSON.parse(b.body); assert.equal(sent.model, 'gpt-6-sol'); assert.equal(sent.thinking, undefined);
    assert.deepEqual(b.dropped, ['context_management', 'thinking']);
    // a Messages-speaking provider gets the Messages body with the model swapped; a Claude model there keeps its thinking
    reg.providers.gw.formats = ['messages']; setRoute(reg, 'claude', 'gw/claude-sonnet-5-5');
    const rc = routeOf(Buffer.from(JSON.stringify({ model: 'thinker/claude', messages: [], thinking: { type: 'adaptive' }, context_management: {} })), '/v1/messages', reg);
    const bc = routedBody(Buffer.from(JSON.stringify({ model: 'thinker/claude', messages: [], thinking: { type: 'adaptive' }, context_management: {} })), rc);
    const sc = JSON.parse(bc.body); assert.equal(sc.model, 'claude-sonnet-5-5'); assert.deepEqual(sc.thinking, { type: 'adaptive' }); assert.equal(sc.context_management, undefined); assert.equal(bc.path, undefined);
    assert.equal(routedHeaders({}, rc)['anthropic-version'], '2023-06-01');
    delete process.env.GW_KEY;
    assert.throws(() => routedHeaders({}, r), /GW_KEY is not set/);
  } finally { delete process.env.GW_KEY; }
});

// a Chat Completions upstream that streams a tool call, remembering what it was sent
function chatUpstream({ status = 200, whole = false } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'nope', type: 'invalid_request_error' } })); }
      if (whole) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'chatcmpl-w', choices: [{ finish_reason: 'stop', message: { content: 'whole answer' } }], usage: { prompt_tokens: 11, completion_tokens: 2 } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const lines = ['data: {"id":"chatcmpl-s","choices":[{"delta":{"content":"ok "}}]}\n\n', 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"Read","arguments":"{\\"file_path\\":\\"/a\\"}"}}]}}]}\n\n', 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":5}}\n\n', 'data: [DONE]\n\n'];
      let i = 0; const next = () => { if (i < lines.length) { res.write(lines[i++]); setImmediate(next); } else res.end(); }; next();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
function messagesUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
function proxyWith(reg, upstreamUrl) {
  const logFile = path.join(tmp('thinker-proxy-'), 'proxy.jsonl');
  return new Promise(r => { const server = startProxy({ ...PROXY_DEFAULTS, upstream: upstreamUrl }, { logFile, routes: () => reg, onListen: a => r({ server, logFile, port: a.port }) }); });
}
function send(port, data, { path: p = '/v1/messages?beta=true', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'parent-session', authorization: 'Bearer agent-oauth', 'anthropic-beta': 'oauth-2025-04-20', ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(data);
  });
}
const rows = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const body = (model, extra = {}) => JSON.stringify({ model, max_tokens: 50, stream: true, system: 'be brief', messages: [{ role: 'user', content: 'read /a' }], tools: [{ name: 'Read', input_schema: { type: 'object' } }], thinking: { type: 'adaptive' }, ...extra });

test('a routed request goes to its provider as Chat with the provider\'s key, and the answer comes back as the API\'s events; the row says the route', async () => {
  const home = tmp('thinker-providers-'), anthropic = await messagesUpstream(), gw = await chatUpstream();
  const reg = registry(home); reg.providers.gw.url = gw.url;
  process.env.GW_KEY = 'sk-gw';
  const p = await proxyWith(reg, anthropic.url);
  try {
    const r = await send(p.port, body('thinker/explore'));
    assert.equal(r.status, 200); assert.match(r.headers['content-type'], /event-stream/);
    assert.equal(gw.seen.length, 1, 'the provider got it'); assert.equal(anthropic.seen.length, 0, 'the API did not');
    const up = gw.seen[0];
    assert.equal(up.url, '/v1/chat/completions');
    assert.equal(up.headers.authorization, 'Bearer sk-gw'); assert.equal(up.headers['anthropic-beta'], undefined);
    assert.equal(up.body.model, 'gpt-6-sol'); assert.equal(up.body.messages[0].role, 'system'); assert.equal(up.body.tools[0].function.name, 'Read'); assert.equal(up.body.thinking, undefined);
    const events = r.text.split('\n\n').filter(Boolean).map(e => JSON.parse(e.split('\ndata: ')[1]));
    assert.equal(events[0].type, 'message_start'); assert.equal(events[0].message.model, 'gpt-6-sol');
    const tool = events.find(e => e.type === 'content_block_start' && e.content_block.type === 'tool_use');
    assert.equal(tool.content_block.name, 'Read');
    assert.equal(events.at(-2).delta.stop_reason, 'tool_use'); assert.equal(events.at(-1).type, 'message_stop');
    const row = rows(p.logFile).find(x => x.op === 'proxy');
    assert.equal(row.route, 'thinker/explore'); assert.equal(row.provider, 'gw'); assert.equal(row.routedModel, 'gpt-6-sol'); assert.equal(row.format, 'chat');
    assert.equal(row.model, 'thinker/explore'); assert.equal(row.out, 5); assert.equal(row.input, 30); assert.ok(row.firstByteMs >= 0);
    assert.deepEqual(row.dropped, ['thinking']);
    assert.ok(!JSON.stringify(rows(p.logFile)).includes('sk-gw'), 'the key is in no row');
    // an ordinary request is untouched by any of it
    const r2 = await send(p.port, body('claude-opus-5-5'));
    assert.equal(r2.status, 200); assert.equal(anthropic.seen.length, 1); assert.equal(anthropic.seen[0].headers.authorization, 'Bearer agent-oauth');
    assert.equal(rows(p.logFile).filter(x => x.op === 'proxy').at(-1).route, undefined);
  } finally { delete process.env.GW_KEY; p.server.close(); gw.server.close(); anthropic.server.close(); }
});

test('a whole (non-streamed) Chat answer, a provider error, a missing key and an unknown route each reach the agent in the API\'s shape', async () => {
  const home = tmp('thinker-providers-'), anthropic = await messagesUpstream(), gw = await chatUpstream({ whole: true }), bad = await chatUpstream({ status: 429 });
  const reg = registry(home); reg.providers.gw.url = gw.url;
  addProvider(reg, { id: 'bad', url: bad.url, auth: { env: 'GW_KEY' } }); recordProbe(reg, 'bad', { formats: ['chat'], models: { m: { source: 'provider' } }, probedAt: 'now', checks: {} });
  addProvider(reg, { id: 'nokey', url: gw.url, auth: { env: 'NOKEY_UNSET' } }); recordProbe(reg, 'nokey', { formats: ['chat'], models: { m: { source: 'provider' } }, probedAt: 'now', checks: {} });
  process.env.GW_KEY = 'sk-gw';
  const p = await proxyWith(reg, anthropic.url);
  try {
    const r = await send(p.port, body('thinker/explore', { stream: false }));
    assert.equal(r.status, 200); assert.match(r.headers['content-type'], /json/);
    const j = JSON.parse(r.text); assert.equal(j.type, 'message'); assert.equal(j.content[0].text, 'whole answer'); assert.equal(j.usage.input_tokens, 11);
    assert.equal(rows(p.logFile).find(x => x.op === 'proxy').out, 2);
    const e = await send(p.port, body('thinker/bad/m'));
    assert.equal(e.status, 429); assert.deepEqual(JSON.parse(e.text), { type: 'error', error: { type: 'rate_limit_error', message: 'nope' } });
    const k = await send(p.port, body('thinker/nokey/m'));
    assert.equal(k.status, 401); assert.match(JSON.parse(k.text).error.message, /NOKEY_UNSET is not set/);
    const u = await send(p.port, body('thinker/unknown'));
    assert.equal(u.status, 400); assert.match(JSON.parse(u.text).error.message, /no route named unknown/);
    assert.equal(anthropic.seen.length, 0, 'none of it reached the API with the agent\'s login');
    assert.equal(rows(p.logFile).filter(x => x.op === 'proxy-route-refused').length, 2);
  } finally { delete process.env.GW_KEY; p.server.close(); gw.server.close(); bad.server.close(); anthropic.server.close(); }
});

test('a Messages-speaking provider gets the Messages body as it is, model swapped, no translation', async () => {
  const home = tmp('thinker-providers-'), anthropic = await messagesUpstream(), gw = await messagesUpstream();
  const reg = registry(home, ['messages']); reg.providers.gw.url = gw.url; setRoute(reg, 'explore', 'gw/claude-sonnet-5-5');
  process.env.GW_KEY = 'sk-gw';
  const p = await proxyWith(reg, anthropic.url);
  try {
    const r = await send(p.port, body('thinker/explore', { stream: false }));
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.text).content[0].text, 'hi');
    assert.equal(gw.seen[0].url, '/v1/messages?beta=true'); assert.equal(gw.seen[0].body.model, 'claude-sonnet-5-5'); assert.deepEqual(gw.seen[0].body.thinking, { type: 'adaptive' });
    assert.equal(gw.seen[0].headers['x-api-key'], 'sk-gw'); assert.equal(gw.seen[0].headers['anthropic-version'], '2023-06-01'); assert.equal(gw.seen[0].headers['anthropic-beta'], undefined);
    assert.equal(rows(p.logFile).find(x => x.op === 'proxy').format, 'messages');
  } finally { delete process.env.GW_KEY; p.server.close(); gw.server.close(); anthropic.server.close(); }
});
