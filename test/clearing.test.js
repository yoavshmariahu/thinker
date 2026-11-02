// The clearing policy (src/clearing.js): clear, freeze what was cleared, clear again when it pays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshRecord, decide, price, response, store, remainingCalls, isRewrite, DEEP_MARGIN, COLD_MS, WRITE_1H, WRITE_5M, READ } from '../src/clearing.js';
import { PROXY_DEFAULTS, measureClearing, turnId, transformRequest, proxyConfig, EDIT_TYPE } from '../src/proxy.js';

const cfg = { ...PROXY_DEFAULTS };
// a request measured before the turn: what sits before it, the prompt, and the cached prefix up to the first result
// a deeper ask would newly drop
const m = (before, { prompt = before + 50000, prefix = 10000, turn = 1 } = {}) => ({ before, prompt, prefix, turn });
const now = 1e12;

test('a clear is priced as the tail it writes against the reads it saves over the calls left', () => {
  const p = price(m(300000), 200000, { ttl: '1h', calls: 0 });
  assert.equal(p.recache, 350000 - 10000 - 200000, 'what is written: the prompt after the prefix, less what is dropped');
  assert.equal(p.cost, p.recache * WRITE_1H);
  assert.equal(p.saving, 200000 * READ * remainingCalls(0));
  assert.equal(p.pays, false, 'a 140k write is 80 reads of it: not repaid by 40 calls');
  assert.equal(price(m(300000), 200000, { ttl: '5m' }).cost, p.recache * WRITE_5M, 'the write rate follows the cache TTL');
  // the same clear with the cached prefix covering most of the prompt: a small tail, and it pays
  assert.equal(price(m(300000, { prefix: 330000 }), 200000, { ttl: '1h' }).pays, true);
  // after a pause past the cache's hour the request writes its context anyway: free
  const cold = price(m(300000), 200000, { ttl: '1h', cold: true });
  assert.equal(cold.cost, 0); assert.equal(cold.pays, true);
  assert.equal(price(m(300000), 0, {}).pays, false, 'nothing to drop, nothing to decide');
  assert.deepEqual([0, 10, 20, 40, 100, 500].map(remainingCalls), [40, 40, 40, 68, 90, 90]);
});

test('the decision: the same edit within a turn, a deeper ask at a boundary only when it pays, and the ask only grows', () => {
  const rec = freshRecord('s', cfg);
  assert.deepEqual(rec.edit, { keep: cfg.keepMin, ask: cfg.clearAtLeast }, 'the floor until a boundary says otherwise');
  // the first boundary, nothing cleared yet: the ask goes to the margin of what sits before the turn at no cost,
  // since nothing cleared is cached yet and the first clear, when the trigger fires, is cheaper the deeper it is
  let d = decide(rec, cfg, m(300000), { now, ttl: '1h' });
  assert.equal(d.clear, true); assert.equal(d.turn, 1); assert.equal(d.edit.ask, Math.floor(DEEP_MARGIN * 300000)); assert.equal(d.edit.keep, cfg.keepMin);
  response(rec, cfg, { turn: d.turn, changed: d.clear, keep: d.edit.keep, asked: d.edit.ask, clear: {} }, { cleared: 0, read: 100000, write: 2000, input: 2 }, { now });
  // within the turn: the same edit, and no boundary
  d = decide(rec, cfg, m(400000, { turn: 1 }), { now, ttl: '1h' });
  assert.equal(d.clear, false); assert.equal(d.turn, undefined); assert.deepEqual(d.edit, rec.edit);
  // the floor binds a small conversation
  const small = freshRecord('t', cfg);
  d = decide(small, cfg, m(100000), { now, ttl: '1h' });
  assert.equal(d.clear, false); assert.equal(d.turn, 1); assert.equal(d.edit.ask, cfg.clearAtLeast);
  // the server has cleared 210k at 100 uses; a later boundary with 190k more clearable: the write is most of
  // the prompt, so over the calls left it does not pay -- the same edit, frozen
  rec.cleared = 210000; rec.clearedUses = 100; rec.calls = 10;
  d = decide(rec, cfg, m(400000, { turn: 2, prompt: 450000, prefix: 10000 }), { now, ttl: '1h' });
  assert.equal(d.clear, false); assert.equal(d.turn, 2); assert.deepEqual(d.edit, rec.edit);
  assert.equal(d.clearable, 190000, 'clearable is what the server has not taken');
  assert.ok(d.held.cost > d.held.saving, 'the price it was held at is on the decision');
  // the same with the cached prefix running up to the drop point: a small tail, it pays, and the ask is what is
  // cleared plus the margin of what is clearable -- never less than before
  d = decide(rec, cfg, m(400000, { turn: 2, prompt: 450000, prefix: 300000 }), { now, ttl: '1h' });
  assert.equal(d.clear, true); assert.equal(d.edit.ask, 210000 + Math.floor(DEEP_MARGIN * 190000)); assert.ok(d.edit.ask > rec.edit.ask);
  assert.equal(d.dropped, Math.floor(DEEP_MARGIN * 190000));
  // cold: the write is free, so it clears whatever the tail
  d = decide({ ...rec, lastAt: now - COLD_MS - 1 }, cfg, m(400000, { turn: 2, prompt: 450000, prefix: 10000 }), { now, ttl: '1h' });
  assert.equal(d.clear, true); assert.equal(d.cold, true);
  // the server took more than the proxy counts (the estimate undershot): nothing is clearable, nothing is asked
  d = decide({ ...rec, cleared: 500000 }, cfg, m(400000, { turn: 2 }), { now, ttl: '1h' });
  assert.equal(d.clear, false); assert.equal(d.clearable, 0);
  // clearDeep off: every ask is the floor
  d = decide(freshRecord('u', cfg), { ...cfg, clearDeep: false }, m(300000), { now, ttl: '1h' });
  assert.equal(d.clear, false); assert.equal(d.edit.ask, cfg.clearAtLeast);
  // an ask the server would not meet: back to the floor for good
  d = decide({ ...freshRecord('v', cfg), unmet: true }, cfg, m(300000), { now, ttl: '1h' });
  assert.equal(d.clear, false); assert.equal(d.edit.ask, cfg.clearAtLeast);
  // a stopped session is not decided for
  d = decide({ ...rec, stopped: 'uneconomic' }, cfg, m(400000, { turn: 3 }), { now, ttl: '1h' });
  assert.equal(d.clear, false); assert.equal(d.turn, undefined);
});

