import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProxy, AUTH_REFUSALS, refusesEdit, rewriteWarning, LONG_CONTEXT, transformRequest, proxyConfig, proxyReport, heldOut, usageTap, cutCandidates, applyCut, cutActions, EDIT_BETA, PROXY_DEFAULTS } from '../src/proxy.js';
import { isRewrite, freshCut, cutResponse } from '../src/cutting.js';
// the type Claude Code's own tool clearing goes by: the proxy recognises it to stand aside, never sends it
const AGENT_CLEAR = 'clear_tool_uses_20250919';

const BETA = `oauth-2025-04-20,${EDIT_BETA},claude-code-20250219`;
const body = (extra = {}) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }],
  context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] }, stream: true, ...extra }));
// A conversation with results old enough to cut. The server-side edit went on every request whatever the
// conversation held; a cut needs something to replace, so the tests that want one say so.
const cuttable = (extra = {}) => {
  // ten results, so with keepMin 3 the seven droppable ones outweigh the rewrite at Opus 5.5's read rate
  // (a twentieth of an input token): a thinner fixture is declined on price, which is the policy working.
  const ms = [{ role: 'user', content: 'hi' }];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) ms.push(
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/x/${id}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(40000) }] });
  ms.push({ role: 'user', content: [{ type: 'text', text: 'next' }] });
  return Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: ms, stream: true, ...extra }));
};
const CUTS = { trigger: 0, clearAtLeast: 0 };   // so a test fixture is big enough to be worth cutting
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

function proxyTo(url, cfg = {}, opts = {}) {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-proxy-')), 'proxy.jsonl');
  return new Promise(r => {
    const server = startProxy({ ...PROXY_DEFAULTS, upstream: url, ...cfg }, { logFile, ...opts, onListen: a => r({ server, logFile, port: a.port }) });
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



test('forwards the bytes as they came when the edit cannot or should not be added', async () => {
  const cfg = PROXY_DEFAULTS;
  const h = { 'anthropic-beta': BETA, 'x-claude-code-session-id': 's1' };
  const raw = body();
  // the cut asks nothing of the API, so no beta header is needed by any client (pi, OpenCode, Goose included)
  const big = cuttable();
  const third = transformRequest('POST', '/v1/messages', { 'anthropic-beta': 'oauth-2025-04-20' }, big, { ...cfg, ...CUTS });
  assert.deepEqual([third.injected, third.addBeta], [true, false]);
  assert.equal(transformRequest('POST', '/v1/messages', h, raw, cfg).addBeta, undefined);
  assert.equal(transformRequest('POST', '/v1/messages', h, raw, cfg).reason, 'nothing-to-cut', 'nothing to replace: as it came');
  assert.equal(transformRequest('POST', '/v1/messages/count_tokens', h, raw, cfg).reason, 'other');
  assert.equal(transformRequest('GET', '/v1/messages', h, raw, cfg).reason, 'other');
  assert.equal(transformRequest('POST', '/v1/messages', h, Buffer.from('{not json'), cfg).reason, 'unparsed');
  const own = body({ context_management: { edits: [{ type: AGENT_CLEAR }] } });
  const t = transformRequest('POST', '/v1/messages', h, own, cfg);
  assert.equal(t.reason, 'agent-clears');
  assert.equal(t.body, own);
  // nothing is ever asked of the API now, so an empty conversation is forwarded as it came
  const bare = transformRequest('POST', '/v1/messages', h, Buffer.from(JSON.stringify({ model: 'm', messages: [] })), cfg);
  assert.equal(bare.reason, 'nothing-to-cut');
  assert.equal(JSON.parse(bare.body).context_management, undefined);
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
      req.end(cuttable());
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
  const px = await proxyTo(`http://127.0.0.1:${port}`, { ...CUTS });
  try {
    await new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port: px.port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'anthropic-beta': BETA, 'x-claude-code-session-id': 's1' } }, res => {
        res.on('data', () => {});
        res.on('error', () => {});
        res.on('close', resolve);
      });
      req.on('error', () => {});
      req.end(cuttable());
    });
    // Wait for both rows the assertions below read, rather than 200 ms and a hope: the error row and the
    // usage row are written independently, so a short wait left `err` undefined and failed on a property
    // of it instead of saying what was missing.
    await until(() => { const r = rows(px.logFile); return r.some(x => x.op === 'proxy') && r.some(x => x.op === 'proxy-error'); });
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
  assert.equal(cfg.clearAtLeast, 60000);
  assert.equal(cfg.port, 7000);
  assert.equal(cfg.upstream, 'https://api.anthropic.com');
  assert.equal(proxyConfig({}, {}).trigger, PROXY_DEFAULTS.trigger);
  // The newest turn is kept by a rule (cutting.js, applyCut), not by a count sent to the API: `keep` is gone
  // and keepMin is only a floor for a short turn. The count was what let three echoes evict a 25k read.
  assert.equal(PROXY_DEFAULTS.keep, undefined);
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
      // the placeholder's own opening, so a reworded placeholder does not fail this
      const mark = cutPlaceholder(0).split(':')[0];
      const cut = JSON.stringify(body.messages || []).includes(mark);
      seen.push({ cut, beta: req.headers['anthropic-beta'] });
      if (cut) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"invalid_request_error","message":"context_management: unsupported"}}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"m","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":5,"output_tokens":1}}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const px = await proxyTo(`http://127.0.0.1:${server.address().port}`, { trigger: 0, clearAtLeast: 0 });
  try {
    const first = await send(px.port, { data: cuttable({ stream: false }) });
    assert.equal(first.status, 200, 'the agent gets an answer, not the refusal');
    assert.match(first.text, /"ok"/);
    assert.equal(seen[0].cut, true, 'the first try carried the cut');
    assert.equal(seen[1].cut, false, 'the second went as the agent wrote it');
    const second = await send(px.port, { data: cuttable({ stream: false }) });
    assert.equal(second.status, 200);
    assert.equal(seen.length, 3, 'no second try needed');
    assert.equal(seen[2].cut, false, 'and nothing is cut again');
    const r = rows(px.logFile);
    assert.equal(r.filter(x => x.op === 'proxy-cut-rejected').length, 1);
    assert.deepEqual(r.filter(x => x.op === 'proxy').map(x => x.reason), ['cut-rejected', 'cut-rejected']);
  } finally { px.server.close(); server.close(); }
});

