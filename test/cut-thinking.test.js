// The earlier turns' thinking goes with a cut (proxy.js: `cutThinking`, off by default).
//
// What these hold. That a cut leaves out the thinking of the messages after its own oldest replaced result and
// before the turn it was made in, and nothing else: not a block above the cut, not one of the turn in progress,
// not a message that holds thinking alone. That the ladder prices exactly what is then sent. That the same
// blocks stay out on every later request, so the bytes above the newest message never move. That a second cut
// adds a range of its own and leaves the first as it was. And that nothing changes with the switch off.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transformRequest, proxyConfig, cutCandidates, applyCut, placeMark, thinkingChars, thinkingGone, turnIndex, turnId, PROXY_DEFAULTS, TOKENS_PER_CHAR, THINKING_TOKENS_PER_CHAR, resultTokens } from '../src/proxy.js';
import { cutResponse, freshCut, addThink, mergeCut, policyId } from '../src/cutting.js';
import { serviceArgs } from '../src/proxy-service.js';

const tu = id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/p/${id}` } });
const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
const think = (n, tag = 'T') => ({ type: 'thinking', thinking: '', signature: tag.repeat(n) });
const isThink = b => b.type === 'thinking' || b.type === 'redacted_thinking';
const thinkingAt = ms => ms.map((m, i) => (Array.isArray(m.content) && m.content.some(isThink) ? i : -1)).filter(i => i >= 0);

// `turns` turns, each a prompt, a thinking call, its result, and a thinking answer
function conversation(turns, { size = 20000, thought = 3000, live = true } = {}) {
  const ms = [];
  for (let k = 0; k < turns; k++) {
    ms.push({ role: 'user', content: `prompt ${k}` });
    ms.push({ role: 'assistant', content: [think(thought), tu(`r${k}`)] });
    ms.push({ role: 'user', content: [tr(`r${k}`, typeof size === 'function' ? size(k) : size)] });
    ms.push({ role: 'assistant', content: [think(thought), { type: 'text', text: `answer ${k}` }] });
  }
  if (live) ms.push({ role: 'user', content: [{ type: 'text', text: 'the live turn' }] });
  return ms;
}

test('what a message can lose, and where a turn starts', () => {
  const a = { role: 'assistant', content: [think(100), tu('a')] };
  assert.equal(thinkingChars(a), JSON.stringify(a.content[0]).length + 1, 'the block and its comma');
  assert.equal(thinkingChars({ role: 'assistant', content: [think(100)] }), 0, 'a message of thinking alone is left whole: it may not be sent empty');
  assert.equal(thinkingChars({ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'zz' }, tu('b')] }) > 0, true, 'a redacted block goes too');
  assert.equal(thinkingChars({ role: 'user', content: [tr('a', 10)] }), 0);
  const ms = conversation(3);
  assert.equal(turnId(ms), 4);
  assert.deepEqual([1, 2, 3, 4, 5].map(t => turnIndex(ms, t)), [0, 4, 8, 12, 13], 'the prompt that opens each turn; the end for one not begun');
});

test('off by default: a cut leaves the thinking where it is', () => {
  assert.equal(PROXY_DEFAULTS.cutThinking, false);
  const ms = conversation(6), a = applyCut(ms, ['r0', 'r1']);
  assert.deepEqual(thinkingAt(a.messages), thinkingAt(ms));
  assert.equal('thinking' in a, false);
  assert.equal('thinking' in cutCandidates(ms, { keepMin: 3 }).steps[0], false);
});

test('a cut leaves out the thinking after its oldest result and before the turn it was made in', () => {
  const ms = conversation(6), turn = turnId(ms);
  const a = applyCut(ms, ['r1', 'r2'], { thinking: [['r1', turn]] });
  // r1's result is message 6: its own call (5) keeps its thinking, since that was said before the result
  assert.deepEqual(thinkingAt(a.messages), [1, 3, 5], 'everything above the cut point stays, as one run');
  const lost = [7, 9, 11, 13, 15, 17, 19, 21, 23].reduce((n, i) => n + thinkingChars(ms[i]), 0);
  assert.equal(a.thinking, Math.round(lost * THINKING_TOKENS_PER_CHAR));
  assert.equal(a.tokens, resultTokens('x'.repeat(a.chars)) + a.thinking, 'and it is part of what the prompt is shorter by');
  for (const i of [7, 23]) assert.deepEqual(a.messages[i].content, ms[i].content.filter(b => !isThink(b)), 'the rest of the message is the agent\'s own');
  assert.equal(ms[7].content.length, 2, 'the request\'s own messages are not written on');
  // the turn in progress: its thinking must go back to the API as it came
  const going = [...ms, { role: 'assistant', content: [think(500), tu('live')] }, { role: 'user', content: [tr('live', 300)] }];
  const b = applyCut(going, ['r1', 'r2'], { thinking: [['r1', turn]] });
  assert.deepEqual(thinkingAt(b.messages), [1, 3, 5, 25]);
  assert.deepEqual(b.messages.slice(0, ms.length), a.messages, 'and not a byte above it has moved');
});

test('the ladder prices what is then sent, and counts the thinking as removed', () => {
  const ms = conversation(8), turn = turnId(ms), to = turnIndex(ms, turn);
  const plain = cutCandidates(ms, { keepMin: 3 }), c = cutCandidates(ms, { keepMin: 3, thinking: { to, done: [] } });
  assert.equal(c.steps.length, plain.steps.length);
  c.steps.forEach((s, k) => {
    const oldest = s.ids[s.ids.length - 1];
    const sent = applyCut(ms, s.ids, { thinking: [[oldest, turn]] });
    assert.ok(Math.abs(s.tail - Math.round(JSON.stringify(sent.messages.slice(s.firstChanged)).length * TOKENS_PER_CHAR)) <= 1, `rung ${k}: the tail is the messages as sent from the first replaced result`);
    assert.ok(Math.abs(s.recache - Math.round(JSON.stringify(sent.messages).length * TOKENS_PER_CHAR)) <= 1, `rung ${k}: and the whole is every message as sent`);
    assert.equal(s.tokens, sent.tokens, `rung ${k}: what it removes is what the applied cut reports`);
    assert.equal(s.tokens, plain.steps[k].tokens + s.thinking);
    assert.ok(s.tail < plain.steps[k].tail && s.thinking > 0);
  });
  assert.equal(c.tokens, c.steps[c.steps.length - 1].tokens, 'the whole set is the deepest rung');
});

// one request through the door, with the record kept the way the proxy keeps it
function send(rec, j, cfg, now) {
  const t = transformRequest('POST', '/v1/messages', {}, Buffer.from(JSON.stringify(j)), { ...cfg, cutRecord: rec, now });
  if (Array.isArray(t.cut) && t.turn != null) { rec.cut = t.cut; rec.turn = t.turn; if (t.think) rec.think = addThink(rec.think, t.think); }
  cutResponse(rec, cfg, t, { read: 1 }, { now });
  return { t, sent: JSON.parse(t.body) };
}
const CFG = { ...PROXY_DEFAULTS, trigger: 1000, clearAtLeast: 1000, cutThinking: true };

test('through the door: the cut names its range, and every later request leaves out the same blocks', () => {
  const ms = conversation(6), rec = { ...freshCut('s'), at: 1 };   // a pause past the cache's hour: everything eligible goes
  const { t, sent } = send(rec, { model: 'claude-opus-5', messages: ms }, CFG, 1e12);
  assert.equal(t.injected, true);
  assert.deepEqual(t.think, ['r0', 7], 'from the oldest result replaced, to this turn');
  assert.deepEqual(rec.think, [['r0', 7]]);
  assert.deepEqual(thinkingAt(sent.messages), [1], 'only the thinking said before the first replaced result is left');
  assert.ok(t.clientCut.thinking > 0 && t.clear.thinking === t.clientCut.thinking);
  assert.ok(t.policy.endsWith('+th'));
  // the turn goes on: the model thinks, calls a tool, and the request comes back with both
  const next = [...ms, { role: 'assistant', content: [think(700, 'N'), tu('live')] }, { role: 'user', content: [tr('live', 300)] }];
  const again = send(rec, { model: 'claude-opus-5', messages: next }, CFG, 1e12 + 1000);
  assert.deepEqual(again.sent.messages.slice(0, ms.length), sent.messages, 'the prefix is byte for byte what the cut request sent');
  assert.deepEqual(again.sent.messages[ms.length], next[ms.length], 'and the turn in progress keeps its thinking');
  assert.deepEqual(rec.think, [['r0', 7]], 'a request that cuts nothing adds no range');
});

test('a second cut adds its own range and leaves the first as it was', () => {
  // turns 3 to 5 answer in a line, so nothing of theirs is ever worth replacing
  const size = k => (k >= 3 && k <= 5 ? 50 : 20000);
  const ms = conversation(6, { size }), rec = { ...freshCut('s'), at: 1 };
  const first = send(rec, { model: 'claude-opus-5', messages: ms }, CFG, 1e12);
  assert.deepEqual(rec.think, [['r0', 7]]);
  // six more turns, said after the cut; then a long pause, and the boundary cuts again
  const more = conversation(12, { size });
  const second = send(rec, { model: 'claude-opus-5', messages: more }, CFG, 1e12 + 3 * 3600e3);
  assert.equal(second.t.injected, true);
  assert.deepEqual(rec.think, [['r0', 7], ['r6', 13]]);
  const anchor = more.findIndex(m => Array.isArray(m.content) && m.content.some(b => b.tool_use_id === 'r6'));
  assert.equal(anchor, 26);
  assert.deepEqual(second.sent.messages.slice(0, 24), first.sent.messages.slice(0, 24), 'the first cut\'s part of the prompt has not moved');
  assert.deepEqual(thinkingAt(second.sent.messages), [1, 25], 'thinking said after the first cut and above the second is still there, and none below it');
  const gone = thinkingGone(more, rec.think);
  assert.deepEqual([23, 24, 25, 26, 27].map(i => gone[i]), [true, false, false, false, true]);
});

test('the record only ever grows, and the switch has a flag, a variable, a config key and a policy name', () => {
  assert.deepEqual(addThink([['a', 3]], ['a', 2]), [['a', 3]], 'a range is never shortened');
  assert.deepEqual(addThink([['a', 3]], ['b', 5]), [['a', 3], ['b', 5]]);
  const merged = mergeCut({ ...freshCut('s'), turn: 5, think: [['a', 3]] }, { ...freshCut('s'), turn: 5, think: [['b', 5]] });
  assert.deepEqual(merged.think, [['a', 3], ['b', 5]], 'two clones of one record keep both ranges');
  assert.equal('think' in mergeCut(freshCut('s'), freshCut('s')), false);
  assert.equal(proxyConfig({}, {}).cutThinking, false);
  assert.equal(proxyConfig({ 'cut-thinking': true }, {}).cutThinking, true);
  assert.equal(proxyConfig({}, { THINKER_PROXY_CUT_THINKING: 'on' }).cutThinking, true);
  assert.ok(policyId({ ...PROXY_DEFAULTS, cutThinking: true }).endsWith('+th'));
  assert.ok(!policyId(PROXY_DEFAULTS).includes('+th'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-th-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { cutThinking: true } }));
    assert.ok(serviceArgs(home, { port: 4000 }).includes('--cut-thinking'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('thinkingKeepTurns: only thinking that many turns old goes with a cut', () => {
  const ms = conversation(6), rec = { ...freshCut('s'), at: 1 };
  const { t, sent } = send(rec, { model: 'claude-opus-5', messages: ms }, { ...CFG, thinkingKeepTurns: 2 }, 1e12);
  assert.equal(t.injected, true);
  assert.deepEqual(t.think, ['r0', 5], 'the range stops two turns before the one in progress');
  // turns 5 and 6 (messages 16 to 23) keep theirs; message 1 is above the first replaced result
  assert.deepEqual(thinkingAt(sent.messages), [1, 17, 19, 21, 23]);
  const lost = [3, 5, 7, 9, 11, 13, 15].reduce((n, i) => n + thinkingChars(ms[i]), 0);
  assert.equal(t.clientCut.thinking, Math.round(lost * THINKING_TOKENS_PER_CHAR));
  assert.equal(t.clear.thinking, t.clientCut.thinking, 'and the ladder priced the same blocks');
  assert.ok(t.policy.endsWith('+th2'));
  // more turns kept than there are: no range, and no thinking moves
  const all = send({ ...freshCut('s'), at: 1 }, { model: 'claude-opus-5', messages: ms }, { ...CFG, thinkingKeepTurns: 50 }, 1e12);
  assert.equal(all.t.injected, true);
  assert.equal('think' in all.t, false);
  assert.deepEqual(thinkingAt(all.sent.messages), thinkingAt(ms));
  assert.equal(turnIndex(ms, 0), 0);
  assert.equal(proxyConfig({}, {}).thinkingKeepTurns, 0);
  assert.equal(proxyConfig({ 'thinking-keep-turns': '3' }, {}).thinkingKeepTurns, 3);
  assert.equal(proxyConfig({}, { THINKER_PROXY_THINKING_KEEP_TURNS: '2' }).thinkingKeepTurns, 2);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-th-'));
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { cutThinking: true, thinkingKeepTurns: 3 } }));
    const args = serviceArgs(home, { port: 4000 });
    assert.equal(args[args.indexOf('--thinking-keep-turns') + 1], '3');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('thinkingKeepTurns: a later cut never reaches above its own first result for thinking that has aged', () => {
  // The case from a nine-turn PostHog session (2026-11-18): thinking too new for the first cut had aged by the
  // next one, sat above everything that cut replaced, and taking it moved the breakpoint to the top.
  const cfg = { ...CFG, thinkingKeepTurns: 1, keepMin: 1 }, rec = { ...freshCut('s'), at: 1 };
  const ms = conversation(6);
  const first = send(rec, { model: 'claude-opus-5', messages: ms }, cfg, 1e12);
  assert.deepEqual(rec.think, [['r0', 6]]);
  assert.deepEqual(thinkingAt(first.sent.messages), [1, 21, 23], 'the turn before the live one keeps its thinking');
  // two more turns, a long pause, and the boundary cuts again. Its oldest new result is r5, at message 22.
  const more = conversation(8);
  const second = send(rec, { model: 'claude-opus-5', messages: more }, cfg, 1e12 + 3 * 3600e3);
  assert.equal(second.t.injected, true);
  assert.deepEqual(rec.think, [['r0', 6], ['r5', 8]], 'its own range, from its own oldest result');
  // message 21 is above r5's result: aged, and left where it is. 23 to 27 are inside the span being rewritten.
  assert.deepEqual(thinkingAt(second.sent.messages), [1, 21, 29, 31]);
  const newly = [23, 25, 27].reduce((n, i) => n + thinkingChars(more[i]), 0);
  assert.equal(second.t.clear.thinking, Math.round(newly * THINKING_TOKENS_PER_CHAR));
  assert.deepEqual(second.sent.messages.slice(0, 22), first.sent.messages.slice(0, 22), 'not a byte above the cut has moved');
  // so the rewrite starts where it would have without the thinking, and is only ever smaller for it
  const plain = cutCandidates(more, { keepMin: 1, cut: first.t.cut });
  const c = cutCandidates(more, { keepMin: 1, cut: first.t.cut, thinking: { to: turnIndex(more, 8), done: [['r0', 6]] } });
  assert.ok(c.steps.length >= 1);
  c.steps.forEach((s, k) => {
    assert.equal(s.firstChanged, plain.steps[k].firstChanged);
    assert.ok(s.tail <= plain.steps[k].tail, `rung ${k}: the tail is never longer for the thinking`);
    const j = { messages: more, cache_control: { type: 'ephemeral' } };
    const sent = applyCut(more, [...first.t.cut, ...s.ids], { thinking: [['r0', 6], [s.ids[s.ids.length - 1], 8]] });
    const bare = applyCut(more, [...first.t.cut, ...s.ids]);
    assert.equal(placeMark(j, sent.messages, s.ids).at, placeMark(j, bare.messages, s.ids).at, `rung ${k}: the breakpoint is where it would be with the thinking kept`);
  });
});
