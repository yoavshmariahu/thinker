import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inputSavings, requestsOf, messageHash, sections, lifetimeRequests, clearBoundaries, inputNoticeChanged } from '../src/cache-savings.js';
import { Store } from '../src/store.js';
import { summarize, sessionInputSavings, turnNotice, turnFooterMarkdown, servedFields } from '../src/usage.js';
import { cacheMetrics } from '../src/report.js';

const start = Date.parse('2026-01-01T00:00:00Z');
const note = id => `### [rule] A fact (id: ${id}, confidence 80%)\nA constraint.\n→ pointers: a.js`;
const hit = (id = 'n', tokens = 1000) => ({ id, tokens, noteTokens: 100, at: new Date(start).toISOString() });
const request = (i, notes) => ({ at: start + i * 1000, notes });
const req = (id, keep, tail, i = 1) => ({ type: 'api-request', id, keep, tail, timestamp: new Date(start + i * 1000).toISOString(), querySource: 'repl_main_thread' });
const response = id => ({ type: 'assistant', requestRef: id, message: { model: 'test', usage: { input_tokens: 1000 } } });
const blob = (hash, text) => ({ type: 'api-request-blob', hash, message: { role: 'user', content: [{ type: 'text', text }] } });

test('one hit grows across hundreds of requests, subtracting every carried copy', () => {
  const r = Array.from({ length: 607 }, (_, i) => request(i + 1, { n: 416 }));
  const out = inputSavings([hit('n', 21032)], r);
  assert.equal(out.tokens, (21032 - 416) * 607);
  assert.equal(out.covered, 1); assert.equal(out.requests, 607);
  r[0].notes.n *= 2;
  assert.equal(inputSavings([hit('n', 21032)], r).tokens, out.tokens - 416);
});

test('clearing stops the hypothetical read but still charges note retention; negatives survive', () => {
  const r = [request(1, { n: 600 }), request(2, { n: 600 })];
  const x = inputSavings([hit()], r, { clears: [r[1].at] });
  assert.equal(x.gross, 1000); assert.equal(x.tokens, -200);
  assert.equal(inputSavings([hit()], r, { until: r[0].at }).tokens, 400);
});

test('file overlap is unioned and old estimates share a conservative bucket', () => {
  const r = [request(1, { n: 100, m: 100 })];
  assert.equal(inputSavings([hit(), hit('m', 2000)], r).tokens, 1800);
  const ns = [{ ...hit(), files: [['a', 1000]] }, { ...hit('m', 2000), files: [['a', 1000], ['b', 1000]] }];
  assert.equal(inputSavings(ns, r).tokens, 1800);
  ns[0].files = [['c', 1000]];
  assert.equal(inputSavings(ns, r).tokens, 2800);
});

test('unsupported desktop transcripts and missing files use the one-read fallback without a login', () => {
  const r = lifetimeRequests('/nonexistent/desktop-session.jsonl');
  assert.deepEqual(inputSavings([hit()], r), { tokens: 900, gross: 0, overhead: 0, fallbackTokens: 900, covered: 0, fallback: 1, sessions: 0, requests: 0 });
});

test('request prefixes, compaction, branches, streaming and duplicate responses do not overcount', () => {
  const p = requestsOf([blob('a', note('n')), blob('b', 'summary'), req('1', 0, ['a']), response('1'), response('1'),
    req('2', 0, ['b'], 2), response('2'), { ...req('3', 1, [], 3), base: '1' }, response('3')]);
  assert.equal(p.invalid, 0);
  assert.deepEqual(p.requests.map(r => r.notes.has('n')), [true, false, true]);
  const failed = requestsOf([blob('a', note('n')), req('bad', 0, ['a'])]);
  assert.equal(failed.requests.length, 0);
  assert.equal(requestsOf([req('bad', 2, [])]).invalid, 1);
});

test('canonical hashes resolve ordinary messages; unknown bodies do not fabricate note presence', () => {
  const message = { role: 'user', content: [{ type: 'text', text: note('n') }] };
  const p = requestsOf([{ type: 'user', message }, req('1', 0, [messageHash(message), 'unresolved']), response('1')]);
  assert.equal(p.requests[0].notes.size, 1);
  assert.equal(p.requests[0].notes.get('n').tokens, sections(note('n'))[0].tokens);
  assert.equal(sections(JSON.stringify({ note: note('n') })).length, 0);
});

test('proxy cumulative echoes do not create extra boundaries, and unrelated sessions are isolated', () => {
  const r = [request(1, {}), request(2, {}), request(3, {})];
  const records = [1, 2, 3].map(i => ({ op: 'proxy', session: 's', at: new Date(start + i * 1000 + 100).toISOString(), cleared: 100, clearedUses: i === 3 ? 20 : 10 }));
  assert.deepEqual(clearBoundaries(records, 's', r), [r[0].at, r[2].at]);
  assert.deepEqual(clearBoundaries(records, 'other', r), []);
});

test('usage, report, and session footer use the same estimate; repeated serving stays one hit', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-lifetime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
  t.after(() => old == null ? delete process.env.CLAUDE_CONFIG_DIR : process.env.CLAUDE_CONFIG_DIR = old);
  const store = new Store(dir).init();
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), 's.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [blob('a', note('n')), req('1', 0, ['a']), response('1'), req('2', 1, [], 2), response('2')].map(r => JSON.stringify(r)).join('\n'));
  for (const op of ['orient', 'late']) store.log({ op, t: new Date(start).toISOString(), session: 's', served: ['n'], tokens: 100, est: [[1, 1000]] });
  store.log({ op: 'attest', session: 's', applied: [{ id: 'n', verdict: 'confirmed' }] });
  const u = summarize(store), c = cacheMetrics(store, { usage: u }), running = sessionInputSavings(store, 's', { transcript: file });
  assert.equal(u.saved.input.covered, 1);
  assert.equal(c.tokensSaved, 2000 - 2 * sections(note('n'))[0].tokens);
  assert.equal(running.tokens, c.tokensSaved);
  assert.match(turnNotice(dir, [], { input: running }), /estimated input saved this session: ~[\d,.]+k? tokens$/);
  assert.match(turnFooterMarkdown(dir, [{ id: 'n', body: '' }], { input: running }), /input saved this session/);
  assert.equal(c.coverage.hits, 1);
  // Appended requests are picked up; a missing final newline is allowed.
  fs.appendFileSync(file, '\n' + [req('3', 1, [], 3), response('3')].map(r => JSON.stringify(r)).join('\n'));
  assert.equal(lifetimeRequests(file).length, 3);
});

test('new serving records preserve file-level sizes and injection overhead for future deduplication', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sizing-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'x'.repeat(3600));
  const n = { id: 'n', body: 'body', deps: [{ path: 'a.js' }] };
  const e = servedFields({ repo: dir }, [n], note('n'));
  assert.deepEqual(e.est, [[1, 1000]]); assert.deepEqual(e.estFiles, [[['a.js', 1000]]]);
  assert.ok(e.noteTokens[0] >= sections(note('n'))[0].tokens);
});

test('a retried stop does not repeat an unchanged running total; sessions remain separate', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-input-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const value = { tokens: 1000, requests: 2 };
  assert.equal(inputNoticeChanged(dir, 'one', value), true);
  assert.equal(inputNoticeChanged(dir, 'one', value), false);
  assert.equal(inputNoticeChanged(dir, 'two', value), true);
  assert.equal(inputNoticeChanged(dir, 'one', { tokens: 2000, requests: 3 }), true);
});
