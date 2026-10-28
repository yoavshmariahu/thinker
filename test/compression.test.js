import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TURNS_AFTER, compressionDir, compressionHeader, compressionSaving, markCompressionTurn, noteCompression, readCompression } from '../src/compression.js';
import { compressionNotice, formatTokens } from '../src/usage.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-compression-'));
const row = (over = {}) => ({ at: '2026-10-29T10:00:00.000Z', op: 'proxy', session: 's1', cleared: 1000, clearedUses: 2, ...over });

test('the state directory sits beside the proxy log', () => {
  assert.equal(compressionDir('/home/.thinker'), path.join('/home/.thinker', 'state', 'compression'));
});

test('only a request the server cleared something from is recorded', () => {
  const dir = tmp();
  assert.equal(noteCompression(dir, row({ cleared: 0 })), null, 'a request under the trigger is not a clear');
  assert.equal(noteCompression(dir, row({ op: 'proxy-error' })), null);
  assert.equal(noteCompression(dir, row({ session: null })), null);
  assert.equal(noteCompression(null, row()), null);
  assert.equal(readCompression(dir, 's1'), null, 'nothing written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('what the server left out of each prompt is added up, per session', () => {
  const dir = tmp();
  noteCompression(dir, row({ at: 'a', cleared: 1000, clearedUses: 2 }));
  noteCompression(dir, row({ at: 'b', cleared: 1500, clearedUses: 3 }));
  noteCompression(dir, row({ at: 'c', session: 's2', cleared: 70 }));
  const s1 = readCompression(dir, 's1');
  assert.deepEqual({ ...s1 }, { session: 's1', firstAt: 'a', lastAt: 'b', requests: 2, saved: 2500, uses: 5 });
  assert.equal(readCompression(dir, 's2').saved, 70, 'sessions are kept apart');
  assert.equal(readCompression(dir, 'none'), null);
  assert.equal(readCompression(dir, 'unknown'), null, 'an unnamed session is no session');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session id that is a path is not one', () => {
  const dir = tmp();
  noteCompression(dir, row({ session: '../../escape' }));
  assert.deepEqual(fs.readdirSync(dir), ['.._.._escape.json']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing is shown until the clearing has had TURNS_AFTER turns to pay for itself', () => {
  const dir = tmp();
  noteCompression(dir, row({ cleared: 400_000, clearedUses: 12 }));
  assert.equal(compressionSaving(markCompressionTurn(dir, 's1', 7)), null, 'the turn the clear first shows');
  assert.equal(readCompression(dir, 's1').firstTurn, 7, 'the first turn that saw it is remembered');
  for (let turn = 8; turn < 7 + TURNS_AFTER; turn++) assert.equal(compressionSaving(markCompressionTurn(dir, 's1', turn)), null, `turn ${turn}`);
  const due = compressionSaving(markCompressionTurn(dir, 's1', 7 + TURNS_AFTER));
  assert.deepEqual(due, { saved: 400_000, requests: 1, uses: 12, turns: TURNS_AFTER });
  assert.equal(readCompression(dir, 's1').firstTurn, 7, 'the wait is not restarted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session the proxy cleared nothing from says nothing', () => {
  const dir = tmp();
  assert.equal(markCompressionTurn(dir, 's1', 9), null);
  assert.equal(compressionSaving(null), null);
  assert.equal(compressionSaving({ saved: 0, requests: 3, turns: 9 }), null);
  assert.equal(compressionNotice(null), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the notice says what the card says', () => {
  const saving = { saved: 2_500_000, requests: 40, uses: 300, turns: TURNS_AFTER };
  assert.equal(compressionHeader(saving, formatTokens), 'context cleared · ~2.5M tokens not re-read over 40 calls');
  assert.equal(compressionNotice({ ...saving }), '🗜 thinker: context cleared · ~2.5M tokens not re-read over 40 calls');
  assert.equal(compressionHeader({ saved: 900, requests: 1 }, formatTokens), 'context cleared · ~900 tokens not re-read over 1 call');
});
