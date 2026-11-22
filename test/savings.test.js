// How the savings of context cutting and delegation are counted: priced, netted and added up in src/accountant.js
// and nowhere else. Every dollar figure here is built from prices.js, so a change of rate moves the test with the
// product and a change of rule breaks it.
import { tmp } from './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addSaving, clearedBySession, clearingCostBySession, computeSavings, delegationBySession, delegationSavings,
  netOf, readSavings, rereadCost, savingsLine, savingsValue, sessionSaving, sumSavings, weeklySavings,
  RECENT_DAYS,
} from '../src/accountant.js';
import { clearingRows, loggedClearing, noteCompression } from '../src/compression.js';
import { costOf, costOfInputSavings, listPrice } from '../src/prices.js';
import { rereadsOf } from '../src/rereads.js';
import { RESULT_TOKENS_PER_CHAR } from '../src/proxy.js';
import { sessionKey } from '../src/usage.js';

const MODEL = 'claude-opus-5-5', SUB = 'claude-haiku-5-5';
const P = listPrice(MODEL), PS = listPrice(SUB);
const DAY = 86400_000;
const NOW = new Date(2026, 10, 20, 12, 0, 0).getTime();   // midday where the test runs: a day starts at local midnight
const WEEK = [{ t: Date.parse('2026-11-16T00:00:00Z'), prompts: 10, pricedPrompts: 10 }];
const iso = t => new Date(t).toISOString();
const at = (m, s = 0) => Date.parse(`2026-11-18T10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`);
// a request of the session, so the clearing's rows are counted for a session the log knows
const known = (session = 's') => ({ op: 'request', session, t: iso(at(0)) });
const row = (x = {}) => ({ op: 'proxy', status: 200, session: 's', model: MODEL, at: iso(at(1)), cleared: 1000, ...x });
const series = (opts = {}) => weeklySavings({ columns: WEEK, now: NOW, config: {}, compression: [], events: [], ...opts });
const cleared = opts => series(opts)[0].cells[0];
const file = (name, lines) => {
  const f = path.join(tmp(name), 'proxy.jsonl');
  fs.writeFileSync(f, lines.map(r => JSON.stringify(r)).join('\n') + '\n');
  return f;
};
// what a number of tokens of each kind costs the lead's model, by the rules the product prices with: a cache read, a
// cache write after a clear (always the hour's rate), and a saved token as the kind of input it would have been
const readsCost = n => n * P.cacheRead / 1e6;
const writesCost = n => n * P.cacheWrite1h / 1e6;
const savedCost = kinds => costOfInputSavings(kinds, P);
// dollars are sums of products: equal to within rounding, however the product orders the arithmetic
const near = (got, want, why) => assert.ok(Math.abs(got - want) < 1e-9, `${why || 'dollars'}: ${got} against ${want}`);

test('the net is what was saved less the rewrites and the re-reads a cut caused, for one session and for any sum of them', () => {
  const rereads = { reads: 2, tokens: 10_000, laterTokens: 40_000 };
  const clearing = { usd: readsCost(10_000_000), pricedTokens: 10_000_000, coldUsd: 0 };
  const rewrite = { usd: writesCost(20_000) };
  const paid = sessionSaving({ cleared: 10_000_000, clearing, rewrite, rereads, model: MODEL, config: {} });
  assert.equal(paid.priced, true);
  assert.equal(paid.saved, clearing.usd);
  assert.equal(paid.rewrite, rewrite.usd);
  near(paid.reread, writesCost(10_000) + readsCost(40_000), 'what the re-reads cost');
  assert.ok(Math.abs(paid.net - (paid.saved - paid.rewrite - paid.reread)) < 1e-12, 'the net is the three parts');
  assert.ok(paid.net > 0);
  // the same cut on a session whose requests went on to write their whole context again
  const lost = sessionSaving({ cleared: 10_000_000, clearing, rewrite: { usd: writesCost(400_000) }, rereads, model: MODEL, config: {} });
  assert.ok(lost.net < 0, 'a cut that cost more than it saved reads as a loss, never as zero');
  // a pull request holds a share of a session, and the net of a sum is the sum of the nets
  const group = addSaving({ saved: 0, rewrite: 0, reread: 0 }, paid, 0.5);
  assert.equal(group.saved, paid.saved / 2);
  assert.ok(Math.abs(sumSavings([paid, lost]).net - (netOf(paid) + netOf(lost))) < 1e-12);
});

