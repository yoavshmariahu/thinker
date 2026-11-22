// What the proxy does to a request on the wire: which finished tool results it replaces, that the set never
// moves under a conversation, that the three wire formats decide alike, and that a request it cannot cut
// goes up as the agent wrote it. The policy itself (what is worth cutting) is test/cutting.test.js.
import { tmp } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { transformRequest, startProxy, PROXY_DEFAULTS, authWatch, AUTH_REFUSALS, cutActions, saveCutImages, imagePathIn, breakpointsOf } from '../src/proxy.js';
import { freshCut, cutResponse, addThink } from '../src/cutting.js';
import { routedHeaders } from '../src/proxy-routing.js';

const NOW = 1_700_000_000_000;
const BIG = 'x'.repeat(40_000);

// A Claude Code shaped conversation: the person, `first` finished Read calls each with its own thinking, the
// person again, then `second` calls of the turn in progress. `md` makes the oldest read a file the keep list holds.
function messages({ first = 12, second = 0, size = BIG, secondSize = 'y'.repeat(5000), md = false } = {}) {
  const file = i => (md && i === 0 ? '/x/notes.md' : `/x/f${i}.txt`);
  const ms = [{ role: 'user', content: [{ type: 'text', text: 'first' }] }];
  for (let i = 0; i < first; i++) ms.push(
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: `sig-${i}` }, { type: 'tool_use', id: `a${i}`, name: 'Read', input: { file_path: file(i) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `a${i}`, content: size }] });
  ms.push({ role: 'user', content: [{ type: 'text', text: 'second' }] });
  for (let i = 0; i < second; i++) ms.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `b${i}`, content: secondSize }] });
  return ms;
}
// the same conversation on the other two wires
const responsesInput = ({ first = 12, size = BIG } = {}) => {
  const inp = [{ role: 'user', content: 'first' }];
  for (let i = 0; i < first; i++) inp.push({ type: 'function_call', call_id: `a${i}`, name: 'read', arguments: '{}' }, { type: 'function_call_output', call_id: `a${i}`, output: size });
  return [...inp, { role: 'user', content: 'second' }];
};
const chatMessages = ({ first = 12, size = BIG } = {}) => {
  const ms = [{ role: 'user', content: 'first' }];
  for (let i = 0; i < first; i++) ms.push({ role: 'assistant', tool_calls: [{ id: `a${i}`, function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: `a${i}`, content: size });
  return [...ms, { role: 'user', content: 'second' }];
};

const asked = (ms, extra = {}) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: ms, stream: true, ...extra }));
const sent = t => JSON.parse(t.body);
// The guards are the shipped ones; what the tests set is the clock, the keep list and the breakpoint (a request
// with no `cache_control` of its own can carry none anyway, and the seeding is its own matter).
const CUT = { ...PROXY_DEFAULTS, cutBreakpoint: false, keepPatterns: [], now: NOW };
const SESSION = { 'x-claude-code-session-id': 's' };
const door = (ms, cfg = {}) => transformRequest('POST', '/v1/messages', SESSION, Buffer.isBuffer(ms) ? ms : asked(ms), { ...CUT, cutRecord: freshCut('s'), ...cfg });
// what startProxy does with a request's decision: reserve it, then count the answer against it
const answer = (rec, t, cfg = CUT) => {
  if (Array.isArray(t.cut) && t.turn != null) {
    rec.cut = t.cut; rec.turn = t.turn;
    if ('seed' in t) rec.seed = t.seed || null;
    if (t.think) rec.think = addThink(rec.think, t.think);
  }
  cutResponse(rec, cfg, t, { read: 1, write: 1 }, { now: NOW });
};

