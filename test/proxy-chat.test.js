import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proxyConfig, startProxy, transformRequest, proxyReport } from '../src/proxy.js';
import { transformChat, chatCandidates, applyChatCut, chatUsage, chatUsageTap, chatReport, chatSession, refusesChatCut } from '../src/proxy-chat.js';
import { placeholder, freshCut, clearedOf, clearedEstimated } from '../src/cutting.js';

// A gateway config as the service builds it (proxyConfig reads the flags; the door reads the fields).
const cfg = extra => ({ ...proxyConfig({}, {}), protocol: 'chat', gateway: 'openrouter', trigger: 1, clearAtLeast: 1, keepMin: 1, ...extra });
const user = text => ({ role: 'user', content: text });
const call = (id, name = 'read_file') => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] });
const result = (id, content = 'old file contents '.repeat(4000)) => ({ role: 'tool', tool_call_id: id, content });
const history = () => [user('first task'), call('a'), result('a'), user('second task'), call('b'), result('b', 'old file contents '.repeat(200))];
const raw = (messages = history(), extra = {}) => Buffer.from(JSON.stringify({ model: 'test-model', messages, stream: true, ...extra }));
const transform = (body = raw(), config = cfg(), headers = {}) => transformRequest('POST', '/v1/chat/completions', headers, body, config);

test('gateways are opt-in and validate their URLs', () => {
  const body = raw();
  // no gateway configured: the request passes through exactly as it came
  assert.equal(transform(body, { ...proxyConfig({}, {}), protocol: 'anthropic' }).reason, 'other');
  assert.equal(transformChat('POST', '/v1/messages', {}, body, cfg()).reason, 'other');
  assert.equal(proxyConfig({ 'gateway-openrouter': true }, {}).gateways.openrouter.upstream, 'https://openrouter.ai/api/v1');
  assert.equal(proxyConfig({ 'gateway-litellm': 'http://127.0.0.1:4000' }, {}).gateways.litellm.upstream, 'http://127.0.0.1:4000');
  assert.throws(() => proxyConfig({ 'gateway-litellm': 'file:///tmp/no' }, {}), /HTTP\(S\)/);
});

test('only old tool messages change; current turn, ids, calls and prompts survive', () => {
  const messages = history();
  messages.splice(3, 0, user('between turns'));
  const original = raw(messages, { tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }] });
  const t = transform(original);
  const sent = JSON.parse(t.body), before = JSON.parse(original);
  assert.equal(t.injected, true);
  assert.equal(t.clearedUses, 1);
  assert.ok(t.removedBytes > 4000);
  // 'a' is old, 'b' is the current turn's, the between prompt starts the newest turn and keeps 'b' whole
  assert.equal(sent.messages[2].content, placeholder(before.messages[2].content.length));
  assert.equal(sent.messages[5].content, before.messages[5].content);
  assert.equal(sent.messages[4].content, before.messages[4].content);
  assert.deepEqual(sent.tools, before.tools);
  assert.equal(sent.model, before.model);
  assert.equal(transform(t.body).body, t.body, 'idempotent if a client sends the shortened history');
  assert.deepEqual(transform(original).body, t.body, 'retries reconstruct exactly the same prefix without session state');
  const next = transform(raw([...messages, call('c'), result('c', 'x'.repeat(300))]));
  assert.deepEqual(JSON.parse(next.body).messages.slice(0, messages.length), sent.messages, 'a follow-up keeps the rewritten prefix and the current turn');
});

test('array content parts are cut as one text, non-text parts pass through', () => {
  const messages = [user('go'), call('a'), { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'x'.repeat(4000) }] }, user('again'), call('b'), result('b', 'y'.repeat(300))];
  const t = transform(raw(messages));
  assert.equal(t.injected, true);
  assert.deepEqual(JSON.parse(t.body).messages[2].content, [{ type: 'text', text: placeholder(4000) }]);
  const images = [user('go'), call('a'), { role: 'tool', tool_call_id: 'a', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }, user('again'), call('b'), result('b', 'y'.repeat(300))];
  assert.equal(transform(raw(images)).reason, 'mixed-content');
});

