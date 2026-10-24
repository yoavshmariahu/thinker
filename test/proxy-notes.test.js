import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NoteInjector, userTurns, conversationKey, requestFormat, withBundle } from '../src/proxy-notes.js';
import { startProxy, PROXY_DEFAULTS } from '../src/proxy.js';

const serve = (log = []) => async ({ task, session, turn }) => { log.push({ task, session, turn }); return task.includes('nothing') ? { text: '', ids: [] } : { text: `<thinker-cache>${task}</thinker-cache>`, ids: ['n1'] }; };
const req = (messages, extra = {}) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', system: 'be brief', messages, ...extra }));
const parse = r => JSON.parse(r.body.toString());

test('user turns: text messages count, tool-result continuations do not, both request shapes are read', () => {
  const a = userTurns({ messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] }] }, 'anthropic');
  assert.deepEqual(a.turns.map(t => t.index), [0]); assert.equal(a.endsOnTurn, false);
  const o = userTurns({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: [{ type: 'text', text: 'one' }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'two' }] }, 'openai');
  assert.deepEqual(o.turns.map(t => [t.index, t.text]), [[1, 'one'], [3, 'two']]); assert.equal(o.endsOnTurn, true);
  assert.equal(requestFormat('/v1/messages?beta=true'), 'anthropic'); assert.equal(requestFormat('/v1/chat/completions'), 'openai'); assert.equal(requestFormat('/v1/models'), null);
  assert.equal(conversationKey({ system: 's', messages: [{ role: 'user', content: 'one' }] }, 'anthropic'), conversationKey({ system: 's', messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'two' }] }, 'anthropic'));
  assert.notEqual(conversationKey({ system: 's', messages: [{ role: 'user', content: 'one' }] }, 'anthropic'), conversationKey({ system: 's', messages: [{ role: 'user', content: 'other' }] }, 'anthropic'));
  assert.deepEqual(withBundle({ role: 'user', content: 'hi' }, 'B', 'anthropic').content, [{ type: 'text', text: 'B' }, { type: 'text', text: 'hi' }]);
  assert.equal(withBundle({ role: 'user', content: 'hi' }, 'B', 'openai').content, 'B\n\nhi');
});

test('the injector serves a new user turn once and replays the same text on every later request of the conversation', async () => {
  const log = [];
  const inj = new NoteInjector({ serve: serve(log) });
  const first = await inj.transform('POST', '/v1/messages', {}, req([{ role: 'user', content: 'fix the parser' }]));
  assert.deepEqual([first.served, first.replayed], [['n1'], 0]);
  assert.deepEqual(parse(first).messages[0].content, [{ type: 'text', text: '<thinker-cache>fix the parser</thinker-cache>' }, { type: 'text', text: 'fix the parser' }]);
  // the tool-result continuation of the same turn: nothing new is served, the injection stands where it was
  const cont = await inj.transform('POST', '/v1/messages', {}, req([{ role: 'user', content: 'fix the parser' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] }]));
  assert.deepEqual([cont.served, cont.replayed], [[], 1]);
  assert.equal(parse(cont).messages[0].content[0].text, '<thinker-cache>fix the parser</thinker-cache>');
  assert.equal(parse(cont).messages[2].content[0].type, 'tool_result');
  // the next turn: served for its own text, the first turn's text replayed, the session and turn numbers carried
  const second = await inj.transform('POST', '/v1/messages', {}, req([{ role: 'user', content: 'fix the parser' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now the tests' }]));
  assert.deepEqual([second.served, second.replayed], [['n1'], 1]);
  assert.equal(parse(second).messages[2].content[0].text, '<thinker-cache>now the tests</thinker-cache>');
  assert.deepEqual(log.map(l => l.turn), [1, 2]);
  assert.equal(new Set(log.map(l => l.session)).size, 1);
  assert.match(log[0].session, /^proxy-[0-9a-f]{24}$/);
  // a turn nothing was served for is remembered as nothing and not asked again
  const none = await inj.transform('POST', '/v1/messages', {}, req([{ role: 'user', content: 'nothing here' }]));
  assert.deepEqual([none.served, none.reason], [[], 'nothing-served']);
  await inj.transform('POST', '/v1/messages', {}, req([{ role: 'user', content: 'nothing here' }]));
  assert.equal(log.length, 3);
});

test('the injector leaves Claude Code, other paths and unparsable bodies alone, and serves OpenAI chat requests in their shape', async () => {
  const inj = new NoteInjector({ serve: serve() });
  const body = req([{ role: 'user', content: 'task' }]);
  assert.equal((await inj.transform('POST', '/v1/messages', { 'x-claude-code-session-id': 's' }, body)).reason, 'hooked-client');
  assert.equal(await inj.transform('POST', '/v1/models', {}, body), null);
  assert.equal(await inj.transform('GET', '/v1/messages', {}, body), null);
  assert.equal((await inj.transform('POST', '/v1/messages', {}, Buffer.from('{nope'))).reason, 'unparsed');
  assert.equal((await inj.transform('POST', '/v1/messages', {}, req([{ role: 'assistant', content: 'a' }]))).reason, 'no-user-turn');
  const o = await inj.transform('POST', '/v1/chat/completions', {}, Buffer.from(JSON.stringify({ model: 'gpt', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }] })));
  assert.equal(parse(o).messages[1].content, '<thinker-cache>task</thinker-cache>\n\ntask');
  const failing = new NoteInjector({ serve: async () => { throw new Error('no cache'); } });
  const r = await failing.transform('POST', '/v1/messages', {}, body);
  assert.deepEqual([r.served, r.reason], [[], 'nothing-served']);
  assert.equal(r.body, body);
});

test('through the proxy: the upstream sees the bundle, the log counts the notes', async () => {
  const seen = [];
  const up = http.createServer((q, res) => { const c = []; q.on('data', d => c.push(d)); q.on('end', () => { seen.push(JSON.parse(Buffer.concat(c).toString())); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: { input_tokens: 5, output_tokens: 1 } })); }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-proxy-notes-')), 'proxy.jsonl');
  const notes = new NoteInjector({ serve: serve() });
  const proxy = await new Promise(r => { const s = startProxy({ ...PROXY_DEFAULTS, upstream: `http://127.0.0.1:${up.address().port}` }, { logFile, notes, onListen: a => r({ s, port: a.port }) }); });
  const post = body => new Promise(r => { const q = http.request({ host: '127.0.0.1', port: proxy.port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', r); }); q.end(body); });
  await post(req([{ role: 'user', content: 'task' }]));
  await post(req([{ role: 'user', content: 'task' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'more' }]));
  assert.equal(seen[0].messages[0].content[0].text, '<thinker-cache>task</thinker-cache>');
  assert.equal(seen[1].messages[2].content[0].text, '<thinker-cache>more</thinker-cache>');
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(rows.map(r => [r.notes, r.notesReplayed, r.injected, r.betaAdded]), [[1, 0, true, true], [1, 1, true, true]]);
  proxy.s.close(); up.close();
});
