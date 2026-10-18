import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneState } from '../src/state-prune.js';

test('state files no session will read again are pruned: finished or orphaned batches after a day, session files after a month', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-prune-'));
  try {
    const st = path.join(dir, 'state'); fs.mkdirSync(path.join(st, 'session-jobs'), { recursive: true });
    const put = (n, days, body = '') => { const f = path.join(st, n); fs.writeFileSync(f, body); const t = new Date(Date.now() - days * 86400_000); fs.utimesSync(f, t, t); };
    const done = '{"event":"batch","total":1}\n{"event":"finish"}\n';
    put(`distilling-sessions-1-${process.pid}.jsonl`, 2, done);               // finished, old: goes
    put(`pr-mining-2-${process.pid}.jsonl`, 8, '{"event":"batch","total":3}\n'); // unfinished, writer alive: stays
    put('pr-mining-3-999999.jsonl', 8, '{"event":"batch","total":3}\n');       // unfinished, writer gone: goes
    put(`distilling-sessions-4-${process.pid}.jsonl`, 0.5, done);
    put(`pr-mining-9-${process.pid}.jsonl`, 40, done);                         // finished and old, but the newest mining batch: stays             // finished, recent: stays
    put('session-abc.json', 31); put('trace-abc.jsonl', 31); put('oriented-abc', 31);
    put('01a0f03e-ffcc-7ba0-b7a2-c6e4e8a06ff7.json', 31); put('rollout-2026-09-27T19-29-55-x.json', 31);
    put('session-new.json', 3);
    for (const n of ['maintain.json', 'access.json', 'app-session', 'learn.last', 'session-work.log']) put(n, 90);
    const gone = pruneState(dir).sort();
    assert.deepEqual(gone, ['01a0f03e-ffcc-7ba0-b7a2-c6e4e8a06ff7.json', `distilling-sessions-1-${process.pid}.jsonl`, 'oriented-abc', 'pr-mining-3-999999.jsonl', 'rollout-2026-09-27T19-29-55-x.json', 'session-abc.json', 'trace-abc.jsonl']);
    assert.deepEqual(fs.readdirSync(st).sort(), ['access.json', 'app-session', `distilling-sessions-4-${process.pid}.jsonl`, 'learn.last', 'maintain.json', `pr-mining-2-${process.pid}.jsonl`, `pr-mining-9-${process.pid}.jsonl`, 'session-jobs', 'session-new.json', 'session-work.log']);
    assert.deepEqual(pruneState(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
