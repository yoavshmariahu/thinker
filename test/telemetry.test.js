import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import {
  isTelemetryEnabled,
  isTestTelemetryBlocked,
  getTelemetryEndpoint,
  getInstallId,
  computeCacheMetrics,
  buildTelemetryPayload,
  sendTelemetry,
  maybeSendDailyTelemetryInBackground,
  DEFAULT_TELEMETRY_ENDPOINT,
} from '../src/telemetry.js';

// Only this module exercises telemetry opt-in using mocks/loopback. The inherited
// test guard still forbids production requests, including child processes.
const originalTelemetry = process.env.THINKER_TELEMETRY;
beforeEach(() => { process.env.THINKER_TEST = '1'; delete process.env.THINKER_TELEMETRY; });
afterEach(() => {
  if (originalTelemetry === undefined) delete process.env.THINKER_TELEMETRY;
  else process.env.THINKER_TELEMETRY = originalTelemetry;
});

test('distillation telemetry preserves measured outcomes and unknown provider cost', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-distillation-metrics-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-distillation-home-'));
  try {
    const store = new Store(tmpRepo).init();
    store.log({ op: 'distill-run', failed: false, durationMs: 200 });
    store.log({ op: 'distill-run', failed: true, durationMs: 800 });
    store.log({ op: 'distill-run', failed: true, durationMs: 9999, dry: true });
    store.log({ op: 'distill', saved: [], merged: [], metered: true });
    store.log({ op: 'model', purpose: 'distill', cost: null, failed: true, usage: null });
    const d = buildTelemetryPayload(store, { home: tmpHome, all: false }).distillation;
    assert.equal(d.attempts, 2); assert.equal(d.failed, 1); assert.equal(d.succeeded, 1);
    assert.equal(d.durationMs, 1000); assert.equal(d.durationSamples, 2);
    assert.equal(d.reportedCostUsd, null); assert.equal(d.costUnknownCalls, 1);
    assert.equal(d.reportedTokens, null); assert.equal(d.noChanges, 1);
    store.log({ op: 'model', purpose: 'distill', cost: 0.03, usage: { input_tokens: 10, output_tokens: 5 } });
    const partial = buildTelemetryPayload(store, { home: tmpHome, all: false }).distillation;
    assert.equal(partial.reportedCostUsd, 0.03); assert.equal(partial.costKnownCalls, 1);
    assert.equal(partial.costUnknownCalls, 1); assert.equal(partial.reportedTokens, 15);
    assert.equal(partial.tokenUnknownCalls, 1);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true }); fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('isTelemetryEnabled honors environment flags and config overrides', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-telem-home-'));
  try {
    assert.equal(isTelemetryEnabled({ home: tmpHome }), true);

    process.env.THINKER_TELEMETRY = 'off';
    assert.equal(isTelemetryEnabled({ home: tmpHome }), false);
    delete process.env.THINKER_TELEMETRY;

    process.env.THINKER_NO_TELEMETRY = '1';
    assert.equal(isTelemetryEnabled({ home: tmpHome }), false);
    delete process.env.THINKER_NO_TELEMETRY;

    process.env.THINKER_NO_LEARN = '1';
    assert.equal(isTelemetryEnabled({ home: tmpHome }), false);
    delete process.env.THINKER_NO_LEARN;

    // install.json override
    fs.writeFileSync(path.join(tmpHome, 'install.json'), JSON.stringify({ telemetry: false }));
    assert.equal(isTelemetryEnabled({ home: tmpHome }), false);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('getInstallId generates and persists a valid UUID', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-telem-id-'));
  try {
    const id1 = getInstallId(tmpHome);
    assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    const id2 = getInstallId(tmpHome);
    assert.equal(id1, id2, 'Install ID should remain stable once generated');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('getTelemetryEndpoint respects environment variable and default', () => {
  assert.equal(getTelemetryEndpoint(), DEFAULT_TELEMETRY_ENDPOINT);
  process.env.THINKER_TELEMETRY_URL = 'https://custom-proxy.example.com/v1';
  assert.equal(getTelemetryEndpoint(), 'https://custom-proxy.example.com/v1');
  delete process.env.THINKER_TELEMETRY_URL;
});

test('buildTelemetryPayload constructs anonymous high-level metrics without sensitive data', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  try {
    const store = new Store(tmpRepo).init();
    store.put({ id: 'test-note-1', kind: 'location', title: 'Route handling', body: 'router.js:handle handles requests' });
    store.put({ id: 'test-note-2', kind: 'gotcha', title: 'Header parsing', body: 'headers.js:parse requires utf8' });

    const payload = buildTelemetryPayload(store, { home: tmpHome, days: 1, all: false });

    assert.ok(payload.installId);
    assert.ok(payload.deviceId === null || /^v1:[a-f0-9]{64}$/.test(payload.deviceId));
    assert.ok(payload.version);
    assert.equal(payload.periodHours, 24);
    assert.ok(payload.cacheSize.totalNotes >= 2);
    assert.ok(payload.cacheSize.kinds.location >= 1);
    assert.ok(payload.cacheSize.kinds.gotcha >= 1);

    // Assert effectiveness structure
    assert.equal(typeof payload.effectiveness.requestsTotal, 'number');
    assert.equal(typeof payload.effectiveness.hitRate, 'number');
    assert.equal(typeof payload.effectiveness.tokensServed, 'number');
    assert.equal(typeof payload.effectiveness.estimatedSavings.netTokensSaved, 'number');

    // Strict privacy guarantee: no sensitive code, file paths, or note contents
    const jsonStr = JSON.stringify(payload);
    assert.equal(jsonStr.includes('router.js:handle'), false);
    assert.equal(jsonStr.includes('headers.js:parse'), false);
    assert.equal(jsonStr.includes('Route handling'), false);
    assert.equal(jsonStr.includes(tmpRepo), false);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('test telemetry can reach loopback only, including in inherited subprocess environments', async (t) => {
  for (const env of [{ THINKER_TEST: '1' }, { NODE_TEST_CONTEXT: 'child-v8' }]) {
    assert.equal(isTestTelemetryBlocked(DEFAULT_TELEMETRY_ENDPOINT, env), true);
    assert.equal(isTestTelemetryBlocked('https://localhost.example.com', env), true);
    assert.equal(isTestTelemetryBlocked('http://localhost:1234', env), false);
    assert.equal(isTestTelemetryBlocked('http://127.0.0.1:1234', env), false);
    assert.equal(isTestTelemetryBlocked('http://[::1]:1234', env), false);
  }
  assert.equal(isTestTelemetryBlocked(DEFAULT_TELEMETRY_ENDPOINT, {}), false);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-network-'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('should not send'); });
  try {
    const result = await sendTelemetry({ home, endpoint: DEFAULT_TELEMETRY_ENDPOINT, force: true });
    assert.equal(result.reason, 'test_environment');
    assert.equal(calls, 0);
    assert.equal(fs.existsSync(path.join(home, 'state', 'install-id')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('sendTelemetry honors rate limit and mock network transmission', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  try {
    const store = new Store(tmpRepo).init();
    let sentCount = 0;
    let lastBody = null;

    const mockFetch = async (url, opts) => {
      sentCount++;
      lastBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 202,
        json: async () => ({ status: 'accepted', key: 'metrics/test.json' }),
      };
    };

    // First send: should succeed
    const res1 = await sendTelemetry({ home: tmpHome, store, fetchFn: mockFetch });
    assert.equal(res1.sent, true);
    assert.equal(res1.status, 202);
    assert.equal(sentCount, 1);
    assert.ok(lastBody.cacheSize);

    // Second send immediately: should be rate-limited
    const res2 = await sendTelemetry({ home: tmpHome, store, fetchFn: mockFetch });
    assert.equal(res2.sent, false);
    assert.equal(res2.reason, 'already_sent_today');
    assert.equal(sentCount, 1);

    // Force send: bypasses 24h limit
    const res3 = await sendTelemetry({ home: tmpHome, store, fetchFn: mockFetch, force: true });
    assert.equal(res3.sent, true);
    assert.equal(sentCount, 2);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('sendTelemetry handles network errors gracefully without crashing', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  try {
    const store = new Store(tmpRepo).init();
    const failingFetch = async () => {
      throw new Error('Network offline');
    };

    const res = await sendTelemetry({ home: tmpHome, store, fetchFn: failingFetch, force: true });
    assert.equal(res.sent, false);
    assert.equal(res.error, 'Network offline');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('computeCacheMetrics accurately counts local store notes on fresh install without prior log', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  const origHome = process.env.THINKER_HOME;
  try {
    process.env.THINKER_HOME = tmpHome;
    const store = new Store(tmpRepo).init();
    store.put({ id: 'test-note-1', kind: 'location', title: 'Route handling', body: 'router.js:handle handles requests' });
    store.put({ id: 'test-note-2', kind: 'gotcha', title: 'Header parsing', body: 'headers.js:parse requires utf8' });

    const metrics = computeCacheMetrics(store, { home: tmpHome, all: true });
    assert.equal(metrics.totalNotes, 2, 'fresh installation must reflect local store notes');
    assert.equal(metrics.repositoriesCount, 1, 'fresh installation must count the repository');
    assert.equal(metrics.kinds.location, 1);
    assert.equal(metrics.kinds.gotcha, 1);
    assert.ok(metrics.totalBytes > 0);
  } finally {
    if (origHome) process.env.THINKER_HOME = origHome;
    else delete process.env.THINKER_HOME;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('buildTelemetryPayload and sendTelemetry tag event type (install vs daily)', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  try {
    const store = new Store(tmpRepo).init();
    const payloadDaily = buildTelemetryPayload(store, { home: tmpHome });
    assert.equal(payloadDaily.event, 'daily');

    const payloadInstall = buildTelemetryPayload(store, { home: tmpHome, event: 'install' });
    assert.equal(payloadInstall.event, 'install');

    let sentBody = null;
    const mockFetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return { ok: true, status: 202, json: async () => ({ status: 'accepted' }) };
    };

    const res = await sendTelemetry({ home: tmpHome, store, fetchFn: mockFetch, force: true, event: 'install' });
    assert.equal(res.sent, true);
    assert.equal(sentBody.event, 'install');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('sendTelemetry respects user opt-out even when force is true', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  try {
    const store = new Store(tmpRepo).init();
    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 202 };
    };

    process.env.THINKER_TELEMETRY = 'off';
    const res = await sendTelemetry({ home: tmpHome, store, fetchFn: mockFetch, force: true, event: 'install' });
    assert.equal(res.sent, false);
    assert.equal(res.reason, 'disabled');
    assert.equal(fetchCalled, false);
  } finally {
    delete process.env.THINKER_TELEMETRY;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('cli init sends installation telemetry in background', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cli-init-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cli-init-home-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpRepo });

  // Add a sample note to verify note counts
  const store = new Store(tmpRepo).init();
  store.put({ id: 'note-1', kind: 'location', title: 'Location note', body: 'app.js handles routes' });

  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { received.push(JSON.parse(body)); } catch {}
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted' }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const CLI = path.resolve('src/cli.js');
    execFileSync('node', [CLI, 'init', '--local', '--no-mcp', '--clients', 'claude', '--repo', tmpRepo], {
      env: {
        ...process.env,
        THINKER_HOME: tmpHome,
        THINKER_TELEMETRY_URL: `http://127.0.0.1:${port}`,
        THINKER_NO_LEARN: '',
        THINKER_TELEMETRY: 'on',
      },
      stdio: 'pipe',
    });

    // Wait up to 3 seconds for background telemetry request
    const deadline = Date.now() + 3000;
    while (!received.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    assert.equal(received.length, 1, 'telemetry payload should be received');
    assert.equal(received[0].event, 'install');
    assert.equal(received[0].cacheSize.totalNotes, 1);
    assert.equal(received[0].cacheSize.repositoriesCount, 1);
    assert.ok(received[0].installId);
  } finally {
    server.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('cli setup sends installation telemetry in background upon completion', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cli-setup-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cli-setup-home-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpRepo });

  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { received.push(JSON.parse(body)); } catch {}
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted' }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const CLI = path.resolve('src/cli.js');
    execFileSync('node', [CLI, 'setup', '--repo', tmpRepo, '--no-seed', '--no-prs', '--no-phrase', '--clients', 'claude', '--yes'], {
      env: {
        ...process.env,
        THINKER_HOME: tmpHome,
        THINKER_TELEMETRY_URL: `http://127.0.0.1:${port}`,
        THINKER_NO_LEARN: '',
        THINKER_TELEMETRY: 'on',
      },
      stdio: 'pipe',
    });

    const deadline = Date.now() + 3000;
    while (!received.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    assert.equal(received.length, 1, 'telemetry payload should be received');
    assert.equal(received[0].event, 'install');
    assert.equal(received[0].cacheSize.repositoriesCount, 1);
    assert.ok(received[0].installId);
  } finally {
    server.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
