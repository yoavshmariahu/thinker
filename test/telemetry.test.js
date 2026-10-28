import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// Removing a temp directory after a CLI that ran with test mode off: `setup` leaves detached children of its
// own (the telemetry sender, the catch-up and maintenance runs), and one of them writing a file while `rmSync`
// walks the tree fails the walk with ENOTEMPTY -- which `force` does not cover, since the directory is not
// missing, it has just gained an entry. Node retries exactly this class for us. Seen in a release validation
// run on 2026-10-28, where it failed the suite and stopped the release.
const removeTree = d => fs.rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });

import { Store } from '../src/store.js';
import { telemetryScheduleState } from '../src/telemetry-schedule.js';
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
  proxyMetrics,
  spendMetrics,
} from '../src/telemetry.js';
import { writeReport } from '../src/report-snapshot.js';

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
    removeTree(tmpRepo); removeTree(tmpHome);
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
    removeTree(tmpHome);
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
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
  } finally { removeTree(home); }
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
  }
});

test('computeCacheMetrics counts the notes of a cache the log last named days ago: the report is a daily window, the notes are not', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const idleRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-idle-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  const origHome = process.env.THINKER_HOME;
  try {
    process.env.THINKER_HOME = tmpHome;
    const idle = new Store(idleRepo).init();
    idle.put({ id: 'idle-note-1', kind: 'location', title: 'Route handling', body: 'router.js:handle handles requests' });
    idle.put({ id: 'idle-note-2', kind: 'gotcha', title: 'Header parsing', body: 'headers.js:parse requires utf8' });
    idle.log({ t: new Date(Date.now() - 3 * 86400_000).toISOString(), op: 'orient', client: 'claude', task: 'routes', served: ['idle-note-1'] });

    // the hourly job runs outside any checkout: its own store holds nothing
    const store = new Store(tmpRepo).init();
    const metrics = computeCacheMetrics(store, { home: tmpHome, all: true });
    assert.equal(metrics.totalNotes, 2, 'a quiet day must not empty the notes count');
    assert.equal(metrics.repositoriesCount, 1);

    const payload = buildTelemetryPayload(store, { home: tmpHome, days: 1, all: true });
    assert.equal(payload.cacheSize.totalNotes, 2);
    assert.equal(payload.retrieval.requestsTotal, 0, 'requests keep the daily window');
  } finally {
    if (origHome) process.env.THINKER_HOME = origHome;
    else delete process.env.THINKER_HOME;
    removeTree(tmpRepo);
    removeTree(idleRepo);
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    execFileSync('node', [CLI, 'setup', '--no-build', '--no-mcp', '--no-git-hook', '--no-proxy', '--clients', 'claude', '--repo', tmpRepo], {
      env: {
        ...process.env,
        THINKER_HOME: tmpHome,
        HOME: tmpHome, CODEX_HOME: path.join(tmpHome, '.codex'),
        // Exercise background delivery only against this isolated loopback server.
        THINKER_TEST: '0', THINKER_NO_AUTO_UPDATE: '1',
        THINKER_TELEMETRY_URL: `http://127.0.0.1:${port}`,
        THINKER_NO_LEARN: '',
        THINKER_TELEMETRY: 'on',
      },
      stdio: 'pipe',
    });

    // The send is a detached `node cli.js telemetry` of its own, so wait for the process, not a guess at
    // its speed: 3 seconds was enough alone and not under the whole suite, where the release run saw none.
    const deadline = Date.now() + 30000;
    while (!received.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    assert.equal(received.length, 1, 'telemetry payload should be received');
    assert.equal(received[0].event, 'install');
    assert.equal(received[0].cacheSize.totalNotes, 1);
    assert.equal(received[0].cacheSize.repositoriesCount, 1);
    // a CLI spawned by a test never leaves a real hourly job behind (it would report to production)
    assert.equal(telemetryScheduleState(tmpHome).type, undefined);
    assert.ok(received[0].installId);
  } finally {
    server.close();
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    execFileSync('node', [CLI, 'setup', '--repo', tmpRepo, '--no-prs', '--no-phrase', '--no-proxy', '--clients', 'claude', '--yes'], {
      env: {
        ...process.env,
        THINKER_HOME: tmpHome,
        HOME: tmpHome, CODEX_HOME: path.join(tmpHome, '.codex'),
        // Exercise background delivery only against this isolated loopback server.
        THINKER_TEST: '0', THINKER_NO_AUTO_UPDATE: '1',
        THINKER_TELEMETRY_URL: `http://127.0.0.1:${port}`,
        THINKER_NO_LEARN: '',
        THINKER_TELEMETRY: 'on',
      },
      stdio: 'pipe',
    });

    const deadline = Date.now() + 30000; // the detached sender, as above
    while (!received.length && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }

    assert.equal(received.length, 1, 'telemetry payload should be received');
    assert.equal(received[0].event, 'install');
    assert.equal(received[0].cacheSize.repositoriesCount, 1);
    assert.ok(received[0].installId);
  } finally {
    server.close();
    removeTree(tmpRepo);
    removeTree(tmpHome);
  }
});

