#!/usr/bin/env node
// Live integration check; synthetic rows are removed by their exact keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { aws, connectionOptions, verifyReports } from '../../scripts/metrics-postgres.js';

const { values: options } = parseArgs({ options: {
  endpoint: { type: 'string' }, 'admin-secret': { type: 'string' }, host: { type: 'string' },
  'tunnel-port': { type: 'string', default: '15432' }, ca: { type: 'string', default: '.metrics-work/rds.pem' },
  profile: { type: 'string', default: 'yoav' }, region: { type: 'string', default: 'us-east-1' },
} });
if (!options['admin-secret'] || !options.host) throw new Error('--admin-secret and --host required for test cleanup');
const reader = new pg.Client(connectionOptions({ ...options, secret: 'thinker/metrics/reader' }));
const admin = new pg.Client(connectionOptions({ ...options, secret: options['admin-secret'], database: 'thinker_metrics' }));
const writer = new pg.Client(connectionOptions({ ...options, secret: 'thinker/metrics/writer' }));
const id = `migration-smoke-${randomUUID()}`;
const payload = { installId: id, timestamp: new Date().toISOString(), event: 'migration-smoke',
  deviceId: 'v1:' + randomUUID().replaceAll('-', '').repeat(2),
  cacheSize: { totalNotes: 3, kinds: { location: 2, gotcha: 1 } },
  effectiveness: { requestsTotal: 5, requestsAnswered: 2, hitRate: 0.4,
    estimatedSavings: { netTokensSaved: -10 } } };
const scratch = new URL('../../.metrics-work/', import.meta.url);
fs.mkdirSync(scratch, { recursive: true });
const eventFile = new URL(`${id}.event.json`, scratch);
const resultFile = new URL(`${id}.result.json`, scratch);
const keys = new Set();
async function invoke(body, requestId = id) {
  if (options.endpoint) {
    const response = await fetch(options.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20000) });
    return { statusCode: response.status, body: await response.text() };
  }
  fs.writeFileSync(eventFile, JSON.stringify({ requestContext: { requestId, http: { method: 'POST' } }, body }));
  const metadata = JSON.parse(aws(['lambda', 'invoke', '--function-name', 'thinker-metrics-postgres-ingest',
    '--payload', `fileb://${eventFile.pathname}`, resultFile.pathname], options));
  assert.equal(metadata.FunctionError, undefined, 'Lambda execution must succeed');
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

try {
  await Promise.all([reader.connect(), admin.connect(), writer.connect()]);
  await assert.rejects(reader.query('DELETE FROM reports WHERE false'), { code: '42501' });
  await assert.rejects(writer.query('DELETE FROM reports WHERE false'), { code: '42501' });
  for (const body of ['null', '{}']) assert.equal((await invoke(body)).statusCode, 422);
  assert.equal((await invoke('not json')).statusCode, 400);
  for (let i = 0; i < 2; i++) {
    const response = await invoke(JSON.stringify(payload));
    assert.equal(response.statusCode, 202, response.body);
    const key = JSON.parse(response.body).key;
    keys.add(key);
    await verifyReports(reader, [{ key, data: payload }]);
  }
  // Replaying a Lambda event uses the same request ID. Two HTTP requests have
  // different API Gateway IDs and intentionally represent distinct receipts.
  const { rows } = await reader.query('SELECT count(*)::int AS count FROM reports WHERE install_id = $1', [id]);
  assert.equal(rows[0].count, options.endpoint ? 2 : 1);
  assert.equal((await invoke(JSON.stringify({ ...payload, deviceId: 'raw-machine-id' }))).statusCode, 422);
  const otherInstall = { ...payload, installId: `${id}-second` };
  const otherResponse = await invoke(JSON.stringify(otherInstall), `${id}-second`);
  assert.equal(otherResponse.statusCode, 202, otherResponse.body);
  await verifyReports(reader, [{ key: JSON.parse(otherResponse.body).key, data: otherInstall }]);
  const deviceInstalls = await reader.query('SELECT count(DISTINCT install_id)::int AS count FROM reports WHERE device_id = $1', [payload.deviceId]);
  assert.equal(deviceInstalls.rows[0].count, 2);
  const devices = await reader.query('SELECT count(*)::int AS count FROM v_latest_devices WHERE device_id = $1', [payload.deviceId]);
  assert.equal(devices.rows[0].count, 1);
  const { deviceId, ...legacy } = { ...payload, installId: `${id}-legacy` };
  const legacyResponse = await invoke(JSON.stringify(legacy), `${id}-legacy`);
  assert.equal(legacyResponse.statusCode, 202, legacyResponse.body);
  await verifyReports(reader, [{ key: JSON.parse(legacyResponse.body).key, data: legacy }]);
  for (const view of ['v_latest_installs', 'v_active_installs', 'v_latest_devices', 'v_hourly_volume', 'v_kind_distribution']) {
    await reader.query(`SELECT * FROM ${view} LIMIT 1`);
  }
  console.log(JSON.stringify({ target: options.endpoint || 'candidate Lambda', persistence: 'verified',
    repeatedRequests: rows[0].count, permissions: 'verified', views: 'verified', deviceGrouping: '2 installations, 1 device', legacyClient: 'verified', keys: [...keys] }));
} finally {
  try {
    // The exact generated install ID also catches a committed write whose HTTP
    // response was lost before its key could be added to the set above.
    await admin.query('DELETE FROM reports WHERE install_id = ANY($1::text[]) AND event = $2', [[id, `${id}-second`, `${id}-legacy`], 'migration-smoke']);
  } finally {
    await Promise.allSettled([reader.end(), admin.end(), writer.end()]);
    fs.rmSync(eventFile, { force: true }); fs.rmSync(resultFile, { force: true });
  }
}
