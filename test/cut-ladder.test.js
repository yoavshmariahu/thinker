// The ladder: a boundary's candidate sets taken from the tail backwards, and the decision picking the
// deepest rung that pays (proxy.js:cutCandidates, cutting.js:decideCut).
//
// What these hold. That the ladder's deepest rung is exactly the whole-set candidate the single stringify
// used to produce, so the change costs no accuracy. That the rungs are nested suffixes, newest first. That
// the decision takes the biggest paying rung and not merely the first. That a tail-local cut is made where
// the whole set is refused, which is the point. And that a cold boundary still takes everything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutCandidates, applyCut, PROXY_DEFAULTS, TOKENS_PER_CHAR } from '../src/proxy.js';
import { decideCut, priceCut, freshCut, PAYBACK } from '../src/cutting.js';

const tu = id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/p/${id}` } });
const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
const think = n => ({ type: 'thinking', thinking: 'T'.repeat(n), signature: 'sig' });

// n turns, each: a prompt, an assistant row with thinking and a tool call, a result of `size` chars.
// `thinkChars` is the bulk a cut can never remove -- thinking, prompts, the agent's text, tool inputs. It is
// the whole reason a deep set is dear: on this machine's boundaries the results are only 26-34% of the span
// the rewrite covers, so a conversation built with token thinking blocks would not be one of ours.
function conversation(sizes, { tailPrompt = true, thinkChars = 400 } = {}) {
  const ms = [];
  sizes.forEach((size, k) => {
    ms.push({ role: 'user', content: `prompt ${k}` });
    ms.push({ role: 'assistant', content: [think(thinkChars), tu(`r${k}`)] });
    ms.push({ role: 'user', content: [tr(`r${k}`, size)] });
  });
  if (tailPrompt) ms.push({ role: 'user', content: 'the live turn' });
  return ms;
}

// the old way of pricing the whole set: one stringify of the slice from the first replaced result
const wholeByStringify = (messages, ids, have = []) => {
  const first = Math.min(...messages.map((m, i) => (Array.isArray(m.content) && m.content.some(b => b?.type === 'tool_result' && ids.includes(b.tool_use_id)) ? i : Infinity)));
  const sent = applyCut(messages.slice(first), new Set([...have, ...ids])).messages;
  return Math.round(JSON.stringify(sent).length * TOKENS_PER_CHAR);
};

test('the deepest rung is the whole-set candidate, priced as the single stringify priced it', () => {
  const ms = conversation([9000, 12000, 30000, 8000, 15000, 20000]);
  const c = cutCandidates(ms, { keepMin: 3 });
  assert.ok(c.steps.length >= 2, 'a ladder, not one set');
  const deepest = c.steps[c.steps.length - 1];
  assert.deepEqual(deepest.ids.slice().sort(), c.ids.slice().sort(), 'the last rung is every eligible result');
  assert.equal(deepest.tokens, c.tokens);
  assert.equal(c.recache, deepest.recache, 'the returned tail is the last rung');
  assert.equal(c.recache, wholeByStringify(ms, c.ids), 'and it equals the slice stringified in one piece');
});

test('the rungs are nested suffixes from the tail backwards, each dearer and bigger than the last', () => {
  const ms = conversation([9000, 12000, 30000, 8000, 15000, 20000]);
  const { steps } = cutCandidates(ms, { keepMin: 3 });
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i].ids.length > steps[i - 1].ids.length, 'each rung reaches one result further back');
    assert.deepEqual(steps[i].ids.slice(0, steps[i - 1].ids.length), steps[i - 1].ids, 'nested: the shallower set is a prefix');
    assert.ok(steps[i].tokens > steps[i - 1].tokens, 'deeper removes more');
    assert.ok(steps[i].recache >= steps[i - 1].recache, 'and rewrites at least as much');
    assert.ok(steps[i].firstChanged < steps[i - 1].firstChanged, 'the rewrite starts earlier');
  }
  // every rung's own tail matches the one-piece stringify of its own set
  for (const s of steps) assert.equal(s.recache, wholeByStringify(ms, s.ids), `rung of ${s.ids.length}`);
});

test('a tail-local cut is made where the whole set is refused, which is the whole point', () => {
  // Eight turns whose results are a third of what they weigh, which is the measured shape. Taking everything
  // rewrites eight turns of thinking to remove eight results; taking the newest removes one and rewrites
  // almost nothing.
  const ms = conversation(Array(8).fill(30000), { thinkChars: 90000 });
  const cand = cutCandidates(ms, { keepMin: 0 });
  const m = { prompt: Math.round(JSON.stringify(ms).length * TOKENS_PER_CHAR), turn: 1 };
  const opus = { model: 'claude-opus-5' };

  const whole = priceCut(m, { tokens: cand.tokens, recache: cand.recache }, opus);
  assert.equal(whole.pays, false, 'the old single set does not pay');

  const d = decideCut({ ...freshCut('s'), turn: 0, at: Date.now() }, { ...PROXY_DEFAULTS }, m, { cand, ...opus });
  assert.equal(d.clear, true, 'a rung of it does');
  assert.ok(d.payback <= PAYBACK);
  assert.ok(d.candidate < cand.tokens, 'and it took less than everything');
  assert.ok(d.depth < cand.ids.length, 'reaching back less far');
  assert.equal(d.rungs, cand.steps.length);
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

test('a cold boundary still takes everything, at no cost, whatever the ladder says', () => {
  const ms = conversation([40000, 40000, 40000, 40000, 300000]);
  const cand = cutCandidates(ms, { keepMin: 0 });
  const rec = { ...freshCut('s'), turn: 0, at: 1000 };
  const d = decideCut(rec, { ...PROXY_DEFAULTS }, { prompt: 500000, turn: 1 }, { cand, now: 1000 + 66 * 60 * 1000, model: 'claude-opus-5' });
  assert.equal(d.clear, true);
  assert.equal(d.cold, true);
  assert.equal(d.cost, 0);
  assert.deepEqual(d.cut.slice().sort(), cand.ids.slice().sort(), 'every eligible result, not a rung');
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
