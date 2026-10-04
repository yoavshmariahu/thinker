import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { stats, renderStats } from '../src/stats.js';
import { commands } from '../src/commands/cache.js';

test('stats defaults to machine activity, preserves local JSON fields and supports filters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-stats-'));
  const keys = ['THINKER_HOME', 'THINKER_LOG', 'THINKER_NOTES_DIR'];
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  process.env.THINKER_HOME = path.join(dir, 'home');
  delete process.env.THINKER_LOG;
  delete process.env.THINKER_NOTES_DIR;
  try {
    const one = new Store(path.join(dir, 'one')).init();
    const two = new Store(path.join(dir, 'two')).init();
    one.put({ id: 'one', title: 'One', body: 'body', kind: 'rule', status: 'fresh', deps: [] });
    one.log({ op: 'orient', session: 'one', client: 'codex', served: ['one'], tokens: 100 });
    two.log({ op: 'orient', session: 'two', client: 'claude', served: [], t: '2000-01-01T00:00:00.000Z' });
    const result = stats(one);
    assert.equal(result.repo, one.repo);
    assert.equal(result.notes, 1);
    assert.deepEqual(result.status, { fresh: 1 });
    assert.deepEqual(result.kinds, { rule: 1 });
    assert.equal(result.usage.requests, 2);
    assert.equal(result.usage.repos.length, 2);
    assert.equal(stats(one, { here: true }).usage.requests, 1);
    assert.equal(stats(one, { days: 7 }).usage.requests, 1);
    const rendered = renderStats(result);
    for (const text of ['this machine', 'Activity', 'Tokens', 'Learning', 'Current checkout', one.repo, two.repo, '1 codex', '1 claude', 'estimates, not measured']) assert.ok(rendered.includes(text), text);
    let output;
    await commands.stats({ store: one, flags: { json: true, here: true }, out: s => { output = s; } });
    assert.equal(JSON.parse(output).usage.requests, 1);
    for (const days of [true, 'bad', '0', '-1', 'Infinity']) await assert.rejects(commands.stats({ store: one, flags: { days }, out() {} }), /positive number/);
    const empty = new Store(path.join(dir, 'empty'));
    assert.match(renderStats(stats(empty, { here: true })), /No usage recorded/);
    assert.match(renderStats(stats(empty, { here: true })), /Not set up/);
    assert.equal(fs.existsSync(empty.dir), false);
  } finally {
    for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
