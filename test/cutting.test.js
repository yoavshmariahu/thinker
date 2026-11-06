// The three properties the client-side cut exists to provide. Each was impossible with the
// server-side edit, and each failure below is one this session measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cutCandidates, applyCut, transformRequest, proxyConfig, cutPlaceholder, proxyReport, TOKENS_PER_CHAR } from '../src/proxy.js';
import { decideCut, freshCut, priceCut, placeholder, mergeCut, cutStore, cutResponse, clearedOf, clearedUsesOf, clearedEstimated } from '../src/cutting.js';

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

test('the floor is 25 because 20 cut nothing, and 25 still refuses the cuts that lost', () => {
  // the real boundaries, from this machine's proxy log. The first is the cheapest the Claude path reached in
  // the two days after the cut landed: refused at 20, made at 25, in a session that then ran 283 more calls.
  const opus = { model: 'claude-opus-5' };
  const cheapest = priceCut({ prompt: 337692 }, { tokens: 105472, recache: 127570 }, opus);
  assert.equal(cheapest.payback, 25, 'the cheapest real boundary of 2026-11-05 repays in 25 calls');
  assert.equal(cheapest.pays, true, 'and 25 is inside the floor');
  assert.ok(cheapest.payback > 20, 'where 20 refused it, which is why no cut was made that day');

  // the four cuts of the +38% session that set the floor needed 14, 32, 66 and 82 calls. 25 admits the first
  // and no other, so raising the floor re-admits none of the ones that lost.
  for (const [calls, want] of [[14, true], [32, false], [66, false], [82, false]]) {
    // a candidate whose arithmetic gives exactly that payback: cost = calls x tokens x readRate
    const tokens = 100000, recache = calls * tokens * 0.1 / 2;
    const p = priceCut({ prompt: 400000 }, { tokens, recache }, opus);
    assert.equal(p.payback, calls, `the ${calls}-call cut prices at ${calls}`);
    assert.equal(p.pays, want, `a cut repaying in ${calls} is ${want ? 'made' : 'refused'}`);
  }
});

