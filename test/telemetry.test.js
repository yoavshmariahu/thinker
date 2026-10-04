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
  maybeSendTelemetryInBackground,
  maybeSendDailyTelemetryInBackground,
  scheduleTelemetry,
  unscheduleTelemetry,
  isTelemetryScheduled,
  getTelemetryLaunchAgentPath,
  HOUR_MS,
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
    assert.ok(payload.cacheSize.kinds.map >= 1);
    assert.ok(payload.cacheSize.kinds.rule >= 1);

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
    assert.ok(res2.reason === 'already_sent_recently' || res2.reason === 'already_sent_today');
    assert.equal(sentCount, 1);

    // Force send: bypasses rate limit
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
    assert.equal(metrics.kinds.map, 1);
    assert.equal(metrics.kinds.rule, 1);
    assert.ok(metrics.totalBytes > 0);
  } finally {
    if (origHome) process.env.THINKER_HOME = origHome;
    else delete process.env.THINKER_HOME;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('buildTelemetryPayload and sendTelemetry tag event type (install vs hourly vs daily)', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  try {
    const store = new Store(tmpRepo).init();
    const payloadDefault = buildTelemetryPayload(store, { home: tmpHome });
    assert.equal(payloadDefault.event, 'hourly');
    assert.equal(payloadDefault.periodHours, 24);

    const payloadDaily = buildTelemetryPayload(store, { home: tmpHome, event: 'daily' });
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

test('cli setup sends installation telemetry in background', async () => {
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
    execFileSync('node', [CLI, 'setup', '--no-build', '--no-mcp', '--no-git-hook', '--clients', 'claude', '--repo', tmpRepo], {
      env: {
        ...process.env,
        THINKER_HOME: tmpHome,
        HOME: tmpHome, CODEX_HOME: path.join(tmpHome, '.codex'),
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
        HOME: tmpHome, CODEX_HOME: path.join(tmpHome, '.codex'),
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

test('scheduleTelemetry and unscheduleTelemetry manage plist file and status', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-telem-sched-'));
  try {
    const plistPath = path.join(tmp, 'telemetry.plist');
    const binPath = path.join(tmp, 'bin', 'thinker');

    assert.equal(isTelemetryScheduled(tmp, { plistPath }), false);

    const sched = scheduleTelemetry({ home: tmp, binPath, plistPath, skipLaunchctl: true });
    assert.ok(fs.existsSync(plistPath));
    const content = fs.readFileSync(plistPath, 'utf8');
    assert.ok(content.includes('com.thinker.telemetry'));
    assert.ok(content.includes(binPath));
    assert.ok(content.includes('telemetry --send --quiet'));
    assert.ok(content.includes('<key>StartInterval</key>'));
    assert.ok(content.includes('<integer>3600</integer>'));

    assert.equal(isTelemetryScheduled(tmp, { plistPath, checkFileOnly: true }), true);

    const unsched = unscheduleTelemetry({ home: tmp, plistPath, skipLaunchctl: true });
    assert.equal(unsched.unscheduled, true);
    assert.ok(!fs.existsSync(plistPath));
    assert.equal(isTelemetryScheduled(tmp, { plistPath }), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('sendTelemetry honors hourly rate limit (HOUR_MS)', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-hourly-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-hourly-'));
  const stateDir = path.join(tmpHome, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const stampFile = path.join(stateDir, 'telemetry.last');
  try {
    const store = new Store(tmpRepo).init();
    let sentCount = 0;
    const mockFetch = async () => {
      sentCount++;
      return { ok: true, status: 202, json: async () => ({ status: 'accepted' }) };
    };

    // Timestamp 15 minutes ago: rate limited under default HOUR_MS
    const recent = new Date(Date.now() - 15 * 60 * 1000);
    fs.writeFileSync(stampFile, recent.toISOString() + '\n');
    fs.utimesSync(stampFile, recent, recent);
    const res1 = await sendTelemetry({ home: tmpHome, store, fetchFn: mockFetch });
    assert.equal(res1.sent, false);
    assert.equal(res1.reason, 'already_sent_recently');
    assert.equal(sentCount, 0);

    // Timestamp 70 minutes ago (> 1 hour): allowed
    const past = new Date(Date.now() - 70 * 60 * 1000);
    fs.writeFileSync(stampFile, past.toISOString() + '\n');
    fs.utimesSync(stampFile, past, past);
    const res2 = await sendTelemetry({ home: tmpHome, store, fetchFn: mockFetch });
    assert.equal(res2.sent, true);
    assert.equal(sentCount, 1);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('cli telemetry and telemetry --json run cleanly and show hourly event', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-cli-telem-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-cli-telem-home-'));
  try {
    const store = new Store(tmpRepo).init();
    const CLI = path.resolve('src/cli.js');
    const out = execFileSync('node', [CLI, 'telemetry', '--repo', tmpRepo], {
      encoding: 'utf8',
      env: { ...process.env, THINKER_HOME: tmpHome, THINKER_TELEMETRY: 'off' },
    });
    assert.ok(out.includes('Thinker telemetry:'));
    assert.ok(out.includes('Schedule:'));
    assert.ok(out.includes('Event:        hourly'));
    assert.ok(out.includes('--schedule'));

    const jsonOut = execFileSync('node', [CLI, 'telemetry', '--json', '--repo', tmpRepo], {
      encoding: 'utf8',
      env: { ...process.env, THINKER_HOME: tmpHome, THINKER_TELEMETRY: 'off' },
    });
    const parsed = JSON.parse(jsonOut);
    assert.equal(parsed.event, 'hourly');
    assert.equal(parsed.periodHours, 24);
    assert.ok(parsed.clients);
    assert.equal(parsed.clients.schemaVersion, 1);
    assert.ok(Array.isArray(parsed.clients.detected));
    assert.ok(parsed.retrieval);
    assert.equal(parsed.retrieval.schemaVersion, 1);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('telemetry payload captures client adoption breakdown and detected clients', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-clients-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-clients-home-'));
  try {
    const store = new Store(tmpRepo).init();
    store.put({ id: 'note-1', kind: 'location', title: 'Location note', body: 'body' });
    store.put({ id: 'note-2', kind: 'howto', title: 'Howto note', body: 'body' });

    store.log({ op: 'orient', client: 'claude', session: 'sess-claude', served: ['note-1'] });
    store.log({ op: 'orient', client: 'cursor', session: 'sess-cursor', served: ['note-1', 'note-2'] });
    store.log({ op: 'orient', session: 'rollout-12345678-1234-1234-1234-123456789012', served: ['note-1'] });
    store.log({ op: 'orient', client: 'gemini', session: 'sess-gemini', served: [] });
    store.log({ op: 'lookup', client: 'mcp', served: ['note-1'] });
    store.log({ op: 'late', client: 'claude', session: 'sess-claude', served: ['note-2'] });

    const payload = buildTelemetryPayload(store, { home: tmpHome, days: 1, all: false });

    assert.equal(payload.clients.schemaVersion, 1);
    assert.ok(Array.isArray(payload.clients.detected));
    assert.equal(payload.clients.activeRequests.claude, 1);
    assert.equal(payload.clients.activeRequests.cursor, 1);
    assert.equal(payload.clients.activeRequests.codex, 1);
    assert.equal(payload.clients.activeRequests.gemini, 1);
    assert.equal(payload.clients.activeRequests.mcp, 1);

    assert.equal(payload.clients.servings.claude, 2);
    assert.equal(payload.clients.servings.cursor, 2);
    assert.equal(payload.clients.servings.codex, 1);
    assert.equal(payload.clients.servings.gemini, 0);
    assert.equal(payload.clients.servings.mcp, 1);

    assert.equal(payload.clients.sessions.claude, 1);
    assert.equal(payload.clients.sessions.cursor, 1);
    assert.equal(payload.clients.sessions.codex, 1);
    assert.equal(payload.clients.sessions.gemini, 0);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('telemetry payload captures retrieval quality metrics, staleness, and guard triggers', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-retrieval-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-retrieval-home-'));
  try {
    const store = new Store(tmpRepo).init();
    store.put({ id: 'n1', kind: 'callpath', title: 'Callpath note', body: 'body', status: 'stale' });
    store.put({ id: 'n2', kind: 'gotcha', title: 'Gotcha note', body: 'body', status: 'fresh' });

    // Request 1: 2 served (1 stale, 1 fresh), 2 uncovered terms, duration 45ms
    store.log({ op: 'orient', client: 'claude', session: 's1', served: ['n1', 'n2'], stale: ['n1'], uncovered: ['foo_bar', 'baz_qux'], durationMs: 45 });
    // Request 2: empty (0 notes served), duration 15ms
    store.log({ op: 'orient', client: 'claude', session: 's2', served: [], durationMs: 15 });
    // Request 3: lookup, 1 served fresh, duration 30ms
    store.log({ op: 'lookup', client: 'mcp', served: ['n2'], durationMs: 30 });

    const payload = buildTelemetryPayload(store, { home: tmpHome, days: 1, all: false });

    assert.equal(payload.retrieval.schemaVersion, 1);
    assert.equal(payload.retrieval.requestsTotal, 3);
    assert.equal(payload.retrieval.requestsAnswered, 2);
    assert.equal(payload.retrieval.emptyRequests, 1);
    assert.equal(payload.retrieval.hitRate, 0.667);

    assert.equal(payload.retrieval.staleNotesServed, 1);
    assert.equal(payload.retrieval.freshNotesServed, 2);
    assert.equal(payload.retrieval.staleServingRate, 0.333);

    assert.equal(payload.retrieval.guardTriggeredCount, 1);
    assert.equal(payload.retrieval.guardUncoveredTerms, 2);

    assert.equal(payload.retrieval.durationMs, 90);
    assert.equal(payload.retrieval.durationSamples, 3);
    assert.equal(payload.retrieval.averageDurationMs, 30);

    assert.equal(payload.retrieval.servedByKind.map, 1);
    assert.equal(payload.retrieval.servedByKind.rule, 2);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('cache topology metrics aggregate statuses, sources, and dependency granularity', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-topology-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-topology-home-'));
  try {
    const store = new Store(tmpRepo).init();
    store.put({
      id: 'note-agent',
      kind: 'location',
      title: 'Agent note',
      body: 'body',
      status: 'fresh',
      source: { type: 'agent' },
      confidence: 0.9,
      deps: [{ path: 'foo.js', symbol: 'func' }, { path: 'bar.js' }],
    });
    store.put({
      id: 'note-pr',
      kind: 'gotcha',
      title: 'PR note',
      body: 'body',
      status: 'stale',
      source: { type: 'pr' },
      confidence: 0.6,
      deps: [{ path: 'baz.js' }],
    });

    const metrics = computeCacheMetrics(store, { home: tmpHome, all: false });

    assert.equal(metrics.totalNotes, 2);
    assert.equal(metrics.statuses.fresh, 1);
    assert.equal(metrics.statuses.stale, 1);
    assert.equal(metrics.sources.agent, 1);
    assert.equal(metrics.sources.pr, 1);
    assert.equal(metrics.confidenceBuckets.high, 1);
    assert.equal(metrics.confidenceBuckets.medium, 1);
    assert.equal(metrics.confidenceBuckets.low, 0);
    assert.equal(metrics.symbolDepRatio, 0.333); // 1 symbol dep out of 3 total deps
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});