const blocks = ms => ms.flatMap(m => (Array.isArray(m.content) ? m.content : []));
const resultOf = (ms, id) => blocks(ms).find(b => b.type === 'tool_result' && b.tool_use_id === id);
const resultChars = (ms, id) => { const b = resultOf(ms, id); return typeof b.content === 'string' ? b.content.length : b.content.map(x => x.text || '').join('').length; };
const signatures = ms => blocks(ms).filter(b => b.type === 'thinking').map(b => b.signature).join(',');
const callInputs = ms => blocks(ms).filter(b => b.type === 'tool_use').map(b => JSON.stringify(b.input)).join(',');
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

test('past the trigger the old finished results go up as placeholders and nothing else changes', () => {
  const ms = messages({ first: 12, md: true });
  const t = door(ms, { keepPatterns: ['*.md'] });
  const out = sent(t).messages;
  assert.equal(t.injected, true, 'the request was cut');
  // the turn in progress is not there to cut; the newest three results and the kept file are
  assert.deepEqual(t.cut, ['a8', 'a7', 'a6', 'a5', 'a4', 'a3', 'a2', 'a1']);
  for (const id of ['a11', 'a10', 'a9']) assert.equal(resultChars(out, id), BIG.length, `${id} is one of the newest three and stays`);
  assert.equal(resultChars(out, 'a0'), BIG.length, 'the newest read of a kept file stays');
  assert.equal(t.kept.results, 1, 'the row says the keep list held one back');
  for (const id of t.cut) assert.ok(resultChars(out, id) < 400, `${id} is a placeholder now`);
  assert.equal(signatures(out), signatures(ms), 'every thinking block is as it came');
  assert.equal(callInputs(out), callInputs(ms), 'every call input is as it came');
  assert.equal(t.clientCut.cut, 8, 'the row counts the results it replaced');
  assert.equal(t.clear.whole, undefined, 'with no breakpoint of its own the cut pays for the whole conversation, not the tail');
});

test('as it ships, a boundary seeds the cut on one request and makes it on the next', () => {
  // The shipped default puts a cache breakpoint of the proxy's own before the first result it will replace and
  // cuts nothing; the request after that one makes the cut, so the API has the kept prefix stored when it lands.
  const ms = messages({ first: 12 });
  const last = ms[ms.length - 1].content;
  last[last.length - 1] = { ...last[last.length - 1], cache_control: { type: 'ephemeral', ttl: '1h' } };
  const body = asked(ms);
  const cfg = { ...PROXY_DEFAULTS, keepPatterns: [], now: NOW };   // the breakpoint is on, as it ships
  const rec = freshCut('s');
  const seed = transformRequest('POST', '/v1/messages', SESSION, body, { ...cfg, cutRecord: rec });
  assert.equal(seed.reason, 'seed', 'the first boundary past the trigger only seeds');
  assert.ok(!seed.injected, 'and takes nothing out yet');
  assert.equal(breakpointsOf(sent(seed)).n, breakpointsOf(JSON.parse(body)).n + 1, "one breakpoint of the proxy's own");
  answer(rec, seed, cfg);
  const cut = transformRequest('POST', '/v1/messages', SESSION, body, { ...cfg, cutRecord: rec });
  assert.equal(cut.injected, true, 'the request after it makes the cut');
  assert.equal(cut.clear.seeded, true, 'the cut the seed had chosen');
  assert.equal(cut.mark.at, seed.mark.at, 'at the breakpoint the seed left, in the same place');
  assert.ok(cut.clientCut.cut > 0, 'and the results go up as placeholders');
});

test('inside a turn the cut does not move', () => {
  const rec = freshCut('s');
  const seen = [];
  // the turn goes on: each later call of it has more results that the recency rule would release
  for (let n = 0; n <= 4; n++) {
    const t = door(messages({ first: 12, second: n }), { cutRecord: rec });
    answer(rec, t);
    seen.push({ n, cut: t.cut.join(','), before: digest(sent(t).messages.slice(0, 26)) });
  }
  assert.equal(seen[0].cut.split(',').length, 9, 'the boundary cut what it could');
  for (const s of seen.slice(1)) {
    assert.equal(s.cut, seen[0].cut, `call ${s.n + 1} of the turn cuts the same results`);
    assert.equal(s.before, seen[0].before, `call ${s.n + 1} of the turn sends the same bytes up to the prompt`);
  }
});

