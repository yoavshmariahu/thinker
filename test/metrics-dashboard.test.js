import { test } from 'node:test';
import assert from 'node:assert/strict';
// Import the actual entrypoint: a syntax error in the operational script must fail npm test.
import { provision, verify } from '../scripts/metrics-dashboard.mjs';
import { cacheQuestions } from '../scripts/cache-dashboard.mjs';
import { spendQuestions } from '../scripts/spend-dashboard.mjs';
import { armsQuestions } from '../scripts/arms-dashboard.mjs';

test('dashboard provisioning creates Cache health, maps its filters, and refreshes it without duplicates', async t => {
  t.mock.method(console, 'log', () => {});
  const config = {}, records = new Map();
  let nextId = 1;
  const call = async (route, method = 'GET', body) => {
    if (route === '/session/properties') return {};
    if (route === '/session') return { id: 'test-session' };
    if (route === '/database' && method === 'GET') return { data: [] };
    if (route === '/dataset') return { status: 'completed', data: { rows: body.native.query.includes('current_user') ? [['reader', true, 0]] : [['linux', 'test', 'device', 'warmup']] } };
    if (method === 'POST' && ['/database', '/collection', '/card', '/dashboard'].includes(route)) {
      const id = nextId++; records.set(`${route}/${id}`, { id, ...body }); return { id };
    }
    if (method === 'PUT') { assert.ok(records.has(route), route); records.set(route, { ...records.get(route), ...body }); return records.get(route); }
    if (method === 'GET') { assert.ok(records.has(route), route); return records.get(route); }
    throw new Error(`Unexpected request: ${method} ${route}`);
  };
  const options = { call, config, persist: () => {}, reader: { username: 'reader', dbname: 'test', password: 'fake' } };
  await provision(options);
  assert.ok(config.cacheId, 'Cache health must be provisioned on a fresh installation');
  const cache = records.get(`/dashboard/${config.cacheId}`);
  assert.equal(cache.name, 'Cache health');
  assert.deepEqual(cache.dashcards.filter(c => c.card_id).map(c => c.card_id), cacheQuestions.map(q => config.cards[q.name]));
  for (const card of cache.dashcards.filter(c => c.card_id)) {
    assert.deepEqual(card.parameter_mappings.map(m => m.parameter_id), cache.parameters.map(p => p.id));
  }
  for (const a of cache.dashcards) for (const b of cache.dashcards) if (a !== b) {
    assert.ok(a.col + a.size_x <= b.col || b.col + b.size_x <= a.col || a.row + a.size_y <= b.row || b.row + b.size_y <= a.row, 'cards must not overlap');
  }
  const cacheId = config.cacheId;
  await provision(options);
  assert.equal(config.cacheId, cacheId);
  assert.equal([...records.values()].filter(r => r.name === 'Cache health').length, 1);
  // Missing dashboards must fail validation even on installations provisioned before this feature.
  await assert.rejects(verify({ config: {}, call: () => { throw new Error('must fail before queries'); } }), /Cache health dashboard missing/);
});

test('dashboard provisioning creates Token spend, maps its filters, and refreshes it without duplicates', async t => {
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
  assert.ok(config.spendId, 'Token spend must be provisioned on a fresh installation');
  const spend = records.get(`/dashboard/${config.spendId}`);
  assert.equal(spend.name, 'Token spend');
  // every question of the module is on the dashboard, in order, and every card takes every filter
  assert.deepEqual(spend.dashcards.filter(c => c.card_id).map(c => c.card_id), spendQuestions.map(q => config.cards[q.name]));
  for (const card of spend.dashcards.filter(c => c.card_id)) {
    assert.deepEqual(card.parameter_mappings.map(m => m.parameter_id), spend.parameters.map(p => p.id));
  }
  for (const a of spend.dashcards) for (const b of spend.dashcards) if (a !== b) {
    assert.ok(a.col + a.size_x <= b.col || b.col + b.size_x <= a.col || a.row + a.size_y <= b.row || b.row + b.size_y <= a.row, 'cards must not overlap');
  }
  // the three bands are headed by text, and no card runs past the grid
  assert.ok(spend.dashcards.filter(c => !c.card_id).length >= 3, 'each band is introduced');
  for (const card of spend.dashcards) assert.ok(card.col + card.size_x <= 24, 'a card must fit the 24-column grid');
  // each band's title sits above its first card and below the previous band's last: a card added to the end
  // of a band may not slide under the next title (the proxy's trend line did, until 2026-11-06)
  const rowOf = name => spend.dashcards.find(c => c.card_id === config.cards[name]).row;
  const titleRow = prefix => spend.dashcards.find(c => !c.card_id && c.visualization_settings.text.startsWith(prefix)).row;
  assert.ok(rowOf('Devices with the proxy on over time') < titleRow('## Who was shown'), 'the proxy band holds its own trend line');
  assert.ok(titleRow('## Who was shown') <= rowOf('Devices shown a suggestion, and devices that took one · 30 days'));
  assert.ok(rowOf('Compression by kind of result · 30 days') < titleRow('## What it measured'));
  assert.ok(titleRow('## What it measured') <= rowOf('Net savings · 30 days'));
  // a card carries a filtered copy of the sources it reads and no other: a view missing from the database
  // (v_snapshots, until #682's schema is deployed) may not fail a card that never reads it
  const net = records.get(`/card/${config.cards['Net savings · 30 days']}`).dataset_query.native.query;
  assert.ok(/filtered_v_latest_installs AS/.test(net) && !/v_snapshots|filtered_reports|v_latest_devices/.test(net), net.slice(0, 200));
  const spendId = config.spendId;
  await provision(options);
  assert.equal(config.spendId, spendId);
  assert.equal([...records.values()].filter(r => r.name === 'Token spend').length, 1);
  await assert.rejects(verify({ config: { ...config, spendId: null }, call: () => { throw new Error('must fail before queries'); } }), /Token spend dashboard missing/);
});

