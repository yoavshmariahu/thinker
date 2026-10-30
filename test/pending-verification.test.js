import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote, refresh, orient, lookup, verifyNote } from '../src/ops.js';
import { pickStale, DEFAULTS } from '../src/maintain.js';
import { hashDep } from '../src/deps.js';
import { renderNote } from '../src/rank.js';
import { nextRequest, answerRequest, markBuild } from '../src/session-llm.js';

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-recheck-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const file = path.join(repo, 'rows.js');
  const original = 'export function fetchRows() { return 1; }\n';
  fs.writeFileSync(file, original);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q'); git('add', '.'); git('commit', '-qm', 'initial');
  const store = new Store(repo).init();
  const note = createNote(store, { kind: 'rule', title: 'Fetching rows', answers: ['how are rows fetched'], body: 'rows.js:fetchRows fetches rows in order.', deps: [{ path: 'rows.js', symbol: 'fetchRows' }] }, { source: { type: 'human' } }).note;
  return { repo, store, note, original, file, edit: () => fs.writeFileSync(file, original.replace('return 1', 'return 2')) };
}
function env(t, values) {
  for (const [k, v] of Object.entries(values)) {
    const old = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
    t.after(() => { if (old === undefined) delete process.env[k]; else process.env[k] = old; });
  }
}

test('ordinary edits migrate old stale notes to usable pending notes without rebaselining', async t => {
  env(t, { THINKER_CE: 'off', THINKER_LOG: 'local' });
  const f = fixture(t);
  f.edit();
  const since = '2026-01-01T00:00:00.000Z';
  f.store.put({ ...f.note, status: 'stale', stale: { since, changed: [{ path: 'rows.js', symbol: 'fetchRows', reason: 'symbol body changed' }] } });
  const [pending] = refresh(f.store);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.recheck.since, since);
  assert.equal(pending.stale, undefined);
  assert.deepEqual(pending.deps, f.note.deps, 'keep the last verified hashes');
  assert.equal(pending.verified, f.note.verified);
  assert.equal(pending.verifiedCommit, f.note.verifiedCommit);
  assert.equal(new Store(f.repo).get(f.note.id).recheck.since, since, 'queue metadata survives reopening');
  const served = await orient(f.store, { task: 'how are rows fetched', freshOnly: true, session: 's', recordUsage: true });
  assert.ok(served.included.some(n => n.id === f.note.id && n.status === 'pending'));
  assert.match(served.text, /Pending verification/);
  assert.doesNotMatch(served.text, /⚠ STALE/);
  assert.deepEqual(pickStale(f.store.list(), DEFAULTS).stale.map(n => n.id), [f.note.id]);
  assert.equal((await lookup(f.store, { query: f.note.id })).included[0].status, 'pending');
  assert.equal(refresh(f.store)[0].recheck.since, since);
  fs.writeFileSync(f.file, f.original);
  const [restored] = refresh(f.store);
  assert.equal(restored.status, 'fresh');
  assert.equal(restored.recheck, undefined);
});

for (const cause of ['file removed', 'symbol not found', 'contradiction']) {
  test(cause + ' remains withheld from hooks and lookups, even with serveStale on', async t => {
    env(t, { THINKER_CE: 'off', THINKER_SERVE_STALE: 'on', THINKER_LOG: 'off' });
    const f = fixture(t); f.edit(); refresh(f.store);
    if (cause === 'file removed') fs.unlinkSync(f.file);
    else if (cause === 'symbol not found') fs.writeFileSync(f.file, 'export function different() {}\n');
    else f.store.put({ ...f.store.get(f.note.id), contradicted: { evidence: 'fetchRows does not keep rows ordered' } });
    const [note] = refresh(f.store);
    assert.equal(note.status, 'stale');
    assert.equal(note.recheck, undefined);
    assert.equal((await orient(f.store, { task: 'how are rows fetched', freshOnly: true })).included.length, 0);
    assert.equal((await lookup(f.store, { query: f.note.id })).included.length, 0);
    if (cause === 'contradiction') {
      fs.writeFileSync(f.file, f.original);
      assert.equal(refresh(f.store)[0].status, 'stale', 'a revert does not clear evidence of a contradiction');
    }
  });
}

test('pending verification uses the desktop session queue with no CLI login and preserves its baseline until answered', async t => {
  const f = fixture(t), queue = path.join(f.repo, 'queue');
  env(t, { THINKER_LLM: 'session', THINKER_SESSION_QUEUE: queue, THINKER_LOG: 'off', ANTHROPIC_API_KEY: undefined });
  markBuild(queue, process.pid);
  f.edit(); const [pending] = refresh(f.store);
  const checking = verifyNote(f.store, pending);
  const { request } = await nextRequest(queue, { waitMs: 5000, pollMs: 10 });
  assert.match(request.prompt, /rows.js:fetchRows \(symbol body changed\)/);
  assert.deepEqual(f.store.get(f.note.id).deps, f.note.deps);
  answerRequest(queue, request.id, JSON.stringify({ verdict: 'still_valid', reason: 'The ordering claim still holds.' }));
  const result = await checking;
  assert.equal(result.note.status, 'fresh');
  assert.equal(result.note.recheck, undefined);
  assert.equal(result.note.deps[0].hash, hashDep(f.repo, f.note.deps[0]).hash);
});

for (const verdict of ['update', 'invalid']) test('CLI verification of a pending note can ' + verdict, async t => {
  const f = fixture(t); f.edit(); const [pending] = refresh(f.store);
  const model = path.join(f.repo, 'model.cjs');
  const response = { verdict, reason: 'The ordering claim is no longer correct.', body: 'rows.js:fetchRows returns rows in provider order.', confidence: 0.8 };
  fs.writeFileSync(model, "require('fs').readFileSync(0, 'utf8'); process.stdout.write(" + JSON.stringify(JSON.stringify(response)) + ');');
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  env(t, { THINKER_LLM: 'command', THINKER_LLM_CMD: quote(process.execPath) + ' ' + quote(model), THINKER_LOG: 'off' });
  const result = await verifyNote(f.store, pending);
  assert.equal(result.note.status, verdict === 'update' ? 'fresh' : 'invalid');
  assert.equal(result.note.recheck, undefined);
  if (verdict === 'update') assert.equal(result.note.body, response.body);
});

test('pending notes are labelled honestly even when packed in short form', () => {
  assert.match(renderNote({ status: 'pending', title: 'Rows', body: 'Some claim.' }, { full: false }), /Pending verification/);
});

test('check reports pending notes and verify selects them without naming ids', t => {
  const f = fixture(t); f.edit();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const model = path.join(f.repo, 'model.cjs');
  fs.writeFileSync(model, "require('fs').readFileSync(0,'utf8');console.log(JSON.stringify({verdict:'still_valid',reason:'Ordering still holds'}));");
  const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  const childEnv = { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'off', THINKER_LLM: 'command', THINKER_LLM_CMD: quote(process.execPath) + ' ' + quote(model) };
  const run = command => execFileSync(process.execPath, [cli, command, '--repo', f.repo], { encoding: 'utf8', env: childEnv });
  assert.match(run('check'), /0\/1 notes stale; 1 pending verification \(still usable\)/);
  assert.equal(f.store.get(f.note.id).status, 'pending');
  assert.match(run('verify'), /verified 1 notes/);
  assert.equal(f.store.get(f.note.id).status, 'fresh');
  assert.equal(f.store.get(f.note.id).recheck, undefined);
});
