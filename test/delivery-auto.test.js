import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { syncPrs } from '../src/delivery.js';
import { commentOnPr } from '../src/delivery-comment.js';
import { commentRepos, runAutomaticPrComments, PR_COMMENT_LIMIT } from '../src/delivery-auto.js';
import { withCommentLock } from '../src/delivery-lock.js';
import { updateCommand } from '../src/commands/setup.js';
import { UPDATE_EVERY_MS } from '../src/update.js';
import { setRepoDisabled } from '../src/repo-switch.js';

const now = Date.now(), hour = 3600_000;
const at = delta => new Date(now + delta * hour).toISOString();

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-auto-pr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: dir });
  const store = new Store(dir).init(), home = path.join(dir, 'home');
  fs.mkdirSync(home);
  store.log({ op: 'orient', t: at(-2), session: 'session1', branch: 'fix', head: 'sha1', served: ['note1'], est: [[1, 9000]] });
  store.log({ op: 'attest', t: at(-1), session: 'session1', model: 'claude-opus-5', applied: [{ id: 'note1', verdict: 'confirmed' }] });
  const pull = { number: 42, state: 'closed', created_at: at(-5), updated_at: at(-1), merged_at: at(-1), head: { ref: 'fix', sha: 'sha1' }, base: { sha: 'base' } };
  const reads = [], writes = [], comments = [];
  const request = async (endpoint, opts) => {
    reads.push(endpoint);
    if (endpoint.includes('/pulls?')) return [pull];
    if (endpoint.endsWith('/pulls/42')) return pull;
    if (endpoint.includes('/commits?')) return [[{ sha: 'sha1' }]];
    if (endpoint === 'user') return { id: 1 };
    if (endpoint.includes('/comments?')) return [comments];
    throw new Error(`unexpected ${endpoint}`);
  };
  const write = async (endpoint, options) => {
    writes.push({ endpoint, ...options });
    const result = { id: 123, user: { id: 1 }, body: options.body, html_url: 'https://github.com/owner/repo/pull/42#issuecomment-123' };
    comments.splice(0, comments.length, result);
    return result;
  };
  const fns = {
    available: () => true,
    sync: (s, options) => syncPrs(s, { ...options, request }),
    comment: (s, options) => commentOnPr(s, { ...options, request, write }),
  };
  const run = options => runAutomaticPrComments(store, { home, now, fns, ...options });
  const initialize = () => run({ now: now - 4 * hour });
  const stateFile = path.join(home, 'state', 'pr-comments.json');
  return { dir, store, home, pull, reads, writes, comments, fns, run, initialize, stateFile };
}

