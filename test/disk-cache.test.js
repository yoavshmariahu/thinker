// The on-disk caches of what a file's text or a commit's content hashes to (disk-cache.js, deps.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { diskCache, cacheKey, setDiskCache, cachedByFiles } from '../src/disk-cache.js';

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

test('a result read from files is kept by their size and mtime under one key, and thawed the same way fresh or cached', t => {
  const dir = cacheDir(t), c = diskCache('by-files', 1);
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-byfiles-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'a.txt'); fs.writeFileSync(f, 'one\ntwo\n');
  let reads = 0;
  const read = () => cachedByFiles(c, cacheKey('x', f), [f], () => { reads++; return new Set(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); }, { freeze: v => [...v], thaw: v => new Set(v) });
  assert.deepEqual(read(), new Set(['one', 'two']));
  assert.deepEqual(read(), new Set(['one', 'two']));
  assert.equal(reads, 1, 'the second call is the cached entry');
  assert.equal(files(dir).length, 1);
  fs.appendFileSync(f, 'three\n');
  assert.deepEqual(read(), new Set(['one', 'two', 'three']), 'a grown file is read again');
  assert.equal(reads, 2);
  assert.equal(files(dir).length, 1, 'one entry per key, rewritten, not one per size');
  setDiskCache(null);
  assert.deepEqual(read(), new Set(['one', 'two', 'three']), 'with no cache directory it reads every time');
  assert.equal(reads, 3);
});