// The clearing has two doors and the dashboard must count both. The Responses path (Codex) is reported under
// `proxy.sides.responses` with its own sides and fields, so a card written against `sides.clearing` alone sees
// none of it: that is how two of the nine machines the clearing was working for on 2026-11-05 read as devices
// with the proxy on and nothing to show, and how all of that path's savings went uncounted. A card that counts
// one door counts the other, or is named here with the reason it is one protocol's own figure.
const MESSAGES_ONLY = new Map([
  ['Prefix rewrites after a clear · 30 days', 'the rewrite accounting is per Messages call (proxy.js:proxyReport rewrites); the Responses sides keep no such block'],
  ['Tokens cleared · 30 days', 'what the API itself reported clearing, which only the Messages path is told; the Codex card carries this path\'s own figure'],
  ['Billed input a request · cleared vs held out', 'billedInput is weighted from the Anthropic token classes and the Responses sides carry no such field'],
]);

test('dashboard provisioning creates Diff by feature, maps its filters, lays its cards out without overlap and refreshes without duplicates', async t => {
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
  assert.ok(config.armsId, 'Diff by feature must be provisioned on a fresh installation');
  const arms = records.get(`/dashboard/${config.armsId}`);
  assert.equal(arms.name, 'Diff by feature');
  assert.deepEqual(arms.dashcards.filter(c => c.card_id).map(c => c.card_id).sort((a, b) => a - b), armsQuestions.map(q => config.cards[q.name]).sort((a, b) => a - b));
  for (const card of arms.dashcards.filter(c => c.card_id)) assert.deepEqual(card.parameter_mappings.map(m => m.parameter_id), arms.parameters.map(p => p.id));
  for (const a of arms.dashcards) for (const b of arms.dashcards) if (a !== b) {
    assert.ok(a.col + a.size_x <= b.col || b.col + b.size_x <= a.col || a.row + a.size_y <= b.row || b.row + b.size_y <= a.row, 'cards must not overlap');
  }
  // every card is a ratio of sums over the snapshot, and the clearing's cards never pool two cut policies
  for (const q of armsQuestions) { if (!/By device|Devices reporting/.test(q.name)) assert.match(q.sql, /sum\(/, q.name); if (/clearing/i.test(q.name) && q.display === 'table') assert.match(q.sql, /arms,policy/, `${q.name} groups by the cut policy`); }
  const armsId = config.armsId;
  await provision(options);
  assert.equal(config.armsId, armsId);
  assert.equal([...records.values()].filter(r => r.name === 'Diff by feature').length, 1);
});

test('every spend card that counts one door of the clearing counts the other, or says why not', () => {
  for (const q of spendQuestions) {
    if (!/sides,(clearing|holdout)/.test(q.sql)) continue;
    assert.ok(/sides,responses/.test(q.sql) || MESSAGES_ONLY.has(q.name),
      `"${q.name}" counts the Messages path only: count the Responses path too, or exempt it in MESSAGES_ONLY with a reason`);
  }
  for (const name of MESSAGES_ONLY.keys()) {
    assert.ok(spendQuestions.some(q => q.name === name), `MESSAGES_ONLY names "${name}", which is no longer a card`);
  }
  // the daily series reads the day's own figure (telemetry.js:proxyMetrics byDay), never a 30-day sum by snapshot
  for (const name of ['Tokens cleared by day', 'Tokens cleared by day and device']) {
    const q = spendQuestions.find(q => q.name === name);
    assert.ok(q && /proxy,byDay/.test(q.sql) && !/sides,clearing/.test(q.sql), `"${name}" reads byDay alone`);
  }
  // and the netted dollars per device come from the prs block, the one place they are computed (delivery.js)
  for (const name of ['Net savings · 30 days', 'Net savings by device · 30 days']) {
    const q = spendQuestions.find(q => q.name === name);
    assert.ok(q && /prs,netUsd/.test(q.sql), `"${name}" reads the netted figure`);
  }
  // and the Codex door has cards of its own: what it cut, and why it left the rest alone
  assert.ok(spendQuestions.some(q => /sides,responses,clearing,removedTokens/.test(q.sql)), 'the Codex door reports what it removed, in tokens');
  assert.ok(spendQuestions.some(q => /sides,responses,unchanged,reasons/.test(q.sql)), 'the Codex door says why a request was left alone');
});