test('the next turn carries the earlier cut unchanged and only adds to it', () => {
  const rec = freshCut('s');
  const first = door(messages({ first: 12 }), { cutRecord: rec });     // the boundary that opens the second turn
  answer(rec, first);
  const later = messages({ first: 12, second: 8, secondSize: BIG });   // the second turn did its own work
  later.push({ role: 'user', content: [{ type: 'text', text: 'third' }] });
  const next = door(later, { cutRecord: rec });
  assert.equal(next.cut.slice(0, first.cut.length).join(','), first.cut.join(','), 'the earlier set is still there, in order');
  assert.ok(next.cut.length > first.cut.length, 'the new boundary added to it');
  const out = sent(next).messages;
  for (const id of first.cut) assert.ok(resultChars(out, id) < 400, `${id} is still a placeholder`);
});

test("a request the cut does not touch goes up as the agent's own bytes", () => {
  const whole = asked(messages({ first: 12 }));
  const cases = [
    ['anything but a model call', 'GET', '/v1/messages', whole, 'other'],
    ['counting tokens', 'POST', '/v1/messages/count_tokens', whole, 'other'],
    ['a body that is not JSON', 'POST', '/v1/messages', Buffer.from('{not json'), 'unparsed'],
    ['an agent clearing for itself', 'POST', '/v1/messages', asked(messages({ first: 12 }), { context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] } }), 'agent-clears'],
    ['a prompt under the trigger', 'POST', '/v1/messages', asked(messages({ first: 6, size: 'z'.repeat(1000) })), 'below-trigger'],
  ];
  for (const [what, method, url, body, reason] of cases) {
    const t = transformRequest(method, url, SESSION, body, { ...CUT, cutRecord: freshCut('s') });
    assert.equal(t.reason, reason, `${what}: the reason`);
    assert.ok(t.body === body, `${what}: the very buffer the agent sent`);
  }
});

test('the same conversation on three wires gives one decision', () => {
  const rows = [
    ['with the cutting switched off', { cut: false, trigger: 0, clearAtLeast: 0 }, 'off', 0],
    ['under the trigger', { trigger: 10 ** 9, clearAtLeast: 0 }, 'below-trigger', 0],
    ['under the smallest cut worth making', { trigger: 0, clearAtLeast: 10 ** 9 }, 'below-clear-minimum', 0],
    ['inside a turn', { trigger: 0, clearAtLeast: 0 }, 'mid-turn', 2],
  ];
  const run = (over, turn) => {
    const cfg = { ...CUT, ...over };
    const rec = () => ({ ...freshCut('s'), turn });
    return [
      transformRequest('POST', '/v1/messages', SESSION, asked(messages({ first: 12 })), { ...cfg, cutRecord: rec() }),
      transformRequest('POST', '/v1/responses', { session_id: 's' }, Buffer.from(JSON.stringify({ model: 'gpt-5', input: responsesInput({}) })), { ...cfg, protocol: 'responses', cutRecord: rec() }),
      transformRequest('POST', '/v1/chat/completions', { 'x-session-id': 's' }, Buffer.from(JSON.stringify({ model: 'gpt-5', messages: chatMessages({}) })), { ...cfg, protocol: 'chat', cutRecord: rec() }),
    ];
  };
  for (const [what, over, reason, turn] of rows) {
    const [m, r, c] = run(over, turn);
    for (const [name, t] of [['Messages', m], ['Responses', r], ['Chat', c]]) {
      assert.equal(t.reason, reason, `${what}: the ${name} door says why`);
      assert.equal(t.policy, m.policy, `${what}: the ${name} door names the same policy`);
    }
  }
  // and where the policy says cut, all three cut, under one policy
  const [m, r, c] = run({ trigger: 0, clearAtLeast: 0 }, 0);
  for (const [name, t] of [['Messages', m], ['Responses', r], ['Chat', c]]) {
    assert.equal(t.injected, true, `a cut: the ${name} door cut the request`);
    assert.equal(t.policy, m.policy, `a cut: the ${name} door names the same policy`);
    assert.equal(t.clientCut.cut, m.clientCut.cut, `a cut: the ${name} door replaced as many results`);
  }
});

