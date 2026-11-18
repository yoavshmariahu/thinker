// A held-out session is the control of every measurement the clearing has, so the proxy may do nothing to it:
// not a cut, not the thinking, not a cache breakpoint of its own, not a header, not a record on disk.
//
// What this holds, with every default on (results, call text, images, the breakpoint, the thinking): the same
// conversation, sent as three requests of a long session, reaches the API byte for byte from a held-out
// session, while the session beside it is acted on -- which is what shows the fixture was worth acting on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startProxy, transformRequest, heldOut, PROXY_DEFAULTS } from '../src/proxy.js';
import { freshCut } from '../src/cutting.js';

const BETA = 'oauth-2025-04-20,claude-code-20250219';
const think = n => ({ type: 'thinking', thinking: '', signature: 'T'.repeat(n) });
// `turns` finished turns of a thinking call, a 40k result and a thinking answer, then the prompt of the next
function conversation(turns) {
  const ms = [];
  for (let k = 0; k < turns; k++) ms.push(
    { role: 'user', content: [{ type: 'text', text: `prompt ${k}` }] },
    { role: 'assistant', content: [think(6000), { type: 'tool_use', id: `r${k}`, name: 'Read', input: { file_path: `/p/${k}`, note: 'n'.repeat(3000) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `r${k}`, content: 'x'.repeat(40000) }] },
    { role: 'assistant', content: [think(6000), { type: 'text', text: `answer ${k}` }] });
  ms.push({ role: 'user', content: [{ type: 'text', text: 'the live turn', cache_control: { type: 'ephemeral' } }] });
  return Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: ms }));
}
const REQUESTS = [conversation(14), conversation(15), conversation(16)];

function upstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":200000,"cache_creation_input_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const proxyTo = (url, cfg) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-holdout-')), logFile = path.join(dir, 'proxy.jsonl');
  return new Promise(r => { const server = startProxy({ ...PROXY_DEFAULTS, upstream: url, ...cfg }, { logFile, onListen: a => r({ server, dir, logFile, port: a.port }) }); });
};
const send = (port, session, data) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages?beta=true', method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-beta': BETA, 'x-claude-code-session-id': session } }, res => { res.resume(); res.on('end', resolve); });
  req.on('error', reject);
  req.end(data);
});
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.op === 'proxy') : [];
const until = async f => { const t = Date.now(); while (!f()) { if (Date.now() - t > 3000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const files = dir => fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.json'));

test('the defaults are the ones this is about: everything on, the thinking included', () => {
  for (const k of ['cutInputs', 'cutImages', 'cutBreakpoint', 'cutThinking', 'clearDeep']) assert.equal(PROXY_DEFAULTS[k], true, k);
});

test('a held-out request is the very buffer that came in, whatever the conversation holds', () => {
  const cfg = { ...PROXY_DEFAULTS, holdout: 1, protocol: 'anthropic' };
  for (const body of REQUESTS) {
    let asked = 0;
    const t = transformRequest('POST', '/v1/messages?beta=true', { 'x-claude-code-session-id': 'held' }, body, { ...cfg, readCut: () => { asked++; return freshCut('held'); } });
    assert.equal(t.body, body, 'the same object: not parsed and written again, which could move a byte');
    assert.equal(t.reason, 'holdout');
    assert.equal(asked, 0, 'the cut record is never read, so never reserved or written');
    for (const k of ['cut', 'think', 'seed', 'mark', 'clear', 'clientCut', 'injected', 'addBeta', 'turn']) assert.equal(k in t, false, `no ${k}`);
  }
});

test('through the proxy: a held-out session reaches the API byte for byte, and the session beside it does not', async () => {
  const up = await upstream();
  const held = await proxyTo(up.url, { holdout: 1 }), cut = await proxyTo(up.url, { holdout: 0 });
  try {
    for (const body of REQUESTS) await send(held.port, 'a-session', body);
    const got = up.seen.splice(0);
    assert.equal(got.length, REQUESTS.length);
    got.forEach((g, i) => {
      assert.ok(g.body.equals(REQUESTS[i]), `request ${i + 1} is byte for byte what the agent sent`);
      assert.equal(g.headers['anthropic-beta'], BETA, 'and the beta header is the agent\'s own');
    });
    await until(() => rows(held.logFile).length === REQUESTS.length);
    for (const r of rows(held.logFile)) {
      assert.equal(r.reason, 'holdout');
      for (const k of ['clear', 'clientCut', 'mark', 'cleared', 'seed']) assert.ok(!r[k], `the row carries no ${k}`);
      assert.ok(!r.injected);
    }
    assert.deepEqual(files(held.dir), [], 'nothing is kept on disk for the session: no cut record, no reservation');

    // the control of the control: the same three requests, not held out, are acted on
    for (const body of REQUESTS) await send(cut.port, 'a-session', body);
    const acted = up.seen.splice(0);
    assert.ok(acted.some((g, i) => !g.body.equals(REQUESTS[i])), 'so the fixture is one the proxy would have changed');
    await until(() => rows(cut.logFile).length === REQUESTS.length);
    assert.ok(rows(cut.logFile).some(r => r.mark || r.injected), 'by a breakpoint of its own or a cut');
  } finally { held.server.close(); cut.server.close(); up.server.close(); fs.rmSync(held.dir, { recursive: true, force: true }); fs.rmSync(cut.dir, { recursive: true, force: true }); }
});

test('the side is the session\'s for good: every request of a session falls the same way', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `session-${i}`);
  const sides = ids.map(s => heldOut(s, 0.5));
  const share = sides.filter(Boolean).length / ids.length;
  assert.ok(share > 0.4 && share < 0.6, `about half, by hash: ${share}`);
  ids.forEach((s, i) => { for (let n = 0; n < 3; n++) assert.equal(heldOut(s, 0.5), sides[i]); });
  assert.equal(ids.some(s => heldOut(s, 0)), false, 'and with no holdout nobody is held out');
});
