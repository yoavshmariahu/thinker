// The desktop door's clearing decision (src/clear-door.js), which the clearing mod asks for with
// `thinker hook clear`. The rules were the mod's own copy until 2026-11-18 and were tested inside it
// (`claude plugin test src/integrations/claude-clear`); they are the CLI's now, so they are tested here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { clearAnswer, clearPlan, clearLadder, chooseDepth, clearPays, keptOf, desktopPolicy, stampOf, heldOut, proxied, autoDue, HOLD_GROWTH, NEVER } from '../src/clear-door.js';
import { PAYBACK, WRITE_1H, MIN_CHARS, COLD_MS, readRate, placeholder, policyId, VERSION } from '../src/cutting.js';
import { PROXY_DEFAULTS, resultTokens } from '../src/proxy.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const DEFAULTS = desktopPolicy(null);
const big = (n, ch = 'x') => ch.repeat(n);
const prompt = text => ({ role: 'user', text, toolUses: [] });
const call = (id, tool = 'Read', input = {}) => ({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input }] });
const result = (id, text) => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }] });
const writeRatio = model => WRITE_1H / readRate(model);

test('the newest turn and the newest three results stay; older ones are named for a placeholder, and nothing else', () => {
  const messages = [
    prompt('read things'), call('a'), result('a', big(1000, 'a')), call('b', 'Bash'), result('b', big(2000, 'b')), call('c'), result('c', big(300)), call('d'), result('d', big(400)),
    prompt('now this'), call('e'), result('e', big(5000)),
  ];
  const c = clearPlan(messages);
  assert.equal(c.cleared, 2);
  assert.deepEqual(c.replace, { a: placeholder(1000), b: placeholder(2000) });
  // the two piggybacks went on 2026-11-04 (the proxy's too): a call's own text and earlier thinking stay
  assert.equal(c.rows, 0);
  assert.equal(c.inputTokens, 0);
  assert.equal(c.chars, 3000);
  assert.equal(c.tokens, c.resultTokens);
  assert.deepEqual(c.tools, [{ name: 'Bash', calls: 1, tokens: resultTokens(big(2000, 'b')) }, { name: 'Read', calls: 1, tokens: resultTokens(big(1000, 'a')) }]);
});

test('a short result is left alone, keepMin is the policy\'s, and nothing to clear names nothing', () => {
  const messages = [prompt('go'), call('a'), result('a', big(MIN_CHARS - 1)), call('b'), result('b', big(900)), prompt('next')];
  assert.equal(clearPlan(messages, { keepMin: 0 }).cleared, 1);
  assert.equal(clearPlan(messages, { keepMin: PROXY_DEFAULTS.keepMin }).cleared, 0);
  const none = clearPlan([prompt('go'), call('a'), result('a', big(5000))]);
  assert.equal(none.cleared, 0);
  assert.deepEqual(none.replace, {});
  // an earlier clear's placeholder is under MIN_CHARS, so it is never counted or replaced again
  const after = [prompt('go'), call('a'), result('a', placeholder(400000)), call('b'), result('b', big(900)), prompt('next'), call('c'), result('c', big(5000))];
  assert.deepEqual(Object.keys(clearPlan(after, { keepMin: 0 }).replace), ['b']);
});

test('a rung stops the clear at the newest results the decision chose', () => {
  const messages = [prompt('go')];
  for (let i = 0; i < 6; i++) messages.push(call(`t${i}`), result(`t${i}`, big(4000)));
  messages.push(prompt('next'));
  const ladder = clearLadder(messages, { keepMin: 0 });
  assert.deepEqual(ladder.map(r => r.depth), [1, 2, 3, 4, 5, 6]);
  assert.equal(ladder[2].tokens, 3 * resultTokens(big(4000)));
  const c = clearPlan(messages, { keepMin: 0, depth: 2 });
  assert.deepEqual(Object.keys(c.replace).sort(), ['t4', 't5'], 'the newest two eligible, and no more');
  assert.equal(clearPlan(messages, { keepMin: 0 }).cleared, 6, 'no depth is every eligible result');
});

test('the policy is the proxy\'s unless the machine config says otherwise, and its stamp is this release\'s', () => {
  assert.deepEqual(DEFAULTS, { keepMin: PROXY_DEFAULTS.keepMin, clearAtLeast: PROXY_DEFAULTS.clearAtLeast, trigger: PROXY_DEFAULTS.trigger, holdout: 0, auto: true, clearDeep: true });
  assert.deepEqual(desktopPolicy({ proxy: { trigger: 90000, holdout: 0, desktop: false, keepMin: 'x' } }), { ...DEFAULTS, trigger: 90000, auto: false });
  // The mod never sees the request: it places no breakpoint, leaves out no thinking and takes no call text, so a
  // saving made here is named without them and never pooled with the proxy's.
  assert.equal(stampOf(DEFAULTS), `v${VERSION}-t140k-f8k-p${PAYBACK}-deep`);
  assert.equal(stampOf(DEFAULTS), policyId({ ...PROXY_DEFAULTS, cutInputs: false, cutImages: false, cutBreakpoint: false, cutThinking: false }));
  assert.equal(stampOf(desktopPolicy({ proxy: { clearDeep: false, clearAtLeast: 20000 } })), `v${VERSION}-t140k-f20k-p${PAYBACK}-one`);
});

