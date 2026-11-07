// Bedrock's Anthropic-compatible /anthropic/v1/messages endpoint, using a token.
// Loopback only: no AWS credentials, setup, SDK, or network model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProxy, PROXY_DEFAULTS, cutPlaceholder } from '../src/proxy.js';

const MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_bedrock_mock","type":"message","role":"assistant","content":[],"model":"' + MODEL + '","usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"READY"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

function fixture() {
  const messages = [{ role: 'user', content: 'Read ten records.' }];
  for (let i = 0; i < 10; i++) messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `read_${i}`, name: 'Read', input: { file_path: `/fixture/${i}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `read_${i}`, content: `Record ${i}: synthetic compatibility fixture.\n`.repeat(100) }] },
  );
  messages.push({ role: 'assistant', content: 'The records have been read.' }, { role: 'user', content: 'Reply READY.' });
  return { model: MODEL, max_tokens: 64, stream: true,
    tools: [{ name: 'Read', description: 'Read a record.', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }], messages };
}

async function harness(t, reply = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-bedrock-mock-'));
  const seen = [], standDown = [];
  let proxy;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(reply.status || 200, { 'content-type': reply.type || 'text/event-stream', 'x-amzn-requestid': 'mock-request-id' });
    const body = reply.body || SSE;
    // Split in the middle of an SSE event: the proxy must preserve the stream.
    res.write(body.slice(0, 71));
    setImmediate(() => res.end(body.slice(71)));
  });
  t.after(async () => { if (proxy) await close(proxy); await close(upstream); fs.rmSync(work, { recursive: true, force: true }); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  return {
    seen, standDown,
    async start(overrides = {}) {
      if (proxy) { await close(proxy); proxy = null; }
      return new Promise(resolve => {
        proxy = startProxy({ ...PROXY_DEFAULTS, protocol: 'anthropic',
          upstream: `http://127.0.0.1:${upstream.address().port}/anthropic`,
          // Exercise transport with a small fixture, leaving production policy unchanged.
          trigger: 1, clearAtLeast: 1, holdout: 0, ...overrides }, {
          logFile: path.join(work, 'proxy.jsonl'), stubsHome: work,
          onStandDown: reason => standDown.push(reason),
          onListen: a => resolve(`http://127.0.0.1:${a.port}`),
        });
      });
    },
  };
}

async function send(url, body, auth) {
  const response = await fetch(`${url}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01',
      'x-claude-code-session-id': 'bedrock-mock-session', ...auth },
    body, signal: AbortSignal.timeout(5000) });
  return { status: response.status, type: response.headers.get('content-type'),
    requestId: response.headers.get('x-amzn-requestid'), text: await response.text() };
}

for (const auth of [{ 'x-api-key': 'bedrock-api-key-mock' }, { authorization: 'Bearer bedrock-api-key-mock' }]) {
  test(`Bedrock Messages token (${Object.keys(auth)[0]}) survives a cut and restart without re-signing`, async t => {
    const h = await harness(t);
    const original = fixture(), wire = JSON.stringify(original);
    let url = await h.start({ holdout: 1 });
    const baseline = await send(url, wire, auth);
    assert.deepEqual(baseline, { status: 200, type: 'text/event-stream', requestId: 'mock-request-id', text: SSE });
    assert.equal(h.seen[0].body, wire, 'holdout forwards the original bytes');
    url = await h.start();
    assert.deepEqual(await send(url, wire, auth), baseline);
    const expected = structuredClone(original);
    for (let i = 0; i < 7; i++) {
      const result = expected.messages[2 + i * 2].content[0];
      result.content = [{ type: 'text', text: cutPlaceholder(result.content.length) }];
    }
    assert.deepEqual(JSON.parse(h.seen[1].body), expected, 'only seven old tool results change; three newest, calls, prompts and model stay');
    assert.deepEqual(await send(url, wire, auth), baseline);
    assert.equal(h.seen[2].body, h.seen[1].body, 'same turn keeps exactly the same bytes');
    url = await h.start({ trigger: 1e9, clearAtLeast: 1e9 });
    assert.deepEqual(await send(url, wire, auth), baseline);
    assert.equal(h.seen[3].body, h.seen[1].body, 'persisted cuts survive restart even when new cuts are refused');
    assert.equal(h.seen.length, 4);
    for (const request of h.seen) {
      assert.equal(request.url, '/anthropic/v1/messages');
      assert.equal(request.headers['anthropic-version'], '2023-06-01');
      assert.equal(request.headers['x-api-key'], auth['x-api-key']);
      assert.equal(request.headers.authorization, auth.authorization);
      assert.equal(request.headers['x-amz-date'], undefined);
      assert.equal(request.headers['x-amz-security-token'], undefined);
      assert.equal(request.headers['x-amz-content-sha256'], undefined);
    }
    assert.deepEqual(h.standDown, []);
  });
}

test('Bedrock access refusal reaches the client once, without switching routes or standing down', async t => {
  const body = JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'Model access is not enabled.' } });
  const h = await harness(t, { status: 403, type: 'application/json', body });
  const url = await h.start();
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await send(url, JSON.stringify(fixture()), { 'x-api-key': 'bedrock-api-key-mock' }),
      { status: 403, type: 'application/json', requestId: 'mock-request-id', text: body });
  }
  assert.equal(h.seen.length, 3, 'no retry of an access refusal');
  assert.deepEqual(h.standDown, [], 'foreign credentials are valid on an explicitly configured upstream');
});