// the same conversation on each wire, addressed to one session: 'b' falls on the held-out side of a half share, 'a' does not
const wires = [
  ['Messages', s => [['POST', '/v1/messages', { 'x-claude-code-session-id': s }, asked(messages({ first: 12 }))], {}]],
  ['Responses', s => [['POST', '/v1/responses', { session_id: s }, Buffer.from(JSON.stringify({ model: 'gpt-5', input: responsesInput({}) }))], { protocol: 'responses' }]],
  ['Chat', s => [['POST', '/v1/chat/completions', { 'x-session-id': s }, Buffer.from(JSON.stringify({ model: 'gpt-5', messages: chatMessages({}) }))], { protocol: 'chat' }]],
];

test('a held-out session goes up untouched, whichever wire it is on', () => {
  const cfg = { ...CUT, holdout: 0.5, trigger: 0, clearAtLeast: 0 };
  for (const [name, make] of wires) {
    const [args, over] = make('b');
    const held = transformRequest(...args, { ...cfg, ...over, cutRecord: freshCut('b') });
    assert.equal(held.reason, 'holdout', `${name}: a held-out session is not cut`);
    assert.ok(held.body === args[3], `${name}: the very buffer the agent sent`);
    const [other, also] = make('a');
    const cut = transformRequest(...other, { ...cfg, ...also, cutRecord: freshCut('a') });
    assert.equal(cut.injected, true, `${name}: a session on the other side of the same holdout is cut`);
  }
});

