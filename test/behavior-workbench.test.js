import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { hashDep } from '../src/deps.js';
import { createNote } from '../src/ops.js';
import { review } from '../src/review.js';
import { pendingBehaviors, activeBehaviors, acceptPending, discardPending, editBehavior } from '../src/behavior-workbench.js';
import { listBehaviorProposals } from '../src/behavior-proposals.js';
import { behaviorSessionPrompt } from '../src/setup/define.js';
import { createUiServer, usageView } from '../src/ui/server.js';

const GUARD = `export function guard(input) {\n  if (!input) throw new Error('input required');\n  return input.trim();\n}\n\nexport function other() {\n  return 1;\n}\n`;

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-workbench-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/guard.js'), GUARD);
  git('add', '-A'); git('commit', '-qm', 'init');
  const store = new Store(repo).init();
  const dep = symbol => hashDep(repo, { path: 'src/guard.js', symbol });
  // one behavior a person wrote, one an agent saved and nobody accepted, and the rule a draft came from
  store.put({ id: 'guard-rejects-empty', title: 'guard rejects empty input', kind: 'behavior', mutability: 'fixed', answers: [], body: 'src/guard.js:guard throws on empty input.', deps: [dep('guard')], source: { type: 'human' }, confidence: 0.9, status: 'fresh' });
  store.put({ id: 'guard-trims', title: 'guard trims what it returns', kind: 'behavior', mutability: 'mutable', answers: [], body: 'src/guard.js:guard returns trimmed input.', deps: [dep('guard')], source: { type: 'agent', session: 'abc12345' }, confidence: 0.7, status: 'fresh' });
  const rule = { id: 'other-returns-one', title: 'other returns one', kind: 'rule', answers: [], body: 'src/guard.js:other returns 1; callers count on it.', deps: [dep('other')], source: { type: 'pr', ref: 'o/r#7' }, confidence: 0.8, status: 'fresh' };
  store.put(rule);
  fs.writeFileSync(path.join(store.localDir, 'behavior-proposals.json'), JSON.stringify({ proposals: [{ id: 'proposal-other-returns-one', sourceId: rule.id, sourceHash: 'x', source: rule.source, title: 'other always returns one', body: 'Callers rely on src/guard.js:other returning 1.', answers: [], deps: [{ path: 'src/guard.js', symbol: 'other' }], reason: 'The fix says so.', mutability: 'mutable' }] }));
  return { repo, store, git };
}

test('a behavior an agent saved is not held against a change until a person accepts it', async t => {
  const { repo, store } = fixture(t);
  fs.writeFileSync(path.join(repo, 'src/guard.js'), GUARD.replace("return input.trim();", 'return input;'));
  const consulted = async () => (await review(store, { dry: true })).toAssess.map(n => n.id);
  assert.ok((await consulted()).includes('guard-rejects-empty'), 'a behavior a person wrote is consulted');
  assert.ok(!(await consulted()).includes('guard-trims'), 'an agent proposal is not');
  acceptPending(store, 'guard-trims', { mutability: 'mutable' });
  assert.ok((await consulted()).includes('guard-trims'), 'once accepted it is');
});

test('what waits for a decision: build drafts and agent proposals, accepted as written or edited, or discarded', t => {
  const { store } = fixture(t);
  const pending = pendingBehaviors(store);
  assert.deepEqual(pending.map(p => [p.id, p.origin]), [['proposal-other-returns-one', 'draft'], ['guard-trims', 'agent']]);
  assert.deepEqual(activeBehaviors(store).map(b => b.id), ['guard-rejects-empty']);

  // an edited draft is the person's: it needs only to point at code that exists
  const r = acceptPending(store, 'proposal-other-returns-one', { mutability: 'fixed', edit: { title: 'other returns exactly one', body: 'Every caller relies on src/guard.js:other returning 1.' } });
  assert.ok(!r.error, r.error);
  assert.equal(r.note.mutability, 'fixed');
  assert.equal(r.note.source.type, 'human');
  assert.equal(r.note.title, 'other returns exactly one');
  assert.equal(listBehaviorProposals(store).length, 0, 'the draft leaves the list');

  assert.ok(!discardPending(store, 'guard-trims').error);
  assert.equal(store.get('guard-trims'), null);
  assert.equal(pendingBehaviors(store).length, 0);
  assert.match(discardPending(store, 'guard-trims').error, /no such/);
});

test('switching fixed and mutable leaves a stale behavior stale; new words are re-anchored with history', t => {
  const { repo, store } = fixture(t);
  fs.writeFileSync(path.join(repo, 'src/guard.js'), GUARD.replace("'input required'", "'missing'"));
  assert.equal(activeBehaviors(store).find(b => b.id === 'guard-rejects-empty').state, 'unverified');
  editBehavior(store, 'guard-rejects-empty', { mutability: 'mutable' });
  const after = activeBehaviors(store).find(b => b.id === 'guard-rejects-empty');
  assert.equal(after.mutability, 'mutable');
  assert.equal(after.state, 'unverified', 'changing mutability is not a verification');

  const r = editBehavior(store, 'guard-rejects-empty', { body: 'src/guard.js:guard throws when the input is empty or missing.' });
  assert.ok(!r.error, r.error);
  assert.equal(r.note.history.at(-1).body, 'src/guard.js:guard throws on empty input.');
  assert.equal(r.note.source.type, 'human');
});

