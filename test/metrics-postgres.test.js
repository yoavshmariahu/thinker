import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHandler } from '../infra/metrics/handler.mjs';
import { normalizeReport, insertReport, InvalidReport } from '../infra/metrics/report.mjs';
import { readSourceReports, importReports } from '../scripts/metrics-postgres.js';

const payload = {
  installId: 'installation', timestamp: '2026-09-29T12:00:00Z', event: 'daily',
  cacheSize: { totalNotes: 3, kinds: { location: 2, gotcha: 1 } },
  effectiveness: { requestsTotal: 5, requestsAnswered: 2, hitRate: 0.4,
    estimatedSavings: { netTokensSaved: -12 } },
};

test('PostgreSQL normalization preserves the original payload, zeroes, and negative net savings', () => {
  const data = { ...payload, periodHours: 0, extra: { futureMetric: 123 } };
  const row = normalizeReport('key', data);
  assert.equal(row.period_hours, 0);
  assert.equal(row.net_tokens_saved, -12);
  assert.equal(row.requests_total, 5);
  assert.equal(row.cache_total_notes, 3);
  assert.equal(row.servings_prompt, 0);
  assert.deepEqual(JSON.parse(row.raw_json), data);
  assert.equal(normalizeReport('key', { installId: 'old' }, payload.timestamp).timestamp, '2026-09-29T12:00:00.000Z');
});

test('invalid telemetry is rejected before writing to PostgreSQL', () => {
  for (const data of [null, [], {}, { ...payload, timestamp: 'bad' },
    { ...payload, effectiveness: { hitRate: 2 } },
    { ...payload, cacheSize: { kinds: { gotcha: '2' } } },
    { ...payload, effectiveness: { requestsTotal: 0.2 } }]) {
    assert.throws(() => normalizeReport('key', data), InvalidReport);
  }
});

test('PostgreSQL accepts versioned device hashes and keeps older clients unknown', () => {
  const deviceId = 'v1:' + 'a'.repeat(64);
  assert.equal(normalizeReport('new', { ...payload, deviceId }).device_id, deviceId);
  assert.equal(normalizeReport('old', payload).device_id, null);
  assert.equal(normalizeReport('unknown', { ...payload, deviceId: null }).device_id, null);
  for (const invalid of ['raw-machine-uuid', 'v1:short', 'v2:' + 'a'.repeat(64), {}, 42]) {
    assert.throws(() => normalizeReport('bad', { ...payload, deviceId: invalid }), /Invalid deviceId/);
  }
});

test('writer parameterizes reports and rejects key collisions with differing payloads', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    return sql.startsWith('INSERT') ? { rowCount: 0 } : { rows: [{ matches: true }] };
  } };
  const data = { ...payload, installId: "x'); DROP TABLE reports; --" };
  assert.equal(await insertReport(db, 'same-key', data), false);
  assert.ok(!calls[0].sql.includes(data.installId));
  assert.ok(calls[0].values.includes(data.installId));
  db.query = async sql => sql.startsWith('INSERT') ? { rowCount: 0 } : { rows: [{ matches: false }] };
  await assert.rejects(insertReport(db, 'same-key', data), /different data/);
});

test('HTTP writer handles preflight, methods, encoding, limits, and malformed JSON', async () => {
  const writes = [];
  const handler = createHandler(async (key, data, receivedAt) => {
    normalizeReport(key, data, receivedAt);
    writes.push({ key, data });
  });
  assert.equal((await handler({ httpMethod: 'OPTIONS' })).statusCode, 204);
  assert.equal((await handler({ httpMethod: 'GET' })).statusCode, 405);
  assert.equal((await handler({ body: 'bad' })).statusCode, 400);
  assert.equal((await handler({ body: 'null' })).statusCode, 422);
  assert.equal((await handler({ body: 'x'.repeat(65537) })).statusCode, 413);
  assert.equal(writes.length, 0);
  const event = { requestContext: { requestId: 'request-1', http: { method: 'POST' } },
    isBase64Encoded: true, body: Buffer.from(JSON.stringify(payload)).toString('base64') };
  const response = await handler(event);
  assert.equal(response.statusCode, 202);
  assert.equal(JSON.parse(response.body).key, 'metrics/live/request-1.json');
  assert.deepEqual(writes[0].data, payload);
  assert.equal((await handler(event)).statusCode, 202);
  assert.equal(writes[0].key, writes[1].key);
});

test('HTTP writer never acknowledges failed persistence', async () => {
  const handler = createHandler(async () => { throw Object.assign(new Error('database failed'), { code: 'TEST_FAILURE' }); });
  const response = await handler({ body: JSON.stringify(payload) });
  assert.equal(response.statusCode, 500);
  assert.equal(response.body, '{"error":"Failed to record metrics"}');
});

test('S3 importer uses the manifest and verifies checksums before importing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-pg-'));
  try {
    const raw = JSON.stringify(payload);
    fs.writeFileSync(path.join(dir, 'report.json'), raw);
    fs.writeFileSync(path.join(dir, 'stale-cache.json'), '{}');
    const manifest = [{ Key: 'metrics/report.json', Size: Buffer.byteLength(raw),
      ETag: `"${createHash('md5').update(raw).digest('hex')}"`, LastModified: payload.timestamp }];
    assert.equal(readSourceReports(manifest, dir, 'metrics/').length, 1);
    fs.writeFileSync(path.join(dir, 'report.json'), raw.replace('daily', 'other'));
    assert.throws(() => readSourceReports(manifest, dir, 'metrics/'), /checksum mismatch/);
    assert.throws(() => readSourceReports([{ ...manifest[0], Key: 'metrics/../report.json' }], dir, 'metrics/'), /Unexpected S3 key/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migration rolls back when a row cannot be persisted or verified', async () => {
  for (const failure of ['insert', 'verify']) {
    const commands = [];
    const db = { query: async sql => {
      commands.push(sql);
      if (sql.startsWith('INSERT')) {
        if (failure === 'insert') throw new Error('write failed');
        return { rowCount: 1 };
      }
      if (sql.startsWith('SELECT')) return { rows: [{ matches: false }] };
      return {};
    } };
    await assert.rejects(importReports(db, [{ key: 'a', data: payload }]));
    assert.equal(commands[0], 'BEGIN');
    assert.equal(commands.at(-1), 'ROLLBACK');
    assert.ok(!commands.includes('COMMIT'));
  }
});