test('scheduleTelemetry and unscheduleTelemetry manage plist file and status', { skip: process.platform !== 'darwin' }, () => {
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
    removeTree(tmp);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
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
    removeTree(tmpRepo);
    removeTree(tmpHome);
  }
});



test('telemetry payload carries re-verification verdicts and doubted passes as 30-day counts', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-verification-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-verification-home-'));
  try {
    const store = new Store(tmpRepo).init();
    store.log({ op: 'verify', id: 'n1', verdict: 'still_valid' });
    store.log({ op: 'distill', transcript: 'x', saved: [], merged: [], deferred: 1, contradicted: ['n1'] });
    store.log({ op: 'verify', id: 'n1', verdict: 'still_valid' });
    store.log({ op: 'verify', id: 'n2', verdict: 'update' });
    store.log({ op: 'verify', id: 'n3', verdict: 'invalid' });
    const payload = buildTelemetryPayload(store, { home: tmpHome, days: 1, all: false });
    assert.deepEqual(payload.verification, { schemaVersion: 1, windowDays: 30, stillValid: 2, updated: 1, retired: 1, passFlaggedLater: 1, passWhileFlagged: 1 });
    assert.doesNotMatch(JSON.stringify(payload.verification), /n1|n2|n3/, 'counts only, no note ids');
  } finally {
    removeTree(tmpRepo);
    removeTree(tmpHome);
  }
});

test('the payload names the harnesses found and reports no supported agent as none', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-repo-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-harness-user-'));
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = h; process.env.PATH = ''; delete process.env.CLAUDE_CONFIG_DIR; delete process.env.CODEX_HOME;
  try {
    fs.mkdirSync(path.join(h, '.continue'), { recursive: true });
    const store = new Store(tmpRepo).init();
    const payload = buildTelemetryPayload(store, { home: tmpHome });
    assert.deepEqual(payload.clients.detected, [], 'no supported agent: nothing, not the setup fallback');
    assert.deepEqual(Object.keys(payload.clients.harnesses), ['continue']);
    assert.equal(payload.clients.harnesses.continue.supported, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const d of [tmpRepo, tmpHome, h]) removeTree(d);
  }
});

test('an applied update starts one report from the new copy, unless telemetry is off', async () => {
  const { sendTelemetryAfterUpdate } = await import('../src/telemetry.js');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  const cli = path.join(tmpHome, 'cli.js'); fs.writeFileSync(cli, '');
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} }; };
  const env = { PATH: process.env.PATH, THINKER_TELEMETRY_URL: 'http://127.0.0.1:9/x' };
  try {
    assert.equal(sendTelemetryAfterUpdate({ cliPath: cli, home: tmpHome, spawnFn, env, testMode: false }), true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [cli, 'telemetry', '--background', '--force', '--event', 'update', '--quiet']);
    assert.equal(calls[0].opts.env.THINKER_BACKGROUND_TELEMETRY, '1');
    assert.equal(sendTelemetryAfterUpdate({ cliPath: cli, home: tmpHome, spawnFn, env: { ...env, THINKER_BACKGROUND_TELEMETRY: '1' }, testMode: false }), false, 'a background send does not start another');
    fs.writeFileSync(path.join(tmpHome, 'install.json'), JSON.stringify({ telemetry: false }));
    assert.equal(sendTelemetryAfterUpdate({ cliPath: cli, home: tmpHome, spawnFn, env, testMode: false }), false, 'telemetry off: nothing');
    assert.equal(calls.length, 1);
  } finally { removeTree(tmpHome); }
});

