import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { ASK_LENGTH, lengthAsked, askAnswerLength } from '../src/setup/length-ask.js';
import { answerStyle, pinnedStyleLines } from '../src/profile.js';

function tmpRepo(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-length-'));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.thinker'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify(config));
  const store = new Store(dir); store.init();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return store;
}
const tty = { isTTY: true };

// The options carry the measured numbers: asked for N, answers land at about 1.1 N (20 real prompts, 2026-11-21).
test('the options are the measured numbers, and "full detail" sets nothing', () => {
  assert.deepEqual(ASK_LENGTH.map(o => o.value), [60, 120, null]);
  // the note must promise what the number PRODUCES, not what it asks for: answers land about a tenth over
  for (const o of ASK_LENGTH.filter(o => o.value)) {
    const promised = Number(o.note.match(/(\d+)\s*words/)?.[1]);
    assert.ok(promised > o.value && promised <= o.value * 1.3,
      `"${o.note}" should promise a little more than the ${o.value} it asks for, got ${promised}`);
    assert.match(o.note, /no tables/, 'and the table half of the rule, which is the half that actually holds');
  }
});

test('asked once: the answer is written to the machine, and a declined ask is remembered too', async t => {
  const store = tmpRepo(t);
  const cfg = {};
  const update = (home, fn) => Object.assign(cfg, fn({ ...cfg }));
  const said = [];
  const r = await askAnswerLength({ store, out: l => said.push(l), stdin: tty, stdout: tty,
    select: async () => ASK_LENGTH[0], update, asked: false });
  assert.equal(r.words, 60);
  assert.equal(cfg.style.answerWords, 60, 'the number is on the machine config, so it follows the person between repositories');
  assert.equal(cfg.style.asked, true);
  assert.ok(said.some(l => l.includes(pinnedStyleLines({ words: 60 })[0])), 'it says back the line it will serve');

  // "full detail" records that the question was put, and sets no number: the compile keeps the subject
  const cfg2 = {};
  const r2 = await askAnswerLength({ store, out: () => {}, stdin: tty, stdout: tty,
    select: async () => ASK_LENGTH[2], update: (h, fn) => Object.assign(cfg2, fn({ ...cfg2 })), asked: false });
  assert.equal(r2.words, null);
  assert.equal(cfg2.style.asked, true, 'asked and declined is still asked');
  assert.ok(!('answerWords' in cfg2.style), 'and no number is invented');
});

test('it never asks twice, never without a terminal, and escaping leaves it to be asked again', async t => {
  const store = tmpRepo(t);
  let calls = 0;
  const select = async () => { calls++; return ASK_LENGTH[0]; };
  assert.equal((await askAnswerLength({ store, out: () => {}, stdin: tty, stdout: tty, select, asked: true })).asked, false);
  assert.equal((await askAnswerLength({ store, out: () => {}, stdin: {}, stdout: {}, select, asked: false })).asked, false,
    'an installer with no terminal asks nothing rather than hanging');
  assert.equal(calls, 0, 'neither case reached the menu');
  const cfg = {};
  const r = await askAnswerLength({ store, out: () => {}, stdin: tty, stdout: tty,
    select: async () => null, update: (h, fn) => Object.assign(cfg, fn({ ...cfg })), asked: false });
  assert.equal(r.asked, false);
  assert.deepEqual(cfg, {}, 'escaping the menu records nothing, so the question comes back next time');
});

test('a repository that already has a number counts as asked', t => {
  assert.equal(lengthAsked(tmpRepo(t, { style: { answerWords: 90 } })), true);
  assert.equal(answerStyle(tmpRepo(t, { style: { answerWords: 90 } })).words, 90);
});