test('the record after an answer: the clear\'s own write is planned, a move is logged, the gauge stops the session, and a restart reads it back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-clearing-'));
  try {
    const s = store(dir, cfg);
    const rec = s.read('x');
    assert.equal(rec.calls, 0);
    const t = (turn, changed, asked) => ({ turn, changed, keep: cfg.keepMin, asked, clear: changed ? { cost: 1, saving: 2 } : undefined });
    // a deeper ask decided at the boundary and applied by the server: the clear's own write, planned, not counted
    let ev = response(rec, cfg, t(1, true, 210000), { cleared: 210000, clearedUses: 100, read: 20000, write: 150000, input: 2 }, { now: now });
    assert.deepEqual(ev.map(e => Object.keys(e)[0]), ['clear']);
    assert.equal(rec.clears, 1); assert.equal(rec.cleared, 210000); assert.equal(rec.clearedUses, 100); assert.equal(rec.written, 0); assert.deepEqual(rec.edit, { keep: cfg.keepMin, ask: 210000 });
    // a hit: the saving counts
    ev = response(rec, cfg, t(undefined, false, 210000), { cleared: 210000, clearedUses: 100, read: 300000, write: 2000, input: 2 }, { now: now + 1000 });
    assert.deepEqual(ev, []); assert.equal(rec.saved, 2 * 210000 * READ); assert.equal(rec.calls, 2);
    // the server moved the block by one under the same edit, without a rewrite: logged, nothing else
    ev = response(rec, cfg, t(undefined, false, 210000), { cleared: 212000, clearedUses: 101, read: 300000, write: 2000, input: 2 }, { now: now + 2000 });
    assert.deepEqual(ev, [{ moved: true, from: 100, to: 101 }]); assert.equal(rec.written, 0); assert.equal(rec.moves, 1);
    // the same, and this time the prefix was written over: the cost the clearing caused, and it outweighs what
    // the clear saved and can still save over the calls left, so the session is stopped
    ev = response(rec, cfg, t(undefined, false, 210000), { cleared: 212000, clearedUses: 101, read: 20000, write: 250000, input: 2 }, { now: now + 3000 });
    assert.equal(ev.length, 1); assert.equal(ev[0].stopped, 'uneconomic');
    assert.equal(ev[0].written, 250000 * WRITE_1H); assert.ok(ev[0].written > ev[0].saved + ev[0].ahead);
    assert.equal(rec.stopped, 'uneconomic');
    assert.deepEqual(response(rec, cfg, t(undefined, false, 210000), { cleared: 0, read: 1, write: 1 }, now + 4000), [], 'said once');
    // on disk, and a new store (a restarted proxy) reads the same
    s.write(rec);
    assert.equal(store(dir, cfg).read('x').stopped, 'uneconomic');
    assert.equal(store(dir, cfg).read('x').cleared, 212000);
    assert.equal(store(dir, cfg).read('y').calls, 0, 'another session starts fresh');
    // a rewrite after a pause past the cache's hour is the pause's, not the clearing's
    const w = s.read('w'); response(w, cfg, t(1, true, 200000), { cleared: 200000, clearedUses: 90, read: 1000, write: 100000 }, { now: now });
    response(w, cfg, t(undefined, false, 200000), { cleared: 200000, clearedUses: 90, read: 1000, write: 300000 }, { now: now + COLD_MS + 1 });
    assert.equal(w.written, 0); assert.equal(w.stopped, null);
    // the first application of an ask raised ahead of the trigger is the clear's own write too
    const f = s.read('f'); f.edit = { keep: 3, ask: 180000 };
    response(f, cfg, t(2, false, 180000), { cleared: 181000, clearedUses: 80, read: 1000, write: 300000 }, { now: now });
    assert.equal(f.written, 0); assert.equal(f.clears, 1);
    // an ask the server did not meet past the trigger: back to the floor, said once
    const u = s.read('u'); u.edit = { keep: 3, ask: 250000 };
    ev = response(u, cfg, t(2, false, 250000), { cleared: 0, editAcknowledged: true, read: 200000, write: 1000, input: 2 }, { now: now });
    assert.deepEqual(ev, [{ unmet: true, asked: 250000 }]); assert.equal(u.unmet, true);
    assert.equal(decide(u, cfg, m(300000, { turn: 3 }), { now }).edit.ask, cfg.clearAtLeast);
    assert.deepEqual(response(u, cfg, t(undefined, false, 100000), { cleared: 0, editAcknowledged: true, read: 200000, input: 2 }, now), [], 'said once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isRewrite: a call that wrote most of its context rather than reading it', () => {
  assert.equal(isRewrite({ read: 31520, write: 150000, input: 2, cleared: 140000 }), true);
  assert.equal(isRewrite({ read: 200000, write: 3000, input: 2 }), false, 'a hit');
  assert.equal(isRewrite({ read: 0, write: 9000 }), false, 'a fresh subagent\'s small first call is not a rewrite worth counting');
});

test('the request is measured before the turn: the prefix runs to the first result a deeper ask would newly drop', () => {
  const tu = id => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
  const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
  const messages = [{ role: 'user', content: 'first' }];
  for (let i = 0; i < 6; i++) messages.push({ role: 'assistant', content: [tu(`a${i}`)] }, { role: 'user', content: [tr(`a${i}`, 10000)] });
  messages.push({ role: 'user', content: [{ type: 'text', text: 'second' }] });
  for (let i = 0; i < 3; i++) messages.push({ role: 'assistant', content: [tu(`b${i}`)] }, { role: 'user', content: [tr(`b${i}`, 10000)] });
  const j = { model: 'm', messages };
  assert.equal(turnId(messages), 2);
  const none = measureClearing(cfg, j, 0), two = measureClearing(cfg, j, 2);
  assert.equal(none.turn, 2);
  assert.ok(none.prefix < two.prefix && two.prefix < two.prompt, 'the cached prefix grows with what the server already holds');
  assert.equal(none.before, two.before, 'what sits before the turn is the same count either way');
  assert.ok(none.before > 0 && none.before < none.prompt);
  // the current turn's results are not counted, so the measure does not move while the turn runs
  const longer = { model: 'm', messages: [...messages, { role: 'assistant', content: [tu('c')] }, { role: 'user', content: [tr('c', 50000)] }] };
  assert.deepEqual(measureClearing(cfg, longer, 2), two);
  // what transformRequest sends with a record is the record's edit, and the row says what it decided
  const rec = freshRecord('s', cfg);
  const t = transformRequest('POST', '/v1/messages', { 'anthropic-beta': 'context-management-2025-06-27' }, Buffer.from(JSON.stringify(j)), { ...proxyConfig({}, {}), record: rec, now });
  assert.equal(t.injected, true); assert.equal(t.turn, 2); assert.equal(t.keep, cfg.keepMin);
  const edit = JSON.parse(t.body).context_management.edits.find(e => e.type === EDIT_TYPE);
  assert.equal(edit.clear_at_least.value, t.asked);
});
