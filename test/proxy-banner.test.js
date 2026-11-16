// What the proxy says about itself when it starts.
//
// This sentence is the only description of the policy a person gets if they run the proxy by hand rather than as
// a service, and nothing covered it: it had been printing "keeping the newest undefined" ever since the cut moved
// client-side on 2026-11-05, because it read `cfg.keep` -- the API-side edit's keep ('turn' or a count) -- which no
// config has carried since. Found on 2026-11-15 while starting a proxy for a bench arm. The tests are about the
// one thing that went wrong: every number in the sentence comes from the config, so none of them can read
// `undefined` again, and the sentence agrees with the policy stamp about what the policy is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxyBanner } from '../src/commands/proxy.js';
import { proxyConfig, PROXY_DEFAULTS } from '../src/proxy.js';
import { policyId } from '../src/cutting.js';

test('no part of the sentence is undefined, on the defaults or with every switch on', () => {
  for (const [what, cfg] of [
    ['the shipped defaults', proxyConfig({}, {})],
    ['every switch on', proxyConfig({}, { THINKER_PROXY_CUT_INPUTS: 'on', THINKER_PROXY_HOLDOUT: '0.15' })],
    ['inputs off', proxyConfig({}, { THINKER_PROXY_CUT_INPUTS: 'off' })],
    ['the Codex door', { ...PROXY_DEFAULTS, codex: true }],
    ['the Responses door', { ...PROXY_DEFAULTS, protocol: 'responses' }],
  ]) {
    const text = proxyBanner(cfg, 6896);
    assert.doesNotMatch(text, /undefined|NaN|\[object/, `${what}: ${text}`);
    assert.match(text, /127\.0\.0\.1:6896/, what);
  }
});

test('the sentence names the policy the stamp names, so a person and a log row agree', () => {
  const cfg = proxyConfig({}, { THINKER_PROXY_CUT_INPUTS: 'on' });
  const text = proxyBanner(cfg, 1234);
  const stamp = policyId(cfg);
  assert.match(text, new RegExp(`past ${cfg.trigger} input tokens`), 'the trigger the stamp calls t140k');
  assert.match(text, new RegExp(`at least ${cfg.clearAtLeast} at a time`), 'the floor the stamp calls f8k');
  assert.match(text, new RegExp(`newest ${cfg.keepMin}\\b`), 'the tail it keeps');
  // the switch the stamp carries is the one the sentence has to mention
  assert.ok(stamp.includes('+in'), stamp);
  assert.match(text, /with each finished call's own text/, 'and that a call goes with its result');
});

test('a switch that is off is not mentioned at all, so the sentence is never a lie by omission', () => {
  const off = proxyBanner(proxyConfig({}, { THINKER_PROXY_CUT_INPUTS: 'off' }), 1234);
  assert.doesNotMatch(off, /own text/, 'inputs off says nothing about call text');
  assert.doesNotMatch(off, /held out/, 'and the default holdout is none');
  const held = proxyBanner(proxyConfig({}, { THINKER_PROXY_HOLDOUT: '0.15' }), 1234);
  assert.match(held, /15% of sessions held out/, 'a holdout a person set is said in whole percent');
});

test('the Responses door describes itself, and never the Messages policy', () => {
  const text = proxyBanner({ ...PROXY_DEFAULTS, protocol: 'responses', cutInputs: true }, 6896);
  assert.match(text, /^Responses proxy on/);
  assert.match(text, /supports_websockets = false/, 'the one setting a person has to change themselves');
  // that door replaces results alone (proxy-responses.js), so the Messages switches may not appear on it
  assert.doesNotMatch(text, /own text/, 'it cuts results alone, whatever the Messages flags say');
});
