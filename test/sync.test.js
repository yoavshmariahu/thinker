import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listen } from '../src/server/index.js';
import { Store, repoId } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { login, pull, push, syncNotes, pushSessions, planPush, syncConfig, streamingPlan, syncState } from '../src/sync.js';
import { maintain } from '../src/maintain.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
// the server under test runs in this process, so child processes must not block the event loop
const run = (args, env) => new Promise(resolve => execFile('node', args, { encoding: 'utf8', env: { ...process.env, ...env } }, (error, stdout, stderr) => resolve({ status: error ? error.code || 1 : 0, stdout, stderr })));
const ingest = fileURLToPath(new URL('../action/ingest.mjs', import.meta.url));
const ORIGIN = 'https://github.com/acme/widgets.git';
const ID = 'github.com/acme/widgets';

function tmp(t, name) { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `thinker-${name}-`))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function git(cwd, ...args) { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
// a checkout of the "upstream" repository: the first makes it, later ones clone it
function checkout(t, upstream) {
  const dir = tmp(t, 'checkout');
  if (upstream) git(dir, 'clone', '-q', upstream, '.');
  else { git(dir, 'init', '-q'); fs.writeFileSync(path.join(dir, 'code.js'), 'export function value() { return 1; }\nexport function other() { return 2; }\n'); git(dir, 'add', '.'); git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one'); }
  git(dir, 'remote', upstream ? 'set-url' : 'add', 'origin', ORIGIN);
  const store = new Store(dir).init();
  return { dir, store };
}
async function server(t, { fns = {}, workerOpts = {} } = {}) {
  const data = tmp(t, 'server');
  const s = await listen({ host: '127.0.0.1', port: 0, data, adminToken: 'adm', startWorker: false, worker: { fns, idleMs: 0, ...workerOpts } });
  t.after(() => s.close());
  s.url = `http://127.0.0.1:${s.address.port}`;
  s.call = async (method, p, body, token = 'adm') => { const res = await fetch(s.url + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json().catch(() => null) }; };
  return s;
}
const env = { THINKER_LOG: 'off', THINKER_TELEMETRY: 'off', THINKER_SYNC: '' };
function withEnv(t, extra, fn) {
  const all = { ...env, ...extra }, prev = {};
  for (const [k, v] of Object.entries(all)) { prev[k] = process.env[k]; if (v === '' || v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('tokens: scopes and repositories are enforced, the admin token does everything', async t => {
  const s = await server(t);
  assert.equal((await fetch(`${s.url}/health`).then(r => r.json())).ok, true);
  assert.equal((await s.call('GET', `/v1/repos/${encodeURIComponent(ID)}`, undefined, 'nope')).status, 401);
  assert.equal((await s.call('GET', `/v1/repos/${encodeURIComponent(ID)}`)).status, 404, 'unknown until registered');
  const reg = await s.call('PUT', `/v1/repos/${encodeURIComponent(ID)}`, { fetch: false });
  assert.equal(reg.status, 200); assert.equal(reg.body.cloned, false);
  const team = (await s.call('POST', '/v1/tokens', { name: 'team', scopes: ['read', 'write'] })).body.token;
  const ro = (await s.call('POST', '/v1/tokens', { name: 'ro', scopes: ['read'] })).body.token;
  const other = (await s.call('POST', '/v1/tokens', { name: 'other', scopes: ['read', 'write'], repos: ['github.com/acme/else'] })).body.token;
  assert.match(team, /^tk_[a-f0-9]{48}$/);
  assert.equal((await s.call('GET', `/v1/repos/${encodeURIComponent(ID)}`, undefined, ro)).status, 200);
  assert.equal((await s.call('POST', `/v1/repos/${encodeURIComponent(ID)}/notes`, { items: [] }, ro)).status, 403);
  assert.equal((await s.call('GET', `/v1/repos/${encodeURIComponent(ID)}`, undefined, other)).status, 403);
  assert.equal((await s.call('GET', '/v1/repos', undefined, team)).status, 403, 'listing repositories is for admins');
  assert.equal((await s.call('POST', '/v1/tokens', { name: 'x' }, team)).status, 403);
  assert.equal((await s.call('DELETE', '/v1/tokens/ro')).body.revoked, true);
  assert.equal((await s.call('GET', `/v1/repos/${encodeURIComponent(ID)}`, undefined, ro)).status, 401, 'a revoked token is unknown');
  assert.equal((await s.call('PUT', '/v1/repos/not-a-repo', {})).status, 400);
});

test('notes flow between checkouts: push, pull, update, conflict, retire; committed notes and local state stay put', t => withEnv(t, { THINKER_HOME: tmp(t, 'home') }, async () => {
  const s = await server(t);
  const a = checkout(t), b = checkout(t, a.dir);
  assert.equal(repoId(a.dir), ID);
  await s.call('PUT', `/v1/repos/${encodeURIComponent(ID)}`, { fetch: false });
  const token = (await s.call('POST', '/v1/tokens', { name: 'team' })).body.token;
  const cfgA = login(a.store, { url: s.url, token });
  assert.equal(cfgA.repo, ID);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dir, '.thinker', 'config.json'), 'utf8')).sync.url, s.url, 'the url is in the committable config');
  assert.ok(!fs.readFileSync(path.join(a.dir, '.thinker', 'config.json'), 'utf8').includes(token), 'the token is not');

  // a note from a trusted source goes up; an unconfirmed agent note is held back
  const human = createNote(a.store, { title: 'Value computation convention', kind: 'convention', answers: ['How is the value computed?'], body: 'Use code.js:value for the value.', deps: [{ path: 'code.js', symbol: 'value' }] }, { source: { type: 'human' } }).note;
  const agent = createNote(a.store, { title: 'Other returns two', kind: 'gotcha', answers: ['what other returns'], body: 'code.js:other returns 2', deps: [{ path: 'code.js', symbol: 'other' }] }, { source: { type: 'agent', ref: '/Users/me/.claude/x.jsonl' } }).note;
  const plan = planPush(a.store, cfgA);
  assert.deepEqual(plan.items.map(i => i.note.id), [human.id]);
  assert.match(plan.skipped.find(x => x.id === agent.id).reasons.join(), /not confirmed/);
  let r = await syncNotes(a.store, cfgA);
  assert.equal(r.pushed, 1); assert.equal(r.pulled, 0);
  assert.ok(a.store.get(human.id).sync.digest, 'the pushed note carries its sync marker');
  assert.equal(JSON.stringify(a.store.get(human.id)).includes('"sync"'), true);
  assert.equal(await syncNotes(a.store, cfgA).then(x => x.pushed), 0, 'nothing to push twice');

  // another checkout of the same repository pulls it
  const cfgB = login(b.store, { url: s.url, token });
  r = await syncNotes(b.store, cfgB);
  assert.equal(r.pulled, 1);
  const got = b.store.get(human.id);
  assert.equal(got.body, human.body); assert.equal(got.status, 'fresh'); assert.equal(b.store.isShared(human.id), false, 'pulled notes are in the local tier');
  assert.ok(!('uses' in got) || got.uses === 0);
  assert.equal(got.source.type, 'human');

  // a confirmed agent note goes up too; its transcript path does not
  a.store.put({ ...a.store.get(agent.id), attest: { confirmed: 1, contradicted: 0, unused: 0 } });
  r = await push(a.store, cfgA); assert.equal(r.pushed, 1);
  await pull(b.store, cfgB);
  assert.equal(b.store.get(agent.id).source.ref, undefined);
  assert.equal(b.store.get(agent.id).attest.confirmed, 1, 'assessments travel');

  // B changes the note (a verification); A takes the change, keeping its own usage counts
  a.store.put({ ...a.store.get(human.id), uses: 7, servedIn: ['s1'] });
  b.store.put({ ...b.store.get(human.id), body: 'Use code.js:value for the value; it is memoized.', confidence: 0.9 });
  r = await push(b.store, cfgB); assert.equal(r.pushed, 1);
  r = await pull(a.store, cfgA); assert.equal(r.applied, 1);
  assert.equal(a.store.get(human.id).body, 'Use code.js:value for the value; it is memoized.');
  assert.equal(a.store.get(human.id).uses, 7); assert.deepEqual(a.store.get(human.id).servedIn, ['s1']);

  // both change it: the first push wins, the other takes the server's version
  a.store.put({ ...a.store.get(human.id), body: 'A says this.' });
  b.store.put({ ...b.store.get(human.id), body: 'B says that.' });
  await push(b.store, cfgB);
  r = await push(a.store, cfgA);
  assert.equal(r.conflicts, 1); assert.equal(r.pushed, 0);
  assert.equal(a.store.get(human.id).body, 'B says that.');
  assert.equal((await push(a.store, cfgA)).planned, 0, 'and has nothing left to push');

  // retiring propagates
  b.store.put({ ...b.store.get(agent.id), status: 'invalid', invalidReason: 'wrong' });
  r = await push(b.store, cfgB); assert.equal(r.retired, 1);
  await pull(a.store, cfgA);
  assert.equal(a.store.get(agent.id).status, 'invalid');
  // a note the repository commits is left alone by a pull
  fs.mkdirSync(path.join(a.dir, '.thinker', 'notes'), { recursive: true });
  const committed = { id: 'committed-rule', title: 'Committed rule', kind: 'convention', body: 'code.js:value stays pure.', answers: ['pure?'], deps: a.store.get(human.id).deps, source: { type: 'human' }, confidence: 0.8 };
  fs.writeFileSync(path.join(a.dir, '.thinker', 'notes', 'committed-rule.json'), JSON.stringify(committed));
  git(a.dir, 'add', '.thinker/notes/committed-rule.json');
  assert.equal(a.store.isShared('committed-rule'), true);
  await s.call('POST', `/v1/repos/${encodeURIComponent(ID)}/notes`, { items: [{ op: 'put', note: { ...committed, body: 'server version' } }] }, token);
  await pull(a.store, cfgA);
  assert.equal(a.store.get('committed-rule').body, 'code.js:value stays pure.');
  // a repo-level view
  const st = (await s.call('GET', `/v1/repos/${encodeURIComponent(ID)}`, undefined, token)).body;
  assert.equal(st.notes, 3); assert.equal(st.invalid, 1); assert.equal(st.distills, false);
  const feed = (await s.call('GET', `/v1/repos/${encodeURIComponent(ID)}/notes?since=0`, undefined, token)).body;
  assert.ok(feed.seq >= 5); assert.ok(feed.notes.every(n => !('uses' in n) && !('servedIn' in n)), 'server state is not in the feed');
}));

test('sessions stream to the server and are distilled there against its checkout; CI pull requests too', t => withEnv(t, { THINKER_HOME: tmp(t, 'home') }, async () => {
  const a = checkout(t);
  const distilled = [], prs = [], phrased = [];
  const s = await server(t, { fns: {
    distill: async (events, { served }) => { distilled.push({ events, served: served.map(n => n.id) }); return { notes: [{ title: 'Other returns two', kind: 'gotcha', answers: ['what does other return'], body: 'code.js:other returns 2, not 1.', deps: [{ path: 'code.js', symbol: 'other' }], tags: [], confidence: 0.9 }], assessments: served.map(n => ({ id: n.id, verdict: 'confirmed', evidence: 'read it', correction: '' })), cost: 0.01 }; },
    distillPr: async (slug, pr) => { prs.push({ slug, pr }); return { notes: [{ title: 'Value must stay positive', kind: 'invariant', answers: ['can value be negative?'], body: 'code.js:value must return a positive number; callers divide by it.', applies: 'all callers', deps: [{ path: 'code.js', symbol: 'value' }], tags: [], confidence: 0.8 }], cost: 0.02 }; },
    maintain: { verify: async (st, n) => ({ verdict: 'still_valid', cost: 0 }), phrase: async (st, notes) => { phrased.push(...notes.map(n => n.id)); for (const n of notes) st.put({ ...n, says: ['how is it computed'], saysFor: 'test' }); return { done: notes, cost: 0 }; }, graphIndexed: () => false },
  } });
  // the server clones the repository from its url: here a file:// clone of the checkout
  const reg = await s.call('PUT', `/v1/repos/${encodeURIComponent(ID)}`, { clone: `file://${a.dir}` });
  assert.equal(reg.body.cloned, true); assert.equal(reg.body.distills, true); assert.equal(reg.body.head, git(a.dir, 'rev-parse', 'HEAD'));
  const token = (await s.call('POST', '/v1/tokens', { name: 'team' })).body.token;
  const cfg = login(a.store, { url: s.url, token });
  const rule = createNote(a.store, { title: 'Value computation convention', kind: 'convention', answers: ['How is the value computed?'], body: 'Use code.js:value for the value.', deps: [{ path: 'code.js', symbol: 'value' }] }, { source: { type: 'human' } }).note;
  await syncNotes(a.store, cfg);
  assert.equal(streamingPlan(a.store).stream, true); assert.equal(streamingPlan(a.store).local, false, 'the server distills, so the checkout does not');

  // a session as the hooks record it, with the rule served in it
  a.store.put({ ...a.store.get(rule.id), servedIn: ['sess-1'] });
  const trace = path.join(a.dir, '.thinker', 'state', 'trace-sess-1.jsonl');
  fs.mkdirSync(path.dirname(trace), { recursive: true });
  const events = [{ t: 'prompt', text: 'what does other return?' }, { t: 'tool', name: 'Read', input: { file_path: 'code.js' }, result: 'x'.repeat(9000) }, { t: 'tool', name: 'Grep', input: { pattern: 'other' }, result: 'code.js:2' }, { t: 'tool', name: 'Read', input: { file_path: 'code.js' }, result: 'again' }, { t: 'say', text: 'other returns 2' }];
  fs.writeFileSync(trace, events.map(e => JSON.stringify(e)).join('\n') + '\n');
  let r = await pushSessions(a.store, cfg, { sessions: [{ file: trace, session: 'sess-1', client: 'codex' }] });
  assert.equal(r.sessions, 1); assert.equal(r.events, 5);
  r = await pushSessions(a.store, cfg, { sessions: [{ file: trace, session: 'sess-1', client: 'codex' }], end: true });
  assert.equal(r.events, 0, 'only new lines go up'); assert.equal(r.sessions, 1, 'but the end is announced');
  const repo = s.repos.get(ID);
  const meta = repo.sessionMeta('sess-1');
  assert.equal(meta.events, 7, '5 events, the served ids, the end'); assert.equal(meta.ended, true); assert.equal(meta.client, 'codex');
  const stored = repo.sessionEvents('sess-1');
  assert.ok(stored[1].result.length < 6100, 'long tool results are clipped before upload');
  assert.deepEqual(stored.find(e => e.t === 'served').ids, [rule.id]);

  await s.worker.tick();
  assert.equal(distilled.length, 1);
  assert.deepEqual(distilled[0].served, [rule.id]);
  assert.equal(distilled[0].events.length, 5);
  const serverStore = repo.store();
  const made = serverStore.list().find(n => n.title === 'Other returns two');
  assert.ok(made, 'the distilled note is in the server cache');
  assert.equal(made.deps[0].path, 'code.js'); assert.match(made.deps[0].hash, /^sha256:/, 'anchored against the server checkout');
  assert.equal(made.source.type, 'agent'); assert.equal(made.source.ref, 'sess-1');
  assert.equal(serverStore.get(rule.id).attest.confirmed, 1, 'the served note was assessed');
  await s.worker.tick();
  assert.equal(distilled.length, 1, 'a distilled session is not distilled again');
  assert.ok(phrased.length >= 1, 'the server maintains the cache too: notes without phrasings got them');
  assert.equal(repo.journal().some(e => e.by === 'maintenance'), true, 'and journals what maintenance changed');

  // the checkout pulls what the server learned
  r = await pull(a.store, cfg);
  assert.equal(a.store.get(made.id).body, 'code.js:other returns 2, not 1.');
  assert.equal(a.store.get(rule.id).attest.confirmed, 1);
  assert.equal(a.store.get(rule.id).confidence > rule.confidence, true);

  // a merged pull request from CI
  const pr = { number: 7, title: 'Fix negative values', body: 'Callers divide by value.', mergedAt: '2026-10-01T00:00:00Z', mergeCommit: git(a.dir, 'rev-parse', 'HEAD'), additions: 3, files: ['code.js'], diff: 'diff --git a/code.js b/code.js\n+export function value() { return 1; }\n', comments: ['code.js: keep it positive please'] };
  let res = await s.call('POST', `/v1/repos/${encodeURIComponent(ID)}/prs`, pr, token);
  assert.equal(res.status, 202); assert.equal(res.body.queued, true);
  assert.equal((await s.call('POST', `/v1/repos/${encodeURIComponent(ID)}/prs`, { number: 8, title: 'x' }, token)).status, 400, 'a diff is required');
  await s.worker.tick();
  assert.equal(prs.length, 1); assert.equal(prs[0].slug, 'acme/widgets'); assert.deepEqual(prs[0].pr.comments, pr.comments);
  const inv = serverStore.list().find(n => n.title === 'Value must stay positive'); // distilled as an invariant, read as a rule
  assert.equal(inv.kind, 'rule');
  assert.equal(inv.source.ref, 'acme/widgets#7');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo.checkout, '.thinker', 'prs.json'), 'utf8'))['acme/widgets'].mined, [7]);
  res = await s.call('POST', `/v1/repos/${encodeURIComponent(ID)}/prs`, pr, token);
  assert.equal(res.body.done, true, 'a distilled pull request is not queued again');
  await s.worker.tick(); assert.equal(prs.length, 1);
  r = await pull(a.store, cfg); assert.equal(a.store.get(inv.id).kind, 'rule');

  // the action script, against a fake GitHub API and this server
  const gh = http.createServer((req, res) => {
    const send = (body, type = 'application/json') => { res.writeHead(200, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.url.startsWith('/repos/acme/widgets/pulls/9/files')) return send([{ filename: 'code.js' }]);
    if (req.url === '/repos/acme/widgets/pulls/9/comments?per_page=50') return send([{ path: 'code.js', body: 'Please keep the early return; the loop below relies on it.', user: { login: 'reviewer' } }, { path: 'x', body: 'short', user: { login: 'a' } }]);
    if (req.url === '/repos/acme/widgets/pulls/9') return send(req.headers.accept.includes('diff') ? 'diff --git a/code.js b/code.js\n+// nine\n' : { number: 9, title: 'Nine', merged: true, merged_at: '2026-10-02T00:00:00Z', merge_commit_sha: 'abc1234', additions: 1, body: 'desc' }, req.headers.accept.includes('diff') ? 'text/plain' : undefined);
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => gh.listen(0, '127.0.0.1', r)); t.after(() => gh.close());
  const event = path.join(tmp(t, 'event'), 'event.json');
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 9, title: 'Nine', merged: true, merged_at: '2026-10-02T00:00:00Z', merge_commit_sha: 'abc1234', additions: 1, body: 'desc' } }));
  const sent = await run([ingest], { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'acme/widgets', GITHUB_API_URL: `http://127.0.0.1:${gh.address().port}`, GITHUB_TOKEN: 'ghs_x', THINKER_SYNC_URL: s.url, THINKER_SYNC_TOKEN: token });
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, /PR #9 "Nine" queued/);
  const queued = repo.pendingPrs().find(p => p.number === 9);
  assert.equal(queued.diff, 'diff --git a/code.js b/code.js\n+// nine\n'); assert.deepEqual(queued.files, ['code.js']); assert.equal(queued.mergeCommit, 'abc1234');
  assert.deepEqual(queued.comments, ['code.js: Please keep the early return; the loop below relies on it.']);
  // closed without merging: nothing is sent
  fs.writeFileSync(event, JSON.stringify({ pull_request: { number: 10, title: 'Ten', merged: false } }));
  const skip = await run([ingest], { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'acme/widgets', THINKER_SYNC_URL: s.url, THINKER_SYNC_TOKEN: token });
  assert.equal(skip.status, 0); assert.match(skip.stdout, /without merging/);
}));

