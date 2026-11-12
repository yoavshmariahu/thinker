// What the model read again after the clearing took it out, read out of the session's own transcript (rereads.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { parseTranscript } from '../src/transcripts.js';
import { rereadsOf, cutTimesFor, rereadCost } from '../src/rereads.js';
import { RESULT_TOKENS_PER_CHAR } from '../src/proxy.js';
import { CLEARING_OP } from '../src/compression.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-rr-')));
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
const T = s => `2026-11-12T10:${s}.000Z`;
const BIG = 'x'.repeat(2000), SMALL = 'ok';

// A session of three turns. Turn 1 reads a, b, c, d and runs a command; a cut opens turn 2, which reads a again
// (gone) and c (kept: one of the newest three); a cut opens turn 3, which reads a (back since turn 2) and d (gone now).
function session() {
  const lines = [];
  let n = 0;
  const prompt = (at, text) => lines.push({ type: 'user', timestamp: T(at), message: { role: 'user', content: text } });
  const call = (at, name, input, result) => {
    const id = `t${++n}`;
    lines.push({ type: 'assistant', timestamp: T(at), message: { model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', id, name, input }] } });
    lines.push({ type: 'user', timestamp: T(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
  };
  prompt('00:00', 'look at the files');
  call('00:05', 'Read', { file_path: '/r/a.py' }, BIG);
  call('00:10', 'Read', { file_path: '/r/b.py' }, BIG);
  call('00:15', 'Read', { file_path: '/r/c.py' }, BIG);
  call('00:20', 'Read', { file_path: '/r/d.py' }, BIG);
  call('00:25', 'Bash', { command: 'ls' }, SMALL);
  prompt('10:00', 'now fix a');
  call('10:05', 'Read', { file_path: '/r/a.py' }, BIG);
  call('10:10', 'Read', { file_path: '/r/c.py' }, BIG);
  prompt('20:00', 'and d');
  call('20:05', 'Read', { file_path: '/r/a.py' }, BIG);
  call('20:10', 'Read', { file_path: '/r/d.py' }, BIG);
  const f = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return Object.assign(parseTranscript(f), { file: f });
}

test('a Read of a file whose last read a cut took out is a re-read; a kept result, a small one and a read back in the prompt are not', () => {
  const p = session();
  assert.equal(p.calls.length, 9, 'one model call per tool call');
  const r = rereadsOf(p, [Date.parse(T('10:01')), Date.parse(T('20:01'))]);
  // turn 2's cut takes a and b (c, d and the command are the newest three); a is read again: one re-read. turn 3's cut
  // takes c and d (the command, a's second read and c's second read are the newest three); d is read again: a second.
  // a's third read follows a read that stayed in the prompt, so it is not one.
  assert.equal(r.reads, 2);
  const tokens = Math.round(BIG.length * RESULT_TOKENS_PER_CHAR);
  assert.equal(r.tokens, 2 * tokens);
  // the first re-read stays in the prompt for the three calls after it (it is one of the newest three at the next cut);
  // the second is the session's last call
  assert.equal(r.laterTokens, 3 * tokens);
});

test('a shell read counts too: cat, sed -n and head, behind a cd, by the path\'s tail; a piped cat is not a read', () => {
  const lines = [];
  let n = 0;
  const prompt = (at, text) => lines.push({ type: 'user', timestamp: T(at), message: { role: 'user', content: text } });
  const call = (at, name, input, result) => {
    const id = `t${++n}`;
    lines.push({ type: 'assistant', timestamp: T(at), message: { model: 'claude-opus-5-5', usage, content: [{ type: 'tool_use', id, name, input }] } });
    lines.push({ type: 'user', timestamp: T(at), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } });
  };
  prompt('00:00', 'look');
  call('00:05', 'Read', { file_path: '/r/src/a.py' }, BIG);
  call('00:10', 'Bash', { command: 'cat src/b.py' }, BIG);
  call('00:15', 'Bash', { command: 'cd /r && sed -n 1,80p src/c.py' }, BIG);
  call('00:20', 'Bash', { command: 'cat src/d.py | grep def' }, BIG);      // the model trimming for itself: not a read
  call('00:25', 'Bash', { command: 'ls' }, BIG);
  call('00:30', 'Bash', { command: 'ls -la' }, BIG);
  call('00:35', 'Bash', { command: 'git status' }, BIG);
  prompt('10:00', 'go on');
  call('10:05', 'Bash', { command: 'sed -n 10,20p /r/src/a.py' }, SMALL);   // a is gone: a re-read, priced at its own size
  call('10:10', 'Read', { file_path: '/r/src/b.py' }, BIG);                // b was read by cat src/b.py: a re-read
  call('10:15', 'Bash', { command: 'head -n 40 /r/src/c.py' }, BIG);       // c was read behind a cd: a re-read
  call('10:20', 'Bash', { command: 'cat src/d.py' }, BIG);                 // d's first read was piped: no read before, not one
  call('10:25', 'Bash', { command: 'cat src/d.py | wc -l' }, SMALL);       // piped: not a read
  const f = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const r = rereadsOf(parseTranscript(f), [Date.parse(T('10:01'))]);
  assert.equal(r.reads, 3);
  assert.equal(r.tokens, Math.round(SMALL.length * RESULT_TOKENS_PER_CHAR) + 2 * Math.round(BIG.length * RESULT_TOKENS_PER_CHAR));
});

test('no cut, no re-read; a cut before the first turn clears nothing', () => {
  const p = session();
  assert.deepEqual(rereadsOf(p, []), { reads: 0, tokens: 0, laterTokens: 0 });
  assert.deepEqual(rereadsOf(p, [Date.parse(T('00:00')) - 1]), { reads: 0, tokens: 0, laterTokens: 0 });
});

test('a cut named by the end of its turn (the log\'s mirror row) is the same cut as one named by its start', () => {
  const p = session();
  const byStart = rereadsOf(p, [Date.parse(T('10:01'))]);
  const byEnd = rereadsOf(p, [Date.parse(T('19:59'))]);
  assert.equal(byStart.reads, 1);
  assert.deepEqual(byEnd, byStart);
});

test('keepMin and the size floor are the policy\'s: a bigger keep protects more, a lower floor takes the small result too', () => {
  const p = session();
  const cuts = [Date.parse(T('10:01'))];
  assert.equal(rereadsOf(p, cuts, { keepMin: 4 }).reads, 1, 'four kept: a still goes');
  assert.equal(rereadsOf(p, cuts, { keepMin: 5 }).reads, 0, 'five kept: nothing of turn 1 goes');
  assert.equal(rereadsOf(p, cuts, { minChars: 10_000 }).reads, 0, 'a floor above every result: nothing goes');
});

test('cut times come from the proxy\'s rows, the mod\'s record and the log\'s mirror, once each, oldest first', () => {
  const home = tmp(), session = 'S1';
  const log = path.join(home, 'proxy.jsonl');
  const row = (at, extra) => JSON.stringify({ op: 'proxy', session, at, ...extra });
  fs.writeFileSync(log, [
    row(T('00:01'), { reason: 'below-trigger' }),
    row(T('10:01'), { clear: { tokens: 50_000 }, clientCut: { cut: 2, tokens: 50_000 }, cleared: 50_000 }),
    row(T('10:30'), { clientCut: { cut: 2, tokens: 50_000 }, cleared: 50_000 }),   // the same set left out again: no cut
    row(T('20:01'), { clientCut: { cut: 4, tokens: 90_000 }, cleared: 90_000 }),   // the set grew: a cut, with or without `clear`
    JSON.stringify({ op: 'proxy', session: 'other', at: T('15:00'), clear: {}, cleared: 10 }),
  ].join('\n') + '\n');
  const dir = path.join(home, 'state', 'compression');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.json`), JSON.stringify({ session, saved: 1, recent: [{ at: Date.parse(T('10:01')), cleared: 50_000, uses: 2 }, { at: Date.parse(T('30:01')), cleared: 20_000, uses: 1 }] }));
  const events = [
    { op: CLEARING_OP, session, t: T('39:00'), cleared: 160_000 },
    { op: CLEARING_OP, session, t: T('49:00'), cleared: 160_000 },   // the figure did not grow: no new cut
    { op: 'session', session, t: T('50:00') },
  ];
  assert.deepEqual(cutTimesFor({ session, proxyLog: log, dir, events }), ['10:01', '20:01', '30:01', '39:00'].map(s => Date.parse(T(s))));
  assert.deepEqual(cutTimesFor({ session: 'unknown', proxyLog: log, dir, events }), []);
  assert.deepEqual(cutTimesFor({ session: 'nobody', proxyLog: log, dir, events }), []);
});

test('a re-read costs its write once and its reads after at the cache-read rate', () => {
  const price = { input: 4, cacheRead: 0.2, cacheWrite1h: 8 };
  assert.equal(rereadCost({ reads: 1, tokens: 10_000, laterTokens: 100_000 }, price), (10_000 * 8 + 100_000 * 0.2) / 1e6);
  assert.equal(rereadCost({ reads: 0, tokens: 0, laterTokens: 0 }, price), 0);
  assert.equal(rereadCost(null, price), 0);
  assert.equal(rereadCost({ reads: 1, tokens: 10_000, laterTokens: 0 }, null), 0);
});

// The Stop hook counts them over the transcript so far and puts them on the session's row, which is where delivery.js
// reads them from; a session the proxy never cut carries nothing.
test('the Stop hook puts the re-reads on the session row, from the proxy\'s cut rows, and nothing on a session never cut', () => {
  const d = tmp(); execFileSync('git', ['init', '-q', d]);
  const store = new Store(d).init(), home = path.join(d, 'home');
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  const { file } = session();
  const log = path.join(home, 'state', 'proxy.jsonl');
  fs.writeFileSync(log, [
    JSON.stringify({ op: 'proxy', session: 'S1', at: T('10:01'), clear: { tokens: 1780 }, clientCut: { cut: 2, tokens: 1780 }, cleared: 1780 }),
    JSON.stringify({ op: 'proxy', session: 'S1', at: T('20:01'), clear: { tokens: 1780 }, clientCut: { cut: 4, tokens: 3560 }, cleared: 3560 }),
  ].join('\n') + '\n');
  const env = { ...process.env, HOME: d, THINKER_HOME: home, THINKER_TEST: '1', THINKER_HOOKS: 'on', THINKER_TELEMETRY: 'off', THINKER_LOG: 'local', THINKER_NO_LEARN: '1', THINKER_NO_BG_VERIFY: '1', THINKER_HOLDOUT: 'off', THINKER_CE: 'off' };
  const hook = ev => execFileSync('node', [CLI, 'hook', 'stop', '--client', 'claude', '--repo', d], { input: JSON.stringify(ev), encoding: 'utf8', env });
  hook({ session_id: 'S1', transcript_path: file, cwd: d });
  hook({ session_id: 'S2', transcript_path: file, cwd: d });
  const rows = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(r => r.op === 'session');
  const s1 = rows.find(r => r.session === 'S1'), s2 = rows.find(r => r.session === 'S2');
  const tokens = Math.round(BIG.length * RESULT_TOKENS_PER_CHAR);
  assert.deepEqual(s1.rereads, { reads: 2, tokens: 2 * tokens, laterTokens: 3 * tokens });
  assert.equal(s2.rereads, undefined, 'never cut: nothing to read again');
});
