// `thinker prs`: which pull request a session belongs to, and what thinker saved on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { appendDelivery, readDelivery, deliveryFile } from '../src/delivery-journal.js';
import { deliveryReport, renderDelivery, linkSession, syncPrs, sessionsOf, SAVED_BUCKETS } from '../src/delivery.js';

const now = Date.parse('2026-10-29T12:00:00.000Z');
const at = hoursAgo => new Date(now - hoursAgo * 3600_000).toISOString();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-prs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir).init();
  const home = path.join(dir, 'home');
  return { store, home };
}

// What the context proxy left out of this session's prompts, where compression.js keeps it.
function cleared(home, session, saved) {
  const dir = path.join(home, 'state', 'compression');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.json`), JSON.stringify({ session, saved, requests: 4, firstAt: at(5), lastAt: at(1) }));
}

// A session that was served two notes, acted on one, and ran on a branch.
function session(store, { id, branch, head, tokens = 300_000, turns = 12, reading = 9000 }) {
  store.log({ op: 'orient', t: at(6), session: id, served: ['n1', 'n2'], est: [[2, reading], [1, 500]], tokens: 700 });
  store.log({ op: 'attest', t: at(2), session: id, model: 'claude-opus-5', applied: [{ id: 'n1', verdict: 'confirmed' }, { id: 'n2', verdict: 'unused' }] });
  store.log({ op: 'session', t: at(1), session: id, client: 'claude', branch, head, turns, totalTokens: tokens, tokenCoverage: 'complete' });
}

function pullRequest(store, pr) {
  appendDelivery(store, { t: at(1), op: 'pr', pr: { state: 'MERGED', createdAt: at(30), mergedAt: at(1), ...pr } });
}

test('a session is matched to the pull request of its branch, and carries its savings there', t => {
  const { store, home } = fixture(t);
  session(store, { id: 's1', branch: 'agent/fix-thing', head: 'aaa1' });
  cleared(home, 's1', 120_000);
  pullRequest(store, { number: 12, title: 'Fix the thing', branch: 'agent/fix-thing', commits: ['aaa1'] });

  const r = deliveryReport(store, { now, home });
  assert.equal(r.prs.length, 1);
  const p = r.prs[0];
  assert.equal(p.sessions.length, 1);
  assert.equal(p.sessions[0].link, 'commit');         // the head it sat on is one of the PR's commits
  assert.equal(p.saved.cleared, 120_000);             // measured
  assert.equal(p.saved.reading.tokens, 9000);         // estimated, the confirmed serving only
  assert.equal(p.saved.reading.servings, 1);
  assert.equal(p.saved.total, 129_000);
  assert.equal(p.tokens.agent, 300_000);
  assert.equal(p.tokens.complete, true);
  assert.equal(p.notes.served, 2);
  assert.equal(p.notes.actedOn, 1);
  assert.equal(p.hoursToMerge, 29);
  assert.equal(r.summary.merged, 1);
  assert.equal(r.summary.mergedAssisted, 1);
  assert.equal(r.summary.saved.total, 129_000);
  assert.equal(r.summary.sessions.unlinked, 0);
  const text = renderDelivery(r, { detail: true });
  assert.match(text, /cleared\s+120k tokens the API left out of their prompts \(measured\)/);
  assert.match(text, /reading avoided\s+9k tokens of files the notes meant nobody read \(estimate\)/);
  assert.match(text, /Merged with work recorded here: 1 of 1 merged in the repository/);
});

test('the branch alone links a session whose commits GitHub has not seen', t => {
  const { store, home } = fixture(t);
  session(store, { id: 's2', branch: 'agent/wip', head: 'local1' });
  pullRequest(store, { number: 13, branch: 'agent/wip', commits: ['pushed1'], state: 'OPEN', mergedAt: null });
  const p = deliveryReport(store, { now, home }).prs[0];
  assert.equal(p.sessions[0].link, 'branch');
  assert.equal(p.state, 'OPEN');
  assert.equal(deliveryReport(store, { now, home }).summary.merged, 0);
});

test('a branch used by two pull requests goes to the one the session falls inside', t => {
  const { store, home } = fixture(t);
  session(store, { id: 's3', branch: 'agent/shared', head: 'x1' });
  pullRequest(store, { number: 20, branch: 'agent/shared', createdAt: at(200), mergedAt: at(100) });
  pullRequest(store, { number: 21, branch: 'agent/shared', createdAt: at(50), mergedAt: at(0.5) });
  const r = deliveryReport(store, { now, home });
  assert.equal(r.prs.find(p => p.sessions.length).number, 21);
});

test('a person saying so beats anything read from git, and a split divides one session', t => {
  const { store, home } = fixture(t);
  session(store, { id: 's4', branch: 'agent/one', head: 'y1', tokens: 200_000 });
  cleared(home, 's4', 100_000);
  pullRequest(store, { number: 30, branch: 'agent/one', commits: ['y1'] });
  pullRequest(store, { number: 31, branch: 'agent/two' });
  linkSession(store, 's4', [{ pr: 30, share: 0.25 }, { pr: 31, share: 0.75 }], { home });
  const r = deliveryReport(store, { now, home });
  const a = r.prs.find(p => p.number === 30), b = r.prs.find(p => p.number === 31);
  assert.equal(a.sessions[0].link, 'manual');
  assert.equal(a.saved.cleared, 25_000);
  assert.equal(b.saved.cleared, 75_000);
  assert.equal(a.tokens.agent + b.tokens.agent, 200_000);
  assert.throws(() => linkSession(store, 's4', [{ pr: 30, share: 0.5 }], { home }), /sum to 1/);
  assert.throws(() => linkSession(store, 'never-ran', [{ pr: 30, share: 1 }], { home }), /Unknown recorded session/);
});

test('a session on no pull request is named, not dropped', t => {
  const { store, home } = fixture(t);
  session(store, { id: 's5', branch: 'main', head: 'z1' });
  const r = deliveryReport(store, { now, home });
  assert.equal(r.prs.length, 0);
  assert.equal(r.summary.sessions.unlinked, 1);
  assert.equal(r.unlinkedSessions[0].id, 's5');
  assert.match(renderDelivery(r), /belongs to no pull request yet/);
});

test('an observation links a session that served nothing and was never assessed', t => {
  const { store, home } = fixture(t);
  appendDelivery(store, { t: at(4), op: 'observation', session: 's6', client: 'codex', branch: 'agent/quiet', head: 'q1' });
  cleared(home, 's6', 40_000);
  pullRequest(store, { number: 40, branch: 'agent/quiet' });
  const p = deliveryReport(store, { now, home }).prs[0];
  assert.equal(p.sessions.length, 1);
  assert.equal(p.saved.cleared, 40_000);
  assert.equal(p.saved.reading.tokens, 0);
  assert.equal(p.tokens.complete, false);   // nothing counted this session's tokens
});

test('the window holds: an older pull request is left out, and --pr brings it back', t => {
  const { store, home } = fixture(t);
  session(store, { id: 's7', branch: 'agent/old', head: 'o1' });
  pullRequest(store, { number: 50, branch: 'agent/old', createdAt: at(24 * 90), mergedAt: at(24 * 60) });
  assert.equal(deliveryReport(store, { now, home }).prs.length, 0);
  assert.equal(deliveryReport(store, { now, home, days: 365 }).prs.length, 1);
  assert.equal(deliveryReport(store, { now, home, pr: 50 }).prs.length, 1);
});

test('sync reads the listing once and pays for detail only on the pull requests worked on here', async t => {
  const { store, home } = fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: store.repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/private/repo.git'], { cwd: store.repo });
  session(store, { id: 's8', branch: 'agent/mine', head: 'm1' });
  const calls = [];
  const listing = [
    { number: 60, title: 'Mine', html_url: 'u60', state: 'closed', merged_at: at(2), created_at: at(20), updated_at: at(2), head: { ref: 'agent/mine', sha: 'm1' }, base: { sha: 'b' }, merge_commit_sha: 'mc', user: { login: 'me' } },
    { number: 61, title: 'Theirs', html_url: 'u61', state: 'open', merged_at: null, created_at: at(10), updated_at: at(3), head: { ref: 'other/branch', sha: 't1' }, base: { sha: 'b' }, user: { login: 'them' } },
  ];
  const request = async endpoint => {
    calls.push(endpoint);
    if (endpoint.startsWith('repos/private/repo/pulls?')) return endpoint.includes('page=1') ? listing : [];
    if (/pulls\/60\/commits/.test(endpoint)) return [{ sha: 'm1' }];
    if (/pulls\/60$/.test(endpoint)) return { ...listing[0], additions: 10, deletions: 2, changed_files: 3 };
    throw new Error(`unexpected ${endpoint}`);
  };
  const r = await syncPrs(store, { request, now, home });
  assert.equal(r.synced, 2);
  assert.equal(r.detailed, 2);                                   // one detail call and one commits call, for #60 alone
  assert.ok(!calls.some(c => /pulls\/61/.test(c)), 'a pull request nobody here worked on costs no extra call');

  const report = deliveryReport(store, { now, home });
  const mine = report.prs.find(p => p.number === 60);
  assert.equal(mine.state, 'MERGED');
  assert.equal(mine.changedFiles, 3);
  assert.equal(mine.sessions.length, 1);
  assert.equal(report.prs.find(p => p.number === 61).sessions.length, 0);
});

test('the saved buckets cover every merged pull request exactly once', () => {
  for (const saved of [0, 1, 10_000, 10_001, 999_999, 5_000_000]) {
    const hit = SAVED_BUCKETS.filter(u => u === null || saved <= u);
    assert.ok(hit.length >= 1, `no bucket for ${saved}`);
  }
});

test('the journal refuses a record it does not know and survives a torn line', t => {
  const { store } = fixture(t);
  assert.throws(() => appendDelivery(store, { op: 'review', pr: 1 }), /Unknown delivery record/);
  appendDelivery(store, { op: 'observation', session: 's9', branch: 'b', head: 'h' });
  fs.appendFileSync(deliveryFile(store), '{"op":"pr"\n');
  const r = readDelivery(store);
  assert.equal(r.events.length, 1);
  assert.equal(r.warnings.length, 1);
});

test('sessionsOf keeps the last token count a session reported', t => {
  const { store, home } = fixture(t);
  store.log({ op: 'session', t: at(5), session: 'sA', turns: 2, totalTokens: 1000, tokenCoverage: 'complete' });
  store.log({ op: 'session', t: at(1), session: 'sA', turns: 9, totalTokens: 9000, tokenCoverage: 'complete' });
  const x = sessionsOf(store, { home }).get('sA');
  assert.equal(x.tokens, 9000);
  assert.equal(x.prompts, 9);
});
