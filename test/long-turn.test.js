// A turn that runs for a hundred tool calls is cut into; a conversation's turn is not.
//
// The shape here is the one the container e2e found on 2026-11-13 (demo/e2e): one prompt, sixteen calls,
// context past the trigger, and every call refused `nothing-to-cut` because the whole conversation sat
// inside the turn in progress and the turn was protected whole. An autonomous job has no second prompt, so
// that protection never lifted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutCandidates, measurePrompt, PROXY_DEFAULTS } from '../src/proxy.js';
import { decideCut, openTurn, freshCut } from '../src/cutting.js';

// ~5.3k tokens a result, which is about what a read of a module returns: the shape a long turn actually has is many
// results of that size, not a few enormous ones. The difference matters here, because what a cut can remove is
// everything past the newest `keepTurn` -- so the bigger the tail it protects, the more results a turn needs before
// the cut is worth its rewrite at all (`priceCut`, and the `payback` case at the end of this file).
const BIG = 'x'.repeat(12_000);

// One prompt, then n read/result pairs and no second prompt: an autonomous job.
const job = n => {
  const ms = [{ role: 'user', content: [{ type: 'text', text: 'fix the ticket' }] }];
  for (let i = 0; i < n; i++) ms.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { path: `src/m${i}.py` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: BIG }] });
  return { model: 'claude-opus-5-5', messages: ms };
};
// The same work as a conversation: a prompt every few calls.
const chat = (turns, per) => {
  const ms = [];
  let k = 0;
  for (let t = 0; t < turns; t++) {
    ms.push({ role: 'user', content: [{ type: 'text', text: `step ${t}` }] });
    for (let i = 0; i < per; i++, k++) ms.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${k}`, name: 'Read', input: { path: `src/m${k}.py` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${k}`, content: BIG }] });
  }
  return { model: 'claude-opus-5-5', messages: ms };
};
const run = (body, cfg) => {
  const c = { ...PROXY_DEFAULTS, ...cfg };
  const m = measurePrompt(c, body);
  const open = openTurn(c, m);
  const cand = cutCandidates(body.messages, { keepMin: c.keepMin, keepTurn: c.keepTurn, cut: [], openTurn: open });
  return { m, open, cand, d: decideCut(freshCut('s'), c, m, { cand, open, model: body.model }) };
};

test('a one-prompt job is never cut as things stand, however large it grows', () => {
  const r = run(job(40), {});
  assert.ok(r.m.inTurn > PROXY_DEFAULTS.trigger, 'the turn alone is well past the trigger');
  assert.equal(r.m.prompt < PROXY_DEFAULTS.trigger, true, 'and the trigger never sees it: the prompt it measures leaves the turn out');
  assert.equal(r.open, false, 'off by default');
  assert.equal(r.cand.ids.length, 0, 'nothing is even a candidate');
  assert.equal(r.d.clear, false);
  assert.equal(r.d.reason, 'nothing-to-cut', 'which is exactly what the containers logged on all 16 calls');
});

test('with the long-turn rule on, the same job is cut and keeps the newest results', () => {
  const r = run(job(40), { longTurn: true });
  assert.equal(r.open, true, 'the turn put a trigger\'s worth of results in by itself');
  assert.equal(r.d.clear, true, 'and the cut fires inside the turn');
  assert.ok(r.d.cut.length >= 1);
  for (const id of ['t39', 't35', 't30']) assert.ok(!r.d.cut.includes(id), `the newest results are kept (${id}), as in any other stretch`);
  assert.ok(r.d.cut.includes('t0'), 'what it finished with first is what goes first');
  assert.match(r.d.policy, /-lt10$/, 'and the saving names the policy that made it, down to how much of the turn it kept');
});

test('a conversation is untouched: its turns never reach the rule', () => {
  const body = chat(4, 3);
  const off = run(body, {});
  const on = run(body, { longTurn: true });
  assert.ok(on.m.inTurn < PROXY_DEFAULTS.trigger, 'a turn of three reads is not a long turn');
  assert.equal(on.open, false);
  assert.deepEqual(on.d.cut, off.d.cut, 'the same cut either way');
  assert.equal(on.d.clear, off.d.clear);
  assert.equal(on.d.policy.endsWith('-lt10'), true, 'the id still says the rule was on, because a reader must not have to guess');
});

test('inside a long turn the floor and the payback do the pacing a boundary used to do', () => {
  const cfg = { longTurn: true };
  const first = run(job(40), cfg);
  assert.equal(first.d.clear, true);
  // the same turn one call later, with what it already cut on the record: nothing new has piled up
  const rec = { ...freshCut('s'), cut: first.d.cut, turn: first.d.turn };
  const body = job(40);
  const m = measurePrompt({ ...PROXY_DEFAULTS, ...cfg }, body);
  const open = openTurn({ ...PROXY_DEFAULTS, ...cfg }, m);
  const cand = cutCandidates(body.messages, { keepMin: 3, keepTurn: PROXY_DEFAULTS.keepTurn, cut: rec.cut, openTurn: open });
  const again = decideCut(rec, { ...PROXY_DEFAULTS, ...cfg }, m, { cand, open, model: body.model });
  assert.equal(again.clear, false, 'no second cut until another floor\'s worth of results is finished with');
  assert.ok(['nothing-to-cut', 'below-clear-minimum'].includes(again.reason), `paced by size, not by the turn (${again.reason})`);
});

