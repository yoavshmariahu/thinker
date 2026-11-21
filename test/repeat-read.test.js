// The pointer: a read whose bytes the model already has is answered with the copy's whereabouts, not the file
// (delegate.js, "the same file, read again"). What is held to here is every guard, since the guards are the rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { delegateTool, denial, readMemo, rangeKey, contentHash, repeatOf, noteLanded, notePointed, forgetReads, DELEGATE_DEFAULTS } from '../src/delegate.js';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-repeat-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// ~4,100 tokens by default: over `repeatMin` (2,000) and under the handoff's `threshold` (8,000), so a read of
// it goes through the hook untouched and the pointer is the only thing that can fire
const file = (dir, name, lines = 200) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, Array.from({ length: lines }, (_, i) => `def f${i}(x):\n    return x + ${i}\n`).join(''));
  return f;
};
const cfg = { ...DELEGATE_DEFAULTS, handoff: false, fallback: false, holdout: 0, repeatHoldout: 0 };
const session = 'sess';
const harness = (d, over = {}) => {
  const rows = []; const st = {};
  const state = { update: fn => fn(st) };
  const call = (input, { prompt = 'p1', tool = 'Read', ...rest } = {}) =>
    delegateTool({ ev: { tool_name: tool, tool_input: input, prompt_id: prompt, ...rest }, state, session, cwd: d, cfg: { ...cfg, ...over }, log: r => rows.push(r), run: async () => ({ report: 'a report', model: 'claude-haiku-5-5', ms: 1 }) });
  return { rows, st, call, repeats: () => rows.filter(r => r.op === 'repeat') };
};
const reason = out => JSON.parse(out).hookSpecificOutput.permissionDecisionReason;

test('the pointer fires on the identical second read, and says where the copy is', async t => {
  const d = tmp(t); const f = file(d, 'core.py');
  const h = harness(d);
  assert.equal(await h.call({ file_path: f }), null, 'the first read goes through');
  const out = await h.call({ file_path: f });
  assert.ok(out, 'the second read of the same bytes is answered');
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reason(out), /already have core\.py in your context/);
  assert.match(reason(out), /has not changed since/);
  assert.match(reason(out), /offset and limit/);
  assert.match(reason(out), /Nothing has gone wrong/);
  const [row] = h.repeats();
  assert.equal(row.fired, true); assert.equal(row.held, false); assert.equal(row.via, 'settings');
  assert.deepEqual(row.files, ['core.py']);
  assert.ok(row.tokens > 2000, String(row.tokens));
  // the firing is kept for the end of the turn, apart from the handoffs
  assert.equal(h.st.repeated.length, 1);
  assert.equal(h.st.delegated, undefined);
});

test('a file that changed between the reads is read again', async t => {
  const d = tmp(t); const f = file(d, 'core.py');
  const h = harness(d);
  await h.call({ file_path: f });
  fs.appendFileSync(f, 'def later(): pass\n');
  assert.equal(await h.call({ file_path: f }), null, 'other bytes, so the model reads them');
  assert.equal(h.repeats().length, 0);
  // and the new bytes are what is remembered: the read after them repeats
  assert.ok(await h.call({ file_path: f }));
});

test('a model that asks again in the same turn gets the bytes, and the row says so', async t => {
  const d = tmp(t); const f = file(d, 'core.py');
  const h = harness(d);
  await h.call({ file_path: f });
  assert.ok(await h.call({ file_path: f }), 'pointed once');
  assert.equal(await h.call({ file_path: f }), null, 'and never twice in one turn');
  assert.equal(h.repeats().at(-1).declined, 'pointed');
  // the next turn may point at it again: the copy is still in the context
  assert.ok(await h.call({ file_path: f }, { prompt: 'p2' }));
});

test('under repeatMin the read goes through, and the row says which floor stopped it', async t => {
  const d = tmp(t); const small = file(d, 'small.py', 40);
  const h = harness(d);
  await h.call({ file_path: small });
  assert.equal(await h.call({ file_path: small }), null);
  assert.equal(h.repeats().at(-1).declined, 'below-floor');
  assert.ok(h.repeats().at(-1).tokens < 2000);
});

