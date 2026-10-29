// What leaves the machine about pull requests: counts and tokens, and nothing that names one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { appendDelivery } from '../src/delivery-journal.js';
import { deliveryMetrics } from '../src/delivery-telemetry.js';
import { buildTelemetryPayload } from '../src/telemetry.js';
import { normalizeReport } from '../infra/metrics/report.mjs';
import { installGitHooks, uninstallGitHooks } from '../src/git-hooks.js';
import { guardScript, install, MARKER } from '../scripts/install-pr-guard.mjs';

const now = Date.now();
const at = hoursAgo => new Date(now - hoursAgo * 3600_000).toISOString();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-delivery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir).init();
}

// One merged pull request with one session on its branch: tokens spent, tokens cleared, a note acted on.
function evidence(store, home, number = 12, { tokens = 400_000, clearedTokens = 120_000, complete = true } = {}) {
  const session = `PRIVATE_SESSION_${number}`;
  store.log({ op: 'orient', t: at(6), session, served: ['n1'], est: [[2, 9000]], tokens: 700 });
  store.log({ op: 'attest', t: at(5), session, applied: [{ id: 'n1', verdict: 'confirmed' }] });
  store.log({ op: 'session', t: at(4), session, client: 'claude', branch: `PRIVATE_BRANCH_${number}`, head: `PRIVATE_SHA_${number}`, turns: 10, ...(tokens === null ? {} : { totalTokens: tokens }), tokenCoverage: complete ? 'complete' : 'partial' });
  const dir = path.join(home, 'state', 'compression');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.json`), JSON.stringify({ session, saved: clearedTokens, requests: 4 }));
  appendDelivery(store, { t: at(3), op: 'pr', pr: { number, title: 'PRIVATE PR TITLE', url: 'https://github.com/private/repo/pull/12', state: 'MERGED', branch: `PRIVATE_BRANCH_${number}`, author: 'PRIVATE_AUTHOR', createdAt: at(12), mergedAt: at(4), commits: [`PRIVATE_SHA_${number}`] } });
}

test('pull request metrics are numbers only, and name nothing', t => {
  const store = fixture(t), home = path.join(store.repo, 'home');
  evidence(store, home);
  evidence(store, home, 13, { tokens: null, clearedTokens: 30_000, complete: false });
  const d = deliveryMetrics(store, { all: false, now, home });
  assert.equal(d.schemaVersion, 2);
  assert.equal(d.merged, 2);
  assert.equal(d.mergedAssisted, 2);
  assert.equal(d.worked, 2);
  assert.equal(d.clearedTokens, 150_000);        // measured
  assert.equal(d.readingTokens, 18_000);         // estimated, one confirmed serving each
  assert.equal(d.savedTokens, 168_000);
  assert.equal(d.agentTokens, 400_000);          // the session that reported none adds nothing
  assert.equal(d.completeTokenPrs, 1);
  assert.equal(d.linkedSessions, 2);
  assert.equal(d.unlinkedSessions, 0);
  assert.equal(d.hoursToMergeSamples, 2);
  assert.equal(d.hoursToMerge, 16);
  assert.equal(d.savedBuckets.reduce((n, b) => n + b.count, 0), 2);
  for (const value of Object.values(d)) if (!Array.isArray(value)) assert.equal(typeof value, 'number');
  const json = JSON.stringify(d);
  for (const secret of ['PRIVATE', 'github.com', store.repo]) assert.ok(!json.includes(secret), `leaked ${secret}`);
});

test('the payload carries them, and the metrics API promotes them to columns', t => {
  const store = fixture(t), home = path.join(store.repo, 'home');
  evidence(store, home);
  const payload = buildTelemetryPayload(store, { all: false, home });
  assert.equal(payload.prs.merged, 1);
  assert.equal(payload.delivery, undefined);
  const row = normalizeReport('test-only', payload, new Date(now).toISOString());
  assert.equal(row.prs_merged, 1);
  assert.equal(row.prs_merged_assisted, 1);
  assert.equal(row.pr_saved_tokens, payload.prs.savedTokens);
  assert.equal(row.pr_cleared_tokens, payload.prs.clearedTokens);
  assert.equal(row.pr_reading_tokens, payload.prs.readingTokens);
  assert.equal(row.pr_agent_tokens, payload.prs.agentTokens);
  assert.equal(row.prs_linked_sessions, 1);
  assert.deepEqual(JSON.parse(row.raw_json).prs, payload.prs);
});

test('a report from before this release reads as no pull requests, not as a refusal', () => {
  const row = normalizeReport('old', { installId: 'i', timestamp: new Date(now).toISOString(), delivery: { mergedPrs: 4 } }, new Date(now).toISOString());
  assert.equal(row.prs_merged, 0);
  assert.equal(row.pr_saved_tokens, 0);
});

test("a repository's opt-out holds even when another repository triggered the upload", t => {
  const store = fixture(t), home = path.join(store.repo, 'home');
  evidence(store, home);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ telemetry: false }));
  const d = deliveryMetrics(store, { all: true, now, home });
  assert.equal(d.repositories, 0);
  assert.equal(d.merged, 0);
});

test('an install with nothing to report invents no pull requests', t => {
  const d = deliveryMetrics(fixture(t), { all: false, now });
  assert.equal(d.repositoriesWithPrs, 0);
  assert.equal(d.merged, 0);
  assert.equal(d.savedTokens, 0);
});

test('worktrees and clones of one origin are not counted twice', t => {
  const a = fixture(t), b = fixture(t), home = path.join(a.repo, 'home');
  for (const s of [a, b]) {
    execFileSync('git', ['init', '-q'], { cwd: s.repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/private/example.git'], { cwd: s.repo });
    evidence(s, home);
  }
  a.log({ op: 'session', repo: b.repo, session: 'extra', totalTokens: 1 });
  assert.equal(deliveryMetrics(a, { all: true, now, home }).merged, 1);
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
  const installed = install(dir);
  assert.equal(installed.existing, false); assert.equal(install(dir).existing, true);
  const policy = fs.readFileSync(installed.hook, 'utf8');
  installGitHooks(dir, '/unused/cli.js', true);
  uninstallGitHooks(dir);
  assert.equal(fs.readFileSync(installed.hook, 'utf8'), policy);
  fs.writeFileSync(installed.hook, policy.replace(MARKER, '# thinker: require pull requests for main'));
  assert.equal(install(dir).existing, true);
  assert.equal(fs.readFileSync(installed.hook, 'utf8'), policy);
});
