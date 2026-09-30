import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDb, ingestJsonFiles, startServer } from '../scripts/metrics-db.js';

test('initDb creates tables, indexes, and views in SQLite', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sqlite-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  try {
    const db = initDb(dbPath);
    assert.ok(fs.existsSync(dbPath));

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    assert.ok(tables.includes('reports'));
    assert.ok(tables.includes('cache_kinds'));

    const views = db.prepare("SELECT name FROM sqlite_master WHERE type='view'").all().map(r => r.name);
    assert.ok(views.includes('v_latest_installs'));
    assert.ok(views.includes('v_active_installs'));
    assert.ok(views.includes('v_hourly_volume'));
    assert.ok(views.includes('v_kind_distribution'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ingestJsonFiles parses payloads and populates tables and views', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sqlite-ingest-'));
  const dbPath = path.join(tmpDir, 'test.db');
  try {
    const db = initDb(dbPath);

    const mockPayload1 = {
      installId: 'inst-1',
      event: 'install',
      version: '0.1.0',
      platform: 'darwin',
      timestamp: '2026-09-29T10:00:00.000Z',
      periodHours: 24,
      cacheSize: {
        totalNotes: 2,
        totalBytes: 500,
        repositoriesCount: 1,
        kinds: { location: 1, fix: 1 }
      },
      effectiveness: {
        requestsTotal: 5,
        requestsAnswered: 5,
        hitRate: 1.0,
        servings: { prompt: 5, file: 0, lookup: 0 },
        tokensServed: 120,
        assessed: { confirmed: 4, contradicted: 0, unused: 0, pending: 1, confirmationRate: 1.0 },
        estimatedSavings: { callsAvoided: 4, tokensAvoided: 4000, netTokensSaved: 3880 },
        feedback: { useful: 1, notUseful: 0, corrections: 0 },
        lifecycle: { sessionsDistilled: 2, newNotes: 2, notesMerged: 0, prsMined: 1, staleVerified: 0 }
      }
    };

    const mockPayload2 = {
      installId: 'inst-1',
      event: 'daily',
      version: '0.1.0',
      platform: 'darwin',
      timestamp: '2026-09-29T12:00:00.000Z',
      periodHours: 24,
      cacheSize: {
        totalNotes: 3,
        totalBytes: 800,
        repositoriesCount: 1,
        kinds: { location: 1, fix: 2 }
      },
      effectiveness: {
        requestsTotal: 8,
        requestsAnswered: 8,
        hitRate: 1.0,
        servings: { prompt: 8, file: 0, lookup: 0 },
        tokensServed: 200,
        assessed: { confirmed: 7, contradicted: 0, unused: 0, pending: 1, confirmationRate: 1.0 },
        estimatedSavings: { callsAvoided: 7, tokensAvoided: 7000, netTokensSaved: 6800 },
        feedback: { useful: 2, notUseful: 0, corrections: 0 },
        lifecycle: { sessionsDistilled: 3, newNotes: 3, notesMerged: 0, prsMined: 1, staleVerified: 0 }
      }
    };

    const res = ingestJsonFiles(db, [
      { key: 'key1.json', content: JSON.stringify(mockPayload1) },
      { key: 'key2.json', content: JSON.stringify(mockPayload2) }
    ]);

    assert.equal(res.ingested, 2);
    assert.equal(res.skipped, 0);

    // Check reports count
    const totalReports = db.prepare('SELECT COUNT(*) as c FROM reports').get().c;
    assert.equal(totalReports, 2);

    // Check v_latest_installs view (should return latest snapshot at 12:00:00)
    const latest = db.prepare('SELECT * FROM v_latest_installs WHERE install_id = ?').get('inst-1');
    assert.equal(latest.timestamp, '2026-09-29T12:00:00.000Z');
    assert.equal(latest.requests_total, 8);
    assert.equal(latest.cache_total_notes, 3);

    // Check kind distribution
    const kinds = db.prepare('SELECT * FROM v_kind_distribution').all();
    const fixKind = kinds.find(k => k.kind === 'fix');
    assert.equal(fixKind.total_notes, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('startServer serves web UI and query API', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sqlite-server-'));
  const dbPath = path.join(tmpDir, 'test.db');
  let serverInstance = null;

  try {
    const db = initDb(dbPath);
    ingestJsonFiles(db, [{
      key: 'test.json',
      content: JSON.stringify({
        installId: 'srv-1',
        timestamp: '2026-09-29T15:00:00.000Z',
        cacheSize: { totalNotes: 1, totalBytes: 10, repositoriesCount: 1 },
        effectiveness: { requestsTotal: 1, requestsAnswered: 1 }
      })
    }]);

    const { server, url } = await startServer({ port: 0, dbPath });
    serverInstance = server;

    // Test GET /
    const uiRes = await fetch(url + '/');
    assert.equal(uiRes.status, 200);
    const html = await uiRes.text();
    assert.ok(html.includes('Thinker Metrics Explorer'));

    // Test GET /api/stats
    const statsRes = await fetch(url + '/api/stats');
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();
    assert.equal(stats.totalReports, 1);
    assert.equal(stats.uniqueInstalls, 1);

    // Test POST /api/query
    const queryRes = await fetch(url + '/api/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT install_id, requests_total FROM reports;' })
    });
    assert.equal(queryRes.status, 200);
    const queryData = await queryRes.json();
    assert.equal(queryData.rows.length, 1);
    assert.equal(queryData.rows[0].install_id, 'srv-1');
  } finally {
    if (serverInstance) serverInstance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