test('telemetry says whether each installed agent runs thinker and how much it was used', async () => {
  const { wiringHealth } = await import('../src/telemetry.js');
  const { installClient } = await import('../src/clients.js');
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-wiring-home-'));
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = h; delete process.env.CLAUDE_CONFIG_DIR; process.env.CODEX_HOME = path.join(h, '.codex');
  try {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
    installClient('claude', { scope: 'user', cli, mcpEntry: { command: 'node', args: [path.join(path.dirname(cli), 'mcp.js')] }, hooks: true, learn: false, late: false, mcp: true });
    const proj = path.join(h, '.claude', 'projects', '-r'); fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'a.jsonl'), '{}'); fs.writeFileSync(path.join(proj, 'b.jsonl'), '{}');
    const old = path.join(proj, 'c.jsonl'); fs.writeFileSync(old, '{}'); fs.utimesSync(old, new Date(Date.now() - 9 * 864e5), new Date(Date.now() - 9 * 864e5));
    const day = path.join(h, '.codex', 'sessions', '2026', '10', '16'); fs.mkdirSync(day, { recursive: true }); fs.writeFileSync(path.join(day, 'rollout.jsonl'), '{}');
    assert.deepEqual(wiringHealth({ home: h, detected: ['claude', 'codex'] }), {
      claude: { hooks: true, mcp: true, live: true, sessions7d: 2 },
      codex: { hooks: false, mcp: false, live: false, sessions7d: 1 },
    });
  } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});

test('computeCacheMetrics counts a repository\'s notes once, from its fullest checkout, not again for each worktree', () => {
  const main = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-main-'));
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-old-wt-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  const origHome = process.env.THINKER_HOME;
  try {
    process.env.THINKER_HOME = tmpHome;
    for (const dir of [main, old]) {
      execFileSync('git', ['-C', dir, 'init', '-q']);
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://github.com/acme/app.git']);
    }
    const a = new Store(main).init();
    for (const i of [1, 2, 3]) a.put({ id: `n${i}`, kind: 'rule', title: `Rule ${i}`, body: 'app.js:run' });
    a.log({ op: 'orient', client: 'claude', task: 'run', served: ['n1'] });
    // an old worktree: a copy of two of the notes, stale, which no maintenance there will refresh
    const b = new Store(old).init();
    for (const i of [1, 2]) b.put({ id: `n${i}`, kind: 'rule', title: `Rule ${i}`, body: 'app.js:run', status: 'stale' });
    b.log({ op: 'orient', client: 'claude', task: 'run', served: [] });

    const metrics = computeCacheMetrics(new Store(main), { home: tmpHome, all: true });
    assert.equal(metrics.repositoriesCount, 1);
    assert.equal(metrics.totalNotes, 3);
    assert.deepEqual(metrics.statuses, { fresh: 3, stale: 0, invalid: 0 });
    assert.equal(metrics.kinds.rule, 3);
  } finally {
    if (origHome) process.env.THINKER_HOME = origHome;
    else delete process.env.THINKER_HOME;
    for (const d of [main, old, tmpHome]) removeTree(d);
  }
});

test('computeCacheMetrics counts the repositories with a cache now, not every checkout the log ever named', () => {
  const live = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-live-'));
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-gone-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-home-'));
  const origHome = process.env.THINKER_HOME;
  try {
    process.env.THINKER_HOME = tmpHome;
    const a = new Store(live).init();
    a.put({ id: 'n1', kind: 'rule', title: 'Rule', body: 'app.js:run' });
    a.log({ op: 'orient', client: 'claude', task: 'run', served: [] });
    new Store(gone).init().log({ op: 'orient', client: 'claude', task: 'run', served: [] });
    removeTree(gone); // a test run's temporary checkout, long removed
    const metrics = computeCacheMetrics(new Store(live), { home: tmpHome, all: true });
    assert.equal(metrics.repositoriesCount, 1);
    assert.equal(metrics.totalNotes, 1);
  } finally {
    if (origHome) process.env.THINKER_HOME = origHome;
    else delete process.env.THINKER_HOME;
    for (const d of [live, gone, tmpHome]) removeTree(d);
  }
});