// A gateway answers 400 for its own reasons too. Taking any of them for a refusal of the edit switched the
// clearing off for good and sent the failing request twice (LiteLLM over a model name, 2026-10-28).
test('a 400 that is not about the edit reaches the agent as it came, once, and the edit is still added after it', async () => {
  let seen = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen++;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"invalid_request_error","message":"anthropic_messages: Invalid model name passed in model=claude-opus-5-5. Call `/v1/models` to view available models for your key."}}');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const px = await proxyTo(`http://127.0.0.1:${server.address().port}`, { trigger: 0, clearAtLeast: 0 });
  try {
    const r1 = await send(px.port, { data: cuttable({ stream: false }) });
    assert.equal(r1.status, 400, 'the gateway\'s own answer');
    assert.match(r1.text, /Invalid model name/, 'word for word, nothing invented');
    assert.equal(seen, 1, 'and sent once, not twice');
    const r2 = await send(px.port, { data: cuttable({ stream: false }) });
    assert.equal(r2.status, 400);
    assert.equal(seen, 2);
    const r = rows(px.logFile);
    assert.deepEqual(r.filter(x => x.op === 'proxy-cut-rejected'), [], 'nothing concluded about the cut');
    assert.deepEqual(r.filter(x => x.op === 'proxy').map(x => x.injected), [true, true], 'the clearing is still being tried');
  } finally { px.server.close(); server.close(); }
});