test('a cleared token is worth a cache read, and a cache write where its request read nothing back', () => {
  const cases = [
    ['read back from a warm cache', { read: 90_000, write: 500 }, { cacheRead: 1000 }],
    ['wrote its whole context again, all of it for the hour', { read: 0, write: 90_000, write1h: 90_000 }, { cacheWrite: 1000, cacheWrite1h: 1000 }],
    ['wrote its whole context again, half of it for the hour', { read: 0, write: 1000, write1h: 500 }, { cacheWrite: 1000, cacheWrite1h: 500 }],
  ];
  for (const [name, usage, kinds] of cases) {
    const c = cleared({ compression: [row(usage)], events: [known()] });
    assert.equal(c.tokens, 1000, name);
    assert.ok(Math.abs(c.cost - savedCost(kinds)) < 1e-12, name);
  }
});

test('only the cut\'s own request is charged for the rewrite, and a cut made cold is never charged', () => {
  const f = file('charge', [
    row({ session: 'cut', clear: { tokens: 1000 }, read: 1000, write: 40_000 }),
    row({ session: 'cut', at: iso(at(5)), read: 1000, write: 30_000 }),    // a later request's rewrite: not the cut's
    row({ session: 'cold', clear: { tokens: 1000, cold: true }, read: 1000, write: 50_000 }),
    row({ session: 'expired', clear: { tokens: 1000 }, read: 0, write: 60_000 }),
    row({ session: 'rose', cleared: 3000, read: 500, write: 20_000 }),
  ]);
  const cost = clearingCostBySession(f, { config: {} });
  const seen = [...cost].map(([id, x]) => [id, x.rewrites, x.write]);
  assert.deepEqual(seen, [['cut', 1, 40_000], ['rose', 1, 20_000]], 'the cut\'s own warm request, and nothing else');
  assert.equal(cost.get('cold'), undefined, 'a cut made at a cold boundary is never charged');
  assert.equal(cost.get('expired'), undefined, 'nor is a request that read nothing back: that write was coming anyway');
  near(cost.get('cut').usd, writesCost(40_000), 'the cut is charged its own write');
});

test('each clear is counted once across the proxy\'s log, the desktop record and the log\'s mirror of it', () => {
  const dir = tmp('records');
  const record = (session, saved, lastAt) => fs.writeFileSync(path.join(dir, `${session}.json`),
    JSON.stringify({ session, firstAt: iso(at(0)), lastAt: iso(lastAt), requests: 2, saved, uses: 3, model: MODEL, recent: [] }));
  const f = file('once', [row({ session: 'proxied', cleared: 5000 })]);
  record('proxied', 5000, at(1));          // the proxy writes this beside its rows: the log wins
  record('desktop', 80_000, at(2));        // a session the proxy never served
  const events = [
    { op: 'clearing', session: 'desktop', t: iso(at(2)), cleared: 80_000, model: MODEL },   // mirrored too: still once
    { op: 'clearing', session: 'pruned', t: iso(at(3)), cleared: 9000, model: MODEL },      // its record is gone
  ];
  const rows = clearingRows(f, dir, { events, key: sessionKey });
  assert.deepEqual(rows.map(r => [r.session, r.cleared]), [['proxied', 5000], ['desktop', 80_000], ['pruned', 9000]]);
  const c = cleared({ compression: rows, events: [...events, known('proxied'), known('desktop'), known('pruned')] });
  assert.equal(c.tokens, 94_000, 'each clear once, whichever record carried it');
});

test('a session\'s per-request rows add up; its running total takes the newest, never the sum', () => {
  const f = file('add', [row({ cleared: 1000 }), row({ at: iso(at(2)), cleared: 3000 }), row({ at: iso(at(3)), cleared: 6000 })]);
  const summed = clearedBySession(f, { config: {} }).get('s');
  assert.equal(summed.cleared, 10_000, 'every request left those tokens out again');
  assert.equal(summed.requests, 3);
  // the desktop mod's mirror is the session's total so far, written once a turn it grew
  const mirrored = [1000, 3000, 6000].map((n, i) => ({ op: 'clearing', session: 's', t: iso(at(i + 1)), cleared: n, model: MODEL }));
  assert.equal(loggedClearing(mirrored, { key: sessionKey }).get('s').cleared, 6000, 'the newest total, not 10,000');
});