test('first pass only records a start date; next pass posts once and syncs the window once', async t => {
  const f = fixture(t);
  assert.equal((await f.initialize()).initialized, true);
  assert.deepEqual(f.reads, []);
  const result = await f.run();
  assert.equal(result.posted, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(f.writes[0].method, 'POST');
  assert.equal(f.reads.filter(e => e.includes('/pulls?')).length, 1);
  assert.match(f.writes[0].body, /thinker saved you some tokens/);
  const reads = f.reads.length;
  await f.run();
  assert.equal(f.reads.length, reads, 'per-repo four-hour throttle');
  await f.run({ now: now + UPDATE_EVERY_MS });
  assert.equal(f.writes.length, 1, 'receipt prevents reposts and date-only edits');
});

test('no backfill, open PR, missing savings, and active sessions never publish', async t => {
  const f = fixture(t);
  await f.initialize();
  f.pull.merged_at = at(-5);
  assert.equal((await f.run()).posted, 0);
  f.pull.merged_at = null; f.pull.state = 'open';
  assert.equal((await f.run({ now: now + 4 * hour })).posted, 0);
  f.pull.merged_at = at(-1); f.pull.state = 'closed';
  f.store.log({ op: 'attest', t: at(8), session: 'session1', applied: [{ id: 'note1', verdict: 'unused' }] });
  assert.equal((await f.run({ now: now + 8 * hour })).posted, 0);
  f.store.log({ op: 'attest', t: at(12), session: 'session1', applied: [{ id: 'note1', verdict: 'confirmed' }] });
  assert.equal((await f.run({ now: now + 12 * hour })).posted, 0, 'session still active');
  assert.equal((await f.run({ now: now + 16 * hour })).posted, 1, 'next check after quiet');
});

test('a just-merged PR waits twenty minutes, even when its session is already quiet', async t => {
  const f = fixture(t);
  await f.initialize();
  f.pull.merged_at = at(-0.1);
  assert.equal((await f.run()).posted, 0);
  assert.equal((await f.run({ now: now + 4 * hour })).posted, 1);
});

test('GitHub timestamps without milliseconds do not turn a pre-activation merge into a new one', async t => {
  const f = fixture(t);
  const second = Math.floor((now - 4 * hour) / 1000) * 1000;
  await f.run({ now: second + 500 });
  f.pull.merged_at = new Date(second).toISOString().replace('.000Z', 'Z');
  assert.equal((await f.run()).posted, 0);
});

test('missing gh login, sync errors and posting failures are retried without a success receipt', async t => {
  const f = fixture(t);
  await f.initialize();
  assert.equal((await f.run({ fns: { ...f.fns, available: () => false } })).posted, 0);
  assert.equal(f.reads.length, 0);
  const syncFailure = await f.run({ fns: { ...f.fns, sync: () => { throw new Error('offline'); } } });
  assert.equal(syncFailure.errors[0].error, 'offline');
  const failure = await f.run({ fns: { ...f.fns, comment: () => { throw new Error('forbidden'); } } });
  assert.equal(failure.errors[0].error, 'forbidden');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)).repos['github.com/owner/repo'].posted, {});
  assert.equal((await f.run({ now: now + UPDATE_EVERY_MS })).posted, 1);
});

test('dry runs have no network or state writes; machine/repository opt-outs and disabled repos are respected', async t => {
  const f = fixture(t);
  const dry = await f.run({ dry: true });
  assert.equal(dry.initialized, false);
  assert.equal(fs.existsSync(f.stateFile), false);
  await f.initialize();
  // Populate the local journal once, then preview entirely offline.
  await f.fns.sync(f.store, { now });
  const before = fs.readFileSync(f.stateFile, 'utf8'), reads = f.reads.length;
  assert.equal((await f.run({ dry: true })).candidates.length, 1);
  assert.equal(f.reads.length, reads);
  assert.equal(fs.readFileSync(f.stateFile, 'utf8'), before);
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({ prComments: false }));
  assert.equal((await f.run()).skipped, 'disabled');
  fs.writeFileSync(path.join(f.home, 'config.json'), '{}');
  fs.writeFileSync(path.join(f.store.dir, 'config.json'), JSON.stringify({ prComments: false }));
  assert.deepEqual(commentRepos(f.store, { home: f.home }), []);
  assert.equal((await f.run()).posted, 0);
  fs.writeFileSync(path.join(f.store.dir, 'config.json'), '{}');
  setRepoDisabled(f.store.repo, { home: f.home });
  assert.equal((await f.run()).posted, 0);
  assert.equal(f.writes.length, 0);
});

test('damaged state fails closed; ordinary test-mode invocations never reach publishing', async t => {
  const f = fixture(t);
  assert.equal((await runAutomaticPrComments(f.store, { home: f.home })).skipped, 'test');
  assert.equal(fs.existsSync(f.stateFile), false);
  await f.initialize();
  fs.writeFileSync(f.stateFile, 'broken');
  await assert.rejects(f.run(), /Cannot read/);
  fs.writeFileSync(f.stateFile, '{}');
  await assert.rejects(f.run(), /Invalid automatic PR comment state/);
  assert.equal(f.reads.length, 0);
});