test('refusesEdit: the field or the beta header named, not every 400', () => {
  assert.equal(refusesEdit('{"error":{"message":"context_management: unsupported"}}'), true);
  assert.equal(refusesEdit('{"detail":[{"type":"extra_forbidden","loc":["body","context_management"]}]}'), true);
  assert.equal(refusesEdit('unsupported anthropic-beta: context-management-2025-06-27'), true);
  assert.equal(refusesEdit('{"error":{"message":"Invalid model name passed in model=claude-opus-5-5"}}'), false);
  assert.equal(refusesEdit('{"error":{"message":"budget exceeded for key"}}'), false);
  assert.equal(refusesEdit('{"error":{"message":"tools.0.input_schema: unknown field foo"}}'), false);
  assert.equal(refusesEdit(''), false);
  assert.equal(refusesEdit(null), false);
});

// What the keep that grew with the turn did (2026-11-02): a parameter that differs from one call of a turn to the next
// makes the server edit the conversation differently each time, the cached prefix never matches again, and every call
// writes the prefix over (152 running in one session). The rule: whatever the proxy adds to a request must be the same
// on every call of a turn, and an edit that cannot be is not on by default. The policy itself is test/clearing.test.js.
test('what the proxy adds to a request is identical from one call of a turn to the next, for everything on by default', () => {
  const tu = id => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
  const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
  // a first turn heavy enough for every clear to fire by the proxy's own count, then a long second turn
  const messages = [{ role: 'user', content: 'first request' }];
  // ten results in the first turn, so keepMin 3 leaves seven to cut and the cut is worth its rewrite
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    messages.push({ role: 'assistant', content: [tu(id)] }, { role: 'user', content: [tr(id, 80000)] });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'second request' }] });
  for (let i = 0; i < 12; i++) messages.push({ role: 'assistant', content: [tu(`t${i}`)] }, { role: 'user', content: [tr(`t${i}`, 3000)] });
  // one record across the calls, written after each answer, as startProxy does
  const turnOf = (cfg, from, to) => {
    const rec = freshCut('s');
    const out = [];
    for (let k = from; k <= to; k++) {
      const t = transformRequest('POST', '/v1/messages', { 'anthropic-beta': BETA }, Buffer.from(JSON.stringify({ model: 'm', messages: messages.slice(0, k) })), { ...cfg, cutRecord: rec });
      assert.equal(t.injected, true, `call ${k} carries the cut`);
      cutResponse(rec, cfg, t, { read: 1, write: 1, input: 1, out: 1 });
      // what the proxy adds is the edited conversation itself: the same bytes on every call of the turn
      out.push(JSON.stringify(JSON.parse(t.body).messages.slice(0, messages.findIndex(m => Array.isArray(m.content) && m.content[0]?.type === 'text') + 1)));
    }
    return out;
  };
  const TURN2 = 22;                      // messages[21] is 'second request'; its first call carries 22
  const seen = turnOf({ ...proxyConfig({}, {}), ...CUTS }, TURN2, messages.length);
  for (let i = 1; i < seen.length; i++) assert.equal(seen[i], seen[0], `call ${TURN2 + i} of the turn sends what the first did`);
  // with clearDeep off the set is decided once a session, so the bytes hold across turns too
  const once = turnOf({ ...proxyConfig({ 'clear-deep': false }, {}), ...CUTS }, TURN2, messages.length);
  for (let i = 1; i < once.length; i++) assert.equal(once[i], once[0], 'one cut a session holds as well');
  // Everything the proxy does is in the bytes above: it replaces results and touches nothing else, so there
  // is no edit whose parameter could drift. The two piggybacks that could -- emptying the older call text
  // and shedding their thinking -- are gone from both doors (2026-11-04): worth 0.6% and nothing, and the
  // first taught the model it called tools without arguments.
  assert.equal(PROXY_DEFAULTS.clearInputs, undefined, 'the call text is never emptied');
  assert.equal(PROXY_DEFAULTS.clearThinking, undefined, 'thinking is never dropped');
});


