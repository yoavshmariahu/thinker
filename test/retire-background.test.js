import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { Store } from '../src/store.js';
import { retireBackground } from '../src/retire-background.js';

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-retire-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  return { dir, store: new Store(dir).init() };
}

test('an update stops the mining an older version left running, its pending question and its queued jobs', async t => {
  const { store } = repo(t);
  const st = path.join(store.dir, 'state'); fs.mkdirSync(path.join(st, 'session-jobs'), { recursive: true });
  // a live mining batch: a process of our own standing in for it
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
  fs.writeFileSync(path.join(st, `pr-mining-${Date.now()}-${child.pid}.jsonl`), JSON.stringify({ time: new Date().toISOString(), event: 'batch', name: 'mine-prs', total: 20 }) + '\n');
  fs.writeFileSync(path.join(st, 'commits.json'), JSON.stringify({ pending: { count: 30 }, answers: [] }));
  fs.writeFileSync(path.join(st, 'session-jobs', 'mine.json'), JSON.stringify({ key: 'mine', args: ['mine-prs', '--quiet'], t: new Date().toISOString() }));
  fs.writeFileSync(path.join(st, 'session-jobs', 'distill-x.json'), JSON.stringify({ key: 'distill-x', args: ['distill', 'f.jsonl'], t: new Date().toISOString() }));
  // In a desktop app this is the only way the words under the Save page's cards are ever written: no agent CLI is
  // signed in, so the person's request waits here for the session's own model (commands/explain.js). An update that
  // dropped it left that door dead, and nobody would have seen why: the page simply never filled in.
  fs.writeFileSync(path.join(st, 'session-jobs', 'explain.json'), JSON.stringify({ key: 'explain', args: ['explain', '--repo', store.repo], t: new Date().toISOString() }));
  assert.equal(retireBackground(store, { dry: true }).length, 3);
  assert.ok(fs.existsSync(path.join(st, 'session-jobs', 'mine.json')), 'dry changes nothing');
  const done = retireBackground(store);
  assert.equal(done.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(st, 'commits.json'), 'utf8')).pending, undefined);
  assert.ok(!fs.existsSync(path.join(st, 'session-jobs', 'mine.json')));
  assert.ok(fs.existsSync(path.join(st, 'session-jobs', 'distill-x.json')), "a session's distillation stays queued");
  assert.ok(fs.existsSync(path.join(st, 'session-jobs', 'explain.json')), 'a card someone asked for in a desktop app stays queued');
  // Wait for the process to go rather than 200 ms and a hope: a signalled child can take longer than that
  // to be reaped under the whole suite's load, and the assertion would then read it as still running.
  const gone = async (pid, ms = 10_000) => {
    const t = Date.now();
    for (;;) {
      try { process.kill(pid, 0); } catch { return true; }
      if (Date.now() - t > ms) return false;
      await new Promise(r => setTimeout(r, 20));
    }
  };
  assert.equal(await gone(child.pid), true, 'the mining batch is stopped');
});

test('a repository that turned mining on keeps it', t => {
  const { store } = repo(t);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { prs: true } }));
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'state', 'commits.json'), JSON.stringify({ pending: { count: 30 } }));
  assert.deepEqual(retireBackground(store), []);
});