test('the interview prompt names what exists and saves nothing without the person', t => {
  const { store } = fixture(t);
  const p = behaviorSessionPrompt(store);
  assert.match(p, /in force \(1 before this run\)/);
  assert.match(p, /Start from the design documents/);
  assert.match(p, /2 drafts waiting/);
  assert.match(p, /Interview me, one area at a time/);
  assert.match(p, /Save a behavior only after I say yes/);
  assert.match(p, /thinker system add <file> --fixed/);
});

function call(port, pathname, { token, host = `127.0.0.1:${port}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET', headers: { host, ...(token ? { 'x-thinker-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

test('the local page answers only this host, with this run\'s token, and acts through the workbench', async t => {
  const { store } = fixture(t);
  process.env.THINKER_LOG = 'local';
  t.after(() => { delete process.env.THINKER_LOG; });
  const ui = createUiServer(store, { token: 'a'.repeat(32) });
  const { port, url } = await ui.listen(0);
  t.after(() => ui.close());
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/#t=a{32}$/);
  assert.equal((await call(port, '/')).status, 200);
  assert.equal((await call(port, '/api/behaviors')).status, 401, 'no token');
  assert.equal((await call(port, '/api/behaviors', { token: 'b'.repeat(32) })).status, 401, 'wrong token');
  assert.equal((await call(port, '/api/behaviors', { token: 'a'.repeat(32), host: `evil.example:${port}` })).status, 403, 'another host name');
  const list = JSON.parse((await call(port, '/api/behaviors', { token: 'a'.repeat(32) })).body);
  assert.equal(list.pending.length, 2);
  const acc = await call(port, '/api/behaviors/accept', { token: 'a'.repeat(32), body: { id: 'guard-trims', mutability: 'fixed' } });
  assert.equal(acc.status, 200, acc.body);
  assert.equal(store.get('guard-trims').mutability, 'fixed');
  assert.equal((await call(port, '/api/behaviors/discard', { token: 'a'.repeat(32), body: { id: 'nope' } })).status, 400);
  const usage = JSON.parse((await call(port, '/api/usage?days=7', { token: 'a'.repeat(32) })).body);
  assert.equal(usage.notesInCache, 3);
  assert.ok(!JSON.stringify(usage).includes('reportedCost'), 'no dollars on the page');
  assert.equal(usageView(store, {}).spending.tokens, 0);
});

test('the local page lists the cache, archives and restores a note, and is scoped by repository', async t => {
  const { store } = fixture(t);
  process.env.THINKER_LOG = 'local';
  t.after(() => { delete process.env.THINKER_LOG; });
  const ui = createUiServer(store, { token: 'a'.repeat(32) });
  const { port } = await ui.listen(0);
  t.after(() => ui.close());
  const get = async p => { const r = await call(port, p, { token: 'a'.repeat(32) }); assert.equal(r.status, 200, r.body); return JSON.parse(r.body); };
  const { repos } = await get('/api/repos');
  assert.equal(repos.length, 1);
  assert.ok(repos[0].current);
  const cache = await get('/api/cache');
  assert.deepEqual(cache.notes.map(n => n.id), ['other-returns-one'], 'behaviors have their own view');
  const n = cache.notes[0];
  assert.equal(n.status, 'fresh');
  assert.deepEqual(n.pointers, ['src/guard.js:other']);
  assert.equal(n.source, 'o/r#7');
  assert.equal(n.repo, repos[0].id);
  assert.deepEqual((await get(`/api/cache?repo=${encodeURIComponent(repos[0].id)}`)).notes.length, 1);
  assert.equal((await get('/api/cache?repo=all')).notes.length, 1);
  assert.equal((await call(port, '/api/cache?repo=%2Fetc', { token: 'a'.repeat(32) })).status, 400, 'only a listed repository');
  assert.equal((await call(port, '/api/cache/archive', { token: 'a'.repeat(32), body: { id: 'guard-rejects-empty' } })).status, 400, 'a behavior is not archived from here');
  assert.equal((await call(port, '/api/cache/archive', { token: 'a'.repeat(32), body: { id: 'other-returns-one', repo: repos[0].id } })).status, 200);
  assert.ok(store.get('other-returns-one').archived);
  assert.equal((await get('/api/cache')).notes[0].status, 'archived');
  assert.equal((await call(port, '/api/cache/archive', { token: 'a'.repeat(32), body: { id: 'other-returns-one' } })).status, 400, 'already archived');
  assert.equal((await call(port, '/api/cache/restore', { token: 'a'.repeat(32), body: { id: 'other-returns-one' } })).status, 200);
  assert.ok(!store.get('other-returns-one').archived);
  const all = await get('/api/behaviors?repo=all');
  assert.equal(all.pending.length, 2);
  assert.ok(all.active.every(b => b.repo === repos[0].id));
  assert.equal((await call(port, '/api/behaviors/session-prompt?repo=all', { token: 'a'.repeat(32) })).status, 400, 'the interview is for one repository');
  assert.equal((await get('/api/usage?repo=all')).scope, 'machine');
});