test('a delegated read saves the write the lead never made, less what the subagent cost, plus a read on each later call', () => {
  const fired = { op: 'delegate', session: 's', t: iso(at(10)), kind: 'explore', files: ['core.py'], tokens: 40_000 };
  const call = (m, x = {}) => ({ op: 'proxy', status: 200, session: 's', model: MODEL, turn: 3, at: iso(at(m)), input: 2, read: 200_000, write: 500, out: 5, ...x });
  const compression = [
    call(9),                       // before the handoff: not a call the read would have been on
    call(11), call(12, { turn: 4 }),
    call(13, { model: SUB }),      // the subagent's own call, under the session's id
    call(14, { status: 500 }),
    call(20, { turn: 1 }),         // a compaction: the read would have left the prompt anyway
    call(21, { turn: 1 }),
  ];
  const rows = delegationSavings({ events: [{ ...fired, model: SUB }], compression, config: {} });
  assert.equal(rows.length, 3, 'the write, and the two later calls before the compaction');
  assert.equal(rows[0].tokens, 40_000);
  assert.ok(Math.abs(rows[0].cost - (writesCost(40_000) - 40_000 * PS.cacheWrite1h / 1e6)) < 1e-12, 'the lead\'s write less the subagent\'s');
  for (const r of rows.slice(1)) assert.ok(Math.abs(r.cost - readsCost(40_000)) < 1e-12, 'a cache read the lead never paid');
  // where thinker ran the subagent itself, what it reported paying is what comes off
  const own = delegationSavings({ events: [{ ...fired, model: SUB, cost: 0.21 }], compression, config: {} });
  assert.ok(Math.abs(own[0].cost - (writesCost(40_000) - 0.21)) < 1e-12);
  // and where nobody knows what the subagent ran on, the write half is given away rather than guessed
  assert.equal(delegationSavings({ events: [fired], compression, config: {} })[0].cost, 0);
});

test('a handoff that was held out, declined, failed or that the lead then read anyway saves nothing', () => {
  const fired = { op: 'delegate', session: 's', t: iso(at(10)), kind: 'explore', files: ['core.py'], tokens: 40_000, model: SUB };
  const compression = [{ op: 'proxy', status: 200, session: 's', model: MODEL, turn: 3, at: iso(at(11)), input: 2, read: 1000, write: 500, out: 5 }];
  const count = events => delegationSavings({ events, compression, config: {} }).length;
  for (const [name, x] of [['held out of the trigger', { held: true }], ['declined', { fired: false, declined: 'below-threshold' }],
    ['failed', { error: 'timeout' }], ['answered from the turn\'s cache', { cached: true }], ['skipped', { skipped: 'no-native-subagent' }]]) {
    assert.equal(count([{ ...fired, ...x }]), 0, name);
  }
  const anyway = { ...fired, t: iso(at(12)), fired: false, after: 'handoff' };
  assert.equal(count([fired, anyway]), 0, 'the lead read the same file itself, so nothing was kept out');
  assert.equal(count([fired, { ...anyway, files: ['other.py'] }]), 2, 'another file read by hand takes nothing away');
  for (const after of ['budget', 'in-flight']) {
    assert.equal(count([fired, { ...fired, t: iso(at(12)), fired: false, after }]), 2, `a read refused as ${after} is still kept out by the first`);
  }
});

test('a session whose end-of-turn record holds the answer is counted from that record alone, never twice', () => {
  const fired = { op: 'delegate', session: 's', t: iso(at(10)), kind: 'explore', files: ['core.py'], tokens: 40_000, model: SUB };
  const call = m => ({ op: 'proxy', status: 200, session: 's', model: MODEL, turn: 3, at: iso(at(m)), input: 2, read: 1000, write: 500, out: 5 });
  const recorded = {
    op: 'session', session: 's', model: MODEL, t: iso(at(30)),
    delegated: { reads: 1, tokens: 40_000, laterTokens: 80_000, ignored: 0, agents: ['a1'] },
    subagents: [{ agent: 'a1', model: SUB, inputTokens: 45_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 40_000, cacheWrite1hTokens: 40_000 }],
  };
  const rows = delegationSavings({ events: [fired, recorded], compression: [call(11), call(12)], config: {} });
  assert.equal(rows.length, 1, 'the session\'s own figure, not the firing\'s rows as well');
  assert.equal(rows[0].tokens, 120_000, 'the write it never made and the reads of it after');
  const sub = costOf({ input: 45_000, cacheRead: 0, cacheWrite: 40_000, cacheWrite1h: 40_000, output: 500 }, PS);
  assert.ok(Math.abs(rows[0].cost - (writesCost(40_000) + readsCost(80_000) - sub)) < 1e-12, 'netted against the subagent that did the reading');
});

