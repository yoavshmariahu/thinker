import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote, refresh, verifyNote, outcome, archiveNotes } from '../src/ops.js';
import { deleteUnused, maintain } from '../src/maintain.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-retain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'a.js'), 'export function rows() { return 1; }\n');
  const store = new Store(dir).init();
  const note = createNote(store, { title: 'Rows return one', kind: 'rule', answers: ['what rows return'], body: 'a.js:rows returns one.', deps: [{ path: 'a.js', symbol: 'rows' }] }).note;
  return { dir, store, note };
}

test('incomplete verification never invalidates or overwrites a stale note', async t => {
  const { dir, store, note } = fixture(t);
  fs.writeFileSync(path.join(dir, 'a.js'), 'export function rows() { return 2; }\n');
  const stale = refresh(store, [note])[0];
  for (const json of [{}, { verdict: 'unknown' }, { verdict: 'update', body: '' }, { verdict: 'invalid' }]) {
    await assert.rejects(verifyNote(store, stale, { completeFn: async () => ({ json }) }), /incomplete verdict/);
    assert.deepEqual(store.get(note.id), JSON.parse(JSON.stringify(stale)));
  }
  const r = await verifyNote(store, stale, { completeFn: async () => ({ json: { verdict: 'invalid', reason: 'The documented API was removed.' } }) });
  assert.equal(r.note.status, 'invalid', 'an explicit supported verdict still retires a note');
});

test('age and noisy session outcomes do not delete or invalidate notes', t => {
  const { store, note } = fixture(t);
  store.put({ ...note, created: '2020-01-01T00:00:00Z', servedIn: ['s'], confidence: 0.31 });
  for (let i = 0; i < 8; i++) outcome(store, { session: 's', positive: false, reason: 'session-level signal' });
  assert.equal(store.get(note.id).status, 'fresh');
  assert.deepEqual(deleteUnused(store), []);
  assert.deepEqual(archiveNotes(store), []);
  assert.ok(store.get(note.id));
});

test('cache maintenance ignores obsolete background PR and suggestion options', async t => {
  const { dir, store } = fixture(t);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { prSync: true, coverage: true, contextSuggest: true, phrasePerRun: 0 } }));
  const forbidden = () => { throw new Error('retired side work ran'); };
  const r = await maintain(store, dir, { fns: { syncPrs: forbidden, coverage: forbidden, contextSuggest: forbidden, spentToday: () => 0 } });
  assert.equal(r.errors, 0);
});

test('an old stop --nudge hook cannot block completion or ask for more edits', async t => {
  const { dir, store } = fixture(t);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.resolve('src/cli.js'), 'hook', 'stop', '--nudge', '--client', 'claude', '--repo', dir], {
    input: JSON.stringify({ session_id: 's', hook_event_name: 'Stop' }), encoding: 'utf8',
    env: { ...process.env, THINKER_TEST: '1', THINKER_NO_LEARN: '1', THINKER_HOME: path.join(dir, 'home') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /"decision":"block"|Before finishing|Make the additional edits/);
  const file = path.join(store.dir, 'log.jsonl');
  const log = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  assert.doesNotMatch(log, /"op":"nudge"/);
});