test('maintenance syncs when configured and the CLI reports status; without a token nothing syncs', t => withEnv(t, { THINKER_HOME: tmp(t, 'home') }, async () => {
  const s = await server(t);
  const a = checkout(t);
  assert.equal(syncConfig(a.store), null);
  await s.call('PUT', `/v1/repos/${encodeURIComponent(ID)}`, { fetch: false });
  const token = (await s.call('POST', '/v1/tokens', { name: 'team' })).body.token;
  await s.call('POST', `/v1/repos/${encodeURIComponent(ID)}/notes`, { items: [{ op: 'put', note: { id: 'from-server', title: 'From the server', kind: 'howto', body: 'Run node code.js', answers: ['how to run'], deps: [{ path: 'code.js', hash: 'sha256:' + 'a'.repeat(24) }], source: { type: 'human' }, confidence: 0.7 } }] }, token);
  const cfg = login(a.store, { url: s.url, token });
  const r = await maintain(a.store, a.dir, { fns: { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid' }), phrase: async (st, notes) => ({ done: notes, cost: 0 }), sync: () => syncNotes(a.store, cfg) } });
  assert.equal(r.sync.pulled, 1);
  assert.equal(a.store.get('from-server').title, 'From the server');
  const { maintenanceNotice } = await import('../src/maintain.js');
  assert.match(maintenanceNotice(a.store), /team cache: 1 note pulled/);
  const st = await run([cli, 'sync', 'status', '--repo', a.dir], {});
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, new RegExp(`sync: ${s.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} as ${ID}`));
  assert.match(st.stdout, /1 synced notes here/);
  assert.match(st.stdout, /server: 1 notes/);
  const round = await run([cli, 'sync', '--repo', a.dir], {});
  assert.equal(round.status, 0, round.stderr);
  assert.match(round.stdout, /pulled 0 notes/); assert.match(round.stdout, /pushed 0/);
  assert.equal(syncState(a.store).cursor, 1);
  // switched off by the environment
  await withEnv(t, { THINKER_SYNC: 'off' }, async () => assert.equal(syncConfig(a.store), null));
}));