test('cleared context, delegated reads and reads the model already had add up and never overlap', () => {
  const events = [
    known(),
    { op: 'delegate', session: 's', t: iso(at(10)), kind: 'explore', files: ['core.py'], tokens: 40_000, model: SUB },
    { op: 'session', session: 's', model: MODEL, t: iso(at(30)), repeated: { reads: 1, tokens: 20_000, laterTokens: 60_000, ignored: 0, agents: [] } },
  ];
  const cells = series({ compression: [row({ read: 9000, write: 100 })], events }).map(s => s.cells[0]);
  assert.deepEqual(cells.map(c => c.tokens), [1000, 40_000, 80_000], 'each series counts its own tokens and no other\'s');
  const expected = [readsCost(1000), writesCost(40_000) - 40_000 * PS.cacheWrite1h / 1e6, writesCost(20_000) + readsCost(60_000)];
  for (const [i, want] of expected.entries()) assert.ok(Math.abs(cells[i].cost - want) < 1e-12, `series ${i}`);
  assert.ok(Math.abs(cells.reduce((a, c) => a + c.cost, 0) - expected.reduce((a, n) => a + n, 0)) < 1e-12, 'the total is the three of them added');
});

test('a model nobody priced leaves a gap in the dollars, never a zero', () => {
  const c = cleared({ compression: [row({ model: 'nobody-prices-this', read: 9000, write: 100 })], events: [known()] });
  assert.equal(c.tokens, 1000);
  assert.equal(c.cost, 0);
  assert.equal(c.unpricedTokens, 1000, 'the tokens are still counted');
  assert.equal(c.pricedEvents, 0);
  assert.equal(savingsValue(c, WEEK[0], {}, { total: true }), null, 'and no door shows a figure for them');
  assert.equal(savingsValue(c, WEEK[0], {}, { cost: false, total: true }), 1000, 'the tokens it does show');
  // a session handed a read on a model with no price is named, and left out of the dollars
  const handed = delegationBySession({ events: [{ op: 'delegate', session: 's', t: iso(at(10)), kind: 'explore', files: ['a.py'], tokens: 40_000, model: SUB }], compression: [], config: {} });
  assert.equal(handed.length, 1);
  assert.equal(handed[0].saved, null, 'no lead model was ever recorded, so there are no dollars');
  assert.equal(handed[0].reads, 1, 'and the handoff itself is still counted');
  // a session cleared beyond what its priced rows cover, on a model nobody priced
  assert.equal(sessionSaving({ cleared: 200_000, clearing: { usd: 1, pricedTokens: 100_000 }, model: null }).priced, false);
});

test('a file read again after a cut took it is charged; a kept file and the newest results are not', () => {
  const body = 'x'.repeat(1000), tokens = Math.round(1000 * RESULT_TOKENS_PER_CHAR);
  const read = (m, f) => ({ t: 'tool', at: iso(at(m)), name: 'Read', input: { file_path: f }, result: body });
  const transcript = {
    events: [
      { t: 'prompt', at: iso(at(0)), text: 'go' },
      read(1, '/repo/core.py'), read(2, '/repo/NOTES.md'), read(3, '/repo/b.py'), read(4, '/repo/c.py'), read(5, '/repo/d.py'),
      { t: 'prompt', at: iso(at(20)), text: 'again' },
      read(21, 'core.py'),        // the cut took this one: a re-read, named relative this time
      read(22, '/repo/NOTES.md'), // on the keep list, so its newest copy never left the prompt
      read(23, '/repo/d.py'),     // among the newest results the policy protects from any cut
    ],
    calls: [24, 25].map(m => ({ t: iso(at(m)) })),
  };
  const again = rereadsOf(transcript, [at(20)], { patterns: ['*.md'] });
  assert.equal(again.reads, 1, 'one file was fetched back');
  assert.equal(again.files, 1);
  assert.equal(again.tokens, tokens);
  assert.equal(again.laterTokens, 2 * tokens, 'written once, and in the prompt for every later call');
  near(rereadCost(again, P), writesCost(tokens) + readsCost(2 * tokens), 'a re-read costs its write and its later reads');
  assert.equal(rereadsOf(transcript, [], { patterns: ['*.md'] }).reads, 0, 'a session that was never cut reads nothing again');
});