// --- token spend: the proxy, the actions taken and what they measured ---------------------------------------
test('proxy telemetry reports the service, both sides of its holdout, the models and the errors', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-proxy-metrics-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-proxy-home-'));
  try {
    const now = Date.now(), at = ms => new Date(now - ms).toISOString();
    fs.mkdirSync(path.join(tmpHome, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port: 4321, pid: 999999, since: at(5 * 86400_000) }));
    const rows = [
      { at: at(3600_000), op: 'proxy', session: 's1', model: 'claude-opus-5', injected: true, keep: 'turn', input: 1000, read: 20_000, write: 5000, out: 500, cleared: 40_000, clearedUses: 3, overheadMs: 4 },
      { at: at(3500_000), op: 'proxy', session: 's1', model: 'claude-opus-5', injected: true, keep: 'turn', input: 500, read: 10_000, write: 0, out: 100, cleared: 0, overheadMs: 6 },
      { at: at(3400_000), op: 'proxy', session: 's2', model: 'claude-opus-5', injected: false, reason: 'holdout', input: 2000, read: 30_000, write: 8000, out: 900, overheadMs: 1 },
      { at: at(3300_000), op: 'proxy-error', code: 'ECONNRESET', error: 'socket hang up', retried: true },
      { at: at(3200_000), op: 'proxy-error', code: 'ENOTFOUND', error: 'dns', retried: false },
      { at: at(3100_000), op: 'proxy-error', code: 'ECONNRESET', error: 'socket hang up', retried: false, aborted: true },
      { at: at(3000_000), op: 'proxy-error', code: 'ECONNRESET', error: 'aborted', retried: false, truncated: true },
      { at: at(40 * 86400_000), op: 'proxy', session: 'old', model: 'claude-opus-5', injected: true, input: 99_999, read: 0, write: 0, out: 0, cleared: 99_999, overheadMs: 2 },
      { at: at(2900_000), op: 'proxy-standdown', reason: 'the agent sent credentials that are not Anthropic\'s' },
    ];
    fs.writeFileSync(path.join(tmpHome, 'state', 'proxy.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const p = proxyMetrics({ home: tmpHome, now, env: {} });
    assert.equal(p.schemaVersion, 1); assert.equal(p.windowDays, 30);
    assert.equal(p.service.on, true);
    assert.equal(p.service.holdout, 0.15, 'the service holdout share the two sides come from');
    assert.equal(p.sides.clearing.requests, 2, 'the request from 40 days ago is outside the window');
    assert.equal(p.sides.clearing.cleared, 40_000);
    assert.equal(p.sides.clearing.requestsCleared, 1);
    assert.equal(p.sides.holdout.requests, 1);
    assert.equal(p.sides.clearing.billedInput, Math.round(1500 + 0.1 * 30_000 + 2 * 5000));
    assert.equal(p.byModel['claude-opus-5'].clearing.requests, 2);
    assert.equal(p.byModel['claude-opus-5'].holdout.requests, 1);
    assert.equal(p.errors.total, 3, 'tries that errored; the cancelled request is not one of them');
    assert.equal(p.errors.retried, 1);
    assert.equal(p.errors.failed, 2, 'what the agent saw fail: tries minus the ones tried again');
    assert.equal(p.errors.cancelled, 1, 'the agent left; nothing failed');
    assert.equal(p.errors.truncated, 1, 'the answer stopped partway');
    assert.deepEqual(p.errors.byCode, { ECONNRESET: 2, ENOTFOUND: 1 });
    assert.equal(p.standDowns.length, 1, 'the proxy stepping aside is counted, not an error');
    assert.match(p.standDowns[0].reason, /not Anthropic/);
    assert.equal(p.service.standDown, null, 'this service is on');
  } finally {
    removeTree(tmpRepo); removeTree(tmpHome);
  }
});

