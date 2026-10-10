// The on-disk caches of what a file's text or a commit's content hashes to (disk-cache.js, deps.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { diskCache, cacheKey, setDiskCache } from '../src/disk-cache.js';
import { hashText, hashDepAt } from '../src/deps.js';

function cacheDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-diskcache-'));
  setDiskCache(dir);
  t.after(() => { setDiskCache(undefined); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const files = dir => fs.readdirSync(dir, { recursive: true }).filter(f => String(f).endsWith('.json')).map(String);

test('an entry is read back, a missing one is undefined, and no directory means no cache', t => {
  const dir = cacheDir(t), c = diskCache('thing', 1);
  const key = cacheKey('a', 'b');
  assert.equal(c.get(key), undefined);
  c.set(key, { n: 1 });
  assert.deepEqual(c.get(key), { n: 1 });
  assert.notEqual(cacheKey('a', 'b'), cacheKey('ab', ''), 'parts are kept apart');
  assert.equal(diskCache('thing', 2).get(key), undefined, 'another version does not read it');
  assert.equal(files(dir).filter(f => f.endsWith('.tmp')).length, 0);
  setDiskCache(null);
  c.set(cacheKey('c'), 1);
  assert.equal(c.get(key), undefined);
});

test('prune drops entries of earlier versions and those nothing has written for a while', t => {
  const dir = cacheDir(t), old = diskCache('thing', 1), cur = diskCache('thing', 2);
  old.set(cacheKey('x'), 1);
  cur.set(cacheKey('kept'), 1); cur.set(cacheKey('aged'), 1);
  const aged = files(dir).find(f => f.includes(cacheKey('aged')));
  const longAgo = new Date(Date.now() - 60 * 24 * 3600_000);
  fs.utimesSync(path.join(dir, aged), longAgo, longAgo);
  assert.equal(cur.prune(), 2);
  assert.equal(cur.get(cacheKey('kept')), 1);
  assert.equal(cur.get(cacheKey('aged')), undefined);
  assert.equal(fs.existsSync(path.join(dir, 'thing', 'v1')), false);
});

test('a symbol hash is stored by the text it was taken from and follows the text', t => {
  const dir = cacheDir(t);
  const a = 'function run() {\n  return 1;\n}\n\nfunction other() {\n  return 2;\n}\n';
  const first = hashText(a, { path: 'x.unknownlang', symbol: 'run' });
  assert.match(first.hash, /^sha256:/);
  assert.equal(first.line, 1);
  const stored = files(dir).filter(f => f.startsWith('symbol-hash'));
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, stored[0]), 'utf8'))), ['run']);
  assert.deepEqual(hashText(a, { path: 'x.unknownlang', symbol: 'run' }), first);
  // a symbol that is not there is remembered as such, and hashes the file as before
  const none = hashText(a, { path: 'x.unknownlang', symbol: 'absent' });
  assert.equal(none.symbolMissing, true);
  assert.deepEqual(hashText(a, { path: 'x.unknownlang', symbol: 'absent' }), none);
  // the body changes: another text, another entry, another hash
  const b = a.replace('return 1', 'return 3');
  assert.notEqual(hashText(b, { path: 'x.unknownlang', symbol: 'run' }).hash, first.hash);
  assert.equal(hashText(b, { path: 'x.unknownlang', symbol: 'other' }).hash, hashText(a, { path: 'x.unknownlang', symbol: 'other' }).hash);
  assert.equal(files(dir).filter(f => f.startsWith('symbol-hash')).length, 2);
  // without a cache the answers are the same
  setDiskCache(null);
  assert.deepEqual(hashText(a, { path: 'y.unknownlang', symbol: 'run' }), { ...first, path: 'y.unknownlang' });
});

test('a hash at a commit is kept for a full commit id only, and a failure is never kept', t => {
  const dir = cacheDir(t);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-atcommit-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.unknownlang'), 'function run() {\n  return 1;\n}\n');
  git('add', '.'); git('commit', '-qm', 'one');
  const commit = git('rev-parse', 'HEAD');
  const dep = { path: 'a.unknownlang', symbol: 'run', fanout: 3 };
  const first = hashDepAt(repo, dep, commit);
  assert.equal(first.missing, false);
  assert.equal(first.fanout, 3);
  // the answer no longer needs the repository
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-norepo-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  assert.deepEqual(hashDepAt(elsewhere, dep, commit), first);
  assert.equal(hashDepAt(elsewhere, dep, 'HEAD').missing, true, 'a name that moves is asked of git every time');
  // a commit git does not have is a failure, asked again once it is there
  const absent = 'f'.repeat(40);
  assert.equal(hashDepAt(repo, dep, absent).missing, true);
  assert.equal(files(dir).filter(f => f.startsWith('dep-at-commit')).length, 1);
});