test('a read the handoff denied never landed, so no copy of it is ever pointed at', async t => {
  const d = tmp(t); const big = file(d, 'big.py', 3000);
  const h = harness(d, { handoff: false, fallback: true });
  assert.match(reason(await h.call({ file_path: big })), /through a claude-haiku-5-5 subagent/, 'the handoff answered it');
  // the model has never seen these bytes, so the read after it is the handoff's business again and never the pointer's
  assert.match(reason(await h.call({ file_path: big }, { prompt: 'p2' })), /through a claude-haiku-5-5 subagent/);
  assert.equal(h.repeats().length, 0);
});

test('a file the lead insisted on and read whole itself is pointed at the next time', async t => {
  const d = tmp(t); const big = file(d, 'big.py', 3000);
  const h = harness(d, { handoff: true });
  assert.match(reason(await h.call({ file_path: big })), /goes to your own Explore subagent/);
  // the handoff never denies the same file twice in a turn, so the lead that insists reads it (decide: `handed`)
  assert.equal(await h.call({ file_path: big }), null, 'the lead gets the file it insisted on');
  // and now it has the bytes: the read after that is answered with its own copy
  assert.match(reason(await h.call({ file_path: big })), /already have big\.py in your context/);
});

test('a held-out session logs the pointer it would have sent and reads as before', async t => {
  const d = tmp(t); const f = file(d, 'core.py');
  const h = harness(d, { repeatHoldout: 1 });
  await h.call({ file_path: f });
  assert.equal(await h.call({ file_path: f }), null);
  const row = h.repeats().at(-1);
  assert.equal(row.held, true); assert.equal(row.fired, false);
  assert.equal(h.st.repeated, undefined, 'nothing kept out, so nothing to price');
});

test('a compaction takes the copy out of the context, and the memory with it', async t => {
  const d = tmp(t); const f = file(d, 'core.py');
  const h = harness(d);
  let compactions = () => ({ count: 0, offset: 10 });
  const call = (input, prompt = 'p1') => delegateTool({ ev: { tool_name: 'Read', tool_input: input, prompt_id: prompt, transcript_path: 'x' }, state: { update: fn => fn(h.st) }, session, cwd: d, cfg, log: r => h.rows.push(r), compactions: o => compactions(o) });
  await call({ file_path: f });
  compactions = () => ({ count: 1, offset: 20 });
  assert.equal(await call({ file_path: f }), null, 'the copy is gone: the read goes through');
  assert.equal(h.repeats().at(-1).declined, 'compacted');
  // and that read is the copy the new context holds: the pointer may name it, never the one before the compaction
  compactions = () => ({ count: 0, offset: 20 });
  assert.ok(await call({ file_path: f }, 'p2'), 'the read after the compaction is pointed at');
});

test("the person's own files are never answered for", async t => {
  const d = tmp(t); const notes = file(d, 'NOTES.md');
  const h = harness(d, { keepPatterns: ['*.md'] });
  await h.call({ file_path: notes });
  assert.equal(await h.call({ file_path: notes }), null);
  assert.equal(h.repeats().length, 0);
});

