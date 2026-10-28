import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProxy, AUTH_REFUSALS, transformRequest, proxyConfig, proxyReport, heldOut, usageTap, clearEdit, turnToolUses, thinkingEdit, resultsBeforeTurn, EDIT_TYPE, EDIT_BETA, PROXY_DEFAULTS } from '../src/proxy.js';

const BETA = `oauth-2025-04-20,${EDIT_BETA},claude-code-20250219`;
const body = (extra = {}) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }],
  context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }, stream: true, ...extra }));
const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":90000,"cache_creation_input_tokens":2000,"output_tokens":1}}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42},"context_management":{"applied_edits":[{"type":"clear_tool_uses_20250919","cleared_tool_uses":4,"cleared_input_tokens":15626}]}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

function upstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const next = () => { if (i < SSE.length) { res.write(SSE[i++]); setImmediate(next); } else res.end(); };
      next();
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function proxyTo(url, cfg = {}) {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-proxy-')), 'proxy.jsonl');
  return new Promise(r => {
    const server = startProxy({ ...PROXY_DEFAULTS, upstream: url, ...cfg }, { logFile, onListen: a => r({ server, logFile, port: a.port }) });
  });
}

function send(port, { path: p = '/v1/messages?beta=true', headers = {}, data = body() } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-beta': BETA, 'x-claude-code-session-id': 's1', ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const until = async (f, ms = 2000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

test('appends the clearing edit after the agent\'s own and streams the answer through unchanged', async () => {
  const up = await upstream();
  const px = await proxyTo(up.url);
  try {
    const r = await send(px.port);
    assert.equal(r.status, 200);
    assert.equal(r.text, SSE.join(''));
    const sent = JSON.parse(up.seen[0].body);
    assert.equal(sent.context_management.edits[0].type, 'clear_thinking_20251015');
    assert.deepEqual(sent.context_management.edits[1], { type: EDIT_TYPE, trigger: { type: 'input_tokens', value: 100000 }, keep: { type: 'tool_uses', value: 3 }, clear_at_least: { type: 'input_tokens', value: 80000 } });
    assert.equal(up.seen[0].url, '/v1/messages?beta=true');
    assert.equal(up.seen[0].headers['anthropic-beta'], BETA);
    await until(() => rows(px.logFile).length);
    const [row] = rows(px.logFile);
    assert.equal(row.injected, true);
    assert.equal(row.session, 's1');
    assert.equal(row.read, 90000);
    assert.equal(row.out, 42);
    assert.equal(row.cleared, 15626);
    assert.equal(row.clearedUses, 4);
    assert.ok(!JSON.stringify(row).includes('hi'), 'no request content in the log');
  } finally { px.server.close(); up.server.close(); }
});

test('keep turn: the clear leaves the current turn\'s tool uses, never under keep-min', () => {
  const tu = id => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
  const tr = id => ({ type: 'tool_result', tool_use_id: id, content: 'x' });
  const messages = [
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: [tu('a'), tu('b')] }, { role: 'user', content: [tr('a'), tr('b')] },
    { role: 'assistant', content: [tu('c')] }, { role: 'user', content: [tr('c'), { type: 'text', text: '<system-reminder>a hook rode along</system-reminder>' }] },
    { role: 'user', content: [{ type: 'text', text: 'second request' }] },
    { role: 'assistant', content: [tu('d')] }, { role: 'user', content: [tr('d')] },
    { role: 'assistant', content: [tu('e'), tu('f'), tu('g'), tu('h')] }, { role: 'user', content: [tr('e'), tr('f'), tr('g'), tr('h')] },
  ];
  assert.equal(turnToolUses(messages), 5, 'the second turn\'s: a text block beside a tool result starts no turn');
  assert.equal(turnToolUses(messages.slice(0, 5)), 3);
  assert.equal(turnToolUses([]), 0);
  const cfg = proxyConfig({ keep: 'turn', 'keep-min': '3' }, {});
  assert.equal(cfg.keep, 'turn');
  assert.equal(cfg.keepMin, 3);
  assert.equal(clearEdit(cfg, messages).keep.value, 5);
  assert.equal(clearEdit(cfg, messages.slice(0, 3)).keep.value, 3, 'a turn of two tool uses keeps the minimum');
  assert.equal(clearEdit(proxyConfig({}, { THINKER_PROXY_KEEP: 'turn' }), messages).keep.value, 5, 'from the environment too');
  assert.equal(clearEdit(proxyConfig({ keep: '2' }, {}), messages).keep.value, 2, 'a count is a count');
  const t = transformRequest('POST', '/v1/messages', { 'anthropic-beta': BETA }, Buffer.from(JSON.stringify({ model: 'm', messages })), cfg);
  assert.equal(t.keep, 5);
  assert.equal(JSON.parse(t.body).context_management.edits[0].keep.value, 5);
});