test('a session is in or out of the holdout for good, and thinker\'s own proxy is known by its loopback address', () => {
  assert.equal(heldOut('s', 0), false);
  assert.equal(heldOut('s', 1), true);
  assert.equal(heldOut('abc', 0.5), heldOut('abc', 0.5));
  const out = Array.from({ length: 2000 }, (_, i) => `session-${i}`).filter(id => heldOut(id, 0.15)).length;
  assert.ok(out > 200 && out < 400, String(out));
  assert.equal(proxied('http://127.0.0.1:61056'), true);
  assert.equal(proxied('http://localhost:3000/'), true);
  assert.equal(proxied('https://api.anthropic.com'), false);
  assert.equal(proxied(undefined), false);
});

test('an automatic attempt that did not clear holds the next until the context has grown by HOLD_GROWTH', () => {
  assert.equal(autoDue(DEFAULTS.trigger - 1, DEFAULTS, 0), false);
  assert.equal(autoDue(DEFAULTS.trigger, DEFAULTS, 0), true);
  const holdUntil = 200000 + HOLD_GROWTH;
  assert.equal(autoDue(200000, DEFAULTS, holdUntil), false);
  assert.equal(autoDue(250000, DEFAULTS, holdUntil), false);
  assert.equal(autoDue(300000, DEFAULTS, holdUntil), true);
});

test('a clear is made when it repays its write inside PAYBACK calls, and nothing is assumed about session length', () => {
  assert.equal(clearPays(DEFAULTS, { dropped: 0, recache: 0, idle: 0, cleared: false }), false);
  assert.equal(clearPays(DEFAULTS, { dropped: 100000, recache: 20000, idle: 0, cleared: true }), true);
  assert.equal(clearPays(DEFAULTS, { dropped: 100000, recache: 300000, idle: 0, cleared: true }), false);
  // The line itself: (writeRatio(model) - 1) x recache against (PAYBACK + 1) x dropped. A token written needs 20
  // read back where the model is unknown, less the read the rewrite displaces (the `- 1`), and the call that
  // makes the clear is one of the calls that repay it (the `+ 1`; cutting.js:priceCut, 2026-11-13).
  assert.equal(writeRatio(''), 20);
  const edgeAt = (dropped, model = '') => Math.floor((PAYBACK + 1) * dropped / (writeRatio(model) - 1));
  const edge = edgeAt(80000);
  assert.equal(edge, 109473);
  assert.equal(clearPays(DEFAULTS, { dropped: 80000, recache: edge, idle: 0, cleared: true }), true);
  assert.equal(clearPays(DEFAULTS, { dropped: 80000, recache: edge + 1, idle: 0, cleared: true }), false);
  // on Opus 5.5 a read is a twentieth of an input token, so a written token needs 40 reads
  assert.equal(writeRatio('claude-opus-5-5'), 40);
  assert.equal(clearPays(DEFAULTS, { dropped: 80000, recache: edge, idle: 0, cleared: true, model: 'claude-opus-5-5' }), false);
  assert.equal(clearPays(DEFAULTS, { dropped: 80000, recache: edgeAt(80000, 'claude-opus-5-5'), idle: 0, cleared: true, model: 'claude-opus-5-5' }), true);
  // past the cache's hour the whole context is written again anyway, so a clear there costs nothing extra
  assert.equal(clearPays(DEFAULTS, { dropped: 80000, recache: 900000, idle: COLD_MS, cleared: true }), true);
  // one clear a session where the config says so
  assert.equal(clearPays({ ...DEFAULTS, clearDeep: false }, { dropped: 100000, recache: 20000, idle: 0, cleared: true }), false);
});

test('the deepest rung that repays is the one chosen, and none under the size floor', () => {
  const messages = [prompt('go')];
  for (let i = 0; i < 8; i++) messages.push(call(`t${i}`, 'Bash'), result(`t${i}`, big(120000)));
  messages.push(prompt('next'));
  const each = resultTokens(big(120000));
  // five eligible (the newest three stay): at a 300k context every rung repays, so the deepest is taken
  assert.equal(chooseDepth(messages, DEFAULTS, { tokens: 300000, idle: 0, cleared: false }), 5);
  // a context so large beside what any rung drops that none repays
  assert.equal(chooseDepth(messages, DEFAULTS, { tokens: 40 * 5 * each, idle: 0, cleared: false }), null);
  // nothing over the floor: nothing to choose
  assert.equal(chooseDepth(messages, { ...DEFAULTS, clearAtLeast: 6 * each }, { tokens: 300000, idle: 0, cleared: false }), null);
});

