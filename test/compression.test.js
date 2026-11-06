import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TURNS_AFTER, clearedBySession, clearingCostBySession, desktopClearRows, desktopClearingCost, compressionBlock, compressionDetail, compressionDir, compressionHeader, compressionSaving, compressionTools, markCompressionTurn, noteCompression, readCompression, shortTool } from '../src/compression.js';
import { cutActions } from '../src/proxy.js';
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
  // the cut names the ids it replaced, so the card reads them rather than re-deriving a keep window
  assert.deepEqual(cutActions(messages, ['a', 'b', 'c']), [{ name: 'Bash', calls: 2, tokens: 17_280 }, { name: 'Read', calls: 1, tokens: 1440 }], 'what the cut took, by tool');
  assert.deepEqual(cutActions(messages, []), [], 'nothing cut, nothing to show');
  assert.deepEqual(cutActions(null, ['a']), [{ name: 'tool', calls: 1, tokens: 0 }]);
  assert.deepEqual(cutActions([{ role: 'assistant', content: [{ type: 'tool_use', id: 'z' }] }], ['z']), [{ name: 'tool', calls: 1, tokens: 0 }], 'a use with no name or result still counts');
});

// The clearing's own cost: the calls after a clear write the prefix into the cache again, and until the figure
// was netted the band showed the saving without it (the owner's call, 2026-11-04). A session is charged only
// from its first clear onward, because the rewrites before one cannot be the clear's doing.
test('a session is charged for the prefix rewrites of the calls after its first clear, never before it', () => {
  const dir = tmp(), log = path.join(dir, 'proxy.log');
  const call = (over = {}) => JSON.stringify({
    at: '2026-11-04T10:00:00.000Z', op: 'proxy', session: 's1', model: 'claude-opus-5-5',
    cleared: 0, input: 0, read: 200_000, write: 0, ...over,
  });
  fs.writeFileSync(log, [
    // a rewrite before any clear: real, but nothing to do with the clearing
    call({ write: 150_000, read: 0 }),
    // the clearing request itself, and the rewrite on the call after it. A rewrite is a call whose write is
    // more than half its context (cutting.js:isRewrite), so these carry no cache read worth speaking of.
    call({ cleared: 80_000, write: 120_000, read: 0 }),
    call({ write: 100_000, read: 0 }),
    // a cache read on a long prompt: not a rewrite, so not charged
    call({ write: 0, read: 300_000 }),
    // another session that was never cleared is charged nothing at all
    call({ session: 's2', write: 180_000, read: 0 }),
  ].join('\n') + '\n');

  const costs = clearingCostBySession(log);
  assert.equal(costs.has('s2'), false, 'a session with no clear has no clearing cost');
  const s1 = costs.get('s1');
  assert.equal(s1.rewrites, 2, 'the clearing call and the one after it, not the one before');
  assert.equal(s1.write, 220_000);
  // Opus 5.5: $4/M input, a 1h cache write at twice that. 220k x $8/M = $1.76
  assert.ok(Math.abs(s1.usd - 1.76) < 0.01, `priced at the 1h write rate, got ${s1.usd}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the clearing cost honours the window, so a report of today never charges yesterday', () => {
  const dir = tmp(), log = path.join(dir, 'proxy.log');
  const call = (at, over = {}) => JSON.stringify({
    at, op: 'proxy', session: 's1', model: 'claude-opus-5-5', cleared: 0, input: 0, read: 0, write: 0, ...over,
  });
  fs.writeFileSync(log, [
    call('2026-11-01T10:00:00.000Z', { cleared: 80_000, write: 150_000 }),
    call('2026-11-04T10:00:00.000Z', { cleared: 80_000, write: 100_000 }),
  ].join('\n') + '\n');
  assert.equal(clearingCostBySession(log).get('s1').write, 250_000, 'the whole log by default');
  assert.equal(clearingCostBySession(log, { since: '2026-11-03T00:00:00.000Z' }).get('s1').write, 100_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Since the cut (0.2.22) no row carries `cleared`: thinker takes the results out itself and the row
// says so in `clientCut`. The record, what a pull request saved and what the rewrites after a clear
// cost all read the same accessor now, so the figure survives the change of door.
test('a cut row is a clear, and the record says the figure is thinker\'s own count', () => {
  const dir = tmp();
  const cut = row({ cleared: undefined, clearedUses: undefined, clientCut: { cut: 2, chars: 30000, tokens: 10800 } });
  const first = noteCompression(dir, cut);
  assert.equal(first.saved, 10800);
  assert.equal(first.uses, 2);
  assert.equal(first.estimated, true, 'never shown as a figure the API measured');
  const second = noteCompression(dir, { ...cut, at: 'b', clientCut: { cut: 2, chars: 30000, tokens: 10800 } });
  assert.equal(second.saved, 21600, 'every later call leaves those tokens out again');
  assert.equal(second.recent.at(-1).cleared, 10800);
  // nothing taken out is still not a clear
  assert.equal(noteCompression(dir, row({ cleared: undefined, clientCut: { cut: 0, chars: 0, tokens: 0 } })), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('what a pull request saved, and what its rewrites cost, both see a cut row', () => {
  const dir = tmp();
  const file = path.join(dir, 'proxy.jsonl');
  const rows = [
    { at: '2026-11-05T10:00:00Z', op: 'proxy', session: 's1', model: 'claude-opus-5-5', status: 200,
      clientCut: { cut: 2, chars: 30000, tokens: 10800 }, input: 10, read: 20000, write: 0 },
    // a call after the clear that wrote its prefix again: the cost side, charged from the first clear on
    { at: '2026-11-05T10:01:00Z', op: 'proxy', session: 's1', model: 'claude-opus-5-5', status: 200,
      input: 10, read: 1000, write: 150000 },
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  const saved = clearedBySession(file);
  assert.equal(saved.get('s1').cleared, 10800);
  assert.equal(saved.get('s1').requests, 1);
  const cost = clearingCostBySession(file, {});
  assert.equal(cost.get('s1').rewrites, 1, 'a rewrite after a cut is charged to the cut');
  assert.ok(cost.get('s1').usd > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a desktop session\'s record is charged its own count of rewrites, where the log has no rows for it', () => {
  const dir = tmp(), log = path.join(dir, 'proxy.jsonl'), records = path.join(dir, 'compression');
  fs.mkdirSync(records);
  // the proxy's own session: its rows carry the writes, and its record (which the proxy writes too) is left alone
  fs.writeFileSync(log, JSON.stringify({ at: '2026-11-06T10:00:00.000Z', op: 'proxy', session: 'p', model: 'claude-opus-5-5', cleared: 80_000, input: 0, read: 0, write: 120_000 }) + '\n');
  fs.writeFileSync(path.join(records, 'p.json'), JSON.stringify({ session: 'p', firstAt: 1, lastAt: Date.parse('2026-11-06T10:00:00Z'), requests: 1, saved: 80_000, uses: 1, recent: [], cost: { rewrites: 9, write: 9e6 }, model: 'claude-opus-5-5' }));
  // the desktop session: the mod's record alone, with the count the mod made and the model the API answered with
  fs.writeFileSync(path.join(records, 'd.json'), JSON.stringify({ session: 'd', firstAt: 1, lastAt: Date.parse('2026-11-06T11:00:00Z'), requests: 6, saved: 300_000, uses: 4, recent: [], cost: { rewrites: 2, write: 220_000 }, model: 'claude-opus-5-5' }));
  // a record from before the mod counted: a saving, and no cost figure rather than a free one
  fs.writeFileSync(path.join(records, 'old.json'), JSON.stringify({ session: 'old', firstAt: 1, lastAt: Date.parse('2026-11-06T11:00:00Z'), requests: 2, saved: 50_000, uses: 1, recent: [] }));
  // a record with no model: counted in tokens, named unpriced
  fs.writeFileSync(path.join(records, 'u.json'), JSON.stringify({ session: 'u', firstAt: 1, lastAt: Date.parse('2026-11-06T11:00:00Z'), requests: 2, saved: 50_000, uses: 1, recent: [], cost: { rewrites: 1, write: 100_000 } }));
  const costs = clearingCostBySession(log, { dir: records });
  assert.equal(costs.get('p').write, 120_000, 'the proxy\'s session is read from the log, never from the record beside it');
  const d = costs.get('d');
  assert.equal(d.rewrites, 2); assert.equal(d.write, 220_000); assert.equal(d.model, 'claude-opus-5-5');
  assert.ok(Math.abs(d.usd - 1.76) < 0.01, `priced at the 1h write rate as the proxy's rows are, got ${d.usd}`);
  assert.equal(costs.has('old'), false, 'no cost block, no cost figure');
  assert.equal(costs.get('u').usd, 0); assert.equal(costs.get('u').unpriced, 1);
  assert.deepEqual(clearingCostBySession(log, { dir: records, since: '2026-11-07T00:00:00.000Z' }).has('d'), false, 'the window holds for a record too');
  assert.equal(desktopClearingCost(records, { covered: new Set(['p']) }).has('p'), false);
  // the rows the ledger prices carry the record's model before the log's
  const rows = desktopClearRows(records, { covered: new Set(['p']), modelOf: () => 'claude-haiku-5-5' });
  assert.equal(rows.find(r => r.session === 'd').model, 'claude-opus-5-5', 'the record\'s own model');
  assert.equal(rows.find(r => r.session === 'u').model, 'claude-haiku-5-5', 'else the log\'s');
  fs.rmSync(dir, { recursive: true, force: true });
});