test('forwards the bytes as they came when the edit cannot or should not be added', async () => {
  const cfg = PROXY_DEFAULTS;
  const h = { 'anthropic-beta': BETA, 'x-claude-code-session-id': 's1' };
  const raw = body();
  // a client that does not send the beta (pi, OpenCode, Goose: anything but Claude Code) gets the edit and the header
  const third = transformRequest('POST', '/v1/messages', { 'anthropic-beta': 'oauth-2025-04-20' }, raw, cfg);
  assert.deepEqual([third.injected, third.addBeta], [true, true]);
  assert.equal(transformRequest('POST', '/v1/messages', h, raw, cfg).addBeta, false);
  assert.equal(transformRequest('POST', '/v1/messages/count_tokens', h, raw, cfg).reason, 'other');
  assert.equal(transformRequest('GET', '/v1/messages', h, raw, cfg).reason, 'other');
  assert.equal(transformRequest('POST', '/v1/messages', h, Buffer.from('{not json'), cfg).reason, 'unparsed');
  const own = body({ context_management: { edits: [{ type: EDIT_TYPE }] } });
  const t = transformRequest('POST', '/v1/messages', h, own, cfg);
  assert.equal(t.reason, 'agent-clears');
  assert.equal(t.body, own);
  // no context_management at all: the edit is added on its own
  const bare = JSON.parse(transformRequest('POST', '/v1/messages', h, Buffer.from(JSON.stringify({ model: 'm', messages: [] })), cfg).body);
  assert.deepEqual(bare.context_management.edits.map(e => e.type), [EDIT_TYPE]);
});

test('a client without the beta header gets it added upstream, with the edit', async () => {
  const up = await upstream();
  const px = await proxyTo(up.url);
  try {
    assert.equal((await send(px.port, { headers: { 'anthropic-beta': 'oauth-2025-04-20' }, data: body({ context_management: undefined }) })).status, 200);
    assert.equal(up.seen[0].headers['anthropic-beta'], `oauth-2025-04-20,${EDIT_BETA}`);
    assert.deepEqual(JSON.parse(up.seen[0].body).context_management.edits.map(e => e.type), [EDIT_TYPE]);
    await until(() => rows(px.logFile).length);
    assert.deepEqual([rows(px.logFile)[0].injected, rows(px.logFile)[0].betaAdded], [true, true]);
  } finally { px.server.close(); up.server.close(); }
});

test('a held-out session keeps its side for every request', async () => {
  assert.equal(heldOut('s1', 0), false);
  assert.equal(heldOut('s1', 1), true);
  assert.equal(heldOut(null, 0.5), false);
  const sides = Array.from({ length: 400 }, (_, i) => heldOut(`session-${i}`, 0.25));
  const share = sides.filter(Boolean).length / sides.length;
  assert.ok(share > 0.15 && share < 0.35, `share ${share}`);
  for (let i = 0; i < 20; i++) assert.equal(heldOut(`session-${i}`, 0.25), sides[i]);
  const up = await upstream();
  const px = await proxyTo(up.url, { holdout: 1 });
  try {
    await send(px.port);
    assert.deepEqual(up.seen[0].body, body());
    await until(() => rows(px.logFile).length);
    assert.equal(rows(px.logFile)[0].reason, 'holdout');
  } finally { px.server.close(); up.server.close(); }
});

test('an unreachable API is an api_error the agent retries, not a hang', async () => {
  const dead = http.createServer();
  const port = await new Promise(r => dead.listen(0, '127.0.0.1', () => r(dead.address().port)));
  await new Promise(r => dead.close(r));
  const px = await proxyTo(`http://127.0.0.1:${port}`);
  try {
    const r = await send(px.port);
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.text).error.type, 'api_error');
  } finally { px.server.close(); }
});