test('the report counts prefix rewrites after a clear beside the held-out rate, and warns when the clearing breaks the cache', () => {
  const at = i => new Date(1e12 + i * 1000).toISOString();
  const hit = (session, i, extra = {}) => ({ at: at(i), op: 'proxy', session, injected: true, input: 2, read: 200000, write: 2000, cleared: 140000, ...extra });
  const rewrite = (session, i, extra = {}) => ({ at: at(i), op: 'proxy', session, injected: true, input: 2, read: 31520, write: 160000, cleared: 140000, ...extra });
  const held = (session, i, extra = {}) => ({ at: at(i), op: 'proxy', session, reason: 'holdout', input: 2, read: 200000, write: 2000, ...extra });
  let i = 0;
  const good = [];
  for (let s = 0; s < 4; s++) { good.push(hit(`c${s}`, i++, { cleared: 0, write: 150000, read: 31520 })); for (let k = 0; k < 20; k++) good.push(hit(`c${s}`, i++)); }
  for (let s = 0; s < 2; s++) for (let k = 0; k < 15; k++) good.push(held(`h${s}`, i++));
  const g = proxyReport(good);
  assert.deepEqual(g.clearing.rewrites, { before: { calls: 4, rewrites: 4 }, after: { calls: 80, rewrites: 0 } }, 'the clear is the one rewrite, before the first cleared call lands');
  assert.deepEqual(g.holdout.rewrites.before, { calls: 30, rewrites: 0 });
  assert.equal(g.warning, undefined);
  assert.equal(rewriteWarning(g), null);
  const bad = [...good];
  for (let s = 0; s < 2; s++) for (let k = 0; k < 40; k++) bad.push(rewrite(`b${s}`, i++));
  const b = proxyReport(bad);
  assert.deepEqual(b.clearing.rewrites.after, { calls: 160, rewrites: 80 });
  assert.match(b.warning, /50% of 160 calls over 100k of context against 0% without a clear/);
  assert.match(b.warning, /breaking the cache/);
  // short calls are not counted: a rewrite of a small prefix is a fresh subagent, not a cost
  assert.deepEqual(proxyReport([rewrite('x', 1, { read: 1000, write: 60000 })]).clearing.rewrites.after, { calls: 0, rewrites: 0 });
  assert.equal(LONG_CONTEXT, 100000);
  // a few percent after a clear is a clear per new turn, the policy working: no warning without a base to beat
  const some = [...good]; for (let k = 0; k < 6; k++) some.push(rewrite('c0', i++));
  assert.equal(proxyReport(some).warning, undefined);
});

test('THINKER_PROXY_DUMP writes every request as sent, with the edit and the usage, one file a call under the session (research only)', async () => {
  const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-dump-'));
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_read_input_tokens":1000,"cache_creation_input_tokens":500,"output_tokens":1}}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const up = http.createServer((req, res) => { req.on('data', () => {}); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const s of sse) res.write(s); res.end(); }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const { server, logFile, port } = await proxyTo(`http://127.0.0.1:${up.address().port}`, { ...CUTS }, { dumpDir });
  try {
    await send(port, { data: cuttable() }); await until(() => rows(logFile).filter(r => r.op === 'proxy').length === 1);
    await until(() => fs.existsSync(path.join(dumpDir, 's1')) && fs.readdirSync(path.join(dumpDir, 's1')).length === 1);
    const d = JSON.parse(fs.readFileSync(path.join(dumpDir, 's1', fs.readdirSync(path.join(dumpDir, 's1'))[0]), 'utf8'));
    assert.equal(d.injected, true); assert.equal(d.keep, PROXY_DEFAULTS.keepMin);
    assert.equal(d.usage.read, 1000); assert.equal(d.usage.write, 500);
    assert.equal(d.sent.context_management, undefined, 'nothing is asked of the API');
    assert.ok(Array.isArray(d.sent.messages) && d.sent.messages.length > 0);
  } finally { server.close(); up.close(); fs.rmSync(dumpDir, { recursive: true, force: true }); }
});

