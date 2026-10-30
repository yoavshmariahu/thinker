// The one-time staleness reset (stale-reset.js), run once per repository by `thinker rewire`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, gitHead } from '../src/store.js';
import { hashDep, checkNote } from '../src/deps.js';
import { createNote, refresh } from '../src/ops.js';
import { resetStaleMarks, undoStaleReset, markerFile, RESET_VERSION } from '../src/stale-reset.js';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
const withEnv = async (vars, fn) => { const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };

function repoWithStaleNote() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-reset-')));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows(db) {\n  return db.query("select * from rows");\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  const store = new Store(dir).init();
  const n = createNote(store, { title: 'fetchRows reads rows', kind: 'rule', answers: ['how are rows read'], body: 'src/a.js:fetchRows reads the rows table', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  // the code changes under it, which is what marks it stale
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows(db) {\n  const t = Date.now();\n  return db.query("select * from rows order by id", t);\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'change');
  return { dir, store, id: n.id };
}

test('the legacy reset now queues ordinary edits without replacing verified hashes', () => withEnv({ THINKER_LOG: 'off' }, () => {
  const { dir, store, id } = repoWithStaleNote();
  try {
    const before = store.get(id);
    assert.equal(resetStaleMarks(store, { dry: true }), null);
    assert.equal(store.get(id).status, 'fresh', 'dry run writes nothing');
    assert.equal(fs.existsSync(markerFile(store)), false);
    assert.equal(resetStaleMarks(store), null);
    const after = store.get(id);
    assert.equal(after.status, 'pending');
    assert.deepEqual(after.deps, before.deps);
    assert.equal(after.verifiedCommit, before.verifiedCommit);
    assert.equal(after.verified, before.verified);
    assert.equal(after.rebaselined, undefined);
    assert.ok(after.recheck.changed.length);
    assert.equal(JSON.parse(fs.readFileSync(markerFile(store), 'utf8')).version, RESET_VERSION);
    assert.equal(resetStaleMarks(store), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));

test('the legacy reset does not clear a contradiction or missing anchor', () => withEnv({ THINKER_LOG: 'off' }, () => {
  const { dir, store, id } = repoWithStaleNote();
  try {
    store.put({ ...store.get(id), contradicted: { evidence: 'The session found this claim wrong' } });
    const missing = createNote(store, { title: 'human rule', kind: 'rule', answers: ['q'], body: 'src/a.js:fetchRows must read rows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }, { source: { type: 'human' } }).note;
    fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function different() {}');
    assert.equal(resetStaleMarks(store), null);
    assert.equal(store.get(id).status, 'stale');
    assert.ok(store.get(id).contradicted);
    assert.equal(store.get(missing.id).status, 'stale');
    assert.equal(store.get(missing.id).rebaselined, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));

test('a historical reset snapshot can still be undone, then migrate to pending without losing hashes', () => withEnv({ THINKER_LOG: 'off' }, () => {
  const { dir, store, id } = repoWithStaleNote();
  try {
    const before = store.get(id), changed = checkNote(dir, before).changed;
    const prior = { id, status: 'stale', deps: before.deps, verifiedCommit: before.verifiedCommit, stale: { since: '2026-01-01', changed } };
    store.put({ ...before, deps: before.deps.map(d => hashDep(dir, d)), verifiedCommit: gitHead(dir), rebaselined: { at: '2026-01-02' } });
    const saved = JSON.stringify({ version: RESET_VERSION, before: [prior], cleared: [id] });
    fs.mkdirSync(path.dirname(markerFile(store)), { recursive: true });
    fs.writeFileSync(markerFile(store), saved);
    assert.equal(resetStaleMarks(store), null);
    assert.equal(fs.readFileSync(markerFile(store), 'utf8'), saved, 'old undo evidence is retained');
    assert.deepEqual(undoStaleReset(store).restored, [id]);
    assert.deepEqual(store.get(id).deps, before.deps);
    assert.equal(store.get(id).rebaselined, undefined);
    assert.equal(refresh(store)[0].status, 'pending');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));
