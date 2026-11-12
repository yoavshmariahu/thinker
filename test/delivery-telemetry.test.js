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
  const { prs: d } = deliveryMetrics(store, { all: false, now, home });
  assert.equal(d.schemaVersion, 3);
  assert.equal(d.merged, 2);
  assert.equal(d.mergedAssisted, 2);
  assert.equal(d.worked, 2);
  assert.equal(d.clearedTokens, 150_000);        // measured
  assert.equal(d.savedTokens, 150_000);
  assert.equal(d.agentTokens, 400_000);          // the session that reported none adds nothing
  assert.equal(d.completeTokenPrs, 1);
  assert.equal(d.linkedSessions, 2);
  assert.equal(d.unlinkedSessions, 0);
  assert.equal(d.hoursToMergeSamples, 2);
  assert.equal(d.hoursToMerge, 16);
  assert.equal(d.savedBuckets.reduce((n, b) => n + b.count, 0), 2);
  // the netted dollars, as delivery.js prices them: saved less the cache rewrites after a clear, signed
  for (const k of ['savedUsd', 'rewriteUsd', 'netUsd', 'costedPrs']) assert.equal(typeof d[k], 'number', k);
  assert.equal(d.netUsd, Math.round((d.savedUsd - d.rewriteUsd) * 100) / 100);
  assert.ok(d.costedPrs <= d.merged);
  // every figure is a number, a list of numbers, or a group of them under a policy name
  for (const [key, value] of Object.entries(d)) {
    if (Array.isArray(value)) continue;
    if (key === 'byPolicy') { for (const g of Object.values(value)) for (const n of Object.values(g)) assert.equal(typeof n, 'number'); continue; }
    assert.equal(typeof value, 'number', key);
  }
  // what a pull request cost in model calls, and whether it got a clear and how much (the owner's ask, 2026-11-11)
  assert.equal(d.clearedPrs, 2);
  assert.equal(typeof d.spendUsd, 'number');
  assert.ok(d.spendPrs <= d.merged, 'a pull request with an unpriced session is in neither cost figure');
  assert.equal(d.rows.length, 2);
  for (const r of d.rows) {
    assert.equal(r.cleared, true);
    assert.ok(r.clearedTokens > 0);
    assert.equal(typeof r.sessions, 'number');
    assert.ok(r.spendUsd === null || typeof r.spendUsd === 'number');
  }
  // a saving made before the policy was stamped on the record says so, and is never pooled with today's
  assert.deepEqual(Object.keys(d.byPolicy), ['unstamped']);
  assert.equal(d.byPolicy.unstamped.prs, 2);
  assert.equal(d.byPolicy.unstamped.clearedTokens, 150_000);
  const json = JSON.stringify(d);
  for (const secret of ['PRIVATE', 'github.com', store.repo]) assert.ok(!json.includes(secret), `leaked ${secret}`);
});

// The figure the pull request cannot give: most sessions belong to none, and a long session is not a costly
// one, so the work denominator (`prompts`) rides beside the dollars.
test('savings per session are counted once each, split by what actually happened to the session', t => {
  const store = fixture(t), home = path.join(store.repo, 'home');
  evidence(store, home);                                                   // one session, cleared, on a merged PR
  evidence(store, home, 13, { tokens: 50_000, clearedTokens: 0 });         // one session, never cleared
  const { sessions: s, prs } = deliveryMetrics(store, { all: false, now, home });
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.windowDays, 30);
  assert.equal(s.all.sessions, 2);
  assert.equal(s.all.prompts, 20, "the session's own model calls, the denominator of a cost per prompt");
  assert.equal(s.cleared.sessions, 1);
  assert.equal(s.uncleared.sessions, 1);
  assert.equal(s.cleared.clearedTokens, 120_000);
  assert.equal(s.uncleared.clearedTokens, 0);
  assert.equal(s.all.sessions, s.cleared.sessions + s.uncleared.sessions, 'a session is in exactly one of the two');
  assert.equal(s.cleared.clearedSessions, s.cleared.sessions);
  // the groups are sums, so a rate is the reader's own division and never a mean of per-session ratios
  assert.equal(s.all.clearedTokens, s.cleared.clearedTokens);
  assert.equal(s.byClient.claude.sessions, 2);
  assert.equal(s.byPolicy.unstamped.sessions, 1, 'the cleared one, under no recorded policy');
  assert.equal(s.byPolicy.none.sessions, 1, 'and the one nothing cleared');
  assert.equal(s.netBuckets.reduce((n, b) => n + b.count, 0), s.cleared.pricedSessions);
  // a session is counted here whether or not it reached a pull request, which is the point of the block
  assert.ok(s.all.sessions >= prs.linkedSessions);
  for (const secret of ['PRIVATE', 'github.com', store.repo]) assert.ok(!JSON.stringify(s).includes(secret), `leaked ${secret}`);
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
  const { prs: d } = deliveryMetrics(store, { all: true, now, home });
  assert.equal(d.repositories, 0);
  assert.equal(d.merged, 0);
});

test('an install with nothing to report invents no pull requests', t => {
  const { prs: d, sessions } = deliveryMetrics(fixture(t), { all: false, now });
  assert.equal(sessions.all.sessions, 0, 'and no sessions either');
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
  assert.equal(deliveryMetrics(a, { all: true, now, home }).prs.merged, 1);
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
