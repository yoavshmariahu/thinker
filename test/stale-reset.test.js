// The one-time staleness reset (stale-reset.js), run once per repository by `thinker rewire`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
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

test('the reset clears the stale mark, and a refresh does not bring it back', () => withEnv({ THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), THINKER_LOG: undefined, THINKER_NOTES_DIR: undefined }, async () => {
  const { dir, store, id } = repoWithStaleNote();
  assert.equal(refresh(store, [store.get(id)])[0].status, 'stale', 'the code moved: stale');

  const r = resetStaleMarks(store);
  assert.deepEqual(r.cleared, [id]);
  const after = store.get(id);
  assert.equal(after.status, 'fresh');
  assert.equal(after.stale, undefined);
  assert.ok(after.rebaselined?.at, 'the reset records that no model looked at this note');

  // the point of re-hashing the deps: setting the status alone would be undone by the next refresh,
  // which re-derives staleness from the stored hashes
  assert.equal(refresh(store, [store.get(id)])[0].status, 'fresh', 'it stays cleared');

  // a reset is not a verification: confidence is untouched and `verified` is not moved forward
  const fresh = createNote(store, { title: 'x', kind: 'rule', answers: ['x'], body: 'src/a.js:fetchRows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  assert.equal(after.confidence, fresh.confidence, 'confidence not bumped');

  // once per repository
  assert.equal(resetStaleMarks(store), null, 'the marker stops a second run');
  assert.equal(JSON.parse(fs.readFileSync(markerFile(store), 'utf8')).version, RESET_VERSION);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('the reset leaves invalid notes alone and can be undone', () => withEnv({ THINKER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'home-')), THINKER_LOG: undefined, THINKER_NOTES_DIR: undefined }, async () => {
  const { dir, store, id } = repoWithStaleNote();
  const dead = createNote(store, { title: 'gone', kind: 'rule', answers: ['q'], body: 'src/a.js:fetchRows', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] }).note;
  store.put({ ...dead, status: 'invalid', invalidReason: 'retired' });

  const r = resetStaleMarks(store);
  assert.deepEqual(r.cleared, [id], 'only a stale note is cleared');
  assert.equal(store.get(dead.id).status, 'invalid', 'an invalid note is not revived');

  const u = undoStaleReset(store);
  assert.deepEqual(u.restored, [id]);
  const back = store.get(id);
  assert.equal(back.status, 'stale');
  assert.ok(back.stale?.changed?.length, 'the changed deps come back');
  assert.equal(back.rebaselined, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
}));
