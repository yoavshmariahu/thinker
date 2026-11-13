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
import { mirrorClearing } from '../src/compression.js';
import { sessionsOf } from '../src/delivery.js';
import { buildTelemetryPayload, armsMetrics } from '../src/telemetry.js';
import { writeReport } from '../src/report-snapshot.js';
import { armTally } from '../src/factory.js';
import { REPORT_WEEKS } from '../src/report.js';
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

// The Factory's two sides leave the machine as sums off the kept report (telemetry.js:armsMetrics): a repository with no
// kept report counts as such and sends nothing, the policy the on side was cleared under rides along, and nothing names
// a repository, a session or a pull request.
test('the arms block is the kept report\'s two sides per feature, as sums, with the cut policy and nothing named', t => {
  const store = fixture(t), home = path.join(store.repo, 'home');
  store.log({ op: 'session', t: at(2), session: 'PRIVATE_SESSION_A', client: 'claude' });
  const empty = armsMetrics(store, { all: false, now });
  assert.equal(empty.schemaVersion, 1); assert.equal(empty.repos, 1); assert.equal(empty.reposWithoutReport, 1);
  assert.equal(empty.profile.shown, null); assert.equal(empty.compression.on, null); assert.equal(empty.reportsFrom, null);
  assert.match(empty.policy, /^r\d+-t\d+k-f\d+k-p\d+-(deep|one)$/, 'the policy this machine runs today');
  const stage = { cost: 0, tokens: 0, rework: 0, reworkTokens: 0 }, stages = Object.fromEntries(['prompts', 'think', 'explore', 'build', 'verify', 'review', 'merge'].map(k => [k, { ...stage }]));
  const r = (cost, exchanges, loops = []) => ({ cost, tokens: cost * 1e5, calls: 10, exchanges, stages: { ...stages, build: { cost: cost / 2, tokens: 0, rework: cost / 10, reworkTokens: 0 } }, loops, cacheWrite: 1000, cacheRead: 9000 });
  const tally = armTally(0.5, 'r1-t140k-f60k-p25-deep');
  tally.add({ profile: 'shown', compression: 'on' }, r(10, 4, [{ kind: 'fix', cost: 1, tokens: 0 }]), 'PRIVATE_SESSION_A');
  tally.add({ profile: 'holdout', compression: 'holdout' }, r(30, 6), 'PRIVATE_SESSION_B');
  tally.pr({ profile: 'shown', compression: 'on' }, true, 10);
  writeReport(store, REPORT_WEEKS, { factory: { arms: tally.finish() } }, { now });
  const a = armsMetrics(store, { all: false, now });
  assert.equal(a.repos, 1); assert.equal(a.reposWithoutReport, 0); assert.equal(a.reportsFrom, new Date(now).toISOString());
  assert.deepEqual([a.profile.shown.sessions, a.profile.shown.cost, a.profile.shown.exchanges, a.profile.shown.cost2], [1, 10, 4, 100]);
  assert.deepEqual([a.profile.holdout.sessions, a.profile.holdout.cost, a.profile.holdout.exchanges], [1, 30, 6]);
  assert.deepEqual(a.compression.on.prs, { merged: 1, firstPass: 1, cost: 10 }); assert.equal(a.compression.rate, 0.5);
  assert.deepEqual(a.compression.on.loops, { fix: { loops: 1, cost: 1, tokens: 0, sessions: 1 } }); assert.equal(a.profile.shown.stages.build.rework, 1);
  assert.equal(a.compression.holdout.cacheWrite, 1000);
  const text = JSON.stringify(a);
  assert.ok(!/PRIVATE|session|\/tmp|thinker-delivery/i.test(text.replace(/"sessions"/g, '')), 'no session id, path or repository in the block');
  const payload = buildTelemetryPayload(store, { all: false, home });
  assert.equal(payload.arms.profile.shown.sessions, 1, 'the payload carries it');
});

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
    if (key === 'byPolicy' || key === 'byDay') { for (const g of Object.values(value)) for (const n of Object.values(g)) assert.equal(typeof n, 'number'); continue; }
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
  // the day a pull request merged carries its own figures, so a cost per pull request can be trended and a
  // total added up -- which the 30-day rolling sums above can never be
  const days = Object.keys(d.byDay);
  assert.equal(days.length, 1, 'both merged on the same day');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(days[0]));
  assert.equal(d.byDay[days[0]].prs, 2);
  assert.equal(d.byDay[days[0]].clearedPrs, 2);
  assert.equal(d.byDay[days[0]].clearedTokens, d.clearedTokens, 'the days account for every cleared token');
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

