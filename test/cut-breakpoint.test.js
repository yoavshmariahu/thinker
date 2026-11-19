// The proxy's own cache breakpoint (proxy.js:placeMark, cutting.js:SEED_MS; `cutBreakpoint`, off by default).
//
// What these hold. That nothing changes with the switch off but the row saying what breakpoints the request
// carried. That with it on a boundary which finds a cut worth making does not make it: the request goes out
// with one breakpoint on the last block before the first one the cut would change, and nothing replaced.
// That the cut is made on the next request only once the seeding request has been answered, with the same
// breakpoint, priced at the tail. That a stale seed is dropped. That a request with no room for a fifth
// breakpoint is priced as the whole conversation, as before. And that the lifetime is copied, never chosen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transformRequest, proxyConfig, cutCandidates, applyCut, placeMark, markBlock, breakpointsOf, thinkingChars, lastPrompt, PROXY_DEFAULTS, TOKENS_PER_CHAR } from '../src/proxy.js';
import { cutResponse, freshCut, policyId, SEED_MS } from '../src/cutting.js';
import { serviceArgs } from '../src/proxy-service.js';

const tu = (id, input = { file_path: `/p/${id}` }) => ({ type: 'tool_use', id, name: 'Read', input });
const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
const think = n => ({ type: 'thinking', thinking: 'T'.repeat(n), signature: 'sig' });
// The thinking below a rung's first change and before the turn in progress: no cut writes it (2026-11-18), so
// it is off every rung's price, whether or not the proxy also leaves it out.
const unwritten = (messages, firstChanged) => { const live = lastPrompt(messages); return Math.round(messages.reduce((n, m, i) => n + (i > firstChanged && i < live ? thinkingChars(m) : 0), 0) * TOKENS_PER_CHAR); };
const HOUR = { type: 'ephemeral', ttl: '1h' };

// A long conversation whose bulk is above the cut: one huge thinking block, then two 300k results and three
// small ones. The two big ones are eligible. Written whole, the cut never pays; written from the first
// replaced result, it does.
function body({ tail = HOUR, system = HOUR, extra = [] } = {}) {
  const ms = [{ role: 'user', content: 'begin' }, { role: 'assistant', content: [think(2000000), { type: 'text', text: 'ok' }] }];
  for (let k = 0; k < 5; k++) {
    ms.push({ role: 'user', content: `prompt ${k}` });
    ms.push({ role: 'assistant', content: [think(400), tu(`r${k}`)] });
    ms.push({ role: 'user', content: [tr(`r${k}`, k < 2 ? 300000 : 5000)] });
  }
  ms.push(...extra);
  ms.push({ role: 'user', content: [{ type: 'text', text: 'the live turn', ...(tail ? { cache_control: tail } : {}) }] });
  return { model: 'claude-opus-5-5', system: [{ type: 'text', text: 'sys', ...(system ? { cache_control: system } : {}) }], messages: ms };
}
const CFG = on => ({ ...PROXY_DEFAULTS, trigger: 1000, clearAtLeast: 1000, cutBreakpoint: on });
// one request through the door, with the record kept the way the proxy keeps it
function send(rec, j, cfg, now, { answered = true } = {}) {
  const t = transformRequest('POST', '/v1/messages', {}, Buffer.from(JSON.stringify(j)), { ...cfg, cutRecord: rec, now });
  if (Array.isArray(t.cut) && t.turn != null) { rec.cut = t.cut; rec.turn = t.turn; if ('seed' in t) rec.seed = t.seed || null; }
  if (answered) cutResponse(rec, cfg, t, { read: 1 }, { now });
  return { t, sent: JSON.parse(t.body) };
}
const marks = sent => sent.messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content : []).filter(b => b.cache_control).map(b => ({ i, type: b.type, id: b.id, cc: b.cache_control })));
const replaced = sent => sent.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_result' && Array.isArray(b.content)).length;

test('switched off: the cut is priced whole and refused, and the row says what breakpoints came', () => {
  assert.equal(PROXY_DEFAULTS.cutBreakpoint, true, 'on by default');
  const rec = freshCut('s'), j = body();
  const { t, sent } = send(rec, j, CFG(false), 1e12);
  assert.equal(t.reason, 'payback');
  assert.deepEqual(sent, j, 'the request is the agent\'s own');
  assert.deepEqual(t.bp, { n: 2, ttl: '1h' });
  assert.equal(rec.seed, undefined);
});