test('one ledger for every door: today, the last fortnight with its net, and lifetime', t => {
  const h = tmp('ledger'), r = tmp('checkout');
  const before = { ...process.env };
  process.env.THINKER_HOME = h;
  process.env.THINKER_PROXY_LOG = path.join(h, 'proxy.jsonl');
  process.env.THINKER_LOG = path.join(h, 'log.jsonl');
  t.after(() => { for (const k of ['THINKER_HOME', 'THINKER_PROXY_LOG', 'THINKER_LOG']) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });
  const store = { repo: r, dir: path.join(r, '.thinker'), config: () => ({}) };
  const today = NOW - 3600_000;   // the person's own day, which starts at their midnight
  fs.writeFileSync(process.env.THINKER_LOG, [
    // a session logs its running figures every turn: the newest row inside the window is the session's
    { op: 'session', session: 's', model: MODEL, t: iso(NOW - DAY), repo: r, origin: r, rereads: { reads: 1, tokens: 4000, laterTokens: 9000 } },
    { op: 'session', session: 's', model: MODEL, t: iso(today), repo: r, origin: r, rereads: { reads: 2, tokens: 10_000, laterTokens: 40_000 } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(process.env.THINKER_PROXY_LOG, [
    row({ at: iso(today), cleared: 100_000, read: 90_000, write: 0 }),
    row({ at: iso(NOW - 3 * DAY), cleared: 200_000, clear: { tokens: 200_000 }, read: 1000, write: 50_000 }),
    row({ at: iso(NOW - 30 * DAY), cleared: 400_000, read: 90_000, write: 0 }),
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const l = computeSavings(store, { now: NOW });
  assert.equal(l.today.cleared.tokens, 100_000, 'today is the day the person is working through');
  assert.equal(l.recent.cleared.tokens, 300_000, `the last ${RECENT_DAYS} days`);
  assert.equal(l.lifetime.cleared.tokens, 700_000, 'and lifetime is every clear the log remembers');
  near(l.recent.rewrite, writesCost(50_000), 'the fortnight carries what the cuts cost');
  near(l.recent.reread, writesCost(10_000) + readsCost(40_000), 'what it read again, from the session\'s newest count and not the sum of them');
  assert.ok(Math.abs(l.recent.net - (l.recent.cost - l.recent.rewrite - l.recent.reread)) < 1e-12);
  assert.equal(l.today.net, undefined, 'and it is the only window that carries one');
  assert.equal(l.lifetime.net, undefined);
  // a figure stamped on a day that has passed says lifetime alone, rather than reading as this morning's
  assert.ok(savingsLine(l, { now: NOW }).includes('today'));
  assert.equal(savingsLine(l, { now: NOW + DAY }).includes('today'), false);
  assert.equal(readSavings(store, { now: NOW }), null, 'nothing is kept until a refresh writes it');
});

test('every saving names the cut policy it was made under, and a session that spans two is marked', () => {
  const dir = tmp('policy');
  noteCompression(dir, row({ session: 'x', cleared: 1000, policy: 'first' }));
  const spanned = noteCompression(dir, row({ session: 'x', at: iso(at(5)), cleared: 3000, policy: 'second' }));
  assert.equal(spanned.policy, 'second', 'the newest policy a session ran under');
  assert.equal(spanned.policyChanged, true, 'and it says it spans an update, so nothing pools it with either');
  const f = file('stamp', [row({ session: 'one', policy: 'first' }), row({ session: 'two', policy: 'first' }), row({ session: 'two', at: iso(at(5)), cleared: 2000, policy: 'second' })]);
  const by = clearedBySession(f, { config: {} });
  assert.equal(by.get('one').policy, 'first');
  assert.equal(by.get('one').policyChanged, undefined, 'a session under one policy is not marked');
  assert.equal(by.get('two').policyChanged, true);
});

test('no module but the accountant prices a saving', () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const walk = (dir = src) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap(e => (e.name === 'node_modules' ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(js|mjs|tsx?)$/.test(e.name) ? [path.join(dir, e.name)] : []));
  // the code of a file without its comments: a rule about what a module does is not broken by what it says
  const code = f => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  const others = walk().filter(f => path.relative(src, f) !== 'accountant.js');
  const offenders = (re, allowed = []) => others.filter(f => re.test(code(f))).map(f => path.relative(src, f)).filter(f => !allowed.includes(f));
  assert.deepEqual(offenders(/\bcostOfInputSavings\b/, ['prices.js']), [], 'what a saved input token is worth is asked of the accountant');
  assert.deepEqual(offenders(/\bsaved\w*\s*-\s*[\w.?()|\s]*\b(rewrite|reread)/i), [], 'a saving is netted against what it cost in the accountant');
  assert.deepEqual(offenders(/\bclearingRows\(/, ['compression.js']), [], 'the clearing\'s rows are read for a count through the accountant\'s one reader');
});
