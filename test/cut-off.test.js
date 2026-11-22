// Cutting is on for every install again, with no session held out (2026-11-22, the owner's call: "for all users
// please", "actually 0 holdout"; proxy.js:PROXY_DEFAULTS carries why, and why it was off from 2026-11-19). This file
// holds what an unconfigured machine does, which is the only thing a person gets, and what the one switch does when
// a machine turns it off. Every other cut test asks for `cut: true` and tests the mechanism.
//
// The three doors and the desktop mod decide the same policy and, switched off, must decide the same nothing: a
// switch honoured by one door and not another is exactly the drift the shared-policy rules exist to stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROXY_DEFAULTS, proxyConfig, transformRequest, cutCandidates, cuttingOn } from '../src/proxy.js';
import { proxyOfferDue } from '../src/proxy-offer.js';
import { decideCut, freshCut, policyId } from '../src/cutting.js';
import { desktopPolicy, clearAnswer } from '../src/clear-door.js';
import { serviceArgs, SERVICE_HOLDOUT } from '../src/proxy-service.js';

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

test('an unconfigured machine cuts, with no session held out, and the switch is one key', () => {
  assert.equal(PROXY_DEFAULTS.cut, true, 'back on for every install on 2026-11-22, the owner\'s call; see the comment there');
  assert.equal(SERVICE_HOLDOUT, 0, 'and nothing is held out: a cut is rare, and a holdout takes its share of exactly those sessions');
  assert.equal(proxyConfig({}, {}).cut, true);
  // the ways off, which is what makes this a switch
  assert.equal(proxyConfig({ 'no-cut': true }, {}).cut, false);
  assert.equal(proxyConfig({}, { THINKER_PROXY_CUT: 'off' }).cut, false);
  assert.equal(proxyConfig({ cut: true }, { THINKER_PROXY_CUT: 'off' }).cut, true, 'a flag beats the variable');
  // and it reaches the service the machine actually runs, which is the only door a person has: on is the default,
  // so a config that says nothing sends no flag, `cut: false` is what has to travel, and the holdout it runs with
  // is none unless the config names one
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cut-off-'));
  const flags = () => serviceArgs(home);
  assert.deepEqual([flags().includes('--cut'), flags().includes('--no-cut'), flags()[flags().indexOf('--holdout') + 1]], [false, false, '0']);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { cut: false } }));
  assert.equal(flags().includes('--no-cut'), true);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { cut: true, holdout: 0.5 } }));
  assert.deepEqual([flags().includes('--cut'), flags()[flags().indexOf('--holdout') + 1]], [true, '0.5'], 'a machine may still hold sessions out for a comparison of its own');
});

// Every assertion here compares a scalar. `transformRequest` hands back the request's own bytes when it changes
// nothing (`proxy.js:asCame`), and this fixture's are ~800 KB: an `assert.equal(t.body, undefined)` on that made
// node inspect and diff the whole Buffer, which took 40 s and was killed for memory. Compare `=== raw` and
// lengths, never a body or a Buffer.
test('switched off, the Messages door forwards a cuttable request untouched and says why', () => {
  const raw = body();
  const t = transformRequest('POST', '/v1/messages', headers, raw, { ...proxyConfig({ 'no-cut': true }, {}), cutRecord: freshCut('s'), now: 2e12 });
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
test('switched off, the decision every door asks refuses a cuttable boundary outright; left alone, it cuts', () => {
  const cand = cutCandidates(messages(), { keepMin: 3 });
  assert.ok(cand.ids.length > 0 && cand.tokens > 100000, 'the fixture is well past both guards');
  const d = decideCut({ ...freshCut('s'), turn: 1 }, proxyConfig({ 'no-cut': true }, {}), { prompt: 500000, turn: 2 }, { cand, model: 'claude-opus-5-5' });
  assert.equal(d.clear, false);
  assert.equal(d.reason, 'off', 'not below-trigger and not payback: nothing was weighed at all');
  assert.equal(d.cut.length, 0, 'and no set is remembered, so there is nothing for a later turn to hold to');
  assert.equal(d.candidate, cand.tokens, 'the row carries what it would have taken');
  // an unconfigured machine cuts the same boundary, on the guards exactly as they stood
  assert.equal(decideCut({ ...freshCut('s'), turn: 1 }, proxyConfig({}, {}), { prompt: 500000, turn: 2 }, { cand, model: 'claude-opus-5-5' }).clear, true);
});

test('the desktop door clears by default, and clears nothing while the proxy cuts nothing', () => {
  assert.equal(desktopPolicy(null).auto, true);
  assert.equal(desktopPolicy(null).holdout, 0, 'and holds no session out');
  assert.equal(desktopPolicy({ proxy: { trigger: 90000, keepMin: 1 } }).auto, true, 'a config that only moves a guard leaves it on');
  assert.equal(desktopPolicy({ proxy: { cut: false } }).auto, false);
  assert.equal(clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 500000, messages: [] }, { config: { proxy: { cut: false } } }).reason, 'off');
});

// The proxy's one-off repair question (proxy-offer.js) is a promise that old results will start leaving long
// sessions. With the cutting off it would be a false one, and a machine gets that question once.
test('the one-off offer to turn the proxy back on is asked again, and holds on a machine that switched the cutting off', () => {
  assert.equal(cuttingOn({}, {}), true);
  assert.equal(cuttingOn({ cut: false }, {}), false, 'the machine config wins, as the service is built from it');
  assert.equal(cuttingOn({}, { THINKER_PROXY_CUT: 'off' }), false, 'then the environment');
  assert.equal(cuttingOn({ cut: true }, { THINKER_PROXY_CUT: 'off' }), true, 'the config beats the variable, as a flag does');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cut-offer-'));
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  // a machine that turned the proxy off while the fault was live: every one of the offer's own conditions is met
  fs.writeFileSync(path.join(home, 'state', 'proxy-service.json'), JSON.stringify({ enabled: false, off: '2026-10-20T10:00:00.000Z' }));
  const env = { THINKER_ROUTE_HOME: home };
  assert.equal(proxyOfferDue({ home, env })?.kind, 'plain', 'the question is owed again now that a yes means old results leave long sessions');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { cut: false } }));
  assert.equal(proxyOfferDue({ home, env }), null, 'and nothing is asked where nothing would be cut');
});

// The banner's own wording is held in test/proxy-banner.test.js, where the rest of its rules are.
