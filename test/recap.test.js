// Claude Code's recap is not a turn (cutting.js:isRecap, the `recap` branch of `decide`; 2026-11-22).
//
// Three minutes after a turn ends with the person idle, Claude Code sends the conversation again with one
// message of its own on the end. It counts as a prompt, so it read as a boundary and a cut was decided or
// made on it with nobody there. What these hold: that the request is recognised by its last message and by
// nothing else; that it cuts nothing, moves no turn and spends no seed; that what it sends is what a call
// inside the turn before it sent; and that the prompt the person comes back with is then the boundary,
// which is where the cut belongs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { transformRequest, proxyConfig, turnId, PROXY_DEFAULTS } from '../src/proxy.js';
import { decideCut, cutResponse, freshCut, isRecap, RECAP_OPENS, policyId } from '../src/cutting.js';

// the message as Claude Code 2.1.330 sends it
const RECAP = 'The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.';
const recap = { role: 'user', content: [{ type: 'text', text: RECAP }] };
const answer = { role: 'assistant', content: [{ type: 'text', text: 'done' }] };
const prompt = text => ({ role: 'user', content: [{ type: 'text', text }] });

const BIG = 'X'.repeat(40000);
// n finished turns of `calls` tool uses each, the last one answered: a session the person has just left
const finished = (turns, calls = 4) => {
  const ms = [];
  for (let t = 0; t < turns; t++) {
    ms.push(prompt(`turn ${t}`));
    for (let c = 0; c < calls; c++) {
      ms.push({ role: 'assistant', content: [{ type: 'tool_use', id: `u${t}.${c}`, name: 'Read', input: { file_path: `/f${t}.${c}` } }] });
      ms.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `u${t}.${c}`, content: BIG }] });
    }
  }
  ms.push(answer);
  return ms;
};
const cfg = extra => ({ ...proxyConfig({}, {}), cut: true, clientCut: true, cutBreakpoint: false, trigger: 1, clearAtLeast: 1, ...extra });
// one request through the door, with the record kept the way the proxy keeps it (proxy.js: the reservation
// before forwarding, `cutResponse` after the answer)
function send(rec, messages, c, now = 1e12, extra = {}) {
  const j = { model: 'claude-opus-5-5', ...extra, messages };
  const t = transformRequest('POST', '/v1/messages', {}, Buffer.from(JSON.stringify(j)), { ...c, cutRecord: rec, now });
  if (Array.isArray(t.cut) && t.turn != null) { rec.cut = t.cut; rec.turn = t.turn; if ('seed' in t) rec.seed = t.seed || null; }
  cutResponse(rec, c, t, { read: 1 }, { now });
  return { t, sent: JSON.parse(t.body) };
}
const replaced = sent => sent.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_result' && b.content !== BIG && !/^x+$/.test(String(b.content))).length;