test('unknown shapes, encoded bodies and stream_options already set pass through', () => {
  // nothing parseable or shaped like chat is ever rewritten: the agent's own bytes out
  for (const body of [raw('hello'), Buffer.from('null'), Buffer.from('{'), Buffer.from(JSON.stringify({ model: 'm', input: [] }))]) assert.equal(transform(body).body, body);
  assert.equal(transform(raw(), cfg(), { 'content-encoding': 'zstd' }).reason, 'encoded-request');
  // a well-formed body with no session and nothing asked is forwarded byte for byte
  const settled = raw([call('a'), result('a')], { stream: false });
  assert.equal(transform(settled).body, settled);
  const body = raw(history(), { user: 'end-user-1' });
  assert.equal(chatSession(JSON.parse(body)), 'end-user-1');
  // no user message, no session identity, no ratchet: passes through
  assert.equal(transform(raw([call('a'), result('a')])).reason, 'missing-session');
});

test('the shared policy decides: trigger, floor, mid-turn and holdout come from cutting.js', () => {
  assert.equal(transform(raw(), cfg({ trigger: 999999 })).reason, 'below-trigger');
  assert.equal(transform(raw(), cfg({ trigger: 1, clearAtLeast: 999999 })).reason, 'below-clear-minimum');
  assert.equal(transform(raw(), cfg({ trigger: 1, clearAtLeast: 1, keepMin: 10 })).injected, undefined);
  // a mid-turn request never moves the set: same turn number, same answer
  const first = transform(raw());
  const rec = { ...freshCut(chatSession(JSON.parse(first.body))), turn: JSON.parse(first.body).messages.filter(m => m.role === 'user').length };
  const mid = transform(raw(), cfg({ cutRecord: rec }));
  assert.equal(mid.reason, 'mid-turn');
  assert.deepEqual(mid.cut, rec.cut);
  // the whole side is per conversation, by hash of its first message
  assert.equal(transform(raw(), cfg({ holdout: 1 })).reason, 'holdout');
  assert.equal(transform(raw(), cfg({ holdout: 0 })).injected, true);
  // no-session pass through happens before the holdout is even asked
  assert.equal(transform(raw([call('a'), result('a')]), cfg({ holdout: 1 })).reason, 'missing-session');
});

test('LiteLLM usage is asked for on stream, once, and never over an answer the agent set', () => {
  const asked = JSON.parse(transform(raw()).body);
  assert.deepEqual(asked.stream_options, { include_usage: true });
  const set = JSON.parse(transform(raw(history(), { stream_options: { include_usage: false } })).body);
  assert.equal(set.stream_options.include_usage, false);
  const plain = JSON.parse(transform(raw(history(), { stream: false })).body);
  assert.equal(plain.stream_options, undefined);
});

const openrouterUsage = { prompt_tokens: 250, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 40 }, cost: 0.0125 };
const chunk = u => `data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'test-model', choices: [], ...(u ? { usage: u } : {}) })}\n\n`;
test('usage reads OpenRouter and LiteLLM shapes, streamed or plain, dollars kept as data', () => {
  for (const [data, expected] of [
    [chunk(openrouterUsage), { input: 250, read: 200, write: 40, freshInput: 10, out: 7, cost: 0.0125, responseId: 'chatcmpl-1', responseModel: 'test-model' }],
    // LiteLLM: cached_tokens only, no cost, no write split
    [JSON.stringify({ usage: { prompt_tokens: 250, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 200 } } }), { input: 250, read: 200, out: 7 }],
    [JSON.stringify({ usage: { prompt_tokens: 250, completion_tokens: 7 } }), { input: 250, out: 7 }],
  ]) {
    const tap = chatUsageTap();
    for (let i = 0; i < data.length; i += 3) tap.push(Buffer.from(data.slice(i, i + 3)));
    const got = tap.result();
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(got[k], v, `${k} of ${JSON.stringify(expected)}`);
    if (expected.cost != null) assert.deepEqual(got.apiUsage, openrouterUsage);
  }
  // inconsistent counters are named, never quietly reconciled
  assert.equal(chatUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 8, cache_write_tokens: 8 } }).usageInconsistent, true);
});

