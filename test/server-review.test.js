import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listen } from '../src/server/index.js';
import { Store } from '../src/store.js';

const send = fileURLToPath(new URL('../action/review/send.mjs', import.meta.url));
const run = (args, env) => new Promise(resolve => execFile('node', args, { encoding: 'utf8', env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ status: error ? error.code || 1 : 0, stdout, stderr })));
const ID = 'github.com/acme/widgets';
const REPO = encodeURIComponent(ID);
process.env.THINKER_LOG = 'off'; process.env.THINKER_TELEMETRY = 'off'; process.env.THINKER_AST = 'off'; // hashing by regex: loading the parser's grammars takes seconds, so deps.js is imported after this line
const { hashDep } = await import('../src/deps.js');

function tmp(t, name) { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `thinker-${name}-`))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// the upstream: main with one behavior committed, and a branch that breaks it
function upstream(t) {
  const dir = tmp(t, 'upstream');
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'code.js'), 'export function value(x) {\n  if (x === null) throw new Error("x");\n  return x;\n}\n');
  new Store(dir).init();
  // a committed behavior, as `thinker share` writes it
  fs.writeFileSync(path.join(dir, '.thinker', 'notes', 'value-rejects-null.json'), JSON.stringify({ id: 'value-rejects-null', kind: 'behavior', mutability: 'fixed', title: 'value rejects null', answers: ['does value accept null'], body: 'code.js:value throws on null input; callers rely on it.', deps: [hashDep(dir, { path: 'code.js', symbol: 'value' })], source: { type: 'human' }, confidence: 0.9, created: '2026-10-01T00:00:00.000Z', verified: '2026-10-01T00:00:00.000Z' }, null, 2));
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'main');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'feature');
  fs.writeFileSync(path.join(dir, 'code.js'), 'export function value(x) {\n  return x;\n}\n');
  git(dir, 'commit', '-qam', 'drop the check');
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  return { dir, base, head };
}

