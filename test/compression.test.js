import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TURNS_AFTER, compressionBlock, compressionDetail, compressionDir, compressionHeader, compressionSaving, compressionTools, markCompressionTurn, noteCompression, readCompression, shortTool } from '../src/compression.js';
import { clearedActions } from '../src/proxy.js';
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
  assert.deepEqual({ ...s1, recent: s1.recent.length }, { session: 's1', firstAt: 'a', lastAt: 'b', requests: 2, saved: 2500, uses: 5, recent: 2 });
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

const ACTIONS = [{ name: 'Bash', calls: 41, tokens: 1_100_000 }, { name: 'Read', calls: 18, tokens: 380_000 }];

test('the tokens add up but the breakdown does not: it is what is cleared now', () => {
  const dir = tmp();
  noteCompression(dir, row({ at: 'a', cleared: 200_000 }), { actions: ACTIONS });
  noteCompression(dir, row({ at: 'b', cleared: 210_000 }), { actions: [{ name: 'Bash', calls: 44, tokens: 1_200_000 }] });
  const s = readCompression(dir, 's1');
  assert.equal(s.saved, 410_000, 'each request leaves those tokens out again');
  assert.deepEqual(s.tools, [{ name: 'Bash', calls: 44, tokens: 1_200_000 }], 'the latest set, never a sum of the sets');
  noteCompression(dir, row({ at: 'c', cleared: 220_000 }));
  assert.deepEqual(readCompression(dir, 's1').tools, [{ name: 'Bash', calls: 44, tokens: 1_200_000 }], 'a request with no breakdown keeps the last one');
  assert.equal(compressionTools(readCompression(dir, 's1'), formatTokens), 'Bash ×44 (1.2M)');
  assert.equal(compressionTools({}, formatTokens), '');
  assert.equal(shortTool('mcp__artemis__get_experiment'), 'artemis/get_experiment', 'an MCP name as the person reads it');
  assert.equal(shortTool('mcp__claude-in-chrome__read_console_messages'), 'claude-in-chrome/read_con…', 'cut when still too long');
  assert.equal(shortTool('Bash'), 'Bash');
  assert.equal(shortTool(undefined), 'tool');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only the last clears are kept, so the state cannot grow without end', () => {
  const dir = tmp();
  for (let i = 0; i < 40; i++) noteCompression(dir, row({ at: `t${i}`, cleared: 1000 }));
  const s = readCompression(dir, 's1');
  assert.equal(s.requests, 40);
  assert.equal(s.recent.length, 8);
  assert.equal(s.recent.at(-1).at, 't39');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the agent is told once a session, and only once the saving is due', () => {
  const dir = tmp();
  for (let i = 0; i < 3; i++) noteCompression(dir, row({ at: `2026-10-29T09:5${i}:00.000Z`, cleared: 210_000, clearedUses: 60 }), { actions: ACTIONS });
  assert.equal(compressionBlock(dir, 's1', 4, formatTokens), '', 'the turn it first shows');
  for (let turn = 5; turn < 4 + TURNS_AFTER; turn++) assert.equal(compressionBlock(dir, 's1', turn, formatTokens), '', `turn ${turn}`);
  const block = compressionBlock(dir, 's1', 4 + TURNS_AFTER, formatTokens);
  assert.match(block, /^<thinker-compression>\n/);
  assert.match(block, /~630k tokens left out of the prompt, added up over the 3 calls it has cleared, 180 tool results/);
  assert.match(block, /by the action that fetched it: Bash ×41 \(1\.1M\), Read ×18 \(380k\)/);
  assert.match(block, /The last 3 clears: 09:50 210k out, 60 results;/);
  assert.match(block, /<\/thinker-compression>$/);
  assert.equal(readCompression(dir, 's1').told, true);
  assert.equal(compressionBlock(dir, 's1', 4 + TURNS_AFTER + 1, formatTokens), '', 'never a second time in the session');
  assert.equal(readCompression(dir, 's1').turns, undefined, 'the turn count is not stored');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a session with no clear is told nothing', () => {
  const dir = tmp();
  assert.equal(compressionBlock(dir, 's1', 9, formatTokens), '');
  assert.equal(compressionDetail(null, formatTokens), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cleared actions are the tool uses outside the kept window, biggest first', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(40_000) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'Read' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'y'.repeat(4000) }] }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'Bash' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'z'.repeat(8000) }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'd', name: 'Grep' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'd', content: 'w'.repeat(100) }] },
  ];
  assert.deepEqual(clearedActions(messages, 1), [{ name: 'Bash', calls: 2, tokens: 17_280 }, { name: 'Read', calls: 1, tokens: 1440 }], 'the newest tool use stays');
  assert.deepEqual(clearedActions(messages, 99), [], 'nothing is cleared when everything is kept');
  assert.deepEqual(clearedActions(null, 1), []);
  assert.deepEqual(clearedActions([{ role: 'assistant', content: [{ type: 'tool_use', id: 'z' }] }], 0), [{ name: 'tool', calls: 1, tokens: 0 }], 'a use with no name or result still counts');
});