// The number this rule turns on (the owner's call, 2026-11-14: "3 results sounds small let's do ten"). An ordinary cut
// protects the whole turn in progress, so the model never loses a result it is working from. A long-turn cut has to
// name a count instead, and three of a hundred is the shape that could make a model answer out of a gap rather than
// read again -- the one failure re-reads cannot see, because a model that confabulates asks for nothing.
test('a cut inside a turn leaves the model the turn\'s newest ten, not its newest three', () => {
  const body = job(40);
  const keptOf = n => {
    const r = run(body, { longTurn: true, keepTurn: n });
    assert.equal(r.open, true);
    assert.equal(r.d.clear, true, `a cut still fires at ${n}`);
    return [...Array(40).keys()].map(i => `t${i}`).filter(id => !r.d.cut.includes(id));
  };
  const ten = keptOf(10), three = keptOf(3);
  assert.deepEqual(ten, [...Array(10).keys()].map(i => `t${30 + i}`), 'the newest ten of the turn stay');
  assert.deepEqual(three, ['t37', 't38', 't39'], 'where the old number left three');
  // and the saving says which number made it, so one is never read as the other
  const at10 = run(body, { longTurn: true }), at3 = run(body, { longTurn: true, keepTurn: 3 });
  assert.ok(at10.d.cut.length < at3.d.cut.length, 'ten keeps more, so it clears less: 7 results less here');
  assert.match(at10.d.policy, /-lt10$/);
  assert.match(at3.d.policy, /-lt3$/);
});

test('the wider tail is a setting, not a constant: a flag and the machine config reach it', async () => {
  const { proxyConfig } = await import('../src/proxy.js');
  assert.equal(proxyConfig({}, {}).keepTurn, 10, 'ten by default');
  assert.equal(proxyConfig({ 'keep-turn': '20' }, {}).keepTurn, 20, 'a flag wins');
  assert.equal(proxyConfig({}, { THINKER_PROXY_KEEP_TURN: '6' }).keepTurn, 6, 'the environment after it');
  const { serviceArgs } = await import('../src/proxy-service.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const home = fs.default.mkdtempSync(path.default.join(os.default.tmpdir(), 'thinker-kt-'));
  fs.default.writeFileSync(path.default.join(home, 'config.json'), JSON.stringify({ proxy: { longTurn: true, keepTurn: 10 } }));
  const args = serviceArgs(home, { port: 4000 });
  assert.ok(args.includes('--long-turn'), `the service carries the rule: ${args.join(' ')}`);
  assert.deepEqual(args.slice(args.indexOf('--keep-turn'), args.indexOf('--keep-turn') + 2), ['--keep-turn', '10'], 'and the count');
});

// What the wider tail costs, stated rather than discovered later. A cut's rewrite is priced on the WHOLE post-cut
// prompt (`priceCut`), while its saving is only what it removed -- so protecting ten of a turn's results instead of
// three can leave too little to remove for the cut to repay itself within PAYBACK calls. On the turn shape this rule
// was built for (many results of a module's size) that never bites. On a turn of a few very large reads it does, and
// the rule stands down there rather than cutting anyway. That is the trade and it is the safe side of it: a turn of 25
// big reads is exactly where leaving the model 3 of them would have been worst.
test('where ten leaves too little to remove, the cut stands down instead of cutting anyway', () => {
  const huge = (n, chars) => {
    const R = 'x'.repeat(chars);
    const ms = [{ role: 'user', content: [{ type: 'text', text: 'read all of it' }] }];
    for (let i = 0; i < n; i++) ms.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { path: `src/m${i}.py` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: R }] });
    return { model: 'claude-opus-5-5', messages: ms };
  };
  const body = huge(25, 20_000);          // 25 reads of ~8.9k tokens: past the trigger, few enough that ten is most of it
  const at3 = run(body, { longTurn: true, keepTurn: 3 });
  assert.equal(at3.d.clear, true, 'the old number cut 22 of the 25 results the model was working from');
  const at10 = run(body, { longTurn: true });
  assert.equal(at10.d.clear, false);
  assert.equal(at10.d.reason, 'payback', 'ten leaves 15 to remove against the whole prompt rewritten: it does not repay');
  // and the guard that refused is the one that always priced cuts, not a new rule for this case
  assert.ok(at10.cand.ids.length > 0, 'there were candidates; the price is what refused them');
});