test('a connection dropped before the answer is tried once more, unseen by the agent', async () => {
  let calls = 0;
  const flaky = http.createServer((req, res) => {
    calls++;
    req.resume();
    if (calls === 1) { req.socket.destroy(); return; }
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE.join('')); });
  });
  const port = await new Promise(r => flaky.listen(0, '127.0.0.1', () => r(flaky.address().port)));
  const px = await proxyTo(`http://127.0.0.1:${port}`);
  try {
    const r = await send(px.port);
    assert.equal(r.status, 200);
    assert.equal(r.text, SSE.join(''));
    assert.equal(calls, 2);
    await until(() => rows(px.logFile).some(x => x.op === 'proxy'));
    const [err, ok] = rows(px.logFile);
    assert.equal(err.op, 'proxy-error');
    assert.equal(err.retried, true);
    assert.equal(ok.retried, true);
  } finally { px.server.close(); flaky.close(); }
});

test('a second drop is the agent\'s api_error to retry', async () => {
  const dead = http.createServer((req, res) => { req.socket.destroy(); });
  const port = await new Promise(r => dead.listen(0, '127.0.0.1', () => r(dead.address().port)));
  const px = await proxyTo(`http://127.0.0.1:${port}`);
  try {
    const r = await send(px.port);
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.text).error.type, 'api_error');
    const errs = rows(px.logFile).filter(x => x.op === 'proxy-error');
    assert.deepEqual(errs.map(x => x.retried), [true, false]);
  } finally { px.server.close(); dead.close(); }
});

test('a request the agent cancelled is logged as a cancellation, not a failure', async () => {
  const slow = http.createServer(req => req.resume()); // never answers; the agent gives up first
  const port = await new Promise(r => slow.listen(0, '127.0.0.1', () => r(slow.address().port)));
  const px = await proxyTo(`http://127.0.0.1:${port}`);
  try {
    await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: px.port, path: '/v1/messages', method: 'POST' }, () => {});
      req.on('error', () => {});
      req.end(body());
      setTimeout(() => { req.destroy(); setTimeout(resolve, 300); }, 100);
    });
    const errs = rows(px.logFile).filter(x => x.op === 'proxy-error');
    assert.equal(errs.length, 1, 'one row, whichever stream reported the break first');
    assert.equal(errs[0].aborted, true, 'the agent left: nothing failed');
    assert.equal(errs[0].retried, false, 'nobody is waiting for the answer');
  } finally { px.server.close(); slow.close(); }
});

test('a name that does not resolve is tried once more before the agent sees an api_error', async () => {
  const px = await proxyTo('http://thinker-proxy-no-such-host.invalid');
  try {
    const r = await send(px.port);
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.text).error.type, 'api_error');
    const errs = rows(px.logFile).filter(x => x.op === 'proxy-error');
    assert.deepEqual(errs.map(x => x.code), ['ENOTFOUND', 'ENOTFOUND']);
    assert.deepEqual(errs.map(x => x.retried), [true, false], 'the resolver gets a second chance');
  } finally { px.server.close(); }
});

test('an answer that stops partway is a failure, and its usage row says the tokens are partial', async () => {
  const cut = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(SSE[0]);
      setTimeout(() => res.socket.destroy(), 30); // the answer stops after the first event
    });
  });
  const port = await new Promise(r => cut.listen(0, '127.0.0.1', () => r(cut.address().port)));
  const px = await proxyTo(`http://127.0.0.1:${port}`);
  try {
    await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: px.port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-beta': BETA, 'x-claude-code-session-id': 's1' } }, res => {
        res.on('data', () => {});
        res.on('error', () => {});
        res.on('close', () => setTimeout(resolve, 200));
      });
      req.on('error', () => {});
      req.end(body());
    });
    await until(() => rows(px.logFile).some(x => x.op === 'proxy'));
    const all = rows(px.logFile);
    const err = all.find(x => x.op === 'proxy-error'), use = all.find(x => x.op === 'proxy');
    assert.ok(err, 'a dropped answer used to be in no error count at all');
    assert.equal(err.truncated, true);
    assert.equal(err.retried, false, 'the agent already has part of the answer');
    assert.equal(use.truncated, true, 'the tokens on this row are only the ones that arrived');
    assert.equal(proxyReport(all).clearing.requestsTruncated, 1);
  } finally { px.server.close(); cut.close(); }
});