test('the keep list: the newest copy of a notes file, and of a file the person named, is never cleared', () => {
  const read = (id, file) => call(id, 'Read', { file_path: file });
  const messages = [
    prompt('track the posts'), read('a', '/w/learnings.md'), result('a', big(3000)), read('b', '/w/data.json'), result('b', big(3000)),
    read('c', '/w/stats.csv'), result('c', big(3000)), read('d', '/w/learnings.md'), result('d', big(3000)),
    prompt('what did stats.csv say?'), call('e'), result('e', big(500)),
  ];
  const keep = keptOf(messages);
  // the older copy of learnings.md (a) is not kept: the newest one (d) holds the file
  assert.deepEqual([...keep].sort(), ['c', 'd']);
  const c = clearPlan(messages, { keepMin: 0, keep });
  assert.deepEqual(Object.keys(c.replace).sort(), ['a', 'b']);
  // the ladder prices the same set the clear takes
  assert.equal(clearLadder(messages, { keepMin: 0, keep }).at(-1).depth, 2);
  // a result this door replaced is the cut: read again afterwards, the file is kept from then on
  const cut = messages.slice(0, 9).map(m => m.toolResults && c.replace[m.toolResults[0].tool_use_id] ? { ...m, toolResults: [{ ...m.toolResults[0], text: c.replace[m.toolResults[0].tool_use_id] }] } : m);
  const again = [...cut, prompt('go on'), read('f', '/w/data.json'), result('f', big(3000)), prompt('and now'), call('g'), result('g', big(500))];
  assert.equal(keptOf(again).has('f'), true);
});

// ---- the three questions the mod asks ----
const long = () => {
  const messages = [prompt('go')];
  for (let i = 0; i < 8; i++) messages.push(call(`t${i}`, 'Bash'), result(`t${i}`, big(120000)));
  messages.push(prompt('next'));
  return messages;
};

test('start: whether this door clears the session by itself', () => {
  const on = clearAnswer({ op: 'start', session: 's' }, { config: {} });
  assert.deepEqual(on, { auto: true, policy: stampOf(DEFAULTS) });
  assert.equal(clearAnswer({ op: 'start', session: 's', baseUrl: 'http://127.0.0.1:61056' }, { config: {} }).auto, false, 'the proxy serves it');
  assert.equal(clearAnswer({ op: 'start', session: 's', test: true }, { config: {} }).auto, false);
  assert.equal(clearAnswer({ op: 'start', session: 's' }, { config: { proxy: { desktop: false } } }).auto, false);
  assert.equal(clearAnswer({ op: 'start', session: 's' }, { config: { proxy: { holdout: 1 } } }).auto, false);
});

test('decide: nothing below the trigger, the deepest rung that repays past it, and when to ask again', () => {
  const messages = long();
  const below = clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 90000, messages: null }, { config: {} });
  assert.deepEqual(below, { clear: false, depth: null, askAt: DEFAULTS.trigger, hold: HOLD_GROWTH, policy: stampOf(DEFAULTS), reason: 'below-trigger' });
  const due = clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 300000, idle: 0, cleared: false, messages }, { config: {} });
  assert.deepEqual(due, { clear: true, depth: 5, askAt: DEFAULTS.trigger, hold: HOLD_GROWTH, policy: stampOf(DEFAULTS) });
  // an attempt that cleared nothing holds the next: the mod says how far, the answer says when to come back
  const held = clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 300000, holdUntil: 360000, messages }, { config: {} });
  assert.equal(held.clear, false);
  assert.equal(held.askAt, 360000);
  assert.equal(held.reason, 'held');
  // due, but the mod sent no conversation (its every-few-turns check): no clear is guessed, and it is asked for
  const blind = clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 300000, messages: null }, { config: {} });
  assert.equal(blind.clear, false);
  assert.equal(blind.askAt, DEFAULTS.trigger);
  assert.equal(blind.reason, 'unreadable');
  // a machine whose config moved the trigger is answered by the config in force now, not at the session's start
  assert.equal(clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 300000, messages }, { config: { proxy: { trigger: 400000 } } }).askAt, 400000);
  // a session this door does not clear by itself is told not to come back on the context alone
  for (const [ev, config, reason] of [[{ baseUrl: 'http://localhost:9' }, {}, 'proxied'], [{}, { proxy: { desktop: false } }, 'off'], [{}, { proxy: { holdout: 1 } }, 'holdout'], [{ test: true }, {}, 'test']]) {
    const a = clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 300000, messages, ...ev }, { config });
    assert.equal(a.clear, false, reason);
    assert.equal(a.askAt, NEVER, reason);
    assert.equal(a.reason, reason);
  }
});

