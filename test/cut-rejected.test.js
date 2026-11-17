// The API refusing a conversation thinker rewrote: the one failure mode the client-side cut has and the
// server-side clearing did not.
//
// Until the cut moved client-side (2026-11-05) a refusal could only be a gateway that did not know the
// `context_management` field, and `refusesEdit` is written in that vocabulary. thinker rewrites the history itself
// now, so the API can refuse the history -- and a preserved-thinking refusal names none of the words `refusesEdit`
// looks for, so it reached the agent as its own 400 and nothing stood down. These tests hold the two apart: what
// counts as an explicit refusal, what scope each one stops, and that the figure reaches the dashboard.
//
// Why it matters for #797: a pruned tool RESULT has a sanctioned client-side form; a rewritten tool_use INPUT has
// none -- its only listed remedy is to echo the input exactly as received. Cutting a call's own text is therefore
// the half of a cut this check names, which is why the valve had to exist before that shipped on by default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProxy, refusesEdit, refusesHistory, proxyReport, PROXY_DEFAULTS, EDIT_BETA } from '../src/proxy.js';
import { proxyMetrics } from '../src/telemetry.js';

const BETA = `oauth-2025-04-20,${EDIT_BETA},claude-code-20250219`;
const cuttable = () => {
  const ms = [{ role: 'user', content: 'hi' }];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) ms.push(
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'rg '.repeat(400) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(40000) }] });
  ms.push({ role: 'user', content: [{ type: 'text', text: 'next' }] });
  return Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: ms, stream: false }));
};
const proxyTo = (url, cfg = {}) => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-rej-')), 'proxy.jsonl');
  return new Promise(r => {
    const server = startProxy({ ...PROXY_DEFAULTS, upstream: url, trigger: 0, clearAtLeast: 0, ...cfg },
      { logFile, onListen: a => r({ server, logFile, port: a.port }) });
  });
};
const send = (port, session) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-beta': BETA, 'x-claude-code-session-id': session } }, res => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', reject);
  req.end(cuttable());
});
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const OK = '{"id":"m","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":5,"output_tokens":1}}';
const err = m => `{"type":"error","error":{"type":"invalid_request_error","message":${JSON.stringify(m)}}}`;
// the refusal that matters: the check names the field it will not take a rewrite of
const HISTORY = 'messages.4.content.0: tool_use_rewritten - tool_use.input does not match the input received when the thinking block in this conversation was produced';

// What an explicit refusal is. The October lesson was the expensive one: a real router answered 400 over a model
// name it did not know, that was taken for a refusal of the edit, and the clearing stopped over an unrelated error
// while every failing request went twice. So this must name the check, not merely be a 400 near a cut.
test('a refusal of the rewritten history is recognised by name, and nothing else is', () => {
  assert.equal(refusesHistory(HISTORY), true, 'the field is named and so is what was wrong with it');
  for (const body of [
    'prefix_mismatch: the conversation prefix differs from the one the thinking block was bound to',
    '{"error":{"message":"tool_results_rewritten: message 3 was modified"}}',
    'thinking block mismatch: messages.2 altered since the block was produced',
  ]) assert.equal(refusesHistory(body), true, body.slice(0, 40));
  // a 400 of the agent's own, which may never stop the cutting
  for (const body of [
    'Invalid model name passed in model=claude-opus-5-5. Call `/v1/models` to view available models for your key.',
    'rate_limit_error: too many requests',
    'messages.3: thinking blocks are supported on this model',   // says `thinking block` and no verdict
    'messages: at least one message is required',
    'credit balance is too low',
  ]) assert.equal(refusesHistory(body), false, body.slice(0, 40));
  // and the two refusals stay apart: the older one is about a field a gateway cannot take at all
  assert.equal(refusesHistory('context_management: unsupported'), false, 'not a history refusal');
  assert.equal(refusesEdit(HISTORY), false, 'and the history refusal is not an edit refusal');
});

