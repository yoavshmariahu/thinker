// A cut takes a finished call's screenshot too, and leaves the path it was saved at (2026-11-15, the owner's call:
// "remove screenshots from direct context but leave the filepaths where they can be reached if needed").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyCut, cutCandidates, saveCutImages, imagePathIn, wireChars, measurePrompt, PROXY_DEFAULTS, RESULT_TOKENS_PER_CHAR, TOKENS_PER_CHAR, resultTokens } from '../src/proxy.js';
import { imagePlaceholder, policyId, placeholder } from '../src/cutting.js';

// a PNG as far as its header goes: 1280x800, which the API charges 1280*800/750 = 1365 tokens for
const png = (w = 1280, h = 800, bytes = 60_000) => {
  const b = Buffer.alloc(bytes, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b);
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const SHOT = png(), DATA = SHOT.toString('base64'), TOKENS = 1365;
const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: DATA } };
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cut-images-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// one prompt, n browser steps, each a screenshot beside one short line, then a second prompt
const browse = (n, { text = 'Screenshot captured' } = {}) => {
  const ms = [{ role: 'user', content: [{ type: 'text', text: 'check the signup page' }] }];
  for (let i = 0; i < n; i++) ms.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `s${i}`, name: 'mcp__browser__screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `s${i}`, content: [{ type: 'text', text }, image] }] });
  ms.push({ role: 'user', content: [{ type: 'text', text: 'now the login page' }] });
  return ms;
};

test('a screenshot is counted at what it costs, never at its base64', () => {
  const m = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's0', content: [image] }] };
  assert.ok(JSON.stringify(m).length > 80_000, 'the bytes on the wire');
  const chars = wireChars(m);
  assert.ok(Math.abs(chars * TOKENS_PER_CHAR - TOKENS) < 80, `${Math.round(chars * TOKENS_PER_CHAR)} tokens, not ${Math.round(JSON.stringify(m).length * TOKENS_PER_CHAR)}`);
  // so ten screenshots do not put a short conversation past the trigger by themselves
  const j = { messages: browse(10) };
  assert.ok(measurePrompt(PROXY_DEFAULTS, j).prompt < 20_000, String(measurePrompt(PROXY_DEFAULTS, j).prompt));
  assert.equal(wireChars({ a: 'text', n: 1 }), JSON.stringify({ a: 'text', n: 1 }).length, 'and text is counted as it always was');
});

test('a screenshot-only result is cut where there is somewhere to save it, and only there', t => {
  const dir = tmp(t), imagePath = imagePathIn(dir), ms = browse(6);
  // nowhere to save: the result has 19 characters of text and is left alone, as before
  assert.equal(cutCandidates(ms, { keepMin: 3 }).ids.length, 0);
  const cand = cutCandidates(ms, { keepMin: 3, imagePath });
  assert.deepEqual([...cand.ids].sort(), ['s0', 's1', 's2'], 'all but the newest three');
  assert.ok(Math.abs(cand.tokens - 3 * TOKENS) < 10, `priced at the images' tokens: ${cand.tokens}`);
});

test('the placeholder names the file, the short line stays, and the image is gone from the prompt', t => {
  const dir = tmp(t), imagePath = imagePathIn(dir), ms = browse(6);
  assert.equal(saveCutImages(ms, ['s0', 's1'], imagePath), true);
  const out = applyCut(ms, ['s0', 's1'], { imagePath });
  assert.equal(out.cut, 2);
  assert.ok(Math.abs(out.tokens - 2 * TOKENS) < 10, String(out.tokens));
  const r0 = out.messages[2].content[0];
  assert.deepEqual(r0.content.map(b => b.type), ['text'], 'no image block is left');
  const f = path.join(dir, 's0-0.png');
  assert.equal(r0.content[0].text, `Screenshot captured\n${imagePlaceholder([f])}`);
  assert.match(r0.content[0].text, /Read the file if you need to look again/);
  assert.ok(fs.readFileSync(f).equals(SHOT), 'the file is the screenshot, byte for byte');
  // a result that was not cut keeps its image
  assert.deepEqual(out.messages[6].content[0].content.map(b => b.type), ['text', 'image']);
  assert.ok(JSON.stringify(out.messages).length < JSON.stringify(ms).length - 150_000, 'two screenshots lighter on the wire');
  // the agent resends the conversation on every call: the same image again is not written again
  const before = fs.statSync(f).mtimeMs;
  assert.equal(saveCutImages(ms, ['s0', 's1'], imagePath), true);
  assert.equal(fs.statSync(f).mtimeMs, before);
});

test('a long result with a screenshot loses both, and says where the picture went', t => {
  const dir = tmp(t), imagePath = imagePathIn(dir), long = 'p'.repeat(5000), ms = browse(5, { text: long });
  const cand = cutCandidates(ms, { keepMin: 3, imagePath });
  assert.ok(Math.abs(cand.tokens - 2 * (resultTokens(long) + TOKENS)) < 10, 'the text and the image are both the saving');
  saveCutImages(ms, cand.ids, imagePath);
  const text = applyCut(ms, cand.ids, { imagePath }).messages[2].content[0].content[0].text;
  assert.equal(text, `${placeholder(5000)}\n${imagePlaceholder([path.join(dir, 's0-0.png')])}`);
});

test('an image that cannot be saved stays in the prompt', t => {
  const dir = tmp(t), blocked = path.join(dir, 'file'); fs.writeFileSync(blocked, 'x');
  const imagePath = imagePathIn(path.join(blocked, 'images'));     // a directory that cannot be made
  assert.equal(saveCutImages(browse(4), ['s0'], imagePath), false);
});

test('the policy names it: a saving made with screenshots cut is never pooled with one made without', () => {
  const base = { trigger: 140000, clearAtLeast: 8000 };
  assert.equal(policyId({ ...base, cutInputs: true, cutImages: true }), 'r7-t140k-f8k-p25-deep+in+img');
  assert.equal(policyId({ ...base, cutInputs: true }), 'r7-t140k-f8k-p25-deep+in');
  assert.equal(PROXY_DEFAULTS.cutImages, true);
});