test('repository discovery deduplicates recorded clones and an opt-out covers their shared origin', t => {
  const f = fixture(t), clone = path.join(f.dir, 'clone');
  execFileSync('git', ['init', '-q', clone]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repo.git'], { cwd: clone });
  const other = new Store(clone).init();
  f.store.log({ repo: clone, op: 'session', session: 'clone-session' });
  f.store.log({ repo: path.join(f.dir, 'deleted-worktree'), op: 'session', session: 'deleted-session' });
  assert.equal(commentRepos(f.store, { home: f.home }).length, 1);
  fs.writeFileSync(path.join(other.dir, 'config.json'), JSON.stringify({ prComments: false }));
  assert.equal(commentRepos(f.store, { home: f.home }).length, 0);
});

test('the per-pass limit counts failures too, so an unauthorized repo cannot flood GitHub', async t => {
  const f = fixture(t);
  await f.initialize();
  let attempts = 0;
  const report = () => ({ warnings: [], prs: Array.from({ length: PR_COMMENT_LIMIT + 2 }, (_, i) => ({
    number: i + 1, state: 'MERGED', mergedAt: at(-1), sessions: [{ lastAt: at(-1) }], saved: { total: 100 },
  })) });
  const r = await f.run({ fns: { ...f.fns, report, comment: () => { attempts++; throw new Error('forbidden'); } } });
  assert.equal(attempts, PR_COMMENT_LIMIT);
  assert.equal(r.errors.length, PR_COMMENT_LIMIT);
});

test('a receipt lost after publication is recovered through the existing GitHub comment', async t => {
  const f = fixture(t);
  await f.initialize();
  await f.run();
  const state = JSON.parse(fs.readFileSync(f.stateFile));
  state.repos = {};
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  assert.equal((await f.run()).posted, 1);
  assert.equal(f.writes.length, 1, 'same body is unchanged, not another POST');
});

test('lock excludes concurrent runs, recovers dead owners, and releases on failure', async t => {
  const f = fixture(t), lock = path.join(f.home, 'lock');
  fs.writeFileSync(lock, String(process.pid));
  assert.deepEqual(await withCommentLock(lock, () => assert.fail('live lock')), { skipped: 'locked' });
  const child = execFileSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' });
  fs.writeFileSync(lock, child);
  assert.equal(await withCommentLock(lock, () => 7), 7);
  assert.equal(fs.existsSync(lock), false);
  await assert.rejects(withCommentLock(lock, () => { throw new Error('failed'); }), /failed/);
  assert.equal(fs.existsSync(lock), false);
});

test('update job runs comments after no-update, success and failure, but never for status/check/scheduling', async () => {
  for (const flags of [{ quiet: true }, { background: true }, {}]) {
    const calls = [], ctx = { cmd: 'update', pos: [], flags, store: {} };
    const commentsFn = async () => { calls.push('comments'); return {}; };
    await updateCommand(ctx, { updateFn: async () => calls.push('check-no-release'), commentsFn });
    assert.deepEqual(calls, ['check-no-release', 'comments']);
    await assert.rejects(updateCommand(ctx, { updateFn: async () => { throw new Error('update failed'); }, commentsFn }), /update failed/);
    assert.equal(calls.at(-1), 'comments');
  }
  for (const flag of ['status', 'check', 'schedule', 'daily', 'unschedule', 'dry', 'branch', 'ref']) {
    await updateCommand({ cmd: 'update', pos: [], flags: { [flag]: true } }, {
      updateFn: async () => {}, commentsFn: () => assert.fail(`must not post for ${flag}`),
    });
  }
  await updateCommand({ cmd: 'switch', pos: [], flags: {} }, { updateFn: async () => {}, commentsFn: () => assert.fail('switch') });
  await updateCommand({ cmd: 'update', pos: ['v1.2.3'], flags: {} }, { updateFn: async () => {}, commentsFn: () => assert.fail('pinned update') });
});

test('a comment failure cannot turn a successful update into an update failure', async t => {
  const errors = [];
  t.mock.method(process.stderr, 'write', text => { errors.push(text); return true; });
  const result = await updateCommand({ cmd: 'update', pos: [], flags: { quiet: true }, store: {} }, {
    updateFn: async () => 'updated', commentsFn: async () => { throw new Error('GitHub offline'); },
  });
  assert.equal(result, 'updated');
  assert.match(errors.join(''), /thinker PR comments: GitHub offline/);
});