// The scope is the owner's call (2026-11-15). A proxy serves every agent on the machine at once: an upstream that
// cannot take the server-side field will never take it, so that stops the editing for good -- but a history the API
// will not accept is ONE conversation's bound thinking, and stopping the cutting everywhere would give up the
// saving in every other session over one session's broken binding.
test('an explicit refusal stands that session down and leaves the other sessions cutting', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const cut = body.includes('thinker removed');
      seen.push({ session: req.headers['x-claude-code-session-id'], cut });
      // only this session's rewritten history is refused, and only while it is rewritten
      if (cut && req.headers['x-claude-code-session-id'] === 'bad') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(err(HISTORY));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OK);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const px = await proxyTo(`http://127.0.0.1:${server.address().port}`);
  try {
    const first = await send(px.port, 'bad');
    assert.equal(first.status, 200, 'the agent gets its answer, never the refusal');
    assert.match(first.text, /"ok"/);
    const tries = seen.filter(s => s.session === 'bad');
    assert.deepEqual(tries.map(t => t.cut), [true, false], 'cut once, then sent again as the agent wrote it');

    const again = await send(px.port, 'bad');
    assert.equal(again.status, 200);
    assert.deepEqual(seen.filter(s => s.session === 'bad').map(t => t.cut), [true, false, false],
      'and that session never cuts again: the binding it broke does not heal');

    // the other session on the same proxy is untouched by it
    const other = await send(px.port, 'good');
    assert.equal(other.status, 200);
    assert.deepEqual(seen.filter(s => s.session === 'good').map(t => t.cut), [true],
      'a different conversation is still cut, which is the whole point of the session scope');

    const r = rows(px.logFile);
    const refusals = r.filter(x => x.op === 'proxy-cut-rejected');
    assert.equal(refusals.length, 1, 'one refusal, concluded once');
    assert.equal(refusals[0].kind, 'history');
    assert.equal(refusals[0].session, 'bad', 'the row names the conversation, which is what makes the figure a count of conversations');
    assert.equal(refusals[0].door, 'messages', 'and which door: only this one rewrites a call\'s own text');
    assert.ok(refusals[0].says.includes('tool_use_rewritten'), 'what the API said is kept on the machine for a person to read');
  } finally { px.server.close(); server.close(); }
});

// `sessionsRejected` keyed on a field the row did not carry, so it could only ever read 1 however many
// conversations had been refused (found 2026-11-15 while making this a metric).
test('the figure counts conversations, and a row from before the session was written on it still counts as a refusal', () => {
  const at = '2026-11-15T00:00:00.000Z';
  const base = [
    { op: 'proxy', at, injected: true, status: 200, model: 'claude-opus-5-5', session: 's1' },
    { op: 'proxy', at, injected: true, status: 200, model: 'claude-opus-5-5', session: 's2' },
  ];
  const rep = proxyReport([...base,
    { op: 'proxy-cut-rejected', at, kind: 'history', session: 'a' },
    { op: 'proxy-cut-rejected', at, kind: 'history', session: 'a' },   // same conversation twice
    { op: 'proxy-cut-rejected', at, kind: 'history', session: 'b' },
    { op: 'proxy-cut-rejected', at, kind: 'edit' },                    // the older kind, no session
  ], {});
  assert.equal(rep.clearing.sessionsRejected, 2, 'two conversations, not four refusals and not one');
  assert.equal(rep.clearing.rejected, 4, 'every refusal counts');
  assert.equal(rep.clearing.rejectedHistory, 3);
  const none = proxyReport(base, {});
  assert.equal(none.clearing.sessionsRejected, 0);
  assert.equal(none.clearing.rejectedHistory, 0, 'zero is a figure, not a blank');
});

// It had to become a metric, not just a log row: thinker rewrites the history itself now, so a refusal is
// thinker's own fault and nothing on anybody else's machine says it happened.
test('the refusal leaves the machine as counts alone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-rej-home-'));
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const at = new Date().toISOString();
  fs.writeFileSync(path.join(home, 'state', 'proxy.jsonl'), [
    { op: 'proxy', at, injected: true, status: 200, model: 'claude-opus-5-5', session: 's1' },
    { op: 'proxy-cut-rejected', at, kind: 'history', door: 'messages', session: 'a', says: 'tool_use_rewritten: /Users/someone/src/secret/x.py' },
    { op: 'proxy-cut-rejected', at, kind: 'history', door: 'messages', session: 'a' },
    { op: 'proxy-cut-rejected', at, kind: 'history', door: 'messages', session: 'b' },
    { op: 'proxy-cut-rejected', at, kind: 'edit', door: 'responses', session: 'c' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');

  const m = proxyMetrics({ home, env: {} });
  assert.deepEqual(m.rejected, { total: 4, history: 3, edit: 1, sessions: 3, messages: 3, responses: 1 });
  // what the API said is never sent: it quotes the machine's own request back, paths and all
  assert.equal(JSON.stringify(m).includes('secret'), false, 'the body stays on the machine');
  assert.equal(JSON.stringify(m).includes('says'), false);
});