test('on: the boundary seeds the cut with one breakpoint and replaces nothing', () => {
  const rec = freshCut('s'), j = body();
  const { t, sent } = send(rec, j, CFG(true), 1e12, { answered: false });
  assert.equal(t.reason, 'seed');
  assert.equal(replaced(sent), 0, 'no result is replaced on the seeding request');
  const ours = marks(sent).filter(x => x.type === 'tool_use');
  assert.deepEqual(ours, [{ i: 3, type: 'tool_use', id: 'r0', cc: HOUR }], 'the last block before the oldest result of the set, at the lifetime of the breakpoint after it');
  assert.equal(marks(sent).length, 2, 'beside Claude Code\'s own on the newest message');
  const strip = x => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));
  assert.deepEqual(strip(sent), strip(j), 'and not a byte else');
  assert.deepEqual(t.mark, { at: 3, ttl: '1h', n: 3 });
  assert.equal(rec.seed.last, 'r0', 'the seed names the oldest result of the planned set');
  assert.ok(t.planned.recache < t.planned.whole, 'planned at the tail, with the whole rewrite beside it');
  assert.ok(t.planned.payback <= 25);
});

test('the cut waits for the seeding request\'s answer, then is made at the same breakpoint and priced at the tail', () => {
  const rec = freshCut('s'), j = body(), cfg = CFG(true);
  send(rec, j, cfg, 1e12, { answered: false });
  const again = send(rec, j, cfg, 1e12 + 10, { answered: false });
  assert.equal(again.t.reason, 'seed', 'a retry beside an unanswered seed seeds again');
  assert.equal(replaced(again.sent), 0);
  assert.equal(marks(again.sent).length, 2);
  cutResponse(rec, cfg, again.t, { read: 1 }, { now: 1e12 + 1000 });
  assert.ok(rec.seed.ready, 'the answer is what makes the seed ready');
  // the turn has gone on: a call and its result since
  const next = body({ extra: [{ role: 'assistant', content: [tu('live')] }, { role: 'user', content: [tr('live', 500)] }] });
  const { t, sent } = send(rec, next, cfg, 1e12 + 2000);
  assert.equal(t.injected, true);
  // r2 left the newest three when the turn's own result arrived, so it goes with them: the rung is the one
  // that ends on the seeded result as the conversation stands now
  assert.equal(t.clientCut.cut, 3);
  assert.equal(replaced(sent), 3, 'r0, r1 and r2 are placeholders now');
  assert.deepEqual(marks(sent).filter(x => x.type === 'tool_use'), [{ i: 3, type: 'tool_use', id: 'r0', cc: HOUR }]);
  assert.equal(t.clear.seeded, true);
  assert.equal(t.clear.recache, t.clear.tail, 'priced at what the breakpoint leaves to be written');
  assert.ok(t.clear.whole > 5 * t.clear.tail, 'which is a fraction of the conversation');
  assert.equal(rec.seed, null, 'the seed is spent');
  assert.deepEqual(rec.cut, ['r2', 'r1', 'r0']);
  const after = send(rec, next, cfg, 1e12 + 3000);
  assert.equal(replaced(after.sent), 3, 'the set holds for the rest of the turn');
  assert.equal(marks(after.sent).length, 1, 'and the breakpoint is not sent again');
});

test('a seed older than the entry it wrote is dropped', () => {
  const rec = freshCut('s'), j = body(), cfg = CFG(true);
  send(rec, j, cfg, 1e12);
  assert.ok(rec.seed.ready);
  const { t, sent } = send(rec, j, cfg, 1e12 + SEED_MS['1h'] + 1000);
  assert.equal(replaced(sent), 0);
  assert.equal(t.reason, 'mid-turn');
  assert.equal(rec.seed, null);
});

test('a five-minute lifetime is copied as it came, and the seed lives four minutes', () => {
  const rec = freshCut('s'), cfg = CFG(true);
  const j = body({ tail: { type: 'ephemeral' }, system: { type: 'ephemeral' } });
  const { t, sent } = send(rec, j, cfg, 1e12);
  assert.deepEqual(marks(sent).find(x => x.type === 'tool_use').cc, { type: 'ephemeral' });
  assert.equal(t.mark.ttl, '5m');
  const late = send(rec, j, cfg, 1e12 + SEED_MS['5m'] + 1000);
  assert.equal(replaced(late.sent), 0, 'past it the cut is not made on a seed that has expired');
});

test('no room for a breakpoint: the cut is priced whole, as without the switch', () => {
  const rec = freshCut('s'), j = body();
  j.tools = [{ name: 'a', input_schema: {}, cache_control: HOUR }];
  j.system.push({ type: 'text', text: 'more', cache_control: HOUR });
  assert.equal(breakpointsOf(j).n, 4);
  const { t, sent } = send(rec, j, CFG(true), 1e12);
  assert.equal(t.reason, 'payback');
  assert.deepEqual(sent, j);
  assert.equal(rec.seed, undefined);
  // and with no breakpoint after the cut to copy a lifetime from, the same
  const bare = body({ tail: null });
  assert.equal(send(freshCut('s'), bare, CFG(true), 1e12).t.reason, 'payback');
});

