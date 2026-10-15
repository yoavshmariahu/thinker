import { test } from 'node:test';
import assert from 'node:assert/strict';
// Import the actual entrypoint: a syntax error in the operational script must fail npm test.
import { provision, verify } from '../scripts/metrics-dashboard.mjs';
import { cacheQuestions } from '../scripts/cache-dashboard.mjs';

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
