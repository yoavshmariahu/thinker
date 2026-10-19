// The unmined-commits question (commits-offer.js): found by maintenance in a warm cache, asked once by the prompt
// hook, and answered by mining the direct commits in the background, through a CLI login or the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { recordMinedPrs, listMergedCommits } from '../src/prs.js';
import { COMMITS, unminedCommits, scheduleCommitsOffer, commitsOffer, commitsPending, answerCommits, readCommitsState, commitsNever } from '../src/commits-offer.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-19T12:00:00Z');
const tmp = (t, p) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// a repository of `direct` commits pushed straight to main, two squash-merged pull requests and a chore; its cache
// warmed from the pull requests alone
function warmRepo(t, { direct = COMMITS.min + 2, warm = true } = {}) {
  const dir = tmp(t, 'thinker-commits-');
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  const commit = (msg, i) => { fs.writeFileSync(path.join(dir, 'a.js'), `export const a = ${i};\n`); git('add', '.'); git('commit', '-q', '-m', msg); };
  commit('feat: the first page (#1)', 0);
  for (let i = 0; i < direct; i++) commit(`fix the cache eviction, case ${i}`, i + 1);
  commit('chore: bump deps', 1000);
  commit('feat: the second page (#2)', 1001);
  const store = new Store(dir).init();
  if (warm) recordMinedPrs(store, 'o/r', listMergedCommits(dir).filter(c => c.prNumber));
  return store;
}

test('the direct commits a PR-only warm-up never read are counted, not the pull requests, chores or mined commits', t => {
  const store = warmRepo(t, { direct: 5 });
  assert.deepEqual(unminedCommits(store, { slug: 'o/r' }), { count: 5, scanned: 8 });
  recordMinedPrs(store, 'o/r', listMergedCommits(store.repo, { directOnly: true }).filter(c => c.title.startsWith('fix')).slice(0, 2));
  assert.equal(unminedCommits(store, { slug: 'o/r' }).count, 3);
});

test('maintenance queues the question in a warm GitHub cache with enough unmined commits, at most weekly', t => {
  const home = tmp(t, 'thinker-commits-home-');
  const store = warmRepo(t);
  assert.equal(scheduleCommitsOffer(store, { now: T0, home, slug: null }), null, 'not on a repository without GitHub: its mining reads commits already');
  assert.equal(scheduleCommitsOffer(warmRepo(t, { warm: false }), { now: T0, home, slug: 'o/r' }), null, 'a cold cache gets the warm-up offer instead');
  assert.equal(scheduleCommitsOffer(warmRepo(t, { direct: COMMITS.min - 1 }), { now: T0, home, slug: 'o/r' }), null, 'too few to ask about');
  assert.equal(scheduleCommitsOffer(store, { now: T0, home, slug: 'o/r' }), COMMITS.min + 2);
  assert.equal(commitsPending(store, { home }), true);
  assert.equal(scheduleCommitsOffer(store, { now: T0 + DAY, home, slug: 'o/r' }), null, 'one question at a time');
});