test('the report sums each side of the holdout in billed-equivalent input', () => {
  const report = proxyReport([
    { op: 'proxy', injected: true, session: 'a', input: 10, read: 1000, write: 100, out: 5, cleared: 500, overheadMs: 1 },
    { op: 'proxy', injected: true, session: 'a', input: 10, read: 2000, write: 0, out: 5, cleared: 0, overheadMs: 3 },
    { op: 'proxy', injected: false, reason: 'holdout', session: 'b', input: 0, read: 4000, write: 0, out: 1, overheadMs: 2 },
    { op: 'proxy', injected: false, reason: 'no-beta', session: 'c', read: 9 },
    { op: 'proxy-error', error: 'x' },
  ]);
  assert.deepEqual(Object.keys(report).sort(), ['clearing', 'holdout']);
  assert.equal(report.clearing.requests, 2);
  assert.equal(report.clearing.sessions, 1);
  assert.equal(report.clearing.billedInput, 20 + 300 + 200);
  assert.equal(report.clearing.cleared, 500);
  assert.equal(report.clearing.requestsCleared, 1);
  assert.equal(report.holdout.billedInput, 400);
});

test('flags win over the environment, the environment over the defaults', () => {
  const env = { THINKER_PROXY_TRIGGER: '50000', THINKER_PROXY_KEEP: '5', THINKER_PROXY_PORT: '7000' };
  const cfg = proxyConfig({ keep: '1', 'clear-at-least': '60000' }, env);
  assert.equal(cfg.trigger, 50000);
  assert.equal(cfg.keep, 1);
  assert.equal(cfg.clearAtLeast, 60000);
  assert.equal(cfg.port, 7000);
  assert.equal(cfg.upstream, 'https://api.anthropic.com');
  assert.equal(proxyConfig({}, {}).trigger, PROXY_DEFAULTS.trigger);
  // the default policy keeps the current turn's tool uses, three at least (the owner's decision on the replay, 2026-10-22)
  assert.equal(PROXY_DEFAULTS.keep, 'turn');
  assert.equal(proxyConfig({}, {}).keep, 'turn');
  assert.equal(proxyConfig({}, {}).keepMin, 3);
});

test('a plain JSON answer is read too', () => {
  const tap = usageTap();
  tap.push(Buffer.from(JSON.stringify({ usage: { input_tokens: 7, cache_read_input_tokens: 70, output_tokens: 3 }, context_management: { applied_edits: [] } })));
  const r = tap.result();
  assert.equal(r.input, 7);
  assert.equal(r.read, 70);
  assert.equal(r.cleared, 0);
});

test('clear-inputs and clear-thinking: off by default, the inputs on the edit, the thinking edit only where the tool clear fires by the proxy\'s count', () => {
  const tu = id => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
  const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
  const big = Math.ceil(100000 * 4 / 1.44); // 100k tokens of result text by the proxy's count
  const messages = [
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: [tu('a')] }, { role: 'user', content: [tr('a', big)] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: 'second request' }] },
    { role: 'assistant', content: [tu('b')] }, { role: 'user', content: [tr('b', 10)] },
    { role: 'assistant', content: [tu('c')] }, { role: 'user', content: [tr('c', 10)] },
  ];
  const off = proxyConfig({}, {});
  assert.equal(off.clearInputs, false); assert.equal(off.clearThinking, false);
  assert.equal(clearEdit(off, messages).clear_tool_inputs, undefined); assert.equal(thinkingEdit(off, messages), null);
  const on = proxyConfig({ 'clear-inputs': true, 'clear-thinking': true }, {});
  assert.equal(clearEdit(on, messages).clear_tool_inputs, true);
  assert.equal(resultsBeforeTurn(messages), 100000); assert.equal(resultsBeforeTurn(messages.slice(0, 4)), 0, 'the first turn has nothing before it');
  // the results before the second turn weigh 100k, over clearAtLeast (80k) with the margin: the thinking of the first turn
  // goes, the second turn's two assistant messages are kept
  assert.deepEqual(thinkingEdit(on, messages), { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 2 } });
  assert.equal(thinkingEdit(on, messages.slice(0, 6)).keep.value, 1, 'at least one turn, as the API requires');
  assert.equal(thinkingEdit(on, messages.slice(0, 4)), null, 'in the first turn nothing is clearable');
  assert.equal(thinkingEdit(proxyConfig({ 'clear-thinking': true, 'clear-at-least': '90000' }, {}), messages), null, '100k does not clear 90k by the margin of 1.25');
  assert.equal(thinkingEdit(proxyConfig({ 'clear-thinking': true, keep: '3' }, {}), messages), null, 'keep turn alone: a count keeps results of earlier turns');
  // in the request: the proxy's thinking edit first, in place of the agent's `keep: all`, the agent's other edits kept, the clear last
  const body = Buffer.from(JSON.stringify({ model: 'm', messages, context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } }));
  const t = transformRequest('POST', '/v1/messages', { 'anthropic-beta': BETA }, body, on);
  const edits = JSON.parse(t.body).context_management.edits;
  assert.deepEqual(edits.map(e => e.type), ['clear_thinking_20251015', EDIT_TYPE]);
  assert.deepEqual(edits[0].keep, { type: 'thinking_turns', value: 2 }); assert.equal(edits[1].clear_tool_inputs, true);
  assert.equal(t.inputs, true); assert.equal(t.thinkingKeep, 2);
  const early = transformRequest('POST', '/v1/messages', { 'anthropic-beta': BETA }, Buffer.from(JSON.stringify({ model: 'm', messages: messages.slice(0, 4), context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } })), on);
  assert.deepEqual(JSON.parse(early.body).context_management.edits[0], { type: 'clear_thinking_20251015', keep: 'all' }, 'where no thinking edit is due the agent\'s stays');
  assert.equal(early.thinkingKeep, undefined);
  // from the environment, and the service passes the two as flags from the machine config
  assert.equal(proxyConfig({}, { THINKER_PROXY_CLEAR_INPUTS: 'on', THINKER_PROXY_CLEAR_THINKING: '1' }).clearThinking, true);
  assert.equal(proxyConfig({}, { THINKER_PROXY_CLEAR_INPUTS: 'off' }).clearInputs, false);
});

