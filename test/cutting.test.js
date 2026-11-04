// The three properties the client-side cut exists to provide. Each was impossible with the
// server-side edit, and each failure below is one this session measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cutCandidates, applyCut, transformRequest, proxyConfig, cutPlaceholder } from '../src/proxy.js';
import { decideCut, freshCut, priceCut } from '../src/cutting.js';

const BIG = 'X'.repeat(40000);
const headers = { 'anthropic-beta': 'context-management-2025-06-27' };
// n turns of `calls` tool uses each, then a fresh prompt: the shape of a working session
const session = (turns, calls = 4) => {
  const ms = [];
  for (let t = 0; t < turns; t++) {
    ms.push({ role: 'user', content: [{ type: 'text', text: `turn ${t}` }] });
    for (let c = 0; c < calls; c++) {
      ms.push({ role: 'assistant', content: [{ type: 'thinking', thinking: `t${t}.${c}`, signature: 'sig' }, { type: 'tool_use', id: `u${t}.${c}`, name: 'Read', input: { file_path: `/f${t}.${c}` } }] });
      ms.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${t}.${c}`, content: BIG }] });
    }
  }
  ms.push({ role: 'user', content: [{ type: 'text', text: 'the newest prompt' }] });
  return ms;
};
const body = messages => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages }));
const cfg = extra => ({ ...proxyConfig({}, {}), clientCut: true, trigger: 1, clearAtLeast: 1, ...extra });

test('the newest turn is kept by a rule, not a count: a turn of ten tool calls keeps all ten', () => {
  // B6, measured: with `keep: 3` the API kept three echoes and cleared the 25k read the turn was
  // about to answer from, and the model said "I can't see the line count" on 4 of 14 turns. A count
  // cannot express "this turn's work"; the rule can.
  const ms = session(3, 10);
  ms.pop();                                            // the newest turn is the last one, still open
  const c = cutCandidates(ms, { keepMin: 3 });
  const live = new Set(Array.from({ length: 10 }, (_, i) => `u2.${i}`));
  assert.equal(c.ids.some(id => live.has(id)), false, 'nothing from the turn in progress is a candidate');
  // keepMin is a FLOOR, not an allowance on top: the newest turn's results count towards it, as in
  // the mod (`inLatestTurn || kept < keepMin`). A ten-call turn already exceeds a floor of three, so
  // both settled turns are candidates in full.
  assert.equal(c.ids.length, 20, 'both settled turns, the live one untouched');
  const short = session(3, 1); short.pop();
  assert.equal(cutCandidates(short, { keepMin: 3 }).ids.length, 0, 'the floor covers a one-call turn');
});

test('the ratchet: once cut, a result stays cut, so every call of a turn is byte-identical', () => {
  // The server-side edit had no state: it re-derived the clearing per call, moved the set on its own
  // schedule (3 moves in one 9-turn run, 15 in a week of the live log) and rewrote the prefix each
  // time. Here the set is ours, so the bytes cannot move while the turn runs.
  const ms = session(4);
  const rec = { ...freshCut('s'), cut: [], turn: 0 };
  const first = transformRequest('POST', '/v1/messages', headers, body(ms), { ...cfg(), cutRecord: rec });
  assert.equal(first.injected, true);
  assert.ok(first.cut.length > 0, 'the boundary decided a cut');
  rec.cut = first.cut; rec.turn = first.turn;           // as cutResponse would persist it
  // three more calls inside the same turn, each with another tool use appended
  let grown = ms, prev = null;
  for (let i = 0; i < 3; i++) {
    grown = [...grown,
      { role: 'assistant', content: [{ type: 'tool_use', id: `n${i}`, name: 'Bash', input: { command: 'echo' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `n${i}`, content: 'ok' }] }];
    const t = transformRequest('POST', '/v1/messages', headers, body(grown), { ...cfg(), cutRecord: rec });
    const sent = JSON.parse(t.body).messages.slice(0, ms.length);   // the prefix the cache matches on
    if (prev) assert.deepEqual(sent, prev, 'the prefix is byte-identical from one call of a turn to the next');
    prev = sent;
    assert.deepEqual(t.cut, rec.cut, 'the set does not move mid-turn');
  }
});

test('a cut that does not pay is not made, and the placeholder is deterministic', () => {
  const ms = session(4);
  // a tiny candidate against a huge tail: the rewrite cannot repay it
  const p = priceCut({ prompt: 1e6 }, { tokens: 10, recache: 1e6 }, { calls: 1, model: 'claude-opus-5-5' });
  assert.equal(p.pays, false, 'ten tokens never repay a million-token rewrite');
  const rec = freshCut('s');
  const held = decideCut(rec, { trigger: 1, clearAtLeast: 1 }, { prompt: 1e6, turn: 1 },
    { cand: { ids: ['x'], tokens: 10, recache: 1e6, firstChanged: 0 }, model: 'claude-opus-5-5' });
  assert.equal(held.clear, false); assert.deepEqual(held.cut, []);
  assert.ok(held.held, 'the refusal is recorded with its arithmetic');
  // the placeholder is a function of the original length alone, so re-applying gives the same bytes
  const a = applyCut(ms, ['u0.0']), b = applyCut(ms, ['u0.0']);
  assert.deepEqual(JSON.parse(JSON.stringify(a.messages)), JSON.parse(JSON.stringify(b.messages)));
  assert.equal(applyCut(a.messages, ['u0.0']).cut, 0, 'an already-cut result is never cut twice');
});

test('the three operations are the desktop mod\'s three, and each is switchable', () => {
  // register.tsx:clearOld does the same three outside the newest turn: the result becomes a placeholder,
  // the call text is emptied, the row's thinking goes. Checked live 2026-11-04 that the API takes a
  // tool_result-only edit (6 and 8 placeholders beside 3 untouched thinking blocks, every call 200).
  const ms = session(4);
  const ids = ms.filter(m => m.content?.[0]?.type === 'tool_result').map(m => m.content[0].tool_use_id);
  const think = m => (m.content || []).filter(b => b.type === 'thinking');
  const uses = m => (m.content || []).filter(b => b.type === 'tool_use');

  // with both off, only the results move: the narrowest edit, the one proven live
  const narrow = applyCut(ms, ids, { clearInputs: false, clearThinking: false }).messages;
  for (let i = 0; i < ms.length; i++) {
    assert.deepEqual(think(narrow[i]), think(ms[i]), 'thinking untouched when clearThinking is off');
    assert.deepEqual(uses(narrow[i]), uses(ms[i]), 'call text untouched when clearInputs is off');
  }
  assert.ok(narrow.flatMap(m => (m.content || []).filter(b => b.type === 'tool_result'))
    .some(b => b.content.startsWith('[tool result cleared by thinker')), 'results did change');

  // with both on, as they ship: the newest turn keeps everything, the turns before it lose both
  const full = applyCut(ms, ids, { clearInputs: true, clearThinking: true });
  const live = full.messages.length - 1;       // the turn in progress: nothing of it is ever touched
  assert.deepEqual(think(full.messages[live]), think(ms[live]), 'the newest turn keeps its thinking');
  assert.ok(full.thinking > 0, 'earlier thinking was dropped');
  assert.ok(full.inputChars > 0, 'earlier call text was emptied');
  const earlier = full.messages.slice(0, live).filter(m => m.role === 'assistant');
  assert.equal(earlier.flatMap(think).length, 0, 'no thinking survives before the newest turn');
  assert.ok(earlier.flatMap(uses).every(u => Object.keys(u.input || {}).length === 0), 'and no call text');
});

test('stopping is free: applying the set and cutting nothing more leaves the prefix alone', () => {
  // The server-side exit cost 351,929 tokens of write -- 74% of the damage the gauge stopped over --
  // because dropping the edit un-cleared the conversation. Here "stop" is a decision not to add ids.
  const ms = session(4);
  const rec = { ...freshCut('s'), cut: ['u0.0', 'u0.1'], turn: 5 };
  const a = transformRequest('POST', '/v1/messages', headers, body(ms), { ...cfg(), cutRecord: rec });
  // same turn, no new decision, and a boundary that declines to add anything
  const b = transformRequest('POST', '/v1/messages', headers, body(ms), { ...cfg({ clearAtLeast: 1e9 }), cutRecord: { ...rec, turn: 6 } });
  assert.deepEqual(JSON.parse(a.body).messages, JSON.parse(b.body).messages,
    'declining to cut more sends exactly what the previous call sent');
});
