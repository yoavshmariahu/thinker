import { tmp, home, repo } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findSessions, parseTranscript } from '../src/transcripts.js';
import { sessionUsage } from '../src/tool-outputs.js';
import { Store } from '../src/store.js';
import { codexSessionHarness } from '../src/harness-codex.js';
import { weeklySavings } from '../src/accountant.js';

const event = (type, payload, n) => ({ type, payload, timestamp: new Date(Date.now() - 60_000 + n * 1000).toISOString() });
function transcript(rows) {
  const now = new Date(), dir = path.join(home, '.codex/sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${path.basename(tmp('session'))}.jsonl`);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
const usage = n => ({ input_tokens: n, cached_input_tokens: n / 2, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: n + 10 });

test('a chat started elsewhere splits measured usage between visited repositories, once per response', () => {
  const a = repo(), b = repo(), outside = tmp('desktop');
  const rows = [event('session_meta', { cwd: outside }, 0)];
  for (const [i, cwd] of [outside, a, b, a].entries()) {
    rows.push(event('turn_context', { cwd, turn_id: `t${i}`, model: 'gpt-5' }, i * 5 + 1));
    rows.push(event('response_item', { type: 'message', role: 'user', content: [{ text: `work ${i}` }] }, i * 5 + 2));
    rows.push(event('token_usage_record', { response_id: `r${i}`, turn_id: `t${i}`, usage: usage(100 * (i + 1)) }, i * 5 + 3));
    rows.push(rows.at(-1)); // duplicated delivery is not another call
    rows.push(event('event_msg', { type: 'token_count', info: { last_token_usage: usage(100 * (i + 1)) } }, i * 5 + 4));
  }
  const file = transcript(rows), whole = parseTranscript(file);
  assert.equal(whole.stats.inputTokens, 1000);
  const parsed = [outside, a, b].map(r => parseTranscript(file, { repos: [r] }));
  assert.deepEqual(parsed.map(p => p.stats.inputTokens), [100, 600, 300]);
  assert.equal(parsed.reduce((n, p) => n + p.stats.totalTokens, 0), whole.stats.totalTokens);
  assert.equal(parsed.reduce((n, p) => n + p.carried.prompts, 0), whole.carried.prompts);
  assert.equal(parsed[1].events.filter(e => e.t === 'prompt').length, 2);
  for (const [r, expected] of [[a, 600], [b, 300]]) {
    const sessions = findSessions(r).filter(s => s.file === file);
    assert.equal(sessions.length, 1);
    const store = new Store(r); store.init();
    // A pre-existing unscoped cache must be recomputed, including on a second read.
    sessionUsage(store, sessions.map(({ repos, ...s }) => s));
    assert.equal(sessionUsage(store, sessions)[0].usage.input, expected);
    assert.equal(sessionUsage(store, sessions)[0].usage.input, expected);
    assert.equal(codexSessionHarness(file, [r]).calls, r === a ? 2 : 1);
  }
  const sessions = findSessions(a).filter(s => s.file === file);
  const compression = [0, 1, 2, 3].map(i => ({ session: sessions[0].session, at: rows.find(r => r.type === 'token_usage_record' && r.payload.turn_id === `t${i}`).timestamp, status: 200, cleared: 100, model: 'gpt-5' }));
  const series = weeklySavings({ columns: [{ t: Date.now() - 120_000 }], now: Date.now(), config: {}, compression, sessions });
  assert.equal(series[0].cells[0].events, 2, 'clearing rows belong only to this workspace');
});

test('legacy call records split too; a cumulative-only total cannot be assigned to both workspaces', () => {
  const a = repo(), b = repo();
  const file = transcript([
    event('session_meta', { cwd: a }, 0),
    event('event_msg', { type: 'token_count', info: { last_token_usage: usage(100) } }, 1),
    event('turn_context', { cwd: b }, 2),
    event('event_msg', { type: 'token_count', info: { last_token_usage: usage(200) } }, 3),
  ]);
  assert.equal(parseTranscript(file, { repos: [a] }).stats.inputTokens, 100);
  assert.equal(parseTranscript(file, { repos: [b] }).stats.inputTokens, 200);
  const totalOnly = transcript([
    event('session_meta', { cwd: a }, 0), event('turn_context', { cwd: b }, 1),
    event('event_msg', { type: 'token_count', info: { total_token_usage: usage(300) } }, 2),
  ]);
  assert.equal(parseTranscript(totalOnly).stats.inputTokens, 300);
  assert.equal(parseTranscript(totalOnly, { repos: [a] }).stats.inputTokens, null);
  assert.equal(parseTranscript(totalOnly, { repos: [b] }).stats.inputTokens, null);
});

test('late usage keeps its turn workspace, nested repositories do not count in their parent', () => {
  const a = repo(), b = path.join(a, 'nested'); fs.mkdirSync(b); fs.mkdirSync(path.join(b, '.git'));
  const file = transcript([
    event('session_meta', { cwd: a }, 0),
    event('turn_context', { cwd: a, turn_id: 'a' }, 1),
    event('turn_context', { cwd: b, turn_id: 'b' }, 2),
    event('token_usage_record', { turn_id: 'a', response_id: 'a', usage: usage(100) }, 3),
    event('token_usage_record', { turn_id: 'b', response_id: 'b', usage: usage(200) }, 4),
  ]);
  assert.equal(parseTranscript(file, { repos: [a] }).stats.inputTokens, 100);
  assert.equal(parseTranscript(file, { repos: [b] }).stats.inputTokens, 200);
  assert.equal(parseTranscript(file, { repos: [a, b] }).stats.inputTokens, 300);
});

test('explicit tool working directories track work even when the chat workspace stays elsewhere', () => {
  const outside = tmp('desktop'), a = repo(), b = repo();
  const file = transcript([
    event('session_meta', { cwd: outside }, 0),
    event('turn_context', { cwd: outside, turn_id: 'one', model: 'gpt-5' }, 1),
    event('response_item', { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'pwd', workdir: a }) }, 2),
    event('token_usage_record', { turn_id: 'one', response_id: 'a', usage: usage(100) }, 3),
    event('response_item', { type: 'custom_tool_call', name: 'functions.exec', input: `text(await tools.exec_command({cmd:"pwd",workdir:${JSON.stringify(b)}}));` }, 4),
    event('token_usage_record', { turn_id: 'one', response_id: 'b', usage: usage(200) }, 5),
    event('response_item', { type: 'message', role: 'assistant', content: [{ text: `We should visit ${a}` }] }, 6),
    event('token_usage_record', { turn_id: 'one', response_id: 'b2', usage: usage(300) }, 7),
  ]);
  assert.ok(findSessions(a).some(s => s.file === file));
  assert.ok(findSessions(b).some(s => s.file === file));
  assert.equal(parseTranscript(file, { repos: [a] }).stats.inputTokens, 100);
  assert.equal(parseTranscript(file, { repos: [b] }).stats.inputTokens, 500);
  assert.equal(parseTranscript(file, { repos: [b] }).model, 'gpt-5');
});


test('quoted tool examples do not change the working directory', () => {
  const a = repo(), b = repo();
  const file = transcript([
    event('session_meta', { cwd: a }, 0),
    event('response_item', { type: 'custom_tool_call', name: 'functions.exec', input: `text(${JSON.stringify(`tools.exec_command({workdir:${JSON.stringify(b)}})`)});` }, 1),
    event('token_usage_record', { response_id: 'a', usage: usage(100) }, 2),
  ]);
  assert.equal(parseTranscript(file, { repos: [a] }).stats.inputTokens, 100);
  assert.equal(parseTranscript(file, { repos: [b] }).stats.inputTokens, null);
  assert.ok(!findSessions(b).some(s => s.file === file));
});