test('the Codex and gateway doors replace what they cut and send the rest in the shape it came', () => {
  const SHORT = 'z'.repeat(180);     // no bigger than its own placeholder would be: never worth replacing
  // a1 came as a list of parts rather than text; `tiny` is in the set the record already holds
  const made = [['a0', BIG], ['a1', [{ type: 'input_text', text: BIG }]], ['a2', BIG], ['a3', BIG], ['a4', BIG], ['a5', BIG], ['tiny', SHORT]];
  // the person named a file in their own words, and a0 is the newest read of it: the keep list holds it back
  const said = 'first, and check plan.txt while you are there';
  const arg = id => JSON.stringify({ path: id === 'a0' ? '/x/plan.txt' : `/x/${id}.txt` });
  const inp = [{ role: 'user', content: said }], chat = [{ role: 'user', content: said }];
  for (const [id, output] of made) {
    inp.push({ type: 'function_call', call_id: id, name: 'read', arguments: arg(id) }, { type: 'function_call_output', call_id: id, output });
    chat.push({ role: 'assistant', tool_calls: [{ id, function: { name: 'read', arguments: arg(id) } }] },
      { role: 'tool', tool_call_id: id, content: Array.isArray(output) ? [{ type: 'text', text: BIG }] : output });
  }
  inp.push({ role: 'user', content: 'second' }); chat.push({ role: 'user', content: 'second' });
  // the turn in progress has finished results of its own, more of them than the recency rule holds back: never cut
  for (const id of ['c0', 'c1', 'c2', 'c3']) {
    inp.push({ type: 'function_call', call_id: id, name: 'read', arguments: arg(id) }, { type: 'function_call_output', call_id: id, output: BIG });
    chat.push({ role: 'assistant', tool_calls: [{ id, function: { name: 'read', arguments: arg(id) } }] }, { role: 'tool', tool_call_id: id, content: BIG });
  }
  const cfg = { ...CUT, trigger: 0, clearAtLeast: 0 };
  const rec = () => ({ ...freshCut('s'), cut: ['tiny'] });
  const r = transformRequest('POST', '/v1/responses', { session_id: 's' }, Buffer.from(JSON.stringify({ model: 'gpt-5', input: inp })), { ...cfg, protocol: 'responses', cutRecord: rec() });
  const c = transformRequest('POST', '/v1/chat/completions', { 'x-session-id': 's' }, Buffer.from(JSON.stringify({ model: 'gpt-5', stream: true, messages: chat })), { ...cfg, protocol: 'chat', cutRecord: rec() });
  const outputOf = (id, j) => j.input.find(x => x.type === 'function_call_output' && x.call_id === id).output;
  const contentOf = (id, j) => j.messages.find(m => m.role === 'tool' && m.tool_call_id === id).content;
  for (const [name, t, read] of [['Codex', r, outputOf], ['gateway', c, contentOf]]) {
    const j = sent(t), text = id => { const v = read(id, j); return (typeof v === 'string' ? v : v.map(p => p.text).join('')); };
    assert.equal(t.clientCut.cut, 5, `${name}: the results outside the newest three are replaced`);
    assert.ok(text('a2').length < 400 && text('a1').length < 400, `${name}: each one is a placeholder`);
    assert.equal(typeof read('a2', j), 'string', `${name}: a result the agent sent as text goes up as text`);
    assert.ok(Array.isArray(read('a1', j)), `${name}: one it sent as a list of parts goes up as a list`);
    for (const id of ['c0', 'c1', 'c2', 'c3']) assert.equal(text(id).length, BIG.length, `${name}: the turn in progress keeps ${id}, a result it is working from`);
    assert.ok(t.clear.recache > 1000, `${name}: the cut is priced against the conversation it still sends, not against nothing`);
    assert.equal(text('a0').length, BIG.length, `${name}: the newest read of a file the person named stays`);
    assert.equal(text('tiny'), SHORT, `${name}: a result too small for a placeholder stays as it came`);
  }
  assert.equal(c.usageRequested, true, 'a streamed gateway call asks for the usage the saving is counted from');
  assert.equal(sent(c).stream_options.include_usage, true, 'and the request carries the ask');
  const nobody = transformRequest('POST', '/v1/chat/completions', {}, Buffer.from(JSON.stringify({ model: 'm', messages: [{ role: 'tool', tool_call_id: 't', content: BIG }] })), { ...cfg, protocol: 'chat' });
  assert.equal(nobody.reason, 'missing-session', 'a conversation the door cannot name is passed through, never broken');
});

test('what a cut is credited with is counted from the results as they were before it', () => {
  const ms = messages({ first: 12 });
  const t = door(ms);
  const sum = acts => acts.reduce((n, a) => n + a.tokens, 0);
  assert.ok(sum(t.actions) > 0, 'a cut that was made is credited with something');
  assert.equal(sum(t.actions), sum(cutActions(ms, t.cut, { cutInputs: true })), 'counted from the request as it came');
  assert.equal(sum(cutActions(sent(t).messages, t.cut, { cutInputs: true })), 0, 'the placeholders themselves are worth nothing');
  assert.ok(t.clientCut.tokens > 0, 'and so is the figure the row carries');
});

