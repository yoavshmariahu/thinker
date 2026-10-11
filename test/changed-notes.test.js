import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { hashText } from '../src/deps.js';
import { changedCodeNotes } from '../src/changed-notes.js';

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-changed-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.com'); git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app/inject.py'), 'def inject_tcp(flow):\n    if not valid(flow):\n        return\n    send(flow)\n');
  fs.writeFileSync(path.join(dir, 'app/other.py'), 'def other():\n    return 1\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const store = new Store(dir).init();
  const note = (id, file, symbol) => store.put({ id, kind: 'rule', title: `rule on ${file}`, body: `${symbol || file} must validate before sending`, status: 'verified',
    deps: [{ path: file, ...(symbol ? { symbol } : {}), hash: hashText(fs.readFileSync(path.join(dir, file), 'utf8')) }] });
  note('inject-rule', 'app/inject.py', 'inject_tcp');
  note('other-rule', 'app/other.py', 'other');
  return { dir, store };
}

test('no change in the working tree: nothing is served', () => {
  const { store } = repo();
  const r = changedCodeNotes(store, { session: 's1', client: 'codex' });
  assert.equal(r.included.length, 0);
  assert.equal(r.text, '');
});

test('a change in progress: the notes resting on the changed code, once per session', () => {
  const { dir, store } = repo();
  fs.writeFileSync(path.join(dir, 'app/inject.py'), 'def inject_tcp(flow):\n    if not valid(flow):\n        pass\n    send(flow)\n');
  const r = changedCodeNotes(store, { session: 's1', client: 'codex' });
  assert.deepEqual(r.included.map(n => n.id), ['inject-rule']);
  assert.deepEqual(r.files, ['app/inject.py']);
  assert.match(r.text, /code the working tree changes \(app\/inject\.py\)/);
  assert.match(r.text, /must validate before sending/);
  assert.ok(store.get('inject-rule').servedIn.includes('s1'));
  assert.equal(changedCodeNotes(store, { session: 's1', client: 'codex' }).included.length, 0, 'served once in a session');
  assert.equal(changedCodeNotes(store, { session: 's2', client: 'codex' }).included.length, 1, 'another session is served again');
});

test('config changedNotes: false turns it off; notes orient already served are excluded', () => {
  const { dir, store } = repo();
  fs.writeFileSync(path.join(dir, 'app/inject.py'), 'def inject_tcp(flow):\n    send(flow)\n');
  assert.equal(changedCodeNotes(store, { session: 's1', exclude: new Set(['inject-rule']) }).included.length, 0);
  fs.writeFileSync(path.join(dir, '.thinker/config.json'), JSON.stringify({ changedNotes: false }));
  assert.equal(changedCodeNotes(store, { session: 's3' }).included.length, 0);
});