test('a cut the gateway refuses by name stops the editing; any other 400 does not', () => {
  assert.equal(refusesChatCut(Buffer.from(JSON.stringify({ error: { message: 'invalid content: [tool result removed by thinker after use: 4000 chars' } }))), true);
  assert.equal(refusesChatCut(Buffer.from(JSON.stringify({ error: { message: 'model not found' } }))), false);
});

test('the chat rows are an estimate the shared readers read, and the report speaks them', () => {
  const row = { op: 'proxy', protocol: 'chat', gateway: 'openrouter', session: 'chat#ab', injected: true, status: 200,
    input: 250, read: 200, write: 40, out: 7, cost: 0.0125, removedBytes: 4000, estimatedRemovedTokens: 1000, clearedUses: 1 };
  assert.equal(clearedOf(row), 1000);
  assert.equal(clearedEstimated(row), true);
  const plain = { op: 'proxy', session: 's', injected: true, cleared: 5 };
  assert.equal(clearedOf(plain), 5);
  const r = proxyReport([
    row,
    { op: 'proxy', protocol: 'chat', gateway: 'openrouter', session: 'chat#ab', reason: 'holdout', status: 200, input: 10, out: 1 },
    { op: 'proxy', protocol: 'chat', gateway: 'openrouter', session: 'chat#ab', reason: 'missing-session', status: 200 },
    { op: 'proxy', protocol: 'responses', injected: true, status: 200 },
  ]);
  assert.deepEqual(Object.keys(r).sort(), ['chat', 'responses']);
  const clearing = r.chat['openrouter:clearing'];
  assert.equal(clearing.requests, 1);
  assert.equal(clearing.input, 250);
  assert.equal(clearing.cachedInput, 200);
  assert.equal(clearing.cost, 0.0125);
  assert.equal(clearing.removedTokens, 1000);
  assert.deepEqual(r.chat['openrouter:holdout'].reasons, { holdout: 1 });
  // a partial cost keeps its sum and names its coverage: the dollars reported are real, the gap is stated
  const partial = chatReport([{ op: 'proxy', protocol: 'chat', injected: true, status: 200, cost: 0.5 }, { op: 'proxy', protocol: 'chat', injected: true, status: 200 }]);
  assert.equal(partial['gateway:clearing'].cost, 0.5);
  assert.equal(partial['gateway:clearing'].costRequests, 1);
});

