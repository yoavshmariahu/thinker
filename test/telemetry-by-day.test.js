import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/store.js';
import { compactionMetrics, delegateMetrics, proxyMetrics } from '../src/telemetry.js';
import { sessionsOf } from '../src/delivery.js';
import { repoId } from '../src/store.js';

test('delegations leave the machine as counts by day: fired, held out and failed, and never the bookkeeping rows', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-daily-'));
  try {
    const store = new Store(repo).init();
    const row = { op: 'delegate', session: 's1', client: 'claude', kind: 'explore', files: ['src/secret-file.py'], tokens: 40000 };
    store.log({ ...row, held: false, model: 'claude-sonnet-5-5', cost: 0.21 });
    store.log({ ...row, held: false, cached: true });
    store.log({ ...row, held: false, agent: 'Explore', handoffTool: 'Agent' });
    store.log({ ...row, held: true });
    store.log({ ...row, held: false, error: 'timeout' });
    store.log({ ...row, fired: false, declined: 'below-threshold' });
    store.log({ ...row, held: false, fired: false, after: 'handoff' });
    const m = delegateMetrics(store, { all: false });
    assert.equal(m.schemaVersion, 3);
    // The lead read the file itself after the handoff (the last row), so the firings kept nothing out and saved
    // nothing: each is in `ignored` as well, by the rule the saving uses, so a day's count and a day's dollars
    // are one rule and `delegated - ignored` is what the dollars are drawn from. The subagent was paid either way.
    assert.deepEqual(m.byDay, { [new Date().toISOString().slice(0, 10)]: { delegated: 3, ignored: 3, cached: 1, held: 1, failed: 1, costUsd: 0.21, savedTokens: 0, savedUsd: 0, unpricedTokens: 0 } });
    assert.equal(JSON.stringify(m).includes('secret'), false, 'no file leaves the machine');
    // a firing older than the window is in no day
    assert.deepEqual(delegateMetrics(store, { all: false, now: Date.now() + 40 * 86400000 }).byDay, {});
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('what delegation saved leaves the machine by day, as the savings ledger counts it: priced at the lead\'s model, unpriced where there is none', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-daily-'));
  try {
    const store = new Store(repo).init();
    const row = { op: 'delegate', client: 'claude', kind: 'explore', files: ['src/secret-file.py'], tokens: 40000, held: false };
    store.log({ op: 'session', session: 'priced', client: 'claude', model: 'claude-opus-5-5' });
    store.log({ ...row, session: 'priced', model: 'claude-sonnet-5-5', cost: 0.21 });
    store.log({ ...row, session: 'no-model' });
    store.log({ ...row, session: 'held-out', held: true });
    // the two rows the turn's own bookkeeping leaves, which are not the lead reading a file it has a report for
    store.log({ ...row, session: 'priced', files: ['src/other.py'], fired: false, after: 'budget' });
    store.log({ ...row, session: 'priced', fired: false, after: 'in-flight' });
    const day = delegateMetrics(store, { all: false }).byDay[new Date().toISOString().slice(0, 10)];
    // the write Opus 5.5 never made (40k at $8 a million) less the subagent's $0.21; the held-out firing saved nothing
    assert.equal(day.savedUsd, 0.11);
    assert.equal(day.savedTokens, 80000);
    assert.equal(day.unpricedTokens, 40000);
    assert.equal(day.delegated, 2);
    assert.equal(day.ignored, 0, 'the budget and a batch\'s second call keep the file out as the firing did');
    assert.equal(day.held, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a cut is counted on the day it was decided, apart from the requests sent shorter by it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-daily-home-'));
  try {
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    const at = new Date().toISOString(), base = { op: 'proxy', at, injected: true, status: 200, model: 'claude-opus-5-5', session: 's1' };
    fs.writeFileSync(path.join(home, 'state', 'proxy.jsonl'), [
      { ...base, cleared: 50000, clear: { tokens: 50000, payback: 3 } },
      { ...base, cleared: 50000 },
      { ...base, cleared: 50000 },
      { ...base, protocol: 'responses', estimatedRemovedTokens: 20000, clear: { tokens: 20000, payback: 5 } },
      { ...base, injected: false, reason: 'below-trigger' },
    ].map(r => JSON.stringify(r)).join('\n') + '\n');
    const day = proxyMetrics({ home, env: {} }).byDay[at.slice(0, 10)];
    assert.equal(day.cuts, 2);
    assert.equal(day.requestsCleared, 4);
    assert.equal(day.cleared, 170000);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Found on the owner's machine: one profile rebuild on 2026-11-08 logged a row for every session it read, and each
// was then dated that day, so three weeks of the older clearing's sessions landed after the day savings count from.
test('a session is dated by its own turns, never by a background read of it afterwards', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-daily-dated-'));
  try {
    const store = new Store(repo).init(), origin = repoId(repo);
    const row = (t, op, extra = {}) => ({ t, origin, repo, session: 'old-session', client: 'claude', op, ...extra });
    const log = [
      row('2026-10-20T10:00:00.000Z', 'request'),
      row('2026-10-20T11:00:00.000Z', 'session', { model: 'claude-opus-5-5', turns: 4, totalTokens: 1000 }),
      row('2026-11-08T03:48:00.000Z', 'model', { purpose: 'profile' }),
      row('2026-11-08T03:48:01.000Z', 'profile', { exchanges: 4, observations: 2 }),
      row('2026-11-08T03:48:02.000Z', 'distill-skipped'),
    ];
    const x = [...sessionsOf(store, { log, home: path.join(repo, 'home'), env: {} }).values()][0];
    assert.equal(x.firstAt, '2026-10-20T10:00:00.000Z');
    assert.equal(x.lastAt, '2026-10-20T11:00:00.000Z', 'the day it ran, not the day the profile read it');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('Devin\'s compactions leave the machine as counts by day: each once at its size, the sessions they were in, and no session id', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-daily-'));
  try {
    const store = new Store(repo).init();
    // as devin-compaction.js:recordDevinCompactions logs them
    store.log({ op: 'compaction', client: 'devin', session: 'brawny-cave', node: 12, before: 25855, after: 17267, saved: 8588 });
    store.log({ op: 'compaction', client: 'devin', session: 'brawny-cave', node: 31, before: 21000, after: 18195, saved: 2805 });
    store.log({ op: 'compaction', client: 'devin', session: 'quiet-harbor', node: 9, before: 150000, after: 40000, saved: 110000 });
    store.log({ op: 'compaction', client: 'devin', session: 'took-nothing', node: 4, before: 900, after: 900, saved: 0 });
    store.log({ op: 'delegate', session: 'brawny-cave', client: 'devin', kind: 'explore', files: ['a.py'], tokens: 40000, held: false });
    const m = compactionMetrics(store, { all: false });
    assert.equal(m.schemaVersion, 1);
    assert.deepEqual(m.byDay, { [new Date().toISOString().slice(0, 10)]: { compactions: 3, sessions: 2, tokens: 8588 + 2805 + 110000 } });
    for (const id of ['brawny-cave', 'quiet-harbor', repo]) assert.equal(JSON.stringify(m).includes(id), false, 'no session or repository leaves the machine');
    // a compaction older than the window is in no day
    assert.deepEqual(compactionMetrics(store, { all: false, now: Date.now() + 40 * 86400000 }).byDay, {});
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a machine with no Devin compaction sends an empty block, not a zero day', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-daily-'));
  try {
    const store = new Store(repo).init();
    store.log({ op: 'session', session: 's1', client: 'claude', model: 'claude-opus-5-5' });
    assert.deepEqual(compactionMetrics(store, { all: false }), { schemaVersion: 1, windowDays: 30, byDay: {} });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
