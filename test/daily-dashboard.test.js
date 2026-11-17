import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { provision } from '../scripts/metrics-dashboard.mjs';
import { dailyQuestions, SAVINGS_SINCE, WINDOW_DAYS } from '../scripts/daily-dashboard.mjs';
import { Store } from '../src/store.js';
import { delegateMetrics, proxyMetrics } from '../src/telemetry.js';
import { sessionsOf } from '../src/delivery.js';
import { repoId } from '../src/store.js';

test('dashboard provisioning creates Thinker by day, maps its filters, lays its cards out without overlap and refreshes without duplicates', async t => {
  t.mock.method(console, 'log', () => {});
  const config = {}, records = new Map();
  let nextId = 1;
  const call = async (route, method = 'GET', body) => {
    if (route === '/session/properties') return {};
    if (route === '/session') return { id: 'test-session' };
    if (route === '/database' && method === 'GET') return { data: [] };
    if (route === '/dataset') return { status: 'completed', data: { rows: body.native.query.includes('current_user') ? [['reader', true, 0]] : [['linux', 'test', 'device', 'hourly']] } };
    if (method === 'POST' && ['/database', '/collection', '/card', '/dashboard'].includes(route)) {
      const id = nextId++; records.set(`${route}/${id}`, { id, ...body }); return { id };
    }
    if (method === 'PUT') { assert.ok(records.has(route), route); records.set(route, { ...records.get(route), ...body }); return records.get(route); }
    if (method === 'GET') { assert.ok(records.has(route), route); return records.get(route); }
    throw new Error(`Unexpected request: ${method} ${route}`);
  };
  const options = { call, config, persist: () => {}, reader: { username: 'reader', dbname: 'test', password: 'fake' } };
  await provision(options);
  assert.ok(config.dailyId, 'Thinker by day must be provisioned on a fresh installation');
  const daily = records.get(`/dashboard/${config.dailyId}`);
  assert.equal(daily.name, 'Thinker by day');
  assert.deepEqual(daily.dashcards.filter(c => c.card_id).map(c => c.card_id), dailyQuestions.map(q => config.cards[q.name]));
  for (const card of daily.dashcards.filter(c => c.card_id)) assert.deepEqual(card.parameter_mappings.map(m => m.parameter_id), daily.parameters.map(p => p.id));
  for (const a of daily.dashcards) for (const b of daily.dashcards) if (a !== b) {
    assert.ok(a.col + a.size_x <= b.col || b.col + b.size_x <= a.col || a.row + a.size_y <= b.row || b.row + b.size_y <= a.row, 'cards must not overlap');
    assert.ok(a.col + a.size_x <= 24, 'a card stays on the grid');
  }
  const dailyId = config.dailyId;
  await provision(options);
  assert.equal(config.dailyId, dailyId);
  assert.equal([...records.values()].filter(r => r.name === 'Thinker by day').length, 1);
});

