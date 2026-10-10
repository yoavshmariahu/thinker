import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote, phraseBatches } from '../src/ops.js';
import { overCap } from '../src/llm.js';
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

test('source notes are drafted a few per call, and a failed call costs its own notes only', async t => {
  const { store } = fixture(t);
  for (let i = 0; i < 5; i++) createNote(store, { title: `Rule ${i} about admin access`, kind: 'rule',
    body: `Variant ${i}: src/auth.js:authorize checks the admin role before granting access to area ${i}.`,
    deps: [{ path: 'src/auth.js', symbol: 'authorize' }], answers: [`who may access area ${i}`] },
    { source: { type: 'pr', ref: `demo#${50 + i}` } });
  const sizes = [];
  const completeFn = async ({ prompt }) => {
    const ids = [...prompt.matchAll(/^SOURCE ID: (.+)$/gm)].map(m => m[1]);
    sizes.push(ids.length);
    if (sizes.length === 1) throw new Error('claude -p exited 1: the answer ran past the 4500-token output cap');
    return { json: { proposals: ids.map(id => ({ sourceId: id, title: `Behavior for ${id}`,
      body: 'src/auth.js:authorize grants access only to admins.', answers: [],
      deps: [{ path: 'src/auth.js', symbol: 'authorize' }], reason: 'The PR added the check.' })) } };
  };
  const r = await generateBehaviorProposals(store, { completeFn });
  assert.ok(sizes.length > 1 && Math.max(...sizes) <= 4, `calls of ${sizes}`);
  assert.equal(r.failed, sizes[0]);
  assert.equal(r.proposals.length, r.sources - r.failed);
  assert.match(r.lastError.message, /output cap/);
  await assert.rejects(generateBehaviorProposals(store, { completeFn: async () => { throw new Error('down'); } }), /down/);
});

test('phrasings for a whole cache go a few notes per call, and a failed call skips its own notes', async () => {
  const notes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}` }));
  const sizes = [];
  const r = await phraseBatches(null, notes, { phase: 'init', conc: 2, phraseFn: async (store, batch, opts) => {
    sizes.push(batch.length);
    assert.equal(opts.phase, 'init');
    if (batch[0].id === 'n8') throw new Error('claude -p exited 1');
    return { done: batch.map(n => n.id), tokens: 10 };
  } });
  assert.deepEqual(sizes.sort(), [4, 8, 8]);
  assert.equal(r.done.length, 12);
  assert.equal(r.failed, 8);
  assert.equal(r.tokens, 20);
  assert.match(r.lastError.message, /exited 1/);
});

test('an answer that reached the output cap is named as the cause of the exit', () => {
  const out = n => JSON.stringify({ usage: { output_tokens: 240, iterations: [{ output_tokens: n }] } });
  assert.match(overCap(out(2500), 2500), /2500-token output cap/);
  assert.equal(overCap(out(900), 2500), '');
  assert.equal(overCap('not json', 2500), '');
});

test('system propose --refresh drafts again without a build', async t => {
  const { store, note } = fixture(t);
  const draft = { sourceId: note.id, title: 'Only admins may access admin functions',
    body: 'src/auth.js:authorize grants access only to admins.', answers: [],
    deps: [{ path: 'src/auth.js', symbol: 'authorize' }], reason: 'PR demo#42 added it' };
  const answer = path.join(store.repo, 'answer.json');
  fs.writeFileSync(answer, JSON.stringify({ proposals: [draft] }));
  assert.equal(listBehaviorProposals(store).length, 0);
  const out = execFileSync('node', [path.resolve('src/cli.js'), 'system', 'propose', '--refresh', '--repo', store.repo],
    { encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'off', THINKER_LLM: 'command', THINKER_LLM_CMD: `cat > /dev/null; cat "${answer}"` } });
  assert.match(out, /1 behavior drafts from 1 source notes/);
  assert.match(out, /Accept: thinker system accept proposal-/);
  assert.equal(listBehaviorProposals(store).length, 1);
});