test('a recap is told by its last message: Claude Code\'s own words at the start of it', () => {
  const ms = finished(2);
  assert.equal(isRecap([...ms, recap]), true, 'as a text block');
  assert.equal(isRecap([...ms, { role: 'user', content: RECAP }]), true, 'as a bare string');
  assert.equal(isRecap([...ms, { role: 'user', content: [{ type: 'text', text: '<system-reminder>the date changed</system-reminder>' }, { type: 'text', text: `\n${RECAP}`, cache_control: { type: 'ephemeral' } }] }]), true, 'beside a reminder, behind a newline, under a breakpoint');
  assert.equal(isRecap([...ms, prompt(`${RECAP_OPENS} Recap in under 20 words.`)]), true, 'whatever a later release asks for after the opening');
  assert.equal(isRecap([...ms, prompt(`why does Claude Code send "${RECAP}"?`)]), false, 'a prompt that quotes it is a prompt');
  assert.equal(isRecap([...ms, recap, answer, prompt('carry on')]), false, 'and one further up the conversation is history');
  assert.equal(isRecap(ms), false, 'a conversation that ends on the answer');
  assert.equal(isRecap([...ms, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1.3', content: RECAP }] }]), false, 'a tool result that holds the words');
  for (const none of [null, undefined, [], [null], 'x']) assert.equal(isRecap(none), false);
});

test('the decision: a recap is no boundary, and it leaves the turn and the set where they were', () => {
  const now = { ...PROXY_DEFAULTS, cut: true, trigger: 1000, clearAtLeast: 1000 };
  const cand = { ids: ['a', 'b'], tokens: 200000, recache: 1000 };
  const rec = { ...freshCut('s'), turn: 4, cut: ['z'], at: 1000 };
  const back = decideCut(rec, now, { prompt: 300000, turn: 5 }, { cand, now: 2000, model: 'claude-opus-5-5' });
  assert.equal(back.clear, true, 'the same request as a person\'s prompt is cut');
  const d = decideCut(rec, now, { prompt: 300000, turn: 5 }, { cand, now: 2000, model: 'claude-opus-5-5', recap: true });
  assert.equal(d.reason, 'recap');
  assert.equal(d.clear, false);
  assert.deepEqual(d.cut, ['z'], 'the set as it stood');
  assert.equal('turn' in d, false, 'no turn to move the record to');
  assert.equal(d.candidate, 200000, 'what the recap would have given up, for the log');
  assert.equal(d.policy, policyId(now), 'under the policy in force');
  // a seed is neither taken nor dropped
  const seeded = { ...rec, seed: { last: 'b', at: 1500, ready: 1600 } };
  const s = decideCut(seeded, now, { prompt: 300000, turn: 5 }, { cand: { ...cand, steps: [{ ids: ['a', 'b'], tokens: 200000, recache: 1000 }] }, now: 2000, mark: true, recap: true });
  assert.equal(s.reason, 'recap');
  assert.equal('seed' in s, false, 'the seed is not the recap\'s to end');
  // off is still the first thing asked
  assert.equal(decideCut(rec, { ...now, cut: false }, { prompt: 300000, turn: 5 }, { cand, recap: true }).reason, 'off');
});

test('through the door: the recap goes as it came, and the prompt after it is the boundary', () => {
  const ms = finished(4), c = cfg();
  // the turn the person left was decided at its own start, when there was nothing worth taking
  const rec = { ...freshCut('s'), turn: 4, cut: [] };
  assert.equal(turnId([...ms, recap]), 5, 'by the count of prompts the recap is turn 5');
  const r = send(rec, [...ms, recap], c);
  assert.equal(r.t.reason, 'recap');
  assert.equal(r.t.injected, undefined);
  assert.deepEqual(r.sent.messages, [...ms, recap], 'the request is Claude Code\'s own');
  assert.equal(r.t.turn, undefined, 'the row names no turn');
  assert.ok(r.t.candidate > 0, 'and says what it left in');
  assert.equal(rec.turn, 4, 'the record is still on the person\'s last prompt');
  assert.deepEqual(rec.cut, []);
  // the person is back. The recap is not in the conversation Claude Code keeps, so this prompt is turn 5 too:
  // had the recap taken the turn, this would have read as the middle of it
  const next = [...ms, prompt('and now the tests')];
  assert.equal(turnId(next), 5);
  const p = send(rec, next, c, 1e12 + 60000);
  assert.equal(p.t.injected, true, 'the cut is decided on the person\'s own prompt');
  assert.equal(p.t.changed, true);
  assert.ok(p.t.cut.length > 0);
  assert.equal(rec.turn, 5);
});

test('a session already cut: the recap carries the set a call inside the turn carried, byte for byte', () => {
  const ms = finished(4), c = cfg();
  const rec = { ...freshCut('s'), turn: 4, cut: ['u0.0', 'u0.1', 'u0.2'] };
  const inside = send({ ...rec }, ms.slice(0, -1), c).sent.messages;   // the turn's last call, before its answer
  const r = send(rec, [...ms, recap], c);
  assert.equal(r.t.injected, true, 'the earlier cut is still applied');
  assert.equal(r.t.changed, false, 'and nothing is added to it');
  assert.equal(r.t.recap, true, 'the row says what the request was');
  assert.equal(r.t.clear, undefined);
  assert.deepEqual(r.t.cut, ['u0.0', 'u0.1', 'u0.2']);
  assert.deepEqual(r.sent.messages.slice(0, inside.length), inside, 'the prefix the cache holds is untouched');
  assert.equal(r.t.turn, undefined);
  assert.equal(rec.turn, 4);
  assert.deepEqual(rec.cut, ['u0.0', 'u0.1', 'u0.2']);
});

test('a seeded cut is not made on the recap: it waits for the person\'s prompt', () => {
  // the shape of cut-breakpoint.test.js: the bulk above the cut, two big results, room for a breakpoint
  const HOUR = { type: 'ephemeral', ttl: '1h' };
  const tu = id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/p/${id}` } });
  const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
  const ms = [{ role: 'user', content: 'begin' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'T'.repeat(2000000), signature: 'sig' }, { type: 'text', text: 'ok' }] }];
  for (let k = 0; k < 5; k++) ms.push({ role: 'user', content: `prompt ${k}` }, { role: 'assistant', content: [tu(`r${k}`)] }, { role: 'user', content: [tr(`r${k}`, k < 2 ? 300000 : 5000)] });
  const live = { role: 'user', content: [{ type: 'text', text: 'the live turn', cache_control: HOUR }] };
  const system = { system: [{ type: 'text', text: 'sys', cache_control: HOUR }] };
  const c = { ...PROXY_DEFAULTS, cut: true, trigger: 1000, clearAtLeast: 1000, cutBreakpoint: true };
  const marks = sent => sent.messages.flatMap(m => (Array.isArray(m.content) ? m.content : []).filter(b => b.cache_control)).length;
  const rec = freshCut('s');
  // the turn's one call seeds the cut and is answered: the turn is over and the seed is ready
  const seedReq = send(rec, [...ms, live], c, 1e12, system);
  assert.equal(seedReq.t.reason, 'seed');
  assert.ok(rec.seed.ready);
  const turn = rec.turn;
  // three minutes on, the recap
  const tail = { role: 'user', content: [{ type: 'text', text: 'the live turn' }] };
  const done = { role: 'assistant', content: [{ type: 'text', text: 'done', cache_control: HOUR }] };
  const r = send(rec, [...ms, tail, done, recap], c, 1e12 + 186000, system);
  assert.equal(r.t.reason, 'recap');
  assert.equal(replaced(r.sent), 0, 'nothing is replaced on it');
  assert.equal(marks(r.sent), 1, 'and it carries Claude Code\'s breakpoints alone');
  assert.equal('seed' in r.t, false);
  assert.ok(rec.seed?.ready, 'the seed is still there');
  assert.equal(rec.turn, turn);
  assert.deepEqual(rec.cut, []);
  // the person comes back inside the seed's life: the cut is made on their prompt
  const p = send(rec, [...ms, tail, done, { role: 'user', content: [{ type: 'text', text: 'next', cache_control: HOUR }] }], c, 1e12 + 600000, system);
  assert.equal(p.t.injected, true);
  assert.equal(p.t.clear.seeded, true);
  assert.ok(replaced(p.sent) >= 2, 'the two big results are placeholders now');
  assert.equal(rec.seed, null, 'and the seed is spent');
  assert.equal(rec.turn, turn + 1);
});