test('a shell read of part of a file is never a copy of the whole one', async t => {
  const d = tmp(t); const big = file(d, 'big.py', 3000);
  const h = harness(d, { handoff: false, fallback: false, threshold: 1e9 });
  // fifty lines through the shell, then the whole file: the model has fifty lines, so it reads it
  assert.equal(await h.call({ command: `sed -n '1,50p' ${big}` }, { tool: 'Bash' }), null);
  assert.equal(await h.call({ command: `cat ${big}` }, { tool: 'Bash' }), null, 'it has not seen the file');
  assert.equal(h.repeats().length, 0);
  // now it has: the same whole-file read again is answered, and so is a Read of it, which is the same bytes
  assert.ok(await h.call({ command: `cat ${big}` }, { tool: 'Bash' }));
  assert.ok(await h.call({ file_path: big }, { prompt: 'p2' }), 'a cat and a whole Read are one copy');
  // and the same shell range twice is a repeat of itself
  const again = harness(d);
  assert.equal(await again.call({ command: `sed -n '1,900p' ${big}` }, { tool: 'Bash' }), null);
  assert.ok(await again.call({ command: `sed -n '1,900p' ${big}` }, { tool: 'Bash' }));
  // the keys behind it: a whole-file shell read is the whole file, a ranged one is its own command
  assert.equal(rangeKey({ command: 'cat x.py' }), '0|0');
  assert.equal(rangeKey({ file_path: 'x.py' }), '0|0');
  assert.equal(rangeKey({ command: "sed -n '1,50p'  x.py" }), "cmd:sed -n '1,50p' x.py");
  assert.notEqual(rangeKey({ command: "sed -n '1,50p' x.py" }), rangeKey({ command: "sed -n '60,109p' x.py" }), 'fifty lines are not fifty other lines');
  assert.equal(rangeKey({ offset: 1, limit: 50 }), '1|50');
});

test('a range is its own read: the same range repeats, another range goes through', async t => {
  const d = tmp(t); const big = file(d, 'big.py', 3000);
  const h = harness(d);
  const range = { file_path: big, offset: 1, limit: 1200 };
  await h.call(range);
  assert.ok(await h.call(range), 'the same lines again');
  assert.equal(await h.call({ ...range, offset: 1400 }), null, 'other lines are not a repeat');
});

test("a subagent's reads are its own context: neither remembered nor pointed at", async t => {
  const d = tmp(t); const f = file(d, 'core.py');
  const h = harness(d);
  const sub = { agent_type: 'Explore' };
  await h.call({ file_path: f }, sub);
  assert.equal(await h.call({ file_path: f }, sub), null);
  assert.equal(h.repeats().length, 0);
  assert.equal(h.st.reads, undefined);
});

test('the pieces: the memo keys a read, the hash is the bytes, the memory answers', async t => {
  const d = tmp(t); const f = file(d, 'core.py');
  const memo = readMemo({ tool_input: { file_path: f } }, { files: [f], tokens: 4000 }, { cfg });
  assert.ok(memo.key.includes(f)); assert.equal(memo.tokens, 4000);
  assert.equal(memo.hash, contentHash([f]));
  fs.appendFileSync(f, 'x\n');
  assert.notEqual(memo.hash, contentHash([f]), 'other bytes, other hash');
  assert.equal(contentHash([path.join(d, 'gone.py')]), null, 'a file that cannot be read has no hash');
  assert.equal(contentHash([f], { max: 10 }), null, 'and a file too large to hash is never pointed at');
  const st = {};
  assert.equal(repeatOf(st, { ...memo, prompt: 'p1', cfg }).fire, false, 'nothing remembered yet');
  noteLanded(st, memo);
  assert.equal(repeatOf(st, { ...memo, prompt: 'p1', cfg }).fire, true);
  notePointed(st, { key: memo.key, prompt: 'p1' });
  assert.equal(repeatOf(st, { ...memo, prompt: 'p1', cfg }).declined, 'pointed');
  assert.equal(repeatOf(st, { ...memo, prompt: 'p2', cfg }).fire, true, 'a new turn may point again');
  forgetReads(st);
  assert.equal(repeatOf(st, { ...memo, prompt: 'p2', cfg }).fire, false, 'the compaction took it');
  // the memory is capped, and it is the newest reads that are kept
  for (let i = 0; i < 60; i++) noteLanded(st, { key: `k${i}`, hash: 'h', tokens: 3000 });
  assert.equal(Object.keys(st.reads.landed).length, 40);
  assert.ok(st.reads.landed.k59 && !st.reads.landed.k0);
});

test('the words are the mechanism: the pointer never reads as a malfunction', () => {
  const words = reason(denial({ kind: 'repeat', files: ['/repo/src/a.js'], cwd: '/repo' }));
  assert.match(words, /^thinker stopped this call/);
  assert.match(words, /src\/a\.js/);
  assert.doesNotMatch(words, /error|failed|denied/i);
});