// ---- on the wire, through a proxy on loopback -------------------------------------------------------------
const ANSWER = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":9,"cache_creation_input_tokens":2,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const ok = res => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(ANSWER); };
const upstream = reply => {
  const server = http.createServer((req, res) => { const c = []; req.on('data', x => c.push(x)); req.on('end', () => reply(res, Buffer.concat(c))); });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}` })));
};
const proxy = (url, cfg = {}) => {
  const dir = tmp('proxy');
  const logFile = path.join(dir, 'proxy.jsonl');
  return new Promise(r => {
    const server = startProxy({ ...PROXY_DEFAULTS, upstream: url, ...cfg },
      { logFile, host: '127.0.0.1', routes: false, stubsHome: dir, retryWaits: [0, 0], onListen: a => r({ server, logFile, port: a.port }) });
  });
};
const post = (port, body, headers = {}) => new Promise((done, bad) => {
  const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 's1', ...headers } }, res => {
    const c = []; res.on('data', x => c.push(x)); res.on('end', () => done({ status: res.statusCode, text: Buffer.concat(c).toString() }));
  });
  req.on('error', bad); req.end(body);
});
const rows = (file, op = 'proxy') => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.op === op);
// the row is written once the answer has gone out: wait for it to be there, never for a guess at how long that takes
const settle = async (file, n = 1) => { for (let i = 0; i < 400 && rows(file).length < n; i++) await new Promise(r => setTimeout(r, 5)); };
const refusal = res => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'preserved_thinking: tool_use_rewritten, the input does not match what was sent' } })); };

test('a request past the trigger reaches the API cut, and the row says what was cleared', async t => {
  const seen = [];
  const up = await upstream((res, body) => { seen.push(body.length); ok(res); });
  const p = await proxy(up.url);
  t.after(() => { p.server.close(); up.server.close(); });
  const body = asked(messages({ first: 12 }));
  assert.equal((await post(p.port, body)).status, 200, 'the agent got its answer');
  await settle(p.logFile);
  assert.ok(seen[0] < body.length / 2, 'the API was sent far less than the agent wrote');
  const [row] = rows(p.logFile);
  assert.equal(row.injected, true, 'the row says the request was cut');
  assert.equal(row.clearedUses, 9, 'the row counts the results taken out');
  assert.ok(row.cleared > 0, 'and the tokens they were worth');
  assert.ok(row.policy, 'and names the policy that decided it');
});

test('a 400 that names the cut sends the same request again uncut and the agent sees a normal answer', async t => {
  const seen = [];
  const up = await upstream((res, body) => { seen.push(body.length); seen.length === 1 ? refusal(res) : ok(res); });
  const p = await proxy(up.url);
  t.after(() => { p.server.close(); up.server.close(); });
  const body = asked(messages({ first: 12 }));
  const got = await post(p.port, body);
  assert.equal(got.status, 200, 'the agent never sees the 400');
  assert.ok(got.text.includes('message_stop'), 'it sees a whole answer');
  await settle(p.logFile);
  assert.equal(seen.length, 2, 'the request went twice');
  assert.equal(seen[1], body.length, 'the second time as the agent wrote it');
  const [refused] = rows(p.logFile, 'proxy-cut-rejected');
  assert.equal(refused.kind, 'history', 'the refusal is recorded as the conversation being refused');
  assert.equal(refused.session, 's1', 'against the session it stands the cutting down for');
});

test('a cut the API refused is credited nothing', { skip: 'known gap: the refused request keeps clientCut, so the row is credited the whole cut and a cut event is written (proxy.js:1397)' }, async t => {
  const seen = [];
  const up = await upstream((res, body) => { seen.push(body.length); seen.length === 1 ? refusal(res) : ok(res); });
  const p = await proxy(up.url);
  t.after(() => { p.server.close(); up.server.close(); });
  assert.equal((await post(p.port, asked(messages({ first: 12 })))).status, 200);
  await settle(p.logFile);
  const [row] = rows(p.logFile);
  assert.equal(row.injected, false, 'nothing was cut in the end');
  assert.equal(row.cleared, 0, 'so nothing was cleared');
  assert.equal(row.clearedUses, 0, 'and no result was taken out');
  assert.equal(rows(p.logFile, 'proxy-cut').length, 0, 'and no saving was recorded against the session');
});

test('two requests of one conversation in flight together carry the same cut', async t => {
  const seen = [];
  let arrived, release;
  const first = new Promise(r => { arrived = r; });
  const held = new Promise(r => { release = r; });
  const up = await upstream(async (res, body) => {
    seen.push(body.length);
    seen.length === 1 ? arrived() : release();
    await held; ok(res);
  });
  const p = await proxy(up.url);
  t.after(() => { p.server.close(); up.server.close(); });
  const a = post(p.port, asked(messages({ first: 12 })));
  await first;                                              // the first request is at the API, unanswered
  const b = post(p.port, asked(messages({ first: 14 })));    // the same conversation, with more it could cut
  assert.deepEqual((await Promise.all([a, b])).map(r => r.status), [200, 200]);
  await settle(p.logFile, 2);
  const [one, two] = rows(p.logFile);
  assert.equal(two.clearedUses, one.clearedUses, 'the second request cut what the first reserved');
  assert.equal(two.cleared, one.cleared, 'and is credited the same');
});

test('with no session the cut does not move inside a turn', { skip: 'known gap: no session means no record, so the set is chosen afresh on every request and grows through the turn (proxy.js:1010)' }, () => {
  const seen = [];
  for (let n = 0; n <= 3; n++) seen.push(transformRequest('POST', '/v1/messages', {}, asked(messages({ first: 12, second: n })), { ...CUT }).cut.join(','));
  for (const [i, cut] of seen.entries()) assert.equal(cut, seen[0], `call ${i + 1} of the turn cuts the same results`);
});

// ---- the proxy doing no harm ------------------------------------------------------------------------------
test("a request routed to another provider carries the provider's key and never the person's", () => {
  const route = { route: 'thinker/glm', providerId: 'z', model: 'glm-4', format: 'messages',
    provider: { id: 'z', url: 'https://z.example/api', auth: { env: 'A_PROVIDER_KEY' } } };
  const out = routedHeaders({ authorization: 'Bearer sk-ant-personal', 'x-api-key': 'sk-ant-personal',
    'anthropic-beta': 'context-management-2025-06-27', 'user-agent': 'claude-cli' }, route, { A_PROVIDER_KEY: 'provider-secret' });
  assert.equal(out.authorization, 'Bearer provider-secret', "the provider's own credential");
  assert.equal(out['x-api-key'], 'provider-secret');
  assert.ok(!JSON.stringify(out).includes('sk-ant-personal'), "nothing of the person's credential goes to the provider");
  assert.equal(out['anthropic-beta'], undefined, 'no Anthropic beta a provider never agreed to');
  assert.equal(out['user-agent'], 'claude-cli', "the rest of the request is the agent's own");
});

test('the proxy stands down after a run of refusals, unless the API is still answering that agent', () => {
  const headers = s => ({ 'user-agent': 'claude-cli/2.1', 'x-claude-code-session-id': s });
  let now = NOW, down = null, held = [];
  const watch = authWatch(reason => { down = reason; }, { now: () => now, onHeld: why => held.push(why) });
  for (let i = 0; i < AUTH_REFUSALS; i++) watch.response(401, headers('lost'));
  assert.ok(down, 'a session whose every call is refused stands the proxy down');
  assert.equal(held.length, 0, 'with nothing to say the route works');

  now = NOW; down = null; held = [];
  const other = authWatch(reason => { down = reason; }, { now: () => now, onHeld: why => held.push(why) });
  other.response(200, headers('working'));                      // the API is answering this agent
  for (let i = 0; i < AUTH_REFUSALS; i++) other.response(401, headers('lost'));
  assert.equal(down, null, 'one terminal with the wrong key does not decide for the machine');
  assert.equal(held.length, 1, 'and it is said once');
  other.response(401, headers('lost'));
  assert.equal(held.length, 1, 'still once');
});

test("a cut saves a result's screenshot to disk, or leaves the picture in the prompt", () => {
  const shot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('png').toString('base64') } };
  const ms = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a0', content: [{ type: 'text', text: BIG }, shot] }] }];
  const dir = tmp('images');
  assert.equal(saveCutImages(ms, ['a0'], imagePathIn(dir)), true, 'the image is written before the prompt loses it');
  assert.equal(fs.readdirSync(dir).length, 1, 'one file for the one image');
  const blocked = path.join(tmp('blocked'), 'file');
  fs.writeFileSync(blocked, 'not a directory');
  assert.equal(saveCutImages(ms, ['a0'], imagePathIn(blocked)), false, 'nowhere to save means the cut leaves the image alone');
});