test('the prompt hook asks once, saying how many unmined commits it found, through the agent\'s question tool', t => {
  const home = tmp(t, 'thinker-commits-home-');
  const store = warmRepo(t);
  scheduleCommitsOffer(store, { now: T0, home, slug: 'o/r' });
  const said = commitsOffer(store, { client: 'claude', home, now: T0 });
  assert.match(said, /<thinker-unmined-commits>/);
  assert.match(said, new RegExp(`found ${COMMITS.min + 2} unmined commits`));
  assert.match(said, /pushed straight to it, with no pull request/);
  assert.match(said, /AskUserQuestion/);
  assert.match(said, /thinker's `commits` tool/);
  assert.equal(commitsOffer(store, { client: 'claude', home, now: T0 }), '', 'said once');
  // a question nobody answered in three days is dropped, and asked again after the week
  assert.equal(scheduleCommitsOffer(store, { now: T0 + 4 * DAY, home, slug: 'o/r' }), null);
  assert.equal(readCommitsState(store).pending, undefined);
  assert.equal(scheduleCommitsOffer(store, { now: T0 + 8 * DAY, home, slug: 'o/r' }), COMMITS.min + 2);
});

test('mine starts `mine-prs --direct` through the signed-in agent; no waits a month; never stops the question', async t => {
  const home = tmp(t, 'thinker-commits-home-');
  const store = warmRepo(t);
  scheduleCommitsOffer(store, { now: T0, home, slug: 'o/r' });
  let ran = null;
  const said = await answerCommits(store, 'mine', { client: 'claude', home, now: T0, appFn: () => null, selectAgentFn: async () => ({ ok: true, agent: 'codex' }), spawnFn: (bin, args, o) => { ran = { args, o }; return { unref() {} }; } });
  assert.match(said, /Started in the background through codex: the newest 22 unmined commits/);
  assert.deepEqual(ran.args.slice(1, 5), ['mine-prs', '--direct', '--limit', String(COMMITS.min + 2)]);
  assert.equal(ran.o.env.THINKER_LLM, 'codex');
  assert.equal(commitsPending(store, { home }), false);

  const refused = warmRepo(t); scheduleCommitsOffer(refused, { now: T0, home, slug: 'o/r' });
  assert.match(await answerCommits(refused, 'mine', { home, now: T0, appFn: () => null, selectAgentFn: async () => ({ ok: false, agent: 'claude', error: 'unauthenticated' }), spawnFn: () => { throw new Error('must not spawn'); } }), /claude is not signed in/);

  const no = warmRepo(t); scheduleCommitsOffer(no, { now: T0, home, slug: 'o/r' });
  assert.match(await answerCommits(no, 'no', { home, now: T0 }), /not ask again for a month/);
  assert.equal(scheduleCommitsOffer(no, { now: T0 + 8 * DAY, home, slug: 'o/r' }), null);
  assert.equal(scheduleCommitsOffer(no, { now: T0 + 31 * DAY, home, slug: 'o/r' }), COMMITS.min + 2);

  const never = warmRepo(t); scheduleCommitsOffer(never, { now: T0, home, slug: 'o/r' });
  await answerCommits(never, 'never', { home, now: T0 });
  assert.equal(commitsNever(home), true);
  assert.equal(scheduleCommitsOffer(warmRepo(t), { now: T0, home, slug: 'o/r' }), null);
});

test('inside a desktop app, or with no agent CLI signed in, the commits are mined through the session', async t => {
  const home = tmp(t, 'thinker-commits-home-');
  const queued = async (client, opts) => {
    const store = warmRepo(t); scheduleCommitsOffer(store, { now: T0, home, slug: 'o/r' });
    let ran = null;
    const said = await answerCommits(store, 'mine', { client, home, now: T0, spawnFn: (bin, args, o) => { ran = { args, o }; return { pid: 999999, unref() {} }; }, ...opts });
    return { store, said, ran };
  };
  let checked = false;
  const app = await queued('claude-code', { appFn: h => h === 'claude' ? 'Claude Desktop' : null, selectAgentFn: async () => { checked = true; return { ok: true, agent: 'claude' }; } });
  assert.equal(checked, false, 'in an app the CLI login is not consulted');
  assert.match(app.said, /runs in Claude Desktop, so the mining reads through it/);
  assert.match(app.said, /run_in_background/);
  assert.match(app.said, /warmup_next/);
  assert.deepEqual(app.ran.args.slice(1, 5), ['mine-prs', '--direct', '--limit', '12']);
  assert.equal(app.ran.o.env.THINKER_LLM, 'session');
  assert.equal(app.ran.o.env.THINKER_SESSION_QUEUE, path.join(app.store.dir, 'state', 'session-llm'));

  const nologin = await queued('codex-mcp-client', { appFn: () => null, selectAgentFn: async () => ({ ok: false, agent: 'codex', error: 'unauthenticated' }) });
  assert.match(nologin.said, /No agent CLI is signed in on this machine, so the mining reads through this session/);
  assert.match(nologin.said, /spawn_agent/);

  const busy = warmRepo(t); scheduleCommitsOffer(busy, { now: T0, home, slug: 'o/r' });
  fs.mkdirSync(path.join(busy.dir, 'state', 'session-llm'), { recursive: true });
  fs.writeFileSync(path.join(busy.dir, 'state', 'session-llm', 'build.json'), JSON.stringify({ pid: process.pid }));
  assert.match(await answerCommits(busy, 'mine', { client: 'claude-code', home, now: T0, appFn: () => 'Claude Desktop', spawnFn: () => { throw new Error('must not spawn'); } }), /another build already reads through this session/);
});

test('`mine-prs --direct` distills the direct commits alone, newest first, and records them as mined', async t => {
  const { minePrs } = await import('../src/commands/learn.js');
  const store = warmRepo(t, { direct: 3 });
  const seen = [];
  await minePrs({ store, flags: {}, out: () => {} }, 'o/r', { repo: store.repo, direct: true, limit: 10, distillPrFn: async (_, pr) => { seen.push(pr.title); return { notes: [], tokens: 0 }; } });
  assert.deepEqual(seen, ['fix the cache eviction, case 2', 'fix the cache eviction, case 1', 'fix the cache eviction, case 0']);
  assert.equal(unminedCommits(store, { slug: 'o/r' }).count, 0);
});
