import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { provision } from '../scripts/metrics-dashboard.mjs';
import { dailyQuestions, SAVINGS_SINCE } from '../scripts/daily-dashboard.mjs';
import { Store } from '../src/store.js';
import { delegateMetrics, proxyMetrics } from '../src/telemetry.js';

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
  assert.equal(dailyQuestions.length, 6);
  // a day from the newest snapshot that carries it, never a 30-day sum by snapshot
  for (const [name, block] of [['Total saved', 'sessions'], ['Saved per day', 'sessions'], ['Devices with a thinker session', 'sessions'], ['Context cuts', 'proxy'], ['Delegations', 'delegate']]) {
    const q = by(name);
    assert.ok(q, name);
    assert.match(q.sql, new RegExp(`\\{${block},byDay\\}`), `"${name}" reads ${block}.byDay`);
    assert.match(q.sql, /DISTINCT ON \(s\.device, dd\.day\)/, `"${name}" takes each device's day once`);
  }
  assert.equal(SAVINGS_SINCE, '2026-11-04');
  for (const name of ['Total saved', 'Saved per day']) assert.match(by(name).sql, /day_utc >= DATE '2026-11-04'/, name);
  assert.match(by('Total saved').sql, /netUsd/);
  assert.match(by('Context cuts').sql, /'cuts'/);
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
    assert.equal(m.schemaVersion, 1);
    assert.deepEqual(m.byDay, { [new Date().toISOString().slice(0, 10)]: { delegated: 3, cached: 1, held: 1, failed: 1, costUsd: 0.21 } });
    assert.equal(JSON.stringify(m).includes('secret'), false, 'no file leaves the machine');
    // a firing older than the window is in no day
    assert.deepEqual(delegateMetrics(store, { all: false, now: Date.now() + 40 * 86400000 }).byDay, {});
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