test('four breakpoints already, two of them on the last two messages: the older one moves', () => {
  // what Claude Code sends on every request after its first (read from its request bodies, 2026-11-17)
  const rec = freshCut('s'), j = body();
  j.system.unshift({ type: 'text', text: 'You are Claude Code.', cache_control: HOUR });
  const prev = j.messages.length - 2;   // the last assistant message, which holds r4's call
  j.messages[prev] = { ...j.messages[prev], content: j.messages[prev].content.map((b, n, all) => (n === all.length - 1 ? { ...b, cache_control: HOUR } : b)) };
  assert.equal(breakpointsOf(j).n, 4);
  const { t, sent } = send(rec, j, CFG(true), 1e12, { answered: false });
  assert.equal(t.reason, 'seed', 'there is room after all');
  assert.equal(breakpointsOf(sent).n, 4, 'still four: the API takes no more');
  assert.deepEqual(t.mark, { at: 3, ttl: '1h', n: 4, moved: prev });
  assert.equal(sent.messages[prev].content.some(b => b.cache_control), false, 'the older of the agent\'s two message breakpoints is the one given up');
  assert.deepEqual(sent.messages[sent.messages.length - 1].content[0].cache_control, HOUR, 'the newest stays: it is what stores this request for the next');
  assert.deepEqual(sent.messages[3].content.find(b => b.type === 'tool_use').cache_control, HOUR);
  assert.deepEqual(sent.system, j.system, 'and the system prompt\'s are never touched');
  const strip = x => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));
  assert.deepEqual(strip(sent), strip(j), 'not a byte else');
});

test('placeMark passes over a thinking block and a plain-string message', () => {
  const ms = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'said' }, think(10)] },
    { role: 'user', content: 'a plain string' },
    { role: 'assistant', content: [think(10)] },
    { role: 'user', content: [tr('a', 5000)] },
    { role: 'user', content: [{ type: 'text', text: 'now', cache_control: HOUR }] },
  ];
  const got = placeMark({ messages: ms }, ms, ['a']);
  // and a call whose own text goes with its result is itself changed, so the breakpoint sits before it
  const call = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }, { role: 'assistant', content: [{ type: 'text', text: 'writing' }, tu('w', { file_path: '/p/w', content: 'c'.repeat(6000) })] },
    { role: 'user', content: [tr('w', 5000)] }, ms[5]];
  assert.equal(placeMark({ messages: call }, call, ['w']).at, 0);
  assert.equal(placeMark({ messages: call }, call, ['w'], { cutInputs: false }).at, 1);
  assert.equal(got.at, 1);
  assert.deepEqual(got.messages[1].content[0].cache_control, HOUR);
  assert.equal(got.messages[1].content[1].cache_control, undefined);
  assert.equal(ms[1].content[0].cache_control, undefined, 'the request\'s own messages are not written on');
  assert.equal(placeMark({ messages: ms }, ms, ['nothing']), null);
});

test('a rung\'s tail starts at the call whose own text is cut with its result', () => {
  const big = { file_path: '/p/w', content: 'c'.repeat(6000) };
  const ms = [{ role: 'user', content: 'begin' }];
  for (let k = 0; k < 6; k++) {
    ms.push({ role: 'assistant', content: [think(300), tu(`r${k}`, k === 1 ? big : undefined)] });
    ms.push({ role: 'user', content: [tr(`r${k}`, 20000)] });
  }
  ms.push({ role: 'user', content: 'the live turn' });
  const { steps } = cutCandidates(ms, { keepMin: 3 });
  const rung = steps.find(s => s.ids[s.ids.length - 1] === 'r1');
  const from = ms.findIndex(m => Array.isArray(m.content) && m.content.some(b => b.id === 'r1'));
  const slice = applyCut(ms.slice(from), new Set(rung.ids)).messages;
  assert.equal(rung.tail, Math.round(JSON.stringify(slice).length * TOKENS_PER_CHAR) - unwritten(ms, rung.firstChanged));
  assert.equal(rung.firstChanged, from + 1, 'the result\'s own message is still where the rung is named');
});

