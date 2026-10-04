import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { appendImpact } from '../src/impact-journal.js';
import { deliveryMetrics } from '../src/delivery-telemetry.js';
import { buildTelemetryPayload } from '../src/telemetry.js';
import { normalizeReport } from '../infra/metrics/report.mjs';
import { guardScript, install } from '../scripts/install-pr-guard.mjs';

const now = Date.now(), timestamp = new Date(now - 3600000).toISOString();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir).init();
}
function evidence(store, number = 12, total = 400000) {
  const put = e => appendImpact(store, { t: timestamp, ...e });
  put({ op: 'impact-pr', pr: { number, title: 'PRIVATE PR TITLE', url: 'https://github.com/private/repo/pull/12', state: 'MERGED', createdAt: new Date(now - 5 * 3600000).toISOString(), mergedAt: timestamp, commits: ['PRIVATE_SHA'] } });
  put({ op: 'session', session: `PRIVATE_SESSION_${number}`, totalTokens: total, tokenCoverage: total === null ? 'partial' : 'complete' });
  put({ op: 'impact-link', session: `PRIVATE_SESSION_${number}`, allocations: [{ pr: number, share: 1 }] });
  put({ op: 'impact-review', pr: number, runId: `PRIVATE_RUN_${number}`, tokens: 40000, findings: [{ id: `PRIVATE_FINDING_${number}`, message: 'PRIVATE CODE', note: 'PRIVATE_NOTE', evidence: 'private.js:Foo' }] });
}

test('delivery metrics contain only numeric aggregates with complete-token denominators', t => {
  const store = fixture(t); evidence(store); evidence(store, 13, null);
  const d = deliveryMetrics(store, { all: false, now });
  assert.equal(d.mergedPrs, 2); assert.equal(d.completeTokenPrs, 1);
  assert.equal(d.completePrTokens, 440000); assert.equal(d.knownMergedPrTokens, 480000);
  assert.equal(d.reviewTokens, 80000); assert.equal(d.pendingFindings, 2);
  assert.equal(d.tokenBuckets.reduce((sum, b) => sum + b.count, 0), 1);
  assert.equal(d.tokenBuckets[2].count, 1);
  assert.equal(d.openToMergeHours, 8); assert.equal(d.openToMergeSamples, 2);
  assert.equal(d.readyToMergeSamples, 0);
  for (const value of Object.values(d)) if (!Array.isArray(value)) assert.equal(typeof value, 'number');
  const json = JSON.stringify(d);
  for (const secret of ['PRIVATE', 'github.com', 'private.js', store.repo]) assert.ok(!json.includes(secret));
  const payload = buildTelemetryPayload(store, { all: false, home: path.join(store.repo, 'home') });
  assert.deepEqual(payload.delivery, d);
  const row = normalizeReport('test-only', payload, timestamp);
  assert.deepEqual(JSON.parse(row.raw_json).delivery, d);
});

test('repository opt-out excludes delivery data even through machine-wide collection', t => {
  const store = fixture(t); evidence(store);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ telemetry: false }));
  const d = deliveryMetrics(store, { all: true, now });
  assert.equal(d.repositories, 0); assert.equal(d.mergedPrs, 0);
});

test('empty clients report instrumentation without inventing PR outcomes', t => {
  const d = deliveryMetrics(fixture(t), { all: false, now });
  assert.equal(d.schemaVersion, 1); assert.equal(d.windowDays, 30);
  assert.equal(d.repositoriesWithPrData, 0); assert.equal(d.completeTokenPrs, 0);
});

test('worktrees/clones of one origin are not counted twice', t => {
  const a = fixture(t), b = fixture(t);
  for (const s of [a, b]) {
    execFileSync('git', ['init', '-q'], { cwd: s.repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/private/example.git'], { cwd: s.repo });
    evidence(s);
  }
  a.log({ op: 'session', repo: b.repo, session: 'extra', totalTokens: 1 });
  assert.equal(deliveryMetrics(a, { all: true, now }).mergedPrs, 1);
});

test('the PR push guard blocks main updates and deletion but preserves branch pushes and prior hooks', t => {
  const s = fixture(t), dir = s.repo;
  const previous = path.join(dir, 'previous');
  fs.writeFileSync(previous, '#!/bin/sh\ncat > "' + path.join(dir, 'input') + '"\nprintf "%s" "$1" > "' + path.join(dir, 'remote') + '"\n', { mode: 0o755 });
  const hook = path.join(dir, 'guard'); fs.writeFileSync(hook, guardScript(previous), { mode: 0o755 });
  for (const input of ['refs/heads/main abc refs/heads/main def\n', '(delete) 000 refs/heads/main def\n', 'refs/heads/task abc refs/heads/task def\nrefs/heads/main abc refs/heads/main def\n']) {
    const r = spawnSync(hook, ['origin'], { encoding: 'utf8', input });
    assert.equal(r.status, 1); assert.match(r.stderr, /Direct pushes/);
    assert.equal(fs.existsSync(path.join(dir, 'input')), false);
  }
  const input = 'refs/heads/task abc refs/heads/task def\n';
  assert.equal(spawnSync(hook, ['origin'], { encoding: 'utf8', input }).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'input'), 'utf8'), input);
  assert.equal(fs.readFileSync(path.join(dir, 'remote'), 'utf8'), 'origin');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  assert.equal(install(dir).existing, false); assert.equal(install(dir).existing, true);
});
