import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { generateBehaviorProposals, listBehaviorProposals, acceptBehaviorProposal } from '../src/behavior-proposals.js';

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-proposals-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'auth.js'), 'export function authorize(user) { return user.role === "admin"; }\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: repo });
  const store = new Store(repo).init();
  const note = createNote(store, { title: 'Admin access requires the admin role', kind: 'rule',
    body: 'src/auth.js:authorize checks the admin role before granting access.',
    deps: [{ path: 'src/auth.js', symbol: 'authorize' }], answers: ['who may access admin'] },
    { source: { type: 'pr', ref: 'demo#42' } }).note;
  return { store, note };
}

test('optional generation stores reviewable drafts without activating a behavior', async t => {
  const { store, note } = fixture(t);
  let calls = 0;
  const draft = { sourceId: note.id, title: 'Only admins may access admin functions',
    body: 'src/auth.js:authorize grants access only when the user has the admin role.',
    answers: ['can nonadmins access admin functions'], deps: [{ path: 'src/auth.js', symbol: 'authorize' }],
    reason: 'PR demo#42 added the role check.' };
  const result = await generateBehaviorProposals(store, { completeFn: async ({ prompt }) => {
    calls++;
    assert.match(prompt, /demo#42/);
    assert.match(prompt, /authorize/);
    return { json: { proposals: [draft, { ...draft, sourceId: 'made-up' },
      { ...draft, deps: [{ path: 'src/other.js', symbol: 'missing' }] }] } };
  } });
  assert.equal(calls, 1);
  assert.equal(result.proposals.length, 1);
  assert.equal(store.list().filter(n => n.kind === 'behavior').length, 0);
  assert.equal(listBehaviorProposals(store).length, 1);
  const accepted = acceptBehaviorProposal(store, result.proposals[0].id);
  assert.equal(accepted.note.kind, 'behavior');
  assert.equal(accepted.note.mutability, 'mutable');
  assert.equal(accepted.note.source.proposedFrom, note.id);
  assert.equal(listBehaviorProposals(store).length, 0);
});

test('generation avoids model work without evidence and rejects extra body anchors', async t => {
  const { store, note } = fixture(t);
  const invalid = { sourceId: note.id, title: 'Only admins may access admin functions',
    body: 'src/auth.js:authorize checks roles; src/auth.js:other also checks roles.',
    answers: [], deps: [{ path: 'src/auth.js', symbol: 'authorize' }], reason: 'PR added it' };
  const r = await generateBehaviorProposals(store, { completeFn: async () => ({ json: { proposals: [invalid] } }) });
  assert.equal(r.proposals.length, 0);
  assert.equal(listBehaviorProposals(store).length, 0);
  assert.match(acceptBehaviorProposal(store, 'proposal-missing').error, /no such/);
});

test('a draft cannot be accepted after its source code changes', async t => {
  const { store, note } = fixture(t);
  const draft = { sourceId: note.id, title: 'Only admins may access admin functions',
    body: 'src/auth.js:authorize grants access only to admins.', answers: [],
    deps: [{ path: 'src/auth.js', symbol: 'authorize' }], reason: 'PR demo#42 added it' };
  const r = await generateBehaviorProposals(store, { completeFn: async () => ({ json: { proposals: [draft] } }) });
  fs.writeFileSync(path.join(store.repo, 'src/auth.js'), 'export function authorize(user) { return true; }\n');
  assert.match(acceptBehaviorProposal(store, r.proposals[0].id).error, /changed/);
  assert.equal(store.list().filter(n => n.kind === 'behavior').length, 0);
});

test('system propose and accept expose the draft through the CLI', async t => {
  const { store, note } = fixture(t);
  const draft = { sourceId: note.id, title: 'Only admins may access admin functions',
    body: 'src/auth.js:authorize grants access only to admins.', answers: ['who may access admin'],
    deps: [{ path: 'src/auth.js', symbol: 'authorize' }], reason: 'PR demo#42 added it' };
  const r = await generateBehaviorProposals(store, { completeFn: async () => ({ json: { proposals: [draft] } }) });
  const cli = path.resolve('src/cli.js');
  const run = (...args) => execFileSync('node', [cli, 'system', ...args, '--repo', store.repo],
    { encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'off' } });
  assert.match(run('propose'), /proposal-.*Only admins may access admin functions/s);
  assert.match(run('accept', r.proposals[0].id), /now a mutable behavior/);
  assert.equal(store.list().filter(n => n.kind === 'behavior').length, 1);
});
