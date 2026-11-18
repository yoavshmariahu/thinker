// The ladder: a boundary's candidate sets taken from the tail backwards, and the decision picking the
// deepest rung that pays (proxy.js:cutCandidates, cutting.js:decideCut).
//
// What these hold. That every rung is priced at the WHOLE conversation as it will be sent (2026-11-16): the
// API reads a cached prefix only within 20 positions of a breakpoint, so a result replaced further back
// leaves the system prompt as the only thing read, and the tail the ladder priced until then was 1.6x to 7x
// under what the API wrote. That the tail is still measured beside it, for the log. That the rungs are
// nested suffixes, newest first. That the decision takes the biggest paying rung and not merely the first.
// That a tail-local cut is NOT made where the whole set is refused. And that a cold boundary is priced as a warm one is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutCandidates, applyCut, thinkingChars, lastPrompt, PROXY_DEFAULTS, TOKENS_PER_CHAR } from '../src/proxy.js';
import { decideCut, priceCut, freshCut, PAYBACK } from '../src/cutting.js';

const tu = id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/p/${id}` } });
const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
const think = n => ({ type: 'thinking', thinking: 'T'.repeat(n), signature: 'sig' });

// n turns, each: a prompt, an assistant row with thinking and a tool call, a result of `size` chars.
// `thinkChars` is the bulk a cut can never remove -- thinking, prompts, the agent's text, tool inputs. It is
// the whole reason a deep set is dear: on this machine's boundaries the results are only 26-34% of the span
// the rewrite covers, so a conversation built with token thinking blocks would not be one of ours.
function conversation(sizes, { tailPrompt = true, thinkChars = 400, textChars = 0 } = {}) {
  const ms = [];
  sizes.forEach((size, k) => {
    ms.push({ role: 'user', content: `prompt ${k}` });
    ms.push({ role: 'assistant', content: [think(thinkChars), ...(textChars ? [{ type: 'text', text: 't'.repeat(textChars) }] : []), tu(`r${k}`)] });
    ms.push({ role: 'user', content: [tr(`r${k}`, size)] });
  });
  if (tailPrompt) ms.push({ role: 'user', content: 'the live turn' });
  return ms;
}

// The thinking below a rung's first change and before the turn in progress: no cut writes it (2026-11-18), so
// it is off every rung's price, whether or not the proxy also leaves it out.
const unwritten = (messages, firstChanged) => { const live = lastPrompt(messages); return Math.round(messages.reduce((n, m, i) => n + (i > firstChanged && i < live ? thinkingChars(m) : 0), 0) * TOKENS_PER_CHAR); };
// every message as sent with a set replaced, in one stringify: what a cut makes the API write, less that thinking
const firstOf = (messages, ids) => Math.min(...messages.map((m, i) => (Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result' && ids.includes(b.tool_use_id)) ? i : Infinity)));
const allByStringify = (messages, ids, have = []) =>
  Math.round(JSON.stringify(applyCut(messages, new Set([...have, ...ids])).messages).length * TOKENS_PER_CHAR) - unwritten(messages, firstOf(messages, ids));
// the tail alone: one stringify of the slice from the first replaced result (what `recache` was until 2026-11-16)
const wholeByStringify = (messages, ids, have = []) => {
  const first = Math.min(...messages.map((m, i) => (Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result' && ids.includes(b.tool_use_id)) ? i : Infinity)));
  const sent = applyCut(messages.slice(first), new Set([...have, ...ids])).messages;
  return Math.round(JSON.stringify(sent).length * TOKENS_PER_CHAR) - unwritten(messages, first);
};

test('the deepest rung is the whole-set candidate, priced at every message as sent', () => {
  const ms = conversation([9000, 12000, 30000, 8000, 15000, 20000]);
  const c = cutCandidates(ms, { keepMin: 3 });
  assert.ok(c.steps.length >= 2, 'a ladder, not one set');
  const deepest = c.steps[c.steps.length - 1];
  assert.deepEqual(deepest.ids.slice().sort(), c.ids.slice().sort(), 'the last rung is every eligible result');
  assert.equal(deepest.tokens, c.tokens);
  assert.equal(c.recache, deepest.recache, 'the returned rewrite is the last rung');
  assert.equal(c.recache, allByStringify(ms, c.ids), 'and it is the whole conversation as sent, stringified in one piece');
  assert.equal(deepest.tail, wholeByStringify(ms, c.ids), 'the tail from the first replaced result is kept beside it');
  assert.ok(c.recache > deepest.tail, 'and the whole is more than the tail: the prompt above the cut is written too');
});

test('the rungs are nested suffixes from the tail backwards, each bigger and no dearer than the last', () => {
  const ms = conversation([9000, 12000, 30000, 8000, 15000, 20000]);
  const { steps } = cutCandidates(ms, { keepMin: 3 });
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].ids.length > steps[i - 1].ids.length, 'each rung reaches one result further back');
    assert.deepEqual(steps[i].ids.slice(0, steps[i - 1].ids.length), steps[i - 1].ids, 'nested: the shallower set is a prefix');
    assert.ok(steps[i].tokens > steps[i - 1].tokens, 'deeper removes more');
    assert.ok(steps[i].recache < steps[i - 1].recache, 'and rewrites less: the same conversation, shorter by what it took');
    assert.ok(steps[i].tail >= steps[i - 1].tail, 'while its tail is at least as long');
    assert.ok(steps[i].firstChanged < steps[i - 1].firstChanged, 'the first replaced result is earlier');
  }
  // every rung's rewrite is the one-piece stringify of the whole conversation with its own set replaced
  for (const s of steps) {
    assert.equal(s.recache, allByStringify(ms, s.ids), `rung of ${s.ids.length}`);
    assert.equal(s.tail, wholeByStringify(ms, s.ids), `tail of ${s.ids.length}`);
  }
});

test('a tail-local cut is refused where the whole set is: a shallow rung rewrites the conversation too', () => {
  // Eight turns whose results are a third of what they weigh, which is the measured shape. Until 2026-11-16
  // the newest rung was priced as rewriting almost nothing and was taken here. The API wrote the whole
  // conversation for such a cut (35k predicted, 245k written, a cache read of the system prompt alone), so
  // a rung that removes less than everything can only cost more than the set that was already refused.
  // The bulk is the agent's own text here, not thinking: thinking below a cut is in nothing the cut writes.
  const ms = conversation(Array(8).fill(30000), { textChars: 90000 });
  const cand = cutCandidates(ms, { keepMin: 0 });
  const m = { prompt: Math.round(JSON.stringify(ms).length * TOKENS_PER_CHAR), turn: 1 };
  const opus = { model: 'claude-opus-5' };

  const whole = priceCut(m, { tokens: cand.tokens, recache: cand.recache }, opus);
  assert.equal(whole.pays, false, 'the old single set does not pay');

  const shallow = cand.steps[0];
  assert.equal(priceCut(m, { tokens: shallow.tokens, recache: shallow.tail }, opus).pays, true, 'priced on its tail the newest rung paid');
  assert.equal(priceCut(m, shallow, opus).pays, false, 'priced on what the API writes it does not');

  const d = decideCut({ ...freshCut('s'), turn: 0, at: Date.now() }, { ...PROXY_DEFAULTS }, m, { cand, ...opus });
  assert.equal(d.clear, false, 'so no rung is taken');
  assert.equal(d.reason, 'payback');
  assert.ok(d.held.payback > PAYBACK);
  assert.equal(d.held.depth, cand.ids.length, 'and the rung nearest to paying is the deepest');
  assert.equal(d.held.rungs, cand.steps.length);
});

test('the deepest paying rung is taken, not the first that pays', () => {
  const ms = conversation([30000, 30000, 30000, 30000, 30000, 30000]);
  const cand = cutCandidates(ms, { keepMin: 0 });
  const m = { prompt: Math.round(JSON.stringify(ms).length * TOKENS_PER_CHAR), turn: 1 };
  const rates = { read: 0.5, write: 1.0 };   // GLM's, where most rungs pay
  const d = decideCut({ ...freshCut('s'), turn: 0, at: Date.now() }, { ...PROXY_DEFAULTS }, m, { cand, rates });
  assert.equal(d.clear, true);
  const paying = cand.steps.filter(s => s.tokens >= PROXY_DEFAULTS.clearAtLeast && priceCut(m, s, { rates }).pays);
  assert.equal(d.candidate, Math.max(...paying.map(s => s.tokens)), 'the largest saving among the rungs that pay');
});

test('a floor above every rung is the floor refusing, and the shallow rungs stay out of the way', () => {
  const ms = conversation([9000, 9000, 9000, 9000, 9000, 9000]);
  const cand = cutCandidates(ms, { keepMin: 3 });
  const m = { prompt: 400000, turn: 1 };
  const rec = () => ({ ...freshCut('s'), turn: 0, at: Date.now() });
  const high = decideCut(rec(), { ...PROXY_DEFAULTS, clearAtLeast: 10 ** 7 }, m, { cand, model: 'claude-opus-5' });
  assert.equal(high.clear, false);
  assert.equal(high.reason, 'below-clear-minimum', 'no rung clears the floor');
  // and with the shipped floor the rungs under it are never priced into a verdict
  const d = decideCut(rec(), { ...PROXY_DEFAULTS }, m, { cand, rates: { read: 0.5, write: 1 } });
  if (d.clear) assert.ok(d.candidate >= PROXY_DEFAULTS.clearAtLeast, 'what it took clears the floor');
});

test('a cold boundary takes the rung a warm one would, and no deeper', () => {
  // Until 2026-11-18 a pause past the cache's hour priced every rung at nothing, so the deepest was always taken.
  const ms = conversation([40000, 40000, 40000, 40000, 300000]);
  const cand = cutCandidates(ms, { keepMin: 0 });
  const rec = { ...freshCut('s'), turn: 0, at: 1000 };
  const opts = { cand, model: 'claude-opus-5' };
  const cold = decideCut(rec, { ...PROXY_DEFAULTS }, { prompt: 500000, turn: 1 }, { ...opts, now: 1000 + 66 * 60 * 1000 });
  const warm = decideCut(rec, { ...PROXY_DEFAULTS }, { prompt: 500000, turn: 1 }, { ...opts, now: 2000 });
  const { cold: _c, ...coldRest } = cold, { cold: _w, ...warmRest } = warm;
  assert.deepEqual(coldRest, warmRest, 'the same verdict, the same rung, the same price');
  if (cold.clear) assert.ok(cold.cost !== 0 || cold.payback === 0, 'no rewrite is priced at nothing for the pause');
});

test('nothing eligible is still no ladder and no cut', () => {
  const ms = conversation([100, 100, 100]);           // every result under MIN_CHARS
  const c = cutCandidates(ms, { keepMin: 0 });
  assert.deepEqual(c.steps, []);
  assert.equal(c.recache, 0);
  assert.equal(c.ids.length, 0);
  const d = decideCut({ ...freshCut('s'), turn: 0, at: Date.now() }, { ...PROXY_DEFAULTS }, { prompt: 400000, turn: 1 }, { cand: c, model: 'claude-opus-5' });
  assert.equal(d.reason, 'nothing-to-cut');
});

// The row must say which rung was taken, or a boundary that had one choice reads exactly like one that had
// nine. The live smoke of 2026-11-14 came back unreadable for want of these two fields: the decision carried
// `depth` and `rungs`, and no log row did -- `proxy.js` assembles its row from a named list.
test('the decision puts depth and rungs where every door already logs them', async () => {
  const { transformRequest } = await import('../src/proxy.js');
  const ms = conversation(Array(8).fill(30000), { thinkChars: 9000 });
  const cand = cutCandidates(ms, { keepMin: 0 });
  assert.ok(cand.steps.length > 1, 'a ladder with a choice in it');
  const m = { prompt: Math.round(JSON.stringify(ms).length * TOKENS_PER_CHAR), turn: 1 };
  const rec = () => ({ ...freshCut('s'), turn: 0, at: Date.now() });

  // a cut names the rung it took
  const took = decideCut(rec(), { ...PROXY_DEFAULTS }, m, { cand, rates: { read: 0.5, write: 1 } });
  assert.equal(took.clear, true);
  assert.equal(typeof took.depth, 'number');
  assert.equal(took.rungs, cand.steps.length);

  // a refusal names the rung it refused, so the log says whether there was a choice at all
  // A refusal needs the eligible result to be OLD, with protected bulk behind it: the shallowest rung is
  // otherwise almost free on its tail (10,800 tokens out for a 111-token tail) -- which is the pricing that
  // was wrong, and since 2026-11-16 that rung is priced at the whole conversation like any other.
  // With keepMin 7 only the oldest result is eligible and seven turns of bulk follow it, so it cannot pay.
  const far = cutCandidates(ms, { keepMin: 7 });
  assert.equal(far.steps.length, 1, 'one eligible result, so one rung and no choice to make');
  const held = decideCut(rec(), { ...PROXY_DEFAULTS, trigger: 1 }, m, { cand: far, model: 'claude-opus-5' });
  assert.equal(held.reason, 'payback');
  assert.equal(held.held.rungs, 1, 'and the row says so, instead of looking like a boundary that had nine');
  assert.equal(held.held.depth, 1);

  // and the Messages door's row carries them inside `clear`, which it already logged
  const body = Buffer.from(JSON.stringify({ model: 'claude-opus-5', messages: ms }));
  const t = transformRequest('POST', '/v1/messages', { 'x-claude-code-session-id': 'row-test' }, body, {
    ...PROXY_DEFAULTS, holdout: 0, cutRecord: { ...freshCut('row-test'), turn: 0, at: Date.now() },
  });
  if (t?.clear) {
    assert.equal(typeof t.clear.depth, 'number', 'the row names the rung');
    assert.ok(t.clear.rungs >= 1);
  }
});

test('thinking below a cut is in nothing the cut writes, and thinking above it and in the turn in progress still is', () => {
  // The shape of this machine's 2026-11-18 cuts: a third of the conversation's characters are thinking
  // signatures, and the rewrite was predicted three times what the API wrote (181,105 against 54,838).
  const plain = conversation([30000, 30000, 30000, 30000, 30000, 30000], { thinkChars: 0 });
  const thought = conversation([30000, 30000, 30000, 30000, 30000, 30000], { thinkChars: 20000 });
  const a = cutCandidates(plain, { keepMin: 3 }), b = cutCandidates(thought, { keepMin: 3 });
  const deep = b.steps[b.steps.length - 1], bare = a.steps[a.steps.length - 1];
  // the deepest rung's first change is r0's result: only r0's own call sits above it with its thinking
  const above = Math.round(thinkingChars(thought[1]) * TOKENS_PER_CHAR) - Math.round(thinkingChars(plain[1]) * TOKENS_PER_CHAR);
  assert.ok(above > 7000);
  assert.equal(deep.tail, bare.tail, 'the tail is priced as if the thinking below it were not there');
  assert.ok(Math.abs(deep.recache - bare.recache - above) <= 2, 'and the whole keeps only the thinking above the first change');
  // a turn in progress keeps its thinking in the price
  const turn = n => [...thought, { role: 'assistant', content: [think(n), tu('live')] }, { role: 'user', content: [tr('live', 300)] }];
  const deepest = ms => cutCandidates(ms, { keepMin: 3 }).steps.find(st => st.ids[st.ids.length - 1] === 'r0');
  const live = Math.round(thinkingChars(turn(20000)[turn(20000).length - 2]) * TOKENS_PER_CHAR) - Math.round(thinkingChars(turn(0)[turn(0).length - 2]) * TOKENS_PER_CHAR);
  assert.ok(Math.abs(deepest(turn(20000)).tail - deepest(turn(0)).tail - live) <= 2, 'the live turn\'s thinking is still counted');
});