test('the server reviews a pull request against its clone and posts the review; the action waits for it and fails the check', async t => {
  const up = upstream(t);
  const reviewed = [], github = [];
  const fakeGithub = async (url, init) => {
    github.push({ method: init.method, url: url.replace('https://api.github.com', ''), body: init.body ? JSON.parse(init.body) : undefined });
    const body = init.method === 'GET' ? [{ id: 4, state: 'CHANGES_REQUESTED', body: '<!-- thinker-review -->\nold' }] : { id: 5 };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const s = await listen({ host: '127.0.0.1', port: 0, data: tmp(t, 'server'), adminToken: 'adm', startWorker: false, worker: { githubToken: 'ghs_server', fns: {
    review: async (store, { scope, kinds, max }) => {
      reviewed.push({ scope, kinds, max, notes: store.list().map(n => n.id) });
      return { scope: scope.label, kinds, model: 'sonnet', cost: 0.05, tokens: 50000, notes: { consulted: 1, assessed: 1, staleBefore: [], outdated: [], uncovered: [] }, counts: { error: 1, warning: 0, info: 0 }, errors: [],
        behaviors: [{ id: 'value-rejects-null', title: 'value rejects null', mutability: 'fixed', outcome: 'violated', reason: 'the null check is gone' }],
        findings: [{ severity: 'error', category: 'violation', file: 'code.js', line: 2, message: 'value no longer throws on null', evidence: '-  if (x === null) throw', confidence: 0.9, note: 'value-rejects-null', notes: ['value-rejects-null'], inChange: true }] };
    },
    github: fakeGithub,
    // the first tick also maintains the clone: that must not reach a real model from a test
    maintain: { verify: async () => ({ verdict: 'still_valid', cost: 0 }), phrase: async () => ({ done: [], cost: 0 }), graphIndexed: () => false },
  } } });
  t.after(() => s.close());
  const url = `http://127.0.0.1:${s.address.port}`;
  const call = async (method, p, body, token = 'adm') => { const res = await fetch(url + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => null) }; };
  const reg = await call('PUT', `/v1/repos/${REPO}`, { clone: `file://${up.dir}` });
  assert.equal(reg.body.cloned, true);
  const token = (await call('POST', '/v1/tokens', { name: 'ci', scopes: ['write'], repos: [ID] })).body.token;
  const ro = (await call('POST', '/v1/tokens', { name: 'ro', scopes: ['read'] })).body.token;

  // validation and scopes
  assert.equal((await call('POST', `/v1/repos/${REPO}/reviews`, { number: 7, baseRef: 'main' }, token)).status, 400, 'a head is required');
  assert.equal((await call('POST', `/v1/repos/${REPO}/reviews`, { number: 7, headSha: up.head }, token)).status, 400, 'a base is required');
  assert.equal((await call('POST', `/v1/repos/${REPO}/reviews`, { number: 7, headSha: up.head, baseRef: 'main' }, ro)).status, 403);
  assert.equal((await call('GET', `/v1/repos/${REPO}/reviews/7`, undefined, ro)).status, 404, 'nothing requested yet');

  // queued, reviewed on the next tick against the fetched head, posted; the earlier request dismissed
  const q = await call('POST', `/v1/repos/${REPO}/reviews`, { number: 7, headSha: up.head, headRef: 'feature', baseRef: 'main', baseSha: up.base, title: 'Drop the check', apiUrl: 'https://api.github.com' }, token);
  assert.equal(q.status, 202); assert.equal(q.body.queued, true); assert.equal(q.body.reviews, true); assert.equal(q.body.posts, true);
  assert.equal((await call('GET', `/v1/repos/${REPO}/reviews/7`, undefined, ro)).body.review.status, 'queued');
  await s.worker.tick();
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0].scope.head, up.head); assert.equal(reviewed[0].scope.base, up.base); assert.match(reviewed[0].scope.label, /^commit /);
  assert.equal(reviewed[0].kinds, undefined, 'every note by default; kinds narrows'); assert.deepEqual(reviewed[0].notes, ['value-rejects-null']);
  assert.deepEqual(github.map(g => `${g.method} ${g.url}`), ['GET /repos/acme/widgets/pulls/7/reviews?per_page=100', 'PUT /repos/acme/widgets/pulls/7/reviews/4/dismissals', 'POST /repos/acme/widgets/pulls/7/reviews']);
  const posted = github[2].body;
  assert.equal(posted.event, 'REQUEST_CHANGES'); assert.equal(posted.commit_id, up.head);
  assert.deepEqual(posted.comments.map(c => [c.path, c.line]), [['code.js', 2]]);
  assert.match(posted.body, /❌ \| value rejects null/);
  const rec = (await call('GET', `/v1/repos/${REPO}/reviews/7`, undefined, ro)).body.review;
  assert.equal(rec.status, 'done'); assert.equal(rec.headSha, up.head); assert.equal(rec.fail, true); assert.equal(rec.posted, true); assert.equal(rec.dismissed, 1); assert.equal(rec.event, 'REQUEST_CHANGES');
  assert.deepEqual(rec.counts, { error: 1, warning: 0, info: 0 });
  assert.equal(git(s.repos.get(ID).checkout, 'rev-parse', 'HEAD'), up.base, 'the clone stays on the default branch');
  // the same head again: already reviewed, not queued; a push (new head) is
  const again = await call('POST', `/v1/repos/${REPO}/reviews`, { number: 7, headSha: up.head, baseRef: 'main' }, token);
  assert.equal(again.body.queued, false); assert.equal(again.body.status, 'done');
  await s.worker.tick(); assert.equal(reviewed.length, 1);

  // the action script: sends, waits, prints the body, fails the check
  const event = path.join(tmp(t, 'event'), 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 7, title: 'Drop the check', head: { sha: up.head, ref: 'feature' }, base: { ref: 'main', sha: up.base } } }));
  const summary = path.join(tmp(t, 'summary'), 'summary.md');
  const r = await run([send], { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'acme/widgets', GITHUB_API_URL: 'https://api.github.com', GITHUB_STEP_SUMMARY: summary, THINKER_SYNC_URL: url, THINKER_SYNC_TOKEN: token, THINKER_REVIEW_WAIT: '30' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /PR #7 at \w{10} was already reviewed/);
  assert.match(r.stdout, /posted a REQUEST_CHANGES review \(1 errors, 0 warnings; 1 of 1 behaviors violated, ~50k tokens\)/);
  assert.match(r.stderr, /failing the check/);
  assert.match(fs.readFileSync(summary, 'utf8'), /value rejects null/);
  // a token that may only read sends nothing
  const denied = await run([send], { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'acme/widgets', THINKER_SYNC_URL: url, THINKER_SYNC_TOKEN: ro, THINKER_REVIEW_WAIT: '0' });
  assert.equal(denied.status, 1); assert.match(denied.stderr, /403/);

  // a head the server cannot fetch: the action queues it and waits, the review fails and says so, the action fails too
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 8, head: { ref: 'nope' }, base: { ref: 'main' } } }));
  const pending = run([send], { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'acme/widgets', THINKER_SYNC_URL: url, THINKER_SYNC_TOKEN: token, THINKER_REVIEW_WAIT: '30', THINKER_REVIEW_POLL_MS: '200' });
  while (!s.repos.get(ID).pendingReviews().length) await new Promise(r => setTimeout(r, 50));
  await s.worker.tick();
  const failed = (await call('GET', `/v1/repos/${REPO}/reviews/8`, undefined, token)).body.review;
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /could not fetch the pull request's head \(nope\)/);
  assert.equal(reviewed.length, 1);
  const r8 = await pending;
  assert.equal(r8.status, 1, r8.stdout); assert.match(r8.stdout, /queued for review/); assert.match(r8.stderr, /failed on the server: could not fetch/);
  // a failed review is asked again on the next request for the same head
  assert.equal((await call('POST', `/v1/repos/${REPO}/reviews`, { number: 8, headRef: 'nope', baseRef: 'main' }, token)).body.queued, true);
});