// A proxy somebody pointed at an upstream of their own (`--upstream`, a benchmark arm, a gateway) must never
// read a refusal there as thinker having broken a routed harness: the credentials are theirs to match.
test('an upstream of the person\'s own is never judged: refusals there stand nothing down', async () => {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"authentication_error","message":"invalid bearer token"}}'); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const stood = [];
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-proxy-')), 'proxy.jsonl');
  const px = await new Promise(r => { const s = startProxy({ ...PROXY_DEFAULTS, upstream: `http://127.0.0.1:${server.address().port}` }, { logFile, onStandDown: reason => stood.push(reason), onListen: a => r({ server: s, port: a.port }) }); });
  try {
    for (let i = 0; i < AUTH_REFUSALS + 1; i++) {
      const r = await send(px.port, { headers: { authorization: 'Bearer gw_live_123' } });
      assert.equal(r.status, 401, 'the upstream\'s own answer reaches the agent');
    }
    assert.deepEqual(stood, []);
    assert.deepEqual(rows(logFile).filter(r => r.op === 'proxy-standdown'), []);
  } finally { px.server.close(); server.close(); }
});

// A model server of the person's own need not speak the context-management beta. The edit must not cost them
// every call: the proxy sends the request again as the agent wrote it, and stops adding the edit.
test('a gateway that refuses the clearing edit gets the agent\'s own bytes, once, and no edit after that', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const edits = body.context_management?.edits || [];
      seen.push({ edits: edits.map(e => e.type), beta: req.headers['anthropic-beta'] });
      if (edits.some(e => e.type === EDIT_TYPE)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"context_management: unsupported"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"m","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":5,"output_tokens":1}}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const px = await proxyTo(`http://127.0.0.1:${server.address().port}`, { trigger: 0, clearAtLeast: 0 });
  try {
    const first = await send(px.port, { data: body({ stream: false }) });
    assert.equal(first.status, 200, 'the agent gets an answer, not the refusal');
    assert.match(first.text, /"ok"/);
    assert.deepEqual(seen[0].edits.includes(EDIT_TYPE), true, 'the first try carried the edit');
    assert.deepEqual(seen[1].edits.includes(EDIT_TYPE), false, 'the second went as the agent wrote it');
    const second = await send(px.port, { data: body({ stream: false }) });
    assert.equal(second.status, 200);
    assert.equal(seen.length, 3, 'no second try needed');
    assert.deepEqual(seen[2].edits.includes(EDIT_TYPE), false, 'and the edit is not added again');
    const r = rows(px.logFile);
    assert.equal(r.filter(x => x.op === 'proxy-edit-rejected').length, 1);
    assert.deepEqual(r.filter(x => x.op === 'proxy').map(x => x.reason), ['edit-unsupported', 'edit-unsupported']);
  } finally { px.server.close(); server.close(); }
});