test('decide by hand: anything at all to clear is enough, and a conversation that cannot be read may still try', () => {
  const some = [prompt('go'), call('a'), result('a', big(5000)), prompt('next'), call('b'), result('b', big(100)), call('c'), result('c', big(100)), call('d'), result('d', big(100)), prompt('more')];
  assert.equal(clearAnswer({ op: 'decide', from: 'manual', session: 's', messages: some }, { config: {} }).clear, true);
  assert.equal(clearAnswer({ op: 'decide', from: 'manual', session: 's', messages: [prompt('go'), call('a'), result('a', big(5000))] }, { config: {} }).clear, false);
  assert.equal(clearAnswer({ op: 'decide', from: 'manual', session: 's', messages: null }, { config: {} }).clear, true);
  // by hand it runs even where the session is held out or proxied: the person asked
  assert.equal(clearAnswer({ op: 'decide', from: 'manual', session: 's', messages: some, baseUrl: 'http://localhost:9' }, { config: { proxy: { holdout: 1 } } }).clear, true);
});

test('apply: the results to replace and what they come to, or the line the engine prints for a clear not made', () => {
  const messages = long();
  const a = clearAnswer({ op: 'apply', from: 'auto', session: 's', depth: 2, messages }, { config: {} });
  assert.deepEqual(Object.keys(a.replace).sort(), ['t3', 't4']);
  assert.equal(a.cleared, 2);
  assert.equal(a.tokens, 2 * resultTokens(big(120000)));
  assert.equal(a.policy, stampOf(DEFAULTS));
  assert.deepEqual(a.tools, [{ name: 'Bash', calls: 2, tokens: a.tokens }]);
  assert.equal(clearAnswer({ op: 'apply', from: 'manual', session: 's', depth: null, messages }, { config: {} }).cleared, 5, 'no depth is every eligible result');
  // under the size floor: by itself it waits and says why, by hand it runs
  const small = [prompt('go'), call('a'), result('a', big(5000)), prompt('next'), call('b'), result('b', big(100)), call('c'), result('c', big(100)), call('d'), result('d', big(100)), prompt('more')];
  assert.match(clearAnswer({ op: 'apply', from: 'auto', session: 's', depth: null, messages: small }, { config: {} }).skip, /tokens to clear, under 8,000$/);
  assert.equal(clearAnswer({ op: 'apply', from: 'manual', session: 's', depth: null, messages: small }, { config: {} }).cleared, 1);
  assert.equal(clearAnswer({ op: 'apply', from: 'auto', session: 's', messages: [prompt('go')] }, { config: {} }).skip, 'thinker-clear: nothing old enough to clear');
  assert.match(clearAnswer({ op: 'apply', from: 'auto', session: 's', messages: null }, { config: {} }).skip, /could not be read/);
});

test('`thinker hook clear` answers one line of JSON from any folder, and reads the machine config of the home it is given', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-clear-door-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-clear-cwd-'));   // no checkout: a desktop session's folder often is none
  const ask = ev => {
    const r = spawnSync(process.execPath, [CLI, 'hook', 'clear', '--client', 'claude', '--user'], { cwd, input: JSON.stringify(ev), encoding: 'utf8', env: { ...process.env, THINKER_HOME: home, THINKER_TEST: '1' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split('\n').length, 1, 'one line');
    return JSON.parse(r.stdout);
  };
  assert.deepEqual(ask({ op: 'start', session: 's' }), { auto: true, policy: stampOf(DEFAULTS) });
  const due = ask({ op: 'decide', from: 'auto', session: 's', tokens: 300000, messages: long() });
  assert.equal(due.clear, true);
  assert.equal(due.depth, 5);
  assert.equal(Object.keys(ask({ op: 'apply', from: 'auto', session: 's', depth: due.depth, messages: long() }).replace).length, 5);
  // the config in force when the question is asked, which is the point: a session never restarts to see it
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ proxy: { trigger: 500000 } }));
  const later = ask({ op: 'decide', from: 'auto', session: 's', tokens: 300000, messages: long() });
  assert.equal(later.clear, false);
  assert.equal(later.askAt, 500000);
  assert.equal(later.policy, `v${VERSION}-t500k-f8k-p${PAYBACK}-deep`);
  assert.deepEqual(Object.keys(ask({ op: 'nonsense' })), ['policy'], 'an unknown question is answered with nothing to do');
});