test('without a GitHub token the server reviews and records the result but posts nothing', async t => {
  const up = upstream(t);
  const github = [];
  const s = await listen({ host: '127.0.0.1', port: 0, data: tmp(t, 'server'), adminToken: 'adm', startWorker: false, worker: { githubToken: null, fns: {
    review: async (store, { scope }) => ({ scope: scope.label, kinds: ['behavior'], model: 'sonnet', cost: 0.02, notes: { consulted: 1, assessed: 1, staleBefore: [], outdated: [], uncovered: [] }, counts: { error: 0, warning: 0, info: 0 }, errors: [], behaviors: [{ id: 'value-rejects-null', title: 'value rejects null', mutability: 'fixed', outcome: 'upheld' }], findings: [] }),
    github: async (...a) => { github.push(a); return { ok: true, status: 200, text: async () => '[]' }; },
    // the first tick also maintains the clone: that must not reach a real model from a test
    maintain: { verify: async () => ({ verdict: 'still_valid', cost: 0 }), phrase: async () => ({ done: [], cost: 0 }), graphIndexed: () => false },
  } } });
  t.after(() => s.close());
  const url = `http://127.0.0.1:${s.address.port}`;
  const call = async (method, p, body) => { const res = await fetch(url + p, { method, headers: { authorization: 'Bearer adm', 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => null) }; };
  await call('PUT', `/v1/repos/${REPO}`, { clone: `file://${up.dir}` });
  const q = await call('POST', `/v1/repos/${REPO}/reviews`, { number: 3, headRef: 'feature', baseRef: 'main' });
  assert.equal(q.body.posts, false);
  await s.worker.tick();
  const rec = (await call('GET', `/v1/repos/${REPO}/reviews/3`)).body.review;
  assert.equal(rec.status, 'done'); assert.equal(rec.headSha, up.head, 'the head resolved from the branch'); assert.equal(rec.posted, false); assert.equal(rec.wouldPost, false, 'all upheld and quiet: nothing to post anyway'); assert.equal(rec.fail, false);
  assert.equal(github.length, 0);
  assert.equal(s.repos.get(ID).status().pendingReviews, 0);
});
