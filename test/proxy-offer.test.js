import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proxyOffer, proxyOfferDue, proxyOfferPending, answerProxyOffer, offerState, FIXED_AT, FIX_PR, ANSWER_DAYS } from '../src/proxy-offer.js';

// a machine whose proxy state and route are the test's own
function machine({ service = {}, shell = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-offer-'));
  const home = path.join(root, 'thinker');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'proxy-service.json'), JSON.stringify({ port: 6901, ports: [6901], ...service }));
  const shellHome = path.join(root, 'shell');
  fs.mkdirSync(shellHome, { recursive: true });
  if (shell) fs.writeFileSync(path.join(shellHome, '.zshrc'), shell);
  return { home, env: { THINKER_ROUTE_HOME: shellHome }, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const OFF_BEFORE = '2026-10-20T10:00:00.000Z';
const store = () => { const rows = []; return { log: r => rows.push(r), rows }; };

test('who is asked: off before the fix, or stood down; not a machine that is on, never was, or was turned off since', () => {
  const cases = [
    [{ enabled: false, off: OFF_BEFORE }, 'plain', 'off while the fault was live'],
    [{ enabled: false, off: '2026-10-29T10:00:00.000Z' }, null, 'turned off after the fix, on purpose'],
    [{ enabled: false, off: OFF_BEFORE, standDown: { at: '2026-10-29T09:00:00.000Z', reason: 'its URL was taken out' } }, 'plain', 'a stand-down is the fixed code speaking'],
    [{ enabled: true, port: 6901 }, null, 'it is on'],
    [{}, null, 'it was never on'],
  ];
  for (const [service, want, why] of cases) {
    const m = machine({ service });
    try {
      const due = proxyOfferDue({ home: m.home, env: m.env });
      assert.equal(due ? due.kind : null, want, why);
    } finally { m.rm(); }
  }
});

test('a machine routed through its own model server is offered the gateway, a cloud route is not asked at all', () => {
  const gw = machine({ service: { enabled: false, off: OFF_BEFORE }, shell: 'export ANTHROPIC_BASE_URL=https://smartrouter.internal\n' });
  try {
    const due = proxyOfferDue({ home: gw.home, env: gw.env });
    assert.equal(due.kind, 'gateway');
    assert.equal(due.gateway.url, 'https://smartrouter.internal');
  } finally { gw.rm(); }
  const cloud = machine({ service: { enabled: false, off: OFF_BEFORE } });
  try {
    assert.equal(proxyOfferDue({ home: cloud.home, env: { ...cloud.env, CLAUDE_CODE_USE_BEDROCK: '1' } }), null, 'the proxy cannot speak Bedrock, so there is nothing to say yes to');
  } finally { cloud.rm(); }
});

test('the question is put through the agent\'s own tool, once, and names the fix', () => {
  const m = machine({ service: { enabled: false, off: OFF_BEFORE }, shell: 'export ANTHROPIC_BASE_URL=https://smartrouter.internal\n' });
  const st = store();
  try {
    const first = proxyOffer(st, { client: 'claude', home: m.home, env: m.env });
    assert.match(first, /^<thinker-proxy-offer>/);
    assert.match(first, /AskUserQuestion tool, not in prose/);
    assert.match(first, /smartrouter\.internal/, 'it says what the route is');
    assert.match(first, new RegExp(FIX_PR.replace(/[/.]/g, '\\$&')), 'and links the fix');
    assert.match(first, /thinker's `proxy` tool with choice set to yes, no or never/);
    assert.match(first, /off since 2026-10-20/);
    assert.equal(proxyOffer(st, { client: 'claude', home: m.home, env: m.env }), '', 'asked once, never again');
    assert.equal(proxyOfferPending(m.home), true, 'and the answer is awaited');
    assert.deepEqual(st.rows.map(r => r.op), ['proxy-offer']);
    assert.equal(st.rows[0].kind, 'gateway');
  } finally { m.rm(); }
});

test('an agent with no way to ask, and a client with no question tool', () => {
  const m = machine({ service: { enabled: false, off: OFF_BEFORE } });
  try {
    assert.equal(proxyOffer(store(), { client: 'goose', home: m.home, env: m.env }), '', 'nothing to put a question through');
    assert.equal(proxyOfferDue({ home: m.home, env: m.env })?.kind, 'plain', 'and it is not marked asked either');
    const codex = proxyOffer(store(), { client: 'codex', home: m.home, env: m.env });
    assert.match(codex, /ask the user in chat/, 'Codex asks in chat');
    assert.match(codex, /`proxy` tool/, 'and answers over MCP');
  } finally { m.rm(); }
});

test('yes turns it on, in front of the person\'s own server where that was the offer', async () => {
  const m = machine({ service: { enabled: false, off: OFF_BEFORE }, shell: 'export ANTHROPIC_BASE_URL=https://smartrouter.internal\n' });
  const st = store();
  try {
    proxyOffer(st, { client: 'claude', home: m.home, env: m.env });
    let got = null;
    const enableFn = async opts => { got = opts; return { url: 'http://127.0.0.1:6901', upstream: 'https://smartrouter.internal' }; };
    const reply = await answerProxyOffer('yes', { store: st, client: 'claude', home: m.home, env: m.env, enableFn });
    assert.equal(got.gateway, true, 'the gateway is what was offered, so the gateway is what is turned on');
    assert.equal(got.force, true, 'a stand-down is only overridden by the person asking for it');
    assert.match(reply, /Context proxy on: http:\/\/127\.0\.0\.1:6901 and forwards to https:\/\/smartrouter\.internal/);
    assert.equal(offerState(m.home).choice, 'yes');
    assert.equal(proxyOfferPending(m.home), false, 'answered: the tool goes away');
    assert.deepEqual(st.rows.map(r => r.op), ['proxy-offer', 'proxy-offer-answer']);
    assert.equal(st.rows[1].choice, 'yes');
  } finally { m.rm(); }
});

test('no and never close the question, and a plain machine is turned on without a gateway', async () => {
  for (const [choice, mark] of [['no', false], ['never', true]]) {
    const m = machine({ service: { enabled: false, off: OFF_BEFORE } });
    try {
      proxyOffer(store(), { client: 'claude', home: m.home, env: m.env });
      const reply = await answerProxyOffer(choice, { home: m.home, env: m.env, enableFn: async () => assert.fail('nothing is turned on') });
      assert.match(reply, /stays off on this machine/);
      assert.equal(!!offerState(m.home).never, mark, choice);
      assert.equal(proxyOfferPending(m.home), false);
      assert.equal(proxyOfferDue({ home: m.home, env: m.env }), null, 'and it is not asked again');
    } finally { m.rm(); }
  }
  const m = machine({ service: { enabled: false, off: OFF_BEFORE } });
  try {
    proxyOffer(store(), { client: 'claude', home: m.home, env: m.env });
    let got = null;
    await answerProxyOffer('yes', { home: m.home, env: m.env, enableFn: async o => { got = o; return { url: 'http://127.0.0.1:6901' }; } });
    assert.equal(got.gateway, undefined, 'no route of their own: the API as usual');
  } finally { m.rm(); }
});

test('a question nobody answers stops being awaited, and the proxy standing down again is reported not claimed', async () => {
  const m = machine({ service: { enabled: false, off: OFF_BEFORE } });
  try {
    proxyOffer(store(), { client: 'claude', home: m.home, env: m.env });
    const later = Date.parse(offerState(m.home).asked) + (ANSWER_DAYS + 1) * 86400_000;
    assert.equal(proxyOfferPending(m.home, later), false);
    const reply = await answerProxyOffer('yes', { home: m.home, env: m.env, enableFn: async () => ({ stoodDown: 'ANTHROPIC_BASE_URL is set to https://other.gw in ~/.zshrc' }) });
    assert.match(reply, /stayed off: ANTHROPIC_BASE_URL is set/, 'the truth, not a claim that it is on');
  } finally { m.rm(); }
});

test('the fix date is the cohort line', () => {
  assert.equal(FIXED_AT, '2026-10-28');
});