test('HTTP transport routes by prefix, preserves auth, and logs the cut', async t => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'test-id' });
      res.end(chunk(openrouterUsage));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-chat-'));
  const logFile = path.join(dir, 'proxy.jsonl');
  const proxy = startProxy({
    ...proxyConfig({ 'gateway-openrouter': true }, {}),
    trigger: 1, clearAtLeast: 1, keepMin: 1,
    upstream: `http://127.0.0.1:${upstream.address().port}/api/v1`,
    gateways: { openrouter: { upstream: `http://127.0.0.1:${upstream.address().port}/api/v1` } },
  }, { logFile, clearingDir: path.join(dir, 'clearing'), compressionDir: path.join(dir, 'compression') });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.close(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = async endpoint => {
    const r = await fetch(`http://127.0.0.1:${proxy.address().port}${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer mock-only' }, body: raw() });
    assert.equal(await r.text(), chunk(openrouterUsage)); return r.status;
  };
  // what opencode sends with baseURL <proxy>/openrouter: it appends /chat/completions itself
  assert.equal(await send('/openrouter/chat/completions'), 200);
  assert.equal(await send('/openrouter/chat/completions'), 200);
  // nothing configured passes through as it came
  assert.equal(await send('/litellm/v1/chat/completions'), 200);
  assert.deepEqual(seen.map(x => x.url), ['/api/v1/chat/completions', '/api/v1/chat/completions', '/api/v1/litellm/v1/chat/completions']);
  assert.equal(seen[0].headers.authorization, 'Bearer mock-only');
  const sent = JSON.parse(seen[0].body);
  assert.equal(sent.messages[2].content, placeholder(history()[2].content.length));
  assert.deepEqual(sent.stream_options, { include_usage: true });
  const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const rows = log.filter(r => r.op === 'proxy');
  assert.equal(rows[0].protocol, 'chat');
  assert.equal(rows[0].gateway, 'openrouter');
  assert.equal(rows[0].usageRequested, true);
  assert.equal(rows[0].read, 200);
  assert.equal(rows[0].cost, 0.0125);
  assert.equal(rows[0].cleared > 0, true, 'the row carries the cut its request made');
  assert.equal(rows.length, 2, 'a gateway nobody configured is not a door and logs no row');
  assert.equal(seen[2].body, raw().toString(), 'the unconfigured prefix passes through exactly as it came');
  // the ratchet persisted: a restarted proxy re-applies the same set
  const store = JSON.parse(fs.readFileSync(path.join(dir, 'clearing', 'chat', `${rows[0].session.replace(/[^\w.-]/g, '_')}.json`), 'utf8'));
  assert.ok(store.cut.includes('a'));
});

test('candidates and apply agree with the Responses door on the recency rule', () => {
  const messages = history();
  const cand = chatCandidates(messages, { keepMin: 1 });
  assert.deepEqual(cand.ids, ['a']);
  const applied = applyChatCut(messages, new Set(['a', 'b']));
  assert.equal(applied.clearedUses, 2);
  assert.equal(applied.messages[2].content, placeholder(history()[2].content.length));
  assert.equal(applied.messages[4].content, history()[4].content, 'a result below the size floor stays');
});

test('the gateways\' own answers become the rates the next decision is priced with', async t => {
  // the account's own accounting, per call: fresh $1, read $0.1, write $2, out $3 per token
  const price = u => u.fresh + 0.1 * u.read + 2 * u.write + 3 * u.out;
  const usageFor = i => {
    const u = { fresh: 900 + i * 100, read: i % 3 === 0 ? 0 : 500 + (i % 5) * 200, write: i % 2 === 0 ? 0 : 100 + (i % 4) * 50, out: 20 + (i % 7) * 10 };
    return { prompt_tokens: u.fresh + u.read + u.write, completion_tokens: u.out, prompt_tokens_details: { cached_tokens: u.read, cache_write_tokens: u.write }, cost: Number(price(u).toFixed(6)) };
  };
  const upstream = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(chunk(usageFor(Number(body.messages[0].content.split(' ')[1]))));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-rates-'));
  const logFile = path.join(dir, 'proxy.jsonl');
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/api/v1`;
  const proxy = startProxy({
    ...proxyConfig({ 'gateway-openrouter': true }, {}),
    trigger: 1, clearAtLeast: 1, keepMin: 1,
    upstream: upstreamUrl, gateways: { openrouter: { upstream: upstreamUrl } },
  }, { logFile, clearingDir: path.join(dir, 'clearing'), compressionDir: path.join(dir, 'compression') });
  await new Promise(r => proxy.once('listening', r));
  t.after(() => { proxy.close(); upstream.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // nine one-off conversations, same model: the first eight feed the fit, the ninth is priced by it
  for (let i = 0; i < 9; i++) {
    const r = await fetch(`http://127.0.0.1:${proxy.address().port}/openrouter/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer mock-only' },
      body: raw([user(`task ${i}`), call('a'), result('a'), user('again'), call('b'), result('b', 'y'.repeat(300))]),
    });
    assert.equal(r.status, 200);
  }
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.op === 'proxy');
  assert.equal(rows[0].rates, undefined, 'nothing measured yet: the Anthropic defaults priced it, and no row pretends otherwise');
  const priced = rows[8].rates;
  assert.equal(priced.source, 'measured');
  assert.ok(Math.abs(priced.read - 0.1) < 1e-6, `read ${priced.read}`);
  assert.ok(Math.abs(priced.write - 2) < 1e-6, `write ${priced.write}`);
  assert.equal(priced.assumed, undefined);
  // the same rates ride the record, so the savings are read back at the prices they were priced at
  const store = JSON.parse(fs.readFileSync(path.join(dir, 'clearing', 'chat', `${rows[8].session.replace(/[^\w.-]/g, '_')}.json`), 'utf8'));
  assert.deepEqual(store.rates, priced);
});
