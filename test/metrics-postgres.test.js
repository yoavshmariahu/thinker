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

// --- error reports ---------------------------------------------------------
// thinker's own failures, from installs whose person agreed to send them (src/error-report.js).
// The endpoint's job is to refuse anything that still names a person, a machine or a repository:
// the client scrubs, but a client with a bug must not be able to store one here either.

const errorPayload = {
  installId: 'installation', version: '0.2.13', platform: 'darwin',
  errors: [{ at: '2026-10-29T10:00:00Z', op: 'hook.pre', name: 'TypeError', code: 'ERR_X',
    message: 'cannot read properties of undefined', node: '24.15.0', seen: 2,
    frames: ['at wrappedCommand (<thinker>/src/testing.js:491:9)'] }],
};

test('an error report is stored as one row per error', async () => {
  const { normalizeErrorReport, insertErrorReport } = await import('../infra/metrics/errors.mjs');
  const report = normalizeErrorReport({ ...errorPayload, errors: [errorPayload.errors[0], { ...errorPayload.errors[0], op: 'cli.update', seen: 0 }] });
  assert.equal(report.errors.length, 2);
  assert.equal(report.errors[1].seen, 1, 'a nonsense count becomes one');
  const queries = [];
  await insertErrorReport({ query: (sql, params) => { queries.push({ sql, params }); return { rowCount: 2 }; } }, 'errors/req-1', report, '2026-10-29T10:00:01Z');
  assert.equal(queries.length, 1, 'one statement for the whole report');
  assert.match(queries[0].sql, /INSERT INTO error_reports/);
  assert.match(queries[0].sql, /ON CONFLICT \(file_key, idx\) DO NOTHING/, 'a resend stores nothing twice');
  assert.equal(queries[0].params.length, 28, '14 columns × 2 rows, all parameterized');
  assert.deepEqual(queries[0].params.slice(0, 3), ['errors/req-1', 0, 'installation']);
});

test('an error report that still names a person, a machine or a credential is refused', async () => {
  const { normalizeErrorReport } = await import('../infra/metrics/errors.mjs');
  const bad = extra => () => normalizeErrorReport({ ...errorPayload, errors: [{ ...errorPayload.errors[0], ...extra }] });
  for (const [what, extra] of [
    ['a home path in the message', { message: "ENOENT open '/Users/jane/src/acme/notes.json'" }],
    ['a home path in a frame', { frames: ['at x (/home/jane/.thinker/app/src/a.js:1:1)'] }],
    ['a URL', { message: 'POST https://gw.corp.internal/v1/messages failed' }],
    ['a token', { message: 'refused key sk-ant-api03-abcdefgh12345' }],
    ['a server path', { message: 'cannot read /var/data/customer-x/db' }],
  ]) assert.throws(bad(extra), /carries machine detail/, what);
  // and the shape itself is checked
  assert.throws(() => normalizeErrorReport({ ...errorPayload, errors: [] }), /1 to 20 errors/);
  assert.throws(() => normalizeErrorReport({ ...errorPayload, installId: 'no spaces allowed' }), /install ID/);
  assert.throws(() => normalizeErrorReport({ ...errorPayload, version: 'latest' }), /version/);
  assert.throws(() => normalizeErrorReport({ ...errorPayload, errors: [{ ...errorPayload.errors[0], at: 'never' }] }), /error time/);
});

test('POST /errors accepts a report, and a bad one answers 422 without storing it', async () => {
  const stored = [];
  const handler = createHandler(() => { throw new Error('metrics writer must not be used'); },
    () => { throw new Error('message writer must not be used'); },
    (key, report) => { stored.push({ key, report }); });
  const post = body => handler({ rawPath: '/errors', requestContext: { http: { method: 'POST' }, requestId: 'req-9' }, body: JSON.stringify(body) }, {});

  const ok = await post(errorPayload);
  assert.equal(ok.statusCode, 202);
  assert.deepEqual(JSON.parse(ok.body), { status: 'accepted', count: 1 });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key, 'errors/req-9');
  assert.equal(stored[0].report.errors[0].op, 'hook.pre');

  const refused = await post({ ...errorPayload, errors: [{ ...errorPayload.errors[0], message: 'open /Users/jane/x/y' }] });
  assert.equal(refused.statusCode, 422);
  assert.match(JSON.parse(refused.body).error, /machine detail/);
  assert.equal(stored.length, 1, 'nothing was stored');

  // the other routes are untouched by the new one
  const metrics = await handler({ rawPath: '/metrics', requestContext: { http: { method: 'POST' } }, body: '{}' }, {});
  assert.equal(metrics.statusCode, 500, 'the metrics writer is still the one that runs there');
});
