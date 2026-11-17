// A cut takes the finished call's own text, not only its result (2026-11-14, the owner's call: "I want it as the
// default. I want full control of the rewrites and we should do it on the client side").
//
// #611 removed exactly this on 2026-11-04 for two reasons. One has expired and one has not. Expired: inputs bought
// 0.6% of what results buy -- measured on a session whose tool_use inputs were 2,800 chars, a file path each. On this
// machine today they are 3.1M chars over 8 sessions, 72% of it `Bash.command` heredocs and 12% `Write.content`, which
// is 13.3% of what a cut must rewrite. Standing: blanking the call taught the model a false history of itself -- in a
// 28-turn run it read its own emptied calls, reported it had been "making the tool calls without file paths", and
// began doing that. So the shape here is never a blank, and these tests are mostly about that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCut, cutCandidates, PROXY_DEFAULTS, RESULT_TOKENS_PER_CHAR } from '../src/proxy.js';
import { cutInput, inputPlaceholder, policyId, MIN_CHARS } from '../src/cutting.js';

const BIG = 'x'.repeat(12_000), CMD = 'npm test 2>&1 | tail -5\n' + 'y'.repeat(8_000);

// one prompt, n calls, each an assistant tool_use followed by its result
const job = (n, { input } = {}) => {
  const ms = [{ role: 'user', content: [{ type: 'text', text: 'fix the ticket' }] }];
  for (let i = 0; i < n; i++) ms.push(
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'z'.repeat(400), signature: 'sig' },
      { type: 'tool_use', id: `t${i}`, name: 'Bash', input: input || { command: CMD, description: 'Run the suite', timeout: 120 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: BIG }] });
  return ms;
};

test('the call keeps every key, every short value, and loses only a long body', () => {
  const r = cutInput({ command: CMD, description: 'Run the suite', timeout: 120, file_path: '/r/a.py' });
  assert.deepEqual(Object.keys(r.input), ['command', 'description', 'timeout', 'file_path'], 'no key is dropped');
  assert.equal(r.input.description, 'Run the suite', 'the short value the model reads to know what it did stays');
  assert.equal(r.input.timeout, 120, 'a non-string value is untouched');
  assert.equal(r.input.file_path, '/r/a.py', 'a path is short, so it stays -- the #611 failure was losing these');
  assert.equal(r.input.command, inputPlaceholder(CMD.length));
  assert.equal(r.chars, CMD.length, 'and the saving is the body alone');
});

test('a call whose input is all short values is never touched at all', () => {
  assert.equal(cutInput({ file_path: '/r/a.py', limit: 50 }), null);
  assert.equal(cutInput({ command: 'ls' }), null, `under the ${MIN_CHARS}-char floor`);
  assert.equal(cutInput(null), null);
  assert.equal(cutInput('a string'), null);
});

test('the placeholder tells the model the call was made in full and not to copy its shape', () => {
  const t = inputPlaceholder(9000);
  assert.match(t, /9000 chars/, 'says how much went');
  assert.match(t, /made the call in full/, 'so the model does not read a blank as its own doing');
  assert.match(t, /not how a call is written/, 'the #611 failure, addressed in the words themselves');
  assert.match(t, /Make it again if you need/, 'and the way back');
});

test('a cut takes the call beside the result, and only where the result goes too', () => {
  const messages = job(6);
  const on = applyCut(messages, ['t0', 't1'], { cutInputs: true });
  assert.equal(on.cut, 2, 'two results');
  assert.equal(on.chars, 2 * BIG.length);
  assert.equal(on.inputChars, 2 * CMD.length, 'and the two calls that produced them');
  assert.equal(on.tokens, Math.round((on.chars + on.inputChars) * RESULT_TOKENS_PER_CHAR), 'both halves are the saving');
  // the call of a result still in the prompt keeps its text: the pair is what the model reads
  const kept = on.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_use');
  assert.equal(kept.find(b => b.id === 't2').input.command, CMD, 'an uncut call is untouched');
  assert.match(kept.find(b => b.id === 't0').input.command, /removed this finished call/);
  // thinking is never touched -- the one edit that broke the API in October
  const think = on.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'thinking');
  assert.equal(think.length, 6, 'every thinking block survives');
  assert.ok(think.every(b => b.thinking === 'z'.repeat(400) && b.signature === 'sig'), 'byte for byte');
});

test('off, the bytes are exactly what they were before this shipped', () => {
  const messages = job(6);
  const off = applyCut(messages, ['t0', 't1'], { cutInputs: false });
  assert.equal(off.inputChars, 0);
  assert.equal(off.tokens, Math.round(off.chars * RESULT_TOKENS_PER_CHAR), 'the results alone, as #611 left it');
  const calls = off.messages.flatMap(m => (Array.isArray(m.content) ? m.content : [])).filter(b => b.type === 'tool_use');
  assert.ok(calls.every(b => b.input.command === CMD), 'no call is rewritten');
});

test('on by default, and reachable by flag, environment and machine config', async () => {
  assert.equal(PROXY_DEFAULTS.cutInputs, true, 'the owner asked for it as the default');
  const { proxyConfig } = await import('../src/proxy.js');
  assert.equal(proxyConfig({}, {}).cutInputs, true);
  assert.equal(proxyConfig({ 'no-cut-inputs': true }, {}).cutInputs, false, 'a flag turns it off');
  assert.equal(proxyConfig({}, { THINKER_PROXY_CUT_INPUTS: 'off' }).cutInputs, false);
  const { serviceArgs } = await import('../src/proxy-service.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const home = fs.default.mkdtempSync(path.default.join(os.default.tmpdir(), 'thinker-ci-'));
  fs.default.writeFileSync(path.default.join(home, 'config.json'), JSON.stringify({ proxy: { cutInputs: false } }));
  assert.ok(serviceArgs(home, { port: 4000 }).includes('--no-cut-inputs'), 'the service carries a machine that said no');
});

test('the saving names the policy that made it, so a figure with the calls in it is never pooled with one without', () => {
  const base = { trigger: 140_000, clearAtLeast: 8_000 };
  assert.equal(policyId({ ...base, cutInputs: true }), 'r6-t140k-f8k-p25-deep+in');
  assert.equal(policyId({ ...base }), 'r6-t140k-f8k-p25-deep');
});

test('the price of a cut is measured on the bytes it will send, calls included', () => {
  // a second prompt closes the turn: only a finished turn's results are ever offered
  const messages = [...job(14), { role: 'user', content: [{ type: 'text', text: 'and the next one' }] }];
  const ids = { cut: [], keepMin: 3 };
  const withIn = cutCandidates(messages, { ...ids, cutInputs: true });
  const without = cutCandidates(messages, { ...ids, cutInputs: false });
  assert.deepEqual(withIn.ids, without.ids, 'the same results are eligible either way');
  // the rewritten tail is smaller when the calls go with the results, which is the whole economic point
  const deep = a => a.steps[a.steps.length - 1];
  assert.ok(deep(withIn).recache < deep(without).recache,
    `calls out means less to rewrite (${deep(withIn).recache} < ${deep(without).recache})`);
  assert.ok(deep(withIn).tokens > deep(without).tokens, 'and more taken out');
});