test('the cut replaces results and touches nothing else: one operation, not three', () => {
  const think = { type: 'thinking', thinking: 'T', signature: 'sig' };
  const tu = id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/p/' + id } });
  const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
  const ms = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [think, tu('a')] }, { role: 'user', content: [tr('a', 9000)] },
    { role: 'assistant', content: [think, tu('b')] }, { role: 'user', content: [tr('b', 9000)] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
    { role: 'assistant', content: [think, tu('c')] }, { role: 'user', content: [tr('c', 9000)] },
  ];
  const out = applyCut(ms, new Set(['a', 'b'])).messages;
  const blocks = out.flatMap(m => Array.isArray(m.content) ? m.content : []);
  // keyed on the function, not its words, so rewording the placeholder cannot break this
  const cleared = blocks.filter(b => b.type === 'tool_result' && String(b.content?.[0]?.text || '') === placeholder(9000));
  assert.equal(cleared.length, 2, 'the two older results are replaced');
  // Why this holds the piggybacks out. The call text is a file path, 86 chars against a 25k result; in a
  // 28-turn run the model read its own blanked calls, reported it had been making them without file paths,
  // and then did so. Thinking carries no text at all from Claude Code (display: omitted), and dropping it
  // is the edit that broke the API in October. Measured: 487,332 chars of results, 2,800 of inputs, 0 of
  // thinking. The results are the feature.
  assert.equal(blocks.filter(b => b.type === 'thinking').length, 3, 'every thinking block is left alone');
  assert.equal(blocks.filter(b => b.type === 'tool_use' && Object.keys(b.input || {}).length).length, 3,
    'every tool call keeps its arguments');
  assert.equal(out[7].content[0].content, 'x'.repeat(9000), 'the newest turn keeps its own result');
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

test('a turn boundary re-edits nothing older: the write leak that cost ~50k a turn', () => {
  // The bug this guards, found 2026-11-04 by diffing the requests of a real session. `clearInputs` and
  // `clearThinking` applied to the assistant rows BEFORE the newest turn. So when a turn ended, the rows
  // of the turn just finished crossed from protected to older and were re-edited -- thinking stripped,
  // call text blanked -- 38%, 59% and 70% of the way up the conversation on three consecutive boundaries
  // of one session. Everything below that point lost its place in the cache and was written again: ~50k
  // per boundary, 26 boundaries, ~1.3M tokens, which was the bulk of a +38% loss against a control.
  //
  // What makes it safe now is that the cut touches tool results and nothing else, and the set only grows
  // at a boundary. So this asserts the property rather than the absence of those two flags: every message
  // older than the newest turn is byte-identical from one request of a session to the next.
  const think = { type: 'thinking', thinking: '', signature: 'sig'.repeat(300) };
  const tu = id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/p/' + id } });
  const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
  const turn = i => [
    { role: 'user', content: 'prompt ' + i },
    { role: 'assistant', content: [think, tu('a' + i), tu('b' + i)] },
    { role: 'user', content: [tr('a' + i, 30000), tr('b' + i, 30000)] },
    { role: 'assistant', content: [{ type: 'text', text: 'done ' + i }] },
  ];
  const base = [...turn(1), ...turn(2), ...turn(3)];
  const frozen = new Set(['a1', 'b1', 'a2', 'b2']);   // the set a previous boundary settled on
  const before = applyCut(base, frozen).messages;
  const later = [
    ['the next prompt arrives', [...base, { role: 'user', content: 'prompt 4' }]],
    ['its first results arrive', [...base, { role: 'user', content: 'prompt 4' },
      { role: 'assistant', content: [think, tu('a4')] }, { role: 'user', content: [tr('a4', 30000)] }]],
  ];
  for (const [what, messages] of later) {
    const after = applyCut(messages, frozen).messages;
    before.forEach((m, i) => assert.equal(JSON.stringify(after[i]), JSON.stringify(m),
      `${what}: message ${i} must be byte-identical, or everything below it is written again`));
  }
});

// What the cut took out has to reach the five readers that report it. Until 0.2.23 it reached none:
// `applyCut` never returned the `tokens` its caller put on the row, and every reader asked
// `row.cleared > 0`, which the API sets and the cut does not. Measured on production telemetry
// 2026-11-05: an install on 0.2.22 whose clearing-side requests moved over 85 hourly reports while
// its `requestsCleared` stayed at exactly 3,414 and its `cleared` at 1,196,669,313 -- the frozen
// residue of the API-side era, with not one cut counted since.
test('a cut says what it took out, and every reader of the saving agrees on the figure', () => {
  const ms = session(6);
  const cand = cutCandidates(ms, { keepMin: 3 });
  const applied = applyCut(ms, cand.ids);
  assert.ok(applied.cut > 0);
  assert.equal(applied.tokens, Math.round(applied.chars * TOKENS_PER_CHAR), 'the row carries tokens, not undefined');

  const t = transformRequest('POST', '/v1/messages', headers,
    Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: ms })),
    { ...proxyConfig(), cutRecord: freshCut('s'), trigger: 1000, clearAtLeast: 1000 });
  assert.ok(t.injected && t.clientCut.tokens > 0, 'the request logs its own count');

  // A row as the proxy wrote it between 2026-11-04 and the fix in `clearedBy`: `clientCut` alone, no
  // `cleared`, because nothing was asked of the API. Those rows are still inside the 30-day window.
  const row = { op: 'proxy', at: '2026-11-05T10:00:00Z', session: 's', model: 'claude-opus-5-5', status: 200,
    clientCut: t.clientCut, injected: true, input: 10, read: 200000, write: 0, out: 5 };
  assert.equal(clearedOf(row), t.clientCut.tokens);
  assert.equal(clearedUsesOf(row), t.clientCut.cut);
  assert.ok(clearedEstimated(row), 'thinker counted it, the API did not measure it');
  // and a row written since, which carries both: still the cut's own count, so still an estimate
  const now = { ...row, cleared: t.clientCut.tokens, clearedUses: t.clientCut.cut };
  assert.equal(clearedOf(now), t.clientCut.tokens);
  assert.ok(clearedEstimated(now), 'the field it arrives in does not make it a measurement');

  // the API-side era's rows keep their measured figure, and are not estimates
  const old = { op: 'proxy', at: '2026-11-01T10:00:00Z', session: 'old', cleared: 7000, clearedUses: 3 };
  assert.equal(clearedOf(old), 7000);
  assert.equal(clearedUsesOf(old), 3);
  assert.equal(clearedEstimated(old), false);

  // the log's two sides (proxy.js:proxyReport)
  const sides = proxyReport([row]);
  assert.equal(sides.clearing.cleared, t.clientCut.tokens);
  assert.equal(sides.clearing.requestsCleared, 1);
  // a long call after a clear is counted after it, which is what the rewrite warning reads
  assert.equal(sides.clearing.rewrites.after.calls, 1);
  assert.equal(sides.clearing.rewrites.before.calls, 0);
});