test('every daily card reads a day\'s own figure, and the savings count from the day the cut shipped', () => {
  const by = name => dailyQuestions.find(q => q.name.startsWith(name));
  assert.equal(dailyQuestions.length, 8);
  // a day from the newest snapshot that carries it, never a 30-day sum by snapshot
  for (const [name, block] of [['Total saved', 'sessions'], ['Total saved', 'delegate'], ['Saved per day', 'sessions'], ['Saved per day', 'delegate'], ['Saved by context cuts', 'sessions'], ['Devices with a thinker session', 'sessions'], ['Context cuts', 'proxy'], ['Delegations', 'delegate'], ['Saved by delegation', 'delegate']]) {
    const q = by(name);
    assert.ok(q, name);
    assert.match(q.sql, new RegExp(`\\{${block},byDay\\}`), `"${name}" reads ${block}.byDay`);
    assert.match(q.sql, /DISTINCT ON \(s\.device, dd\.day\)/, `"${name}" takes each device's day once`);
  }
  assert.equal(SAVINGS_SINCE, '2026-11-05', 'nothing on or before 2026-11-04 is counted');
  const savings = ['Total saved', 'Saved per day', 'Saved by context cuts'];
  for (const name of savings) assert.match(by(name).sql, /day_utc >= DATE '2026-11-05'/, name);
  // a day both kinds of snapshot carry is read from the correctly dated one; an older client is still read
  for (const name of savings) { assert.match(by(name).sql, /\{sessions,byDaySchema\}' = '2', FALSE\) AS preferred/, name); assert.match(by(name).sql, /ORDER BY s\.device, dd\.day, s\.preferred DESC/, name); }
  assert.match(by('Saved by context cuts').sql, /devices_with_corrected_dating/);
  // only a saving that names its cut policy is counted: no card reads the unstamped figures
  for (const name of savings) { assert.match(by(name).sql, /figures->>'stampedNetUsd'/, name); assert.doesNotMatch(by(name).sql, /'netUsd'|'clearedSessions'|'clearedTokens'/, name); }
  // The total is the sum of the bars beside it: both read the same table of days, the context cuts' net plus what
  // delegation saved. The total once added delegation in while the bars drew the clearing alone ($43 beside $5).
  const table = sql => sql.slice(sql.indexOf('FROM (SELECT day_utc, c.usd'), sql.lastIndexOf('saved_days'));
  assert.ok(table(by('Total saved').sql).length > 100);
  assert.equal(table(by('Total saved').sql), table(by('Saved per day').sql), 'one table of days behind the total and its bars');
  assert.match(by('Total saved').sql, /^SELECT round\(sum\(total_usd\), 2\) AS total_saved_usd/);
  assert.deepEqual(by('Saved per day').settings['graph.metrics'], ['total_saved_usd']);
  assert.match(by('Saved per day').sql, /figures->>'savedUsd'/);
  // and each half has a graph of its own
  assert.match(by('Saved by context cuts').sql, /figures->>'stampedSavedUsd'/);
  assert.deepEqual(by('Saved by context cuts').settings['graph.metrics'], ['saved_by_context_cuts_usd']);
  assert.match(by('Saved by delegation').sql, /figures->>'savedUsd'/);
  assert.match(by('Saved by delegation').sql, /day_utc >= DATE '2026-11-05'/);
  assert.deepEqual(by('Saved by delegation').settings['graph.metrics'], ['saved_by_delegation_usd']);
  assert.match(by('Context cuts').sql, /'cuts'/);
  // one window on every card, and no date in a name: the line savings count from is in the query alone
  assert.equal(WINDOW_DAYS, 30);
  for (const q of dailyQuestions) { assert.match(q.sql, /\(now\(\) AT TIME ZONE 'UTC'\)::date - 29\)/, q.name); assert.doesNotMatch(q.name, /\d{4}-\d{2}-\d{2}/, q.name); }
  assert.equal(by('Total saved').name, 'Total saved · last 30 days');
  // the context cuts' two cards share a row, and delegation's two the next
  assert.deepEqual(dailyQuestions.map(q => q.name), ['Total saved · last 30 days', 'Saved per day', 'Saved by context cuts, per day', 'Context cuts per day', 'Saved by delegation, per day', 'Delegations to a subagent, per day', 'Devices with a thinker session, per day', 'Known devices, per day']);
  assert.match(by('Known devices').sql, /sum\(count\(\*\)\) OVER \(ORDER BY day_utc\)/, 'known devices is a running total');
  for (const q of dailyQuestions.filter(q => q.display !== 'scalar')) assert.deepEqual(q.settings['graph.dimensions'], ['day_utc'], q.name);
});

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
    assert.equal(m.schemaVersion, 2);
    // the lead read the file itself after the handoff (the last row), so the firings kept nothing out and saved nothing
    assert.deepEqual(m.byDay, { [new Date().toISOString().slice(0, 10)]: { delegated: 3, cached: 1, held: 1, failed: 1, costUsd: 0.21, savedTokens: 0, savedUsd: 0, unpricedTokens: 0 } });
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
    const day = delegateMetrics(store, { all: false }).byDay[new Date().toISOString().slice(0, 10)];
    // the write Opus 5.5 never made (40k at $8 a million) less the subagent's $0.21; the held-out firing saved nothing
    assert.equal(day.savedUsd, 0.11);
    assert.equal(day.savedTokens, 80000);
    assert.equal(day.unpricedTokens, 40000);
    assert.equal(day.delegated, 2);
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