test('spend telemetry counts the funnel, the decisions and what they measured, and names only the agent\'s own parts', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-spend-metrics-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-spend-home-'));
  try {
    const store = new Store(tmpRepo).init();
    const now = Date.now(), day = 86400_000, iso = ms => new Date(now - ms).toISOString();
    store.log({ op: 'context-suggest', changes: 5, saving: 50_000 });
    store.log({ op: 'context-offer', changes: 5, saving: 50_000, perPrompt: 1_200, ui: true });
    store.log({ op: 'context-approve', changes: 2, saving: 30_000, reviewed: true, pr: 42, group: 'g1', via: 'page' });
    store.log({ op: 'context-approve', changes: 1, saving: 4_000 });
    store.log({ op: 'context-dismiss', changes: 1, via: 'session' });
    store.log({ op: 'context-answer', asked: 'picker', changes: 5, choice: 'some' });
    store.log({ op: 'context-answer', asked: 'chat', changes: 5, choice: 'none' });
    store.log({ op: 'context-revert', kind: 'off' });
    store.log({ op: 'context-job', group: 'g1', action: 'compress', state: 'started' });
    store.log({ op: 'context-job', group: 'g2', action: 'compress', state: 'failed', error: 'the model said no' });
    store.log({ op: 'harness-offer', client: 'claude', sources: 6, tokens: 9_000, ui: false });
    store.log({ op: 'harness-answer', choice: 'off', client: 'claude', sources: 6, chosen: 2, switched: 2, tokens: 3_000 });
    store.log({ op: 'harness-settings', enabled: true, builtinTools: false });
    store.log({ op: 'diet-settings', tools: { 'Bash:grep': 'moderate', 'mcp:private-server': 'moderate' } });
    store.log({ op: 'diet', kind: 'cap', tool: 'Grep', before: 10_000, after: 4_000 });
    store.log({ op: 'diet', kind: 'cap', tool: 'mcp__private__thing', before: 2_000, after: 1_000 });

    // three decisions: a merged section pull request, a built-in tool switched off, a skill switched off
    const history = [
      { id: 'a', at: iso(10 * day), key: 'section:AGENTS.md:Secret section title', kind: 'section', file: 'AGENTS.md',
        title: 'AGENTS.md · Secret section title', what: 'Instruction section', decision: 'pull request', act: 'compress',
        saving: 9_000, tokens: { before: 4_000, after: 1_000 }, pr: { number: 7, state: 'merged', at: iso(9 * day) } },
      { id: 'b', at: iso(8 * day), key: 'claude:builtin:Workflow', kind: 'tool', title: 'Workflow tool',
        what: 'Built-in tool', decision: 'approved', act: 'off', saving: 4_000 },
      { id: 'c', at: iso(7 * day), key: 'claude:skill:secret-internal-skill', kind: 'skill', title: 'secret-internal-skill skill',
        what: 'Custom tool · skill', decision: 'approved', act: 'off', saving: 1_000 },
    ];
    fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history }));
    // a report of this code with sessions on both sides of every decision, so the effects can be worked out
    const row = (days, { files = [], sources = {}, outputs = {} } = {}) => ({ t: now - days * day, input: 100_000, prompts: 10, calls: 10, files, sources, outputs });
    writeReport(store, 6, { sessionRows: [
      row(12, { files: ['AGENTS.md'], sources: { 'claude:builtin:Workflow': 500, 'claude:skill:secret-internal-skill': 300 } }),
      row(11, { files: ['AGENTS.md'], sources: { 'claude:builtin:Workflow': 500, 'claude:skill:secret-internal-skill': 300 } }),
      row(2, { files: ['AGENTS.md'], sources: {} }),
      row(1, { files: ['AGENTS.md'], sources: {} }),
    ] }, { now });

    const { actions, savings } = spendMetrics(store, { all: false, now });
    assert.equal(actions.suggested, 5);
    assert.equal(actions.offers, 1); assert.equal(actions.offersInPage, 1);
    // the changes a summary actually put in a prompt: the denominator of the share accepted, and both readings of
    // what they were worth (2026-10-26)
    assert.equal(actions.offeredChanges, 5); assert.equal(actions.offeredPerPrompt, 1_200);
    // which door each accepted or dismissed change came through; a line logged before the door was recorded counts
    // as the command
    assert.deepEqual(actions.approvedBy, { page: 2, command: 1 });
    assert.deepEqual(actions.dismissedBy, { session: 1 });
    // the weekly question's answers: where they answered, and whether they chose anything (2026-10-27)
    assert.deepEqual(actions.answers, { picker: 1, chat: 1, some: 1, none: 1 });
    assert.equal(actions.approvals, 2); assert.equal(actions.approvedChanges, 3); assert.equal(actions.approvalsAsPr, 1);
    assert.equal(actions.dismissedChanges, 1); assert.equal(actions.reverts, 1);
    assert.equal(actions.jobsStarted, 1); assert.equal(actions.jobsFailed, 1);
    assert.equal(actions.harnessOffers, 1); assert.equal(actions.harnessAnswers.off, 1); assert.equal(actions.harnessSwitchedOff, 2);
    assert.equal(actions.compression.calls, 2); assert.equal(actions.compression.charsSaved, 7_000);
    assert.equal(actions.compression.byKind.cap.calls, 2);
    assert.deepEqual(actions.compression.byTool, { Grep: { calls: 1, charsSaved: 6_000 } }, 'an MCP tool is counted in the totals, never named');
    assert.deepEqual(actions.settings.outputTools, { moderate: 2 }, 'how many tools are compressed, not which');

    const matrix = Object.fromEntries(actions.decisions.map(d => [`${d.group}/${d.outcome}`, d.decisions]));
    assert.deepEqual(matrix, { 'section/pr-merged': 1, 'builtin-tool/applied': 1, 'skill/applied': 1 });
    assert.deepEqual(actions.builtinParts, [{ group: 'builtin-tool', name: 'Workflow', outcome: 'applied', decisions: 1 }]);

    assert.equal(savings.decisions, 3);
    assert.equal(savings.measured, 3, 'every decision has sessions on both sides of it in the kept report');
    const section = savings.byGroup.find(g => g.group === 'section');
    assert.equal(section.beforeTokens, 2 * 4_000 * 10, 'the section cost its tokens in every call of the sessions that read its file');
    assert.equal(section.afterTokens, 2 * 1_000 * 10);
    assert.equal(savings.promptAverage.perPrompt, 10_000);
    assert.equal(savings.repositories.withDecisions, 1);
    assert.equal(savings.rows.length, 3);
    assert.equal(savings.rows[0].group, 'skill', 'newest first');
    assert.ok(savings.rows.every(r => r.effect && r.effect.perPromptBefore >= r.effect.perPromptAfter));

    // the naming rule: nothing identifying leaves the machine
    const blob = JSON.stringify({ actions, savings });
    for (const secret of ['Secret section title', 'secret-internal-skill', 'AGENTS.md', 'private-server', 'mcp__private__thing', tmpRepo]) {
      assert.ok(!blob.includes(secret), `the payload must not carry ${secret}`);
    }
    assert.ok(blob.includes('Workflow'), 'the agent\'s own built-in tools are named');
  } finally {
    removeTree(tmpRepo); removeTree(tmpHome);
  }
});

test('a repository that opted out of telemetry contributes no decisions', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-spend-optout-'));
  try {
    const store = new Store(tmpRepo).init();
    const now = Date.now();
    store.log({ op: 'context-approve', changes: 1, saving: 1_000 });
    fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [
      { id: 'a', at: new Date(now - 86400_000).toISOString(), key: 'claude:builtin:Workflow', kind: 'tool', what: 'Built-in tool', decision: 'approved', act: 'off', saving: 1_000 },
    ] }));
    assert.equal(spendMetrics(store, { all: false, now }).savings.decisions, 1);
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ telemetry: false }));
    const off = spendMetrics(store, { all: false, now });
    assert.equal(off.savings.decisions, 0);
    assert.equal(off.savings.repositories.total, 0);
    assert.equal(off.actions.approvals, 1, 'the machine log is the upload\'s own; the decisions of an opted-out repository are not');
  } finally {
    removeTree(tmpRepo);
  }
});
