import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { minedPrs, recordMinedPrs, nextPrs } from '../src/prs.js';

const day = n => `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`;
const ALL = Array.from({ length: 12 }, (_, i) => ({ number: i + 1, mergedAt: day(i + 1) }));
// stands in for the GitHub search: newest first, within the window, cut at the limit
const list = (slug, { before, after, limit }) => ALL.filter(p => p.mergedAt < before && (!after || p.mergedAt >= after)).reverse().slice(0, limit);
const store = () => new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-prs-'))).init();
const nums = prs => prs.map(p => p.number);

test('mined pull requests are recorded and not taken again', () => {
  const s = store();
  const first = nextPrs('o/r', minedPrs(s, 'o/r'), { limit: 3, now: day(11), list });
  assert.deepEqual(nums(first), [10, 9, 8]);
  recordMinedPrs(s, 'o/r', first);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dir, 'prs.json'), 'utf8'))['o/r'], { mined: [8, 9, 10], latest: day(10), oldest: day(8) });

  // two were merged since; the rest of the limit goes further back
  const second = nextPrs('o/r', minedPrs(s, 'o/r'), { limit: 4, now: day(13), list });
  assert.deepEqual(nums(second), [12, 11, 7, 6]);
  recordMinedPrs(s, 'o/r', second);

  const third = nextPrs('o/r', minedPrs(s, 'o/r'), { limit: 20, now: day(13), list });
  assert.deepEqual(nums(third), [5, 4, 3, 2, 1]);
  recordMinedPrs(s, 'o/r', third);
  assert.deepEqual(nextPrs('o/r', minedPrs(s, 'o/r'), { limit: 20, now: day(13), list }), []);
  assert.equal(minedPrs(s, 'other/repo').mined.size, 0);
});

test('a cache built before the record existed: notes name the pull requests they came from', () => {
  const s = store();
  fs.writeFileSync(path.join(s.notesDir, 'a.json'), JSON.stringify({ id: 'a', kind: 'fix', title: 't', body: 'b', source: { type: 'pr', ref: 'o/r#12' } }));
  const rec = minedPrs(s, 'o/r');
  assert.ok(rec.mined.has(12));
  assert.deepEqual(nums(nextPrs('o/r', rec, { limit: 2, now: day(13), list })), [11, 10]);
});
