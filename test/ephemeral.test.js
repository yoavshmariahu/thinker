// Superseded page states (src/ephemeral.js): what is replaced, when, and that the cached prefix never moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEphemeral, ephemeralConfig, ephemeralId, pagePlaceholder, MAX_MARKERS, EPHEMERAL_DEFAULTS } from '../src/ephemeral.js';
import { transformRequest, proxyConfig, PROXY_DEFAULTS } from '../src/proxy.js';
import { policyId } from '../src/cutting.js';

const SNAP = n => `### Ran Playwright code\nawait page.click('#b${n}');\n### Page state\n- Page URL: http://shop.test/p/${n}\n- Page Title: Product ${n}\n- Page Snapshot:\n` + `- row ${n} [ref=e${n}]\n`.repeat(400);
const use = (id, name = 'mcp__playwright__browser_click', input = { ref: 'e1' }) => ({ role: 'assistant', content: [{ type: 'text', text: `step ${id}` }, { type: 'tool_use', id, name, input }] });
const result = (id, text, extra = {}) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], ...extra }] });

// The agent's side of a browser loop: the whole conversation resent each call, its one marker on the newest block.
function conversation(steps, { between = null } = {}) {
  const messages = [{ role: 'user', content: 'Find the cheapest kettle.' }];
  for (let n = 1; n <= steps; n++) {
    messages.push(use(`t${n}`), result(`t${n}`, SNAP(n)));
    if (between && n < steps) messages.push(...between(n));
  }
  const last = messages[messages.length - 1];
  last.content = last.content.map((b, k) => (k === last.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral', ttl: '1h' } } : b));
  return { system: [{ type: 'text', text: 'You browse.', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages };
}
const markers = j => { let n = (j.system || []).filter(b => b.cache_control).length; for (const m of j.messages) if (Array.isArray(m.content)) n += m.content.filter(b => b.cache_control).length; return n; };
// the prompt up to and including a block, with the markers taken out: what the cache key is made of
const prefix = (messages, at) => JSON.stringify(messages.slice(0, at.message + 1).map((m, i) => {
  const blocks = (Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]).map(({ cache_control, ...b }) => b);
  return { role: m.role, content: i === at.message ? blocks.slice(0, at.block + 1) : blocks };
}));

test('off by default, and the setting is read whole', () => {
  assert.equal(PROXY_DEFAULTS.ephemeral, false);
  assert.equal(ephemeralConfig(false), null);
  assert.equal(ephemeralConfig({ enabled: false }), null);
  assert.deepEqual(ephemeralConfig(true), EPHEMERAL_DEFAULTS);
  assert.deepEqual(ephemeralConfig('mcp__x__*, shot').tools, ['mcp__x__*', 'shot']);
  assert.equal(ephemeralConfig({ keep: 0 }).keep, 1, 'the live page is never taken');
  assert.equal(proxyConfig({}, {}).ephemeral, false);
  assert.equal(proxyConfig({ ephemeral: true, 'ephemeral-keep': '2' }, {}).ephemeral.keep, 2);
  assert.equal(proxyConfig({ ephemeral: true, 'ephemeral-tail': 'bare' }, {}).ephemeral.tail, 'bare');
  assert.deepEqual(proxyConfig({ ephemeral: 'browser_*,shot' }, {}).ephemeral.tools, ['browser_*', 'shot']);
  assert.equal(proxyConfig({ 'no-ephemeral': true, ephemeral: undefined }, {}).ephemeral, false);
  // no environment variable turns it on: a knob nobody asked for ships in the product
  assert.equal(proxyConfig({}, { THINKER_PROXY_EPHEMERAL: 'on' }).ephemeral, false);
});

test('a saving made beside the rule names it', () => {
  const base = { ...PROXY_DEFAULTS };
  assert.ok(!policyId(base).includes('eph'));
  assert.ok(policyId({ ...base, ephemeral: true }).endsWith('+eph1'));
  assert.equal(ephemeralId({ keep: 2, tail: 'bare' }), '+eph2b');
});

test('nothing to say about a conversation with no browser results', () => {
  const j = { messages: [{ role: 'user', content: 'hi' }, use('a', 'Read'), result('a', 'x'.repeat(9000))] };
  assert.equal(applyEphemeral(j, true), null);
});

test('the first page is left whole and anchored; the request is not mutated', () => {
  const j = conversation(1), before = JSON.stringify(j);
  const r = applyEphemeral(j, true);
  assert.equal(JSON.stringify(j), before);
  assert.equal(r.results, 0);
  assert.equal(r.live, 1);
  // the anchor is the tool_use that asked for the page: the block just before the live result
  assert.deepEqual(r.anchor, { message: 1, block: 1 });
  assert.ok(r.messages[1].content[1].cache_control, 'the marker is on the block before the live page');
  assert.deepEqual(r.messages[1].content[1].cache_control, { type: 'ephemeral', ttl: '1h' }, 'at the TTL the agent chose');
  assert.ok(r.messages[2].content[0].cache_control, "the agent's own marker stays");
  assert.ok(r.changed);
});

test('each page is replaced when the next arrives, and what was sent before the anchor never changes', () => {
  let prev = null;
  for (let steps = 1; steps <= 8; steps++) {
    const j = conversation(steps);
    const r = applyEphemeral(j, true);
    assert.equal(r.results, steps - 1, `${steps} pages: all but the live one are replaced`);
    assert.equal(r.live, 1);
    assert.ok(markers({ ...j, messages: r.messages }) <= MAX_MARKERS);
    const liveText = r.messages[r.messages.length - 1].content[0].content[0].text;
    assert.equal(liveText, SNAP(steps), 'the live page is whole');
    if (prev) {
      // the entry the last request wrote at its anchor is a prefix of this one, byte for byte
      assert.equal(prefix(r.messages, prev.anchor), prefix(prev.messages, prev.anchor), `step ${steps}: the anchored prefix moved`);
      // and it lies within the lookback of this request's anchor
      const blocksBetween = r.messages.slice(prev.anchor.message, r.anchor.message + 1).reduce((n, m) => n + m.content.length, 0);
      assert.ok(blocksBetween < 20);
    }
    prev = { anchor: r.anchor, messages: r.messages };
  }
  const r = applyEphemeral(conversation(8), true);
  const old = r.messages[2].content[0].content[0].text;
  assert.ok(old.startsWith('### Ran Playwright code'), 'the first lines of the result stay');
  assert.ok(old.includes('Page URL: http://shop.test/p/1'));
  assert.match(old, /thinker removed the rest of this page state after use: \d+ chars/);
  assert.ok(old.length < 900);
  assert.ok(r.tokens > 7 * 2500, 'the saving is what left the prompt');
});

test('keep leaves that many pages whole', () => {
  const r = applyEphemeral(conversation(5), { keep: 2 });
  assert.equal(r.results, 3);
  assert.equal(r.live, 2);
  assert.equal(r.messages[8].content[0].content[0].text, SNAP(4));
  // the anchor sits before the older of the two
  assert.deepEqual(r.anchor, { message: 7, block: 1 });
});

test('a page with a lot of work after it is not replaced: that work would be written again', () => {
  // forty file reads between two pages -- the mixed session the rule must not touch
  const reads = n => Array.from({ length: 4 }, (_, x) => [use(`r${n}-${x}`, 'Read', { file_path: `/f${x}` }), result(`r${n}-${x}`, 'code\n'.repeat(3000))]).flat();
  const j = conversation(3, { between: reads });
  const r = applyEphemeral(j, true);
  assert.equal(r.results, 0);
  assert.equal(r.skipped, 2);
  // the live page is the newest thing, so it is still anchored
  assert.ok(r.anchor);
  // and once work piles up behind the live page too, the anchor goes: it can no longer be superseded for free
  const k = conversation(1);
  k.messages.push(...reads(9));
  const s = applyEphemeral(k, true);
  assert.equal(s.anchor, null);
  assert.equal(s.changed, false);
  assert.equal(s.messages, k.messages);
});

test('small results and other tools are neither pages nor replaced', () => {
  const j = conversation(2);
  j.messages.splice(3, 0, use('w', 'mcp__playwright__browser_wait_for'), result('w', 'Waited 1s'), use('g', 'Grep'), result('g', 'x'.repeat(5000)));
  const r = applyEphemeral(j, true);
  // the 5k search between the two pages is less than the page that leaves, so the page is still replaced
  assert.equal(r.results, 1);
  assert.equal(r.live, 1, 'the wait is not a page');
  assert.equal(r.messages[4].content[0].content[0].text, 'Waited 1s');
  assert.equal(r.messages[6].content[0].content[0].text, 'x'.repeat(5000), "another tool's result is the cut's to judge");
});

test('a page read from the file a browser server wrote it to is a page state too', () => {
  const read = (id, file) => use(id, 'Read', { file_path: file });
  const j = { messages: [{ role: 'user', content: 'go' },
    use('n1', 'mcp__playwright__browser_navigate', { url: 'http://x/1' }), result('n1', '### Snapshot\n- [Snapshot](.playwright-mcp/page-1.yml)'),
    read('r1', '/work/s1/.playwright-mcp/page-1.yml'), result('r1', SNAP(1)),
    use('n2', 'mcp__playwright__browser_click'), result('n2', '### Snapshot\n- [Snapshot](.playwright-mcp/page-2.yml)'),
    read('r2', '/work/s1/.playwright-mcp/page-2.yml'), result('r2', SNAP(2)),
    read('r3', '/work/s1/notes.md'), result('r3', 'x'.repeat(3000))] };
  const r = applyEphemeral(j, true);
  assert.equal(r.results, 1);
  assert.match(r.messages[4].content[0].content[0].text, /thinker removed the rest of this page state/);
  assert.equal(r.messages[8].content[0].content[0].text, SNAP(2), 'the newest page file is whole');
  assert.equal(r.messages[10].content[0].content[0].text, 'x'.repeat(3000), 'any other file is not a page');
  assert.equal(applyEphemeral(j, { files: [] }), null, 'with no file patterns, a read is a read');
});

test('four markers already: an older one of the agent gives way, never its last, and never a fifth', () => {
  const j = conversation(3);
  j.system.push({ type: 'text', text: 'More.', cache_control: { type: 'ephemeral', ttl: '1h' } });
  j.messages[0] = { role: 'user', content: [{ type: 'text', text: 'Find the cheapest kettle.', cache_control: { type: 'ephemeral', ttl: '1h' } }] };
  assert.equal(markers(j), 4);
  const r = applyEphemeral(j, true);
  const sent = { ...j, messages: r.messages };
  assert.equal(markers(sent), 4);
  assert.equal(r.anchor.moved, 1);
  assert.ok(!r.messages[0].content[0].cache_control, 'the oldest message marker moved');
  assert.ok(r.messages[r.messages.length - 1].content[0].cache_control, 'the newest stays');
  // nothing left to move: the anchor is refused and the row says so
  const full = conversation(2);
  full.system.push({ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } });
  const t = applyEphemeral(full, true);
  assert.equal(t.anchor, null);
  assert.equal(t.reason, 'no-marker-room');
  assert.ok(markers({ ...full, messages: t.messages }) <= 4);
});

test("tail 'bare' takes the agent's marker off the live page while it is the newest message", () => {
  const r = applyEphemeral(conversation(3), { tail: 'bare' });
  assert.ok(r.anchor.bare);
  assert.ok(!r.messages[r.messages.length - 1].content[0].cache_control);
  assert.ok(r.messages[r.messages.length - 2].content[1].cache_control);
});

test('a screenshot is a page state too, and leaves as one', () => {
  const j = conversation(1);
  const shot = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: [{ type: 'text', text: 'Took the screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(5000) } }] }] };
  j.messages.splice(1, 0, use('s1', 'mcp__playwright__browser_take_screenshot'), shot);
  const r = applyEphemeral(j, true);
  assert.equal(r.results, 1);
  assert.equal(r.images, 1);
  const text = r.messages[2].content[0].content;
  assert.equal(text.length, 1);
  assert.match(text[0].text, /and 1 image/);
});

test('the words say when it was seen and what to do now', () => {
  const w = pagePlaceholder('head', 1234);
  assert.match(w, /^head\n\[thinker removed/);
  assert.match(w, /You saw it in full at the time/);
  assert.match(w, /Take a new snapshot/);
});

test('through the proxy: the body carries the replacement, the row says what it did, and a refusal can stand it down', () => {
  const j = { model: 'claude-sonnet-5-5', ...conversation(4) };
  const body = Buffer.from(JSON.stringify(j));
  const off = transformRequest('POST', '/v1/messages', {}, body, { ...PROXY_DEFAULTS });
  assert.equal(off.body, body, 'off: the bytes as they came');
  assert.equal(off.ephemeral, undefined);
  const on = transformRequest('POST', '/v1/messages', {}, body, { ...PROXY_DEFAULTS, ephemeral: ephemeralConfig(true) });
  assert.equal(on.injected, true);
  assert.equal(on.ephemeral.results, 3);
  assert.equal(on.ephemeral.live, 1);
  assert.ok(on.ephemeral.tokens > 0);
  const sent = JSON.parse(on.body);
  assert.match(sent.messages[2].content[0].content[0].text, /thinker removed the rest of this page state/);
  assert.equal(sent.messages[8].content[0].content[0].text, SNAP(4));
  // held out: untouched
  const held = transformRequest('POST', '/v1/messages', { 'x-session-id': 's1' }, body, { ...PROXY_DEFAULTS, holdout: 1, ephemeral: ephemeralConfig(true) });
  assert.equal(held.body, body);
});
