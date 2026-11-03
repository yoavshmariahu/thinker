// The clearing policy (src/clearing.js): clear, freeze what was cleared, clear again when it pays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshRecord, decide, price, response, store, remainingCalls, isRewrite, readRate, DEEP_MARGIN, COLD_MS, WRITE_1H, WRITE_5M, READ } from '../src/clearing.js';
import { PROXY_DEFAULTS, TOKENS_PER_CHAR, measureClearing, turnId, transformRequest, proxyConfig, EDIT_TYPE } from '../src/proxy.js';

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
  assert.equal(p.pays, true, 'a 140k write is 20 reads of it, 2.8M; 200k read back over 40 calls is 8M');
  assert.equal(price(m(300000), 20000, { ttl: '1h', calls: 0 }).pays, false, 'a 320k write for 20k dropped: 6.4M against 800k');
  // the read is the model's: a twentieth of an input token on Opus 5.5, a fortieth on Fable, a tenth elsewhere
  assert.deepEqual(['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'gpt-6-astra', null].map(readRate), [0.05, 0.025, 0.1, READ, READ]);
  assert.equal(price(m(300000), 200000, { ttl: '1h', calls: 0, model: 'claude-opus-5-5' }).saving, 200000 * 0.05 * remainingCalls(0));
  assert.equal(price(m(300000), 150000, { ttl: '1h', calls: 0 }).pays, true, 'a 190k write for 150k dropped pays at a tenth (600k against 380k)');
  assert.equal(price(m(300000), 150000, { ttl: '1h', calls: 0, model: 'claude-opus-5-5' }).pays, false, 'and not on Opus 5.5 (300k against 380k)');
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

test('the gauge counts material that came back: a clear the model undoes by reading again stops the session', () => {
  // B4 (2026-11-03, research/clearing-bench): the clearing arm cost +81.4% against its control at the same
  // cost per call -- the whole loss was 75% more model calls, the model re-reading files whose results had
  // been cleared mid-turn. Nothing reached the cost side of this gauge, because it counted cache rewrites
  // alone and there was no rewrite: both sessions ran to the end at a loss. A returned token is fresh input.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-clearing-reread-'));
  try {
    const rec = store(dir, cfg).read('b4');
    const t = (turn, changed, asked, reread) => ({ turn, changed, keep: cfg.keepMin, asked, clear: changed ? { cost: 1, saving: 2 } : undefined, ...(reread ? { reread } : {}) });
    // the first clear, planned: 100k out, no cost
    response(rec, cfg, t(1, true, 100000), { cleared: 100000, clearedUses: 10, read: 20000, write: 90000, input: 2 }, { now });
    assert.equal(rec.written, 0); assert.equal(rec.returned, 0); assert.equal(rec.stopped, null);
    // the model reads one of the cleared files again: 25k of fresh input the clear was supposed to have removed
    let ev = response(rec, cfg, t(undefined, false, 100000, { calls: 1, tokens: 25000, tools: [{ name: 'Read' }] }), { cleared: 100000, clearedUses: 10, read: 120000, write: 2000, input: 25000 }, { now: now + 1000 });
    assert.deepEqual(ev.map(e => Object.keys(e)[0]), ['reread'], 'the return is logged');
    assert.equal(ev[0].tokens, 25000); assert.equal(rec.returned, 25000);
    assert.equal(rec.stopped, null, 'one re-read is not yet a loss: the clear still saves on the calls left');
    // it keeps happening, turn after turn, as it did in B4
    let at = 0;
    for (let i = 2; i <= 200; i++) {
      ev = response(rec, cfg, t(undefined, false, 100000, { calls: 1, tokens: 25000, tools: [{ name: 'Read' }] }), { cleared: 100000, clearedUses: 10, read: 120000 + 25000 * i, write: 2000, input: 25000 }, { now: now + 1000 * i });
      if (rec.stopped) { at = i; break; }
    }
    assert.equal(rec.stopped, 'uneconomic', 'the session stops once what came back outweighs what stayed out');
    // the gauge is patient by design: `ahead` credits the cleared set over the 90 calls a long session is
    // assumed to have left, so a steady 25k return against a 100k clear takes this many calls to outweigh it
    assert.ok(at > 50 && at < 90, `stopped at call ${at}`);
    const stop = ev.find(e => e.stopped);
    assert.ok(stop, 'the stop is logged'); assert.ok(stop.returned > 0, 'and names what came back');
    assert.equal(stop.written, 0, 'no rewrite anywhere: this cost is invisible to the old gauge');
    assert.ok(stop.returned > stop.saved + stop.ahead);
    // a session whose clears stay cleared is untouched by the new term
    const keeper = store(dir, cfg).read('good');
    response(keeper, cfg, t(1, true, 100000), { cleared: 100000, clearedUses: 10, read: 20000, write: 90000, input: 2 }, { now });
    for (let i = 2; i <= 200; i++) response(keeper, cfg, t(undefined, false, 100000), { cleared: 100000, clearedUses: 10, read: 120000 + 25000 * i, write: 2000, input: 2 }, { now: now + 1000 * i });
    assert.equal(keeper.returned, 0); assert.equal(keeper.stopped, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
    // the same, and this time the prefix was written over: the cost the clearing caused. The prompt did not grow
    // between the two answers (raw 514002 -> 482002), so all 250000 written is the prefix written again; one such
    // rewrite (500k at the write rate) is still under what the clear saved and can save over the 40 calls left
    ev = response(rec, cfg, t(undefined, false, 210000), { cleared: 212000, clearedUses: 101, read: 20000, write: 250000, input: 2 }, { now: now + 3000 });
    assert.deepEqual(ev, []); assert.equal(rec.written, 250000 * WRITE_1H); assert.equal(rec.stopped, null);
    // a second rewrite of the same size outweighs it, so the session is stopped
    ev = response(rec, cfg, t(undefined, false, 210000), { cleared: 212000, clearedUses: 101, read: 20000, write: 250000, input: 2 }, { now: now + 4000 });
    assert.equal(ev.length, 1); assert.equal(ev[0].stopped, 'uneconomic');
    assert.equal(ev[0].again, 250000, 'what was written beyond the prompt\'s own growth');
    assert.equal(ev[0].written, 2 * 250000 * WRITE_1H); assert.ok(ev[0].written > ev[0].saved + ev[0].ahead);
    assert.equal(rec.stopped, 'uneconomic');
    assert.deepEqual(response(rec, cfg, t(undefined, false, 210000), { cleared: 0, read: 1, write: 1 }, now + 5000), [], 'said once');
    // on disk, and a new store (a restarted proxy) reads the same
    s.write(rec);
    assert.equal(store(dir, cfg).read('x').stopped, 'uneconomic');
    assert.equal(store(dir, cfg).read('x').cleared, 212000);
    assert.equal(store(dir, cfg).read('y').calls, 0, 'another session starts fresh');
    // a rewrite after a pause past the cache's hour is the pause's, not the clearing's
    const w = s.read('w'); response(w, cfg, t(1, true, 200000), { cleared: 200000, clearedUses: 90, read: 1000, write: 100000 }, { now: now });
    response(w, cfg, t(undefined, false, 200000), { cleared: 200000, clearedUses: 90, read: 1000, write: 300000 }, { now: now + COLD_MS + 1 });
    assert.equal(w.written, 0); assert.equal(w.stopped, null);
    // a 21k file read into a 40k conversation is new content, not a rewrite: the request grew by it (the multi-turn
    // paired run of 2026-11-02 stopped both sessions on exactly this call under a ratio heuristic)
    const g = s.read('g'); response(g, cfg, t(1, true, 30000), { cleared: 31556, clearedUses: 2, read: 17161, write: 3874 }, { now });
    response(g, cfg, t(undefined, false, 30000), { cleared: 32900, clearedUses: 2, read: 21035, write: 21742 }, { now: now + 1000 });
    assert.equal(g.written, 0); assert.equal(g.stopped, null);
    // the same growth with the prefix written over as well: only the excess counts (raw 75677 -> 113900, +38223)
    response(g, cfg, t(undefined, false, 30000), { cleared: 32900, clearedUses: 2, read: 1000, write: 80000 }, { now: now + 2000 });
    assert.equal(g.written, (80000 - (113900 - 75677)) * WRITE_1H);
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
  assert.equal(isRewrite({ read: 21035, write: 21742, input: 2 }), false, 'a file read into a 40k conversation is new content, not a rewrite (the multi-turn run, 2026-11-02)');
  assert.equal(isRewrite({ read: 40000, write: 60000, input: 2 }), true, 'from LONG_CONTEXT up the same shape is a rewrite');
});

test('the request is measured before the turn: the prefix a deeper ask keeps is the head, the system prompt and tools', () => {
  const tu = id => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } });
  const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
  // three turns of three tool calls: the keep a boundary decides is the previous turn's count (3), so six
  // results sit before the turn and three of them are clearable. Before 2026-11-03 the keep was `keepMin`
  // whatever the turn's shape, which let the server clear the turn in progress (B6, research/clearing-bench).
  const messages = [{ role: 'user', content: 'first' }];
  for (let i = 0; i < 3; i++) messages.push({ role: 'assistant', content: [tu(`a${i}`)] }, { role: 'user', content: [tr(`a${i}`, 10000)] });
  messages.push({ role: 'user', content: [{ type: 'text', text: 'second' }] });
  for (let i = 0; i < 3; i++) messages.push({ role: 'assistant', content: [tu(`b${i}`)] }, { role: 'user', content: [tr(`b${i}`, 10000)] });
  messages.push({ role: 'user', content: [{ type: 'text', text: 'third' }] });
  for (let i = 0; i < 3; i++) messages.push({ role: 'assistant', content: [tu(`c${i}`)] }, { role: 'user', content: [tr(`c${i}`, 10000)] });
  const j = { model: 'm', messages };
  assert.equal(turnId(messages), 3);
  assert.equal(measureClearing(cfg, j, 0).keep, 3, 'the keep covers the previous turn, and here equals the floor');
  const none = measureClearing(cfg, j, 0), two = measureClearing(cfg, j, 2);
  assert.equal(none.turn, 3);
  assert.equal(none.prefix, two.prefix, 'the head, whatever the server already holds: a prefix ending mid-conversation is not found');
  assert.ok(two.prefix < two.prompt);
  assert.equal(measureClearing(cfg, { ...j, system: 's'.repeat(4000), tools: [{ name: 't', description: 'd'.repeat(4000) }] }, 0).prefix, Math.floor((JSON.stringify('s'.repeat(4000)).length + JSON.stringify([{ name: 't', description: 'd'.repeat(4000) }]).length) * TOKENS_PER_CHAR));
  assert.equal(none.before, two.before, 'what sits before the turn is the same count either way');
  assert.ok(none.before > 0 && none.before < none.prompt);
  // the newest keep results and their calls are never cleared, so they are not clearable: 6 results of 10000 chars
  // before the turn and a keep of 3 leave 3 (smoke5, 2026-11-02: counted in, the ask passed what the server could
  // meet and it applied nothing)
  const results = 3 * 10000 * TOKENS_PER_CHAR, inputs = 3 * JSON.stringify({ command: 'ls' }).length * TOKENS_PER_CHAR;
  assert.equal(none.before, Math.round(results + inputs));
  // `keepMin` is a floor under the turn's own count, not the keep itself: a turn of three tool calls keeps
  // three however low the floor goes, because the alternative is clearing the work the turn is using
  assert.equal(measureClearing({ ...cfg, keepMin: 0 }, j, 0).keep, 3, 'the previous turn floors the keep');
  assert.equal(measureClearing({ ...cfg, keepMin: 0 }, j, 0).before, Math.round(results + inputs));
  assert.equal(measureClearing({ ...cfg, keepMin: 9 }, j, 0).before, 0, 'a keep past the count leaves nothing clearable');
  // a long turn raises the keep for the turn that follows it, and the measure shrinks to match
  const long = [{ role: 'user', content: 'first' }];
  for (let i = 0; i < 8; i++) long.push({ role: 'assistant', content: [tu(`d${i}`)] }, { role: 'user', content: [tr(`d${i}`, 10000)] });
  long.push({ role: 'user', content: [{ type: 'text', text: 'second' }] });
  assert.equal(measureClearing(cfg, { model: 'm', messages: long }, 0).keep, 8, 'eight tool calls last turn, eight kept');
  assert.equal(measureClearing(cfg, { model: 'm', messages: long }, 0).before, 0, 'so none of those eight is clearable yet');
  // the current turn's results are not counted, so the measure does not move while the turn runs
  const longer = { model: 'm', messages: [...messages, { role: 'assistant', content: [tu('c')] }, { role: 'user', content: [tr('c', 50000)] }] };
  assert.deepEqual(measureClearing(cfg, longer, 2), two);
  // what transformRequest sends with a record is the record's edit, and the row says what it decided
  const rec = freshRecord('s', cfg);
  const t = transformRequest('POST', '/v1/messages', { 'anthropic-beta': 'context-management-2025-06-27' }, Buffer.from(JSON.stringify(j)), { ...proxyConfig({}, {}), record: rec, now });
  assert.equal(t.injected, true); assert.equal(t.turn, 3); assert.equal(t.keep, 3, 'the previous turn made three tool calls, so three are kept');
  const edit = JSON.parse(t.body).context_management.edits.find(e => e.type === EDIT_TYPE);
  assert.equal(edit.clear_at_least.value, t.asked);
});

test('the clearing never reaches into the turn in progress: the keep covers it and the ask stays inside what is older', () => {
  // B6, 2026-11-03 (research/clearing-bench): a turn of one Read, one grep and two echoes against `keep: 3`
  // lost its Read mid-turn in 4 of 14 turns, and the model answered "I couldn't give the line count (its
  // Read result was cleared from my context)". Two causes, one test. The keep was the floor whatever the
  // turn's shape, so three worthless results displaced the one that mattered; and the ask was the 100k
  // floor whatever sat before the turn, so at turn 5 the server was asked for 100k when ~54k was older
  // than the turn, and it cleared 106k -- the rest out of the turn the model was answering from.
  const tu = id => ({ type: 'tool_use', id, name: 'Read', input: { file_path: `/x/${id}` } });
  const tr = (id, n) => ({ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(n) });
  const session = (turns, per, chars) => {
    const messages = [];
    for (let t = 0; t < turns; t++) {
      messages.push({ role: 'user', content: [{ type: 'text', text: `request ${t}` }] });
      for (let i = 0; i < per; i++) messages.push({ role: 'assistant', content: [tu(`t${t}u${i}`)] }, { role: 'user', content: [tr(`t${t}u${i}`, chars)] });
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: 'newest request' }] });
    return { model: 'claude-opus-5-5', messages };
  };

  // a turn of five tool calls is covered by the keep the next boundary decides, where the old floor of 3 was not
  const five = measureClearing(cfg, session(3, 5, 20000), 0);
  assert.equal(five.keep, 5, 'five tool calls last turn, five kept');

  // the ask never exceeds what is clearable before the turn, so the server can always satisfy it from
  // older material and stop before the turn in progress
  const m = measureClearing(cfg, session(4, 4, 30000), 0);
  const rec = { ...freshRecord('s', cfg), cleared: 60000, clears: 1, calls: 10, turn: 0, model: 'claude-opus-5-5' };
  const d = decide(rec, cfg, m, { turn: m.turn });
  assert.ok(d.edit.ask <= rec.cleared + Math.max(0, m.before - rec.cleared) || d.edit.ask === cfg.clearAtLeast,
    `the ask (${d.edit.ask}) stays within the cleared set plus what is older than the turn (${rec.cleared} + ${Math.max(0, m.before - rec.cleared)})`);

  // and a deepening may never ask past it either, however much the price likes the trade
  const rich = measureClearing(cfg, session(10, 4, 40000), 0);
  const deep = decide({ ...freshRecord('s', cfg), cleared: 100000, clears: 1, calls: 5, turn: 0, model: 'claude-opus-5-5' }, cfg, rich, { turn: rich.turn });
  assert.ok(deep.edit.ask <= 100000 + Math.max(0, rich.before - 100000),
    `a deepened ask (${deep.edit.ask}) is still inside what is older than the turn`);
});
