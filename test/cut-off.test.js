// Cutting is off, and this file is where that is held (2026-11-19, the owner's call; proxy.js:PROXY_DEFAULTS
// carries why). Every other cut test asks for `cut: true` and tests the mechanism; nothing but this says what
// an unconfigured machine does, which is the only thing a person gets.
//
// The three doors and the desktop mod decided the same policy before this and must decide the same nothing now:
// a switch honoured by one door and not another is exactly the drift the shared-policy rules exist to stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROXY_DEFAULTS, proxyConfig, transformRequest, cutCandidates, cuttingOn } from '../src/proxy.js';
import { proxyOfferDue } from '../src/proxy-offer.js';
import { decideCut, freshCut, policyId } from '../src/cutting.js';
import { desktopPolicy, clearAnswer } from '../src/clear-door.js';
import { serviceArgs } from '../src/proxy-service.js';

const headers = { 'x-claude-code-session-id': 's' };
// a conversation that every guard would have let through: well past the trigger, seven big finished results
const messages = () => {
  const out = [{ role: 'user', content: 'go' }];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']) {
    out.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: `/f/${id}` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(80000) }] });
  }
  out.push({ role: 'user', content: [{ type: 'text', text: 'next' }] });
  return out;
};
const body = () => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', messages: messages() }));

test('nothing is cut on an unconfigured machine, and the switch is one key', () => {
  assert.equal(PROXY_DEFAULTS.cut, false, 'the owner turned the cutting off on 2026-11-19; see the comment there for what it was worth');
  assert.equal(proxyConfig({}, {}).cut, false);
  // the ways back, which is what makes this a switch and not a removal
  assert.equal(proxyConfig({ cut: true }, {}).cut, true);
  assert.equal(proxyConfig({}, { THINKER_PROXY_CUT: 'on' }).cut, true);
  assert.equal(proxyConfig({ 'no-cut': true }, { THINKER_PROXY_CUT: 'on' }).cut, false, 'a flag beats the variable');
  // and it reaches the service the machine actually runs, which is the only door a person has: off is the
  // default, so `cut: true` is what has to travel, and a config that says nothing must not send the flag
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cut-off-'));
  assert.equal(serviceArgs(home).includes('--cut'), false);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { cut: true } }));
  assert.equal(serviceArgs(home).includes('--cut'), true);
});

// Every assertion here compares a scalar. `transformRequest` hands back the request's own bytes when it changes
// nothing (`proxy.js:asCame`), and this fixture's are ~800 KB: an `assert.equal(t.body, undefined)` on that made
// node inspect and diff the whole Buffer, which took 40 s and was killed for memory. Compare `=== raw` and
// lengths, never a body or a Buffer.
test('the Messages door forwards a cuttable request untouched and says why', () => {
  const raw = body();
  const t = transformRequest('POST', '/v1/messages', headers, raw, { ...proxyConfig({}, {}), cutRecord: freshCut('s'), now: 2e12 });
  assert.equal(!!t.injected, false, 'nothing was replaced');
  assert.equal(t.body === raw, true, 'the bytes that go out are the agent\'s own, the same object');
  assert.equal(t.reason, 'off');
  assert.equal(t.mark === undefined, true, 'no cache breakpoint of ours is placed either: a seed is the first half of a cut');
  // what the row still says, which is the point of leaving the proxy in place: the size of the cut not made
  assert.ok(t.candidate > 0, 'the log goes on measuring what a cut would have taken');
  assert.equal(t.policy, policyId({ cut: false }));
  assert.match(t.policy, /-off$/, 'a row made now is never pooled with one made under the cutting policy');
});

// One refusal for all three doors: Messages, Responses (Codex) and Chat (the gateways) each take their decision
// from `decideCut` and nowhere else, which is the shared-policy rule and is held by their own test files. So the
// switch is tested where it is read -- a door that cut on its own would fail those files, not this one.
test('the decision every door asks refuses a cuttable boundary outright', () => {
  const cand = cutCandidates(messages(), { keepMin: 3 });
  assert.ok(cand.ids.length > 0 && cand.tokens > 100000, 'the fixture is well past both guards');
  const d = decideCut({ ...freshCut('s'), turn: 1 }, proxyConfig({}, {}), { prompt: 500000, turn: 2 }, { cand, model: 'claude-opus-5-5' });
  assert.equal(d.clear, false);
  assert.equal(d.reason, 'off', 'not below-trigger and not payback: nothing was weighed at all');
  assert.equal(d.cut.length, 0, 'and no set is remembered, so there is nothing for a later turn to hold to');
  assert.equal(d.candidate, cand.tokens, 'the row carries what it would have taken');
  // `cut: true` and the same boundary is cut, on the guards exactly as they stood
  assert.equal(decideCut({ ...freshCut('s'), turn: 1 }, { ...proxyConfig({}, {}), cut: true }, { prompt: 500000, turn: 2 }, { cand, model: 'claude-opus-5-5' }).clear, true);
});

test('the desktop door clears nothing while the proxy cuts nothing', () => {
  assert.equal(desktopPolicy(null).auto, false);
  assert.equal(desktopPolicy({ proxy: { trigger: 90000, keepMin: 1 } }).auto, false, 'a config that only moves a guard does not turn it on');
  assert.equal(desktopPolicy({ proxy: { cut: true } }).auto, true);
  assert.equal(clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 500000, messages: [] }, { config: null }).reason, 'off');
});

// The proxy's one-off repair question (proxy-offer.js) is a promise that old results will start leaving long
// sessions. With the cutting off it would be a false one, and a machine gets that question once.
test('the one-off offer to turn the proxy back on holds while the cutting is off', () => {
  assert.equal(cuttingOn({}, {}), false);
  assert.equal(cuttingOn({ cut: true }, {}), true, 'the machine config wins, as the service is built from it');
  assert.equal(cuttingOn({}, { THINKER_PROXY_CUT: 'on' }), true, 'then the environment');
  assert.equal(cuttingOn({ cut: false }, { THINKER_PROXY_CUT: 'on' }), false, 'the config beats the variable, as a flag does');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cut-offer-'));
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  // a machine that turned the proxy off while the fault was live: every one of the offer's own conditions is met
  fs.writeFileSync(path.join(home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: false, off: '2026-10-20T10:00:00.000Z' }));
  const env = { THINKER_ROUTE_HOME: home };
  assert.equal(proxyOfferDue({ home, env }), null, 'nothing is asked while nothing would be cut');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { cut: true } }));
  assert.equal(proxyOfferDue({ home, env })?.kind, 'plain', 'and the question is still owed once the cutting is back');
});

// The banner's own wording is held in test/proxy-banner.test.js, where the rest of its rules are.