// A desktop session reaches no proxy, so its clear lives in the clearing mod's own state file -- which is a
// card's working memory, pruned after two days. Every window that reads a saving is longer than that, so the
// Stop hook mirrors the clear into the machine's log, where it lasts as long as the log does.
test('a desktop clear still counts after its record is pruned, with its cost and its policy', t => {
  const store = fixture(t), home = path.join(store.repo, 'home');
  const dir = path.join(home, 'state', 'compression');
  fs.mkdirSync(dir, { recursive: true });
  const session = 'PRIVATE_DESKTOP_SESSION';
  const record = { session, saved: 90_000, uses: 5, requests: 3, policy: 'r1-t140k-f60k-p25-deep',
    model: 'claude-opus-5-5', lastAt: now - 3600_000, cost: { rewrites: 2, write: 120_000 } };
  const file = path.join(dir, `${session}.json`);
  fs.writeFileSync(file, JSON.stringify(record));
  store.log({ op: 'session', t: at(4), session, client: 'claude', model: 'claude-opus-5-5', turns: 8, totalTokens: 300_000, tokenCoverage: 'complete' });

  // the hook mirrors it once, and does not write the same total again
  const first = mirrorClearing(dir, session, row => store.log({ ...row, t: at(3) }));
  assert.equal(first.cleared, 90_000);
  assert.equal(first.policy, 'r1-t140k-f60k-p25-deep');
  assert.deepEqual(first.cost, { rewrites: 2, write: 120_000 });
  assert.equal(mirrorClearing(dir, session, () => { throw new Error('wrote the same clear twice'); }), null);
  // a later clear in the same session raises the total, so a new row is written
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), saved: 150_000 }));
  assert.equal(mirrorClearing(dir, session, row => store.log({ ...row, t: at(2) })).cleared, 150_000);

  // now the record is gone, as the prune would leave it
  fs.rmSync(file);
  const { sessions: s } = deliveryMetrics(store, { all: false, now, home });
  assert.equal(s.cleared.sessions, 1, 'the session still reads as cleared');
  assert.equal(s.cleared.clearedTokens, 150_000, 'at the newest total, never the sum of the rows');
  assert.equal(s.byPolicy['r1-t140k-f60k-p25-deep'].sessions, 1, 'under the policy that cleared it');
  assert.ok(s.cleared.savedUsd > 0, 'priced from the model the record named');
  assert.ok(s.cleared.rewriteUsd > 0, 'and what the clear cost is charged too');
  assert.equal(s.cleared.netUsd, Math.round((s.cleared.savedUsd - s.cleared.rewriteUsd) * 100) / 100);
});

// Two faults that made every windowed dollar figure wrong, found by asking what the last five days saved.
test('a window holds the clears made inside it, priced at the model the proxy saw', t => {
  const store = fixture(t), home = path.join(store.repo, 'home');
  const dir = path.join(home, 'state', 'compression');
  fs.mkdirSync(dir, { recursive: true });
  const old = 'PRIVATE_OLD_SESSION', fresh = 'PRIVATE_FRESH_SESSION';
  // a session whose clear happened well before the window, with an event inside it
  fs.writeFileSync(path.join(dir, `${old}.json`), JSON.stringify({ session: old, saved: 400_000_000, requests: 9, lastAt: now - 12 * 86400_000 }));
  store.log({ op: 'session', t: at(1), session: old, client: 'claude', turns: 4, totalTokens: 10_000, tokenCoverage: 'complete' });
  // and one cleared inside it, whose own `session` row names no model: the proxy's rows do
  fs.writeFileSync(path.join(dir, `${fresh}.json`), JSON.stringify({ session: fresh, saved: 5_000_000, requests: 3, lastAt: now - 3600_000, model: 'claude-opus-5-5' }));
  store.log({ op: 'session', t: at(2), session: fresh, client: 'claude', turns: 6, totalTokens: 20_000, tokenCoverage: 'complete' });

  const five = new Date(now - 5 * 86400_000).toISOString();
  const inWindow = sessionsOf(store, { since: five, home });
  assert.equal(inWindow.get(old).cleared, 0, 'a clear made before the window is not a saving inside it');
  assert.equal(inWindow.get(fresh).cleared, 5_000_000);
  assert.ok(inWindow.get(fresh).cost.priced, 'priced from the model the clearing itself recorded');
  assert.ok(inWindow.get(fresh).cost.saved > 0);
  // the same record counts in a window that holds it
  const all = sessionsOf(store, { since: new Date(now - 30 * 86400_000).toISOString(), home });
  assert.equal(all.get(old).cleared, 400_000_000);
  // a record with no date at all cannot be judged, so it is kept rather than dropped
  const undated = 'PRIVATE_UNDATED';
  fs.writeFileSync(path.join(dir, `${undated}.json`), JSON.stringify({ session: undated, saved: 7_000, requests: 1 }));
  store.log({ op: 'session', t: at(1), session: undated, client: 'claude', turns: 1, totalTokens: 100, tokenCoverage: 'complete' });
  assert.equal(sessionsOf(store, { since: five, home }).get(undated).cleared, 7_000);
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