test('a rung\'s tail starts after the message the breakpoint can sit on, whatever the walk back steps over', () => {
  // Claude Code's second message is the environment block, sent as a plain string: no breakpoint can go on it
  const env = 'e'.repeat(50000);
  const ms = [{ role: 'user', content: [{ type: 'text', text: 'reminders and the prompt' }] }, { role: 'system', content: env }];
  for (let k = 0; k < 6; k++) {
    // the first call's own text is long, so the cut changes the call's message and the walk starts above it
    ms.push({ role: 'assistant', content: [think(300), tu(`r${k}`, k === 0 ? { command: 'c'.repeat(6000) } : undefined)] });
    ms.push({ role: 'user', content: [tr(`r${k}`, 20000)] });
  }
  ms.push({ role: 'user', content: [{ type: 'text', text: 'the live turn', cache_control: HOUR }] });
  assert.equal(markBlock(ms[1]), -1);
  assert.equal(markBlock(ms[0]), 0);
  assert.equal(markBlock({ role: 'assistant', content: [think(10)] }), -1, 'a thinking block carries none');
  assert.equal(markBlock({ role: 'user', content: [{ type: 'text', text: '' }] }), -1);
  const { steps } = cutCandidates(ms, { keepMin: 3 });
  const deep = steps[steps.length - 1], shallow = steps[0];
  assert.equal(deep.ids[deep.ids.length - 1], 'r0');
  const j = { system: [{ type: 'text', text: 'sys', cache_control: HOUR }], messages: ms };
  const mark = placeMark(j, ms, deep.ids);
  assert.equal(mark.at, 0, 'the breakpoint steps over the string message');
  const written = applyCut(ms.slice(mark.at + 1), new Set(deep.ids)).messages;
  assert.equal(deep.tail, Math.round(JSON.stringify(written).length * TOKENS_PER_CHAR) - unwritten(ms, deep.firstChanged), 'and the price is everything after it, less the thinking below the cut');
  assert.ok(deep.tail > env.length * TOKENS_PER_CHAR, 'the message stepped over is in it');
  // a rung whose breakpoint has somewhere to sit right before it is priced as it was
  const at = placeMark(j, ms, shallow.ids).at;
  assert.equal(shallow.tail, Math.round(JSON.stringify(applyCut(ms.slice(at + 1), new Set(shallow.ids)).messages).length * TOKENS_PER_CHAR) - unwritten(ms, shallow.firstChanged));
});

test('the switch: a flag, a variable, the machine config, and a policy name of its own', () => {
  assert.equal(proxyConfig({}, {}).cutBreakpoint, true);
  assert.equal(proxyConfig({ 'no-cut-breakpoint': true }, {}).cutBreakpoint, false);
  assert.equal(proxyConfig({}, { THINKER_PROXY_CUT_BREAKPOINT: 'off' }).cutBreakpoint, false);
  assert.ok(policyId({ ...PROXY_DEFAULTS, cutBreakpoint: true }).includes('+bp'));
  assert.ok(!policyId({ ...PROXY_DEFAULTS, cutBreakpoint: false }).includes('+bp'), 'savings made with the breakpoint are never pooled with those made without');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-bp-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { cutBreakpoint: false } }));
    assert.ok(serviceArgs(home, { port: 4000 }).includes('--no-cut-breakpoint'), 'the service carries a machine that said no');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// 2026-11-18. Every earlier cut is still applied on the request that seeds the next one, and the row said nothing
// of it: `cleared` 0 on the one request a pause past the cache's hour writes whole.
test('the request that seeds a cut says what the cuts before it took out of it', () => {
  const cfg = CFG(true);
  // a conversation's first cut is seeded on a request sent whole: nothing to say
  const first = send(freshCut('s'), body(), cfg, 1e12);
  assert.equal(first.t.reason, 'seed'); assert.equal(first.t.clientCut, undefined);
  // one with r0 already out of it, at the next boundary: r1 is seeded, r0 stays a placeholder
  const rec = freshCut('s'); rec.cut = ['r0']; rec.turn = first.t.turn - 1; rec.at = 1e12 - 1000;
  const { t, sent } = send(rec, body(), cfg, 1e12);
  assert.equal(t.reason, 'seed', 'still a seed: the row keeps its reason');
  assert.equal(replaced(sent), 1, 'r0 as the earlier cut left it, and r1 not yet replaced');
  assert.equal(t.clientCut.cut, 1);
  assert.equal(t.clientCut.tokens, applyCut(body().messages, ['r0'], { cutInputs: cfg.cutInputs }).tokens, 'the tokens this request was sent without');
  assert.ok(t.clientCut.tokens > 100000);
  assert.equal(t.injected, undefined, 'and it is not marked as a request that made or held a cut, so nothing else about its row moves');
});