// Two requests of one conversation in the proxy at once. The record is the reservation that keeps the
// set from moving inside a turn, so a write may never undo one: the simulation of 2026-11-05 had an
// overlapping request's late answer put the set back to 0 ids mid-turn (`mergeCut`, `cutStore.update`).
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cut-'));

test('a record never goes backwards: the turn, the set, and every counter', () => {
  const at = Date.now();
  const reserved = { ...freshCut('c1'), turn: 7, cut: ['a', 'b'], calls: 9, clears: 2, saved: 500, chars: 40, at };
  const behind = { ...freshCut('c1'), turn: 6, cut: ['a'], calls: 4, clears: 1, saved: 10, chars: 10, at: at - 1000 };
  const m = mergeCut(reserved, behind);
  assert.equal(m.turn, 7, 'the boundary a later request reserved stands');
  assert.deepEqual(m.cut, ['a', 'b'], 'and so does the set it reserved');
  assert.deepEqual([m.calls, m.clears, m.saved, m.chars], [9, 2, 500, 40], 'no counter is rolled back');
  assert.equal(m.at, at);
  // at the same boundary both requests decided the same set; a union cannot shrink it either way
  assert.deepEqual(mergeCut({ ...reserved, turn: 7 }, { ...behind, turn: 7, cut: ['c'] }).cut, ['a', 'b', 'c']);
  // the turn moving on is the one case where the newer set replaces the older
  assert.deepEqual(mergeCut(reserved, { ...behind, turn: 8, cut: ['a', 'b', 'c'] }).cut, ['a', 'b', 'c']);
  assert.deepEqual(mergeCut(null, behind).cut, ['a'], 'a first write has nothing to merge with');
  assert.equal(mergeCut({ ...reserved, session: 'other' }, behind).turn, 6, 'another conversation is not merged in');
});

test('the store merges a stale writer and counts an increment on the freshest record', () => {
  const dir = tmp();
  const store = cutStore(dir);
  // request A reads, reserves the boundary, and its answer is still streaming
  const a = store.read('c1');
  a.turn = 5; a.cut = ['x'];
  store.write(a);
  // request B reads what A reserved, reserves the next boundary, and is answered first
  const b = store.read('c1');
  assert.deepEqual([b.turn, b.cut], [5, ['x']], 'B starts from the reservation, not from nothing');
  b.turn = 6; b.cut = ['x', 'y'];
  store.write(b);
  store.update('c1', rec => cutResponse(rec, {}, { turn: 6, cut: ['x', 'y'], model: 'claude-opus-5-5' }, { read: 1 }));
  // A's answer lands now, with the record A read minutes ago
  store.update('c1', rec => cutResponse(rec, {}, { turn: 5, cut: ['x'] }, { read: 1 }));
  const rec = store.read('c1');
  assert.equal(rec.turn, 6, 'the late answer did not put the turn back');
  assert.deepEqual(rec.cut, ['x', 'y'], 'nor the set, which is what keeps the cache within a turn');
  assert.equal(rec.calls, 2, 'and both calls were counted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'c1.json'), 'utf8')).turn, 6, 'the disk says the same');
});

test('a record is renamed into place, so a reader never sees half of one', () => {
  const dir = tmp();
  const store = cutStore(dir);
  store.write({ ...freshCut('c1'), turn: 2, cut: ['x'] });
  assert.deepEqual(fs.readdirSync(dir), ['c1.json'], 'nothing is left behind but the record itself');
  // the other proxy of a handover reads the file while this one writes it
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'c1.json'), 'utf8'));
  for (let i = 3; i < 60; i++) { store.write({ ...freshCut('c1'), turn: i, cut: ['x', `y${i}`] }); assert.ok(read().turn >= 2); }
  assert.equal(cutStore(dir).read('c1').turn, 59, 'and a fresh process reads the latest');
});
