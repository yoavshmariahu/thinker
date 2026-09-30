import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, repoId } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { maintain, maintenanceNotice, renderMaintain, spentToday, postCommitHook, DEFAULTS } from '../src/maintain.js';

// a git repo with one note whose dependency is then changed, so the note is stale
function staleRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-maintain-')));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.py'), 'def foo():\n    return 1\n');
  fs.writeFileSync(path.join(dir, 'src/b.py'), 'def bar():\n    return 2\n');
  const git = args => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']); git(['config', 'user.name', 't']); git(['config', 'user.email', 't@t']); git(['config', 'commit.gpgsign', 'false']);
  git(['add', '.']); git(['commit', '-q', '-m', 'one']);
  const store = new Store(dir).init();
  const a = createNote(store, { title: 'Foo returns one', kind: 'gotcha', answers: ['what foo returns'], body: 'src/a.py:foo returns 1', deps: [{ path: 'src/a.py', symbol: 'foo' }] }).note;
  const b = createNote(store, { title: 'Bar returns two', kind: 'gotcha', answers: ['what bar returns'], body: 'src/b.py:bar returns 2', deps: [{ path: 'src/b.py', symbol: 'bar' }] }).note;
  fs.writeFileSync(path.join(dir, 'src/a.py'), 'def foo():\n    return 11\n');
  return { dir, store, a, b };
}

const env = { THINKER_LOG: 'off', THINKER_TELEMETRY: 'off' };
function withEnv(fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('maintain verifies stale notes, phrases unphrased ones, refreshes co-change, and reports once', () => withEnv(async () => {
  const { dir, store, a, b } = staleRepo();
  const verified = [], phrased = [];
  const r = await maintain(store, dir, { fns: {
    spentToday: () => 0,
    verify: async (s, n) => { verified.push(n.id); return { verdict: n.id === a.id ? 'update' : 'still_valid', cost: 0.01 }; },
    phrase: async (s, notes) => { phrased.push(...notes.map(n => n.id)); return { done: notes, cost: 0.005 }; },
    minePrs: async () => ({ saved: 9 }),
  } });
  assert.deepEqual(verified, [a.id], 'only the stale note is sent to the model');
  assert.equal(r.verified, 1); assert.equal(r.updated, 1); assert.equal(r.retired, 0);
  assert.deepEqual(phrased.sort(), [a.id, b.id].sort(), 'both notes lack phrasings');
  assert.equal(r.cochange, true);
  assert.ok(fs.existsSync(path.join(dir, '.thinker', 'cochange.json')));
  assert.equal(r.prs, 0, 'the first run only marks where PR mining starts');
  assert.ok(Math.abs(r.cost - 0.015) < 1e-9);
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'state', 'maintain.json'), 'utf8'));
  assert.ok(state.prsAfter);
  // the user hears about it once
  const notice = maintenanceNotice(store);
  assert.match(notice, /1 stale note re-verified \(1 updated\); 2 notes phrased; co-change index refreshed/);
  assert.equal(maintenanceNotice(store), '');
  assert.match(renderMaintain(r), /1 re-verified, 1 updated, 2 phrased, 0 from pull requests, co-change refreshed \(\$0\.015\)/);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('maintain mines pull requests merged since its first run, and co-change only when HEAD moved', () => withEnv(async () => {
  const { dir, store } = staleRepo();
  const calls = [];
  const fns = { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid', cost: 0 }), phrase: async (s, n) => ({ done: n, cost: 0 }), minePrs: async o => { calls.push(o); return { saved: 2, cost: 0.1 }; } };
  await maintain(store, dir, { fns });
  const first = JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'state', 'maintain.json'), 'utf8')).prsAfter;
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  const r = await maintain(store, dir, { fns });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].after, first);
  assert.equal(calls[0].limit, DEFAULTS.prsPerRun);
  assert.equal(r.prs, 2);
  assert.equal(r.cochange, false, 'HEAD did not move');
  assert.match(maintenanceNotice(store), /2 notes from merged pull requests/);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('maintain stops at the daily cap, honours the lock, and can be switched off', () => withEnv(async () => {
  const { dir, store } = staleRepo();
  let verifyCalls = 0;
  const fns = { spentToday: () => DEFAULTS.dailyCap, verify: async () => { verifyCalls++; return { verdict: 'still_valid', cost: 0 }; }, phrase: async (s, n) => ({ done: n, cost: 0 }) };
  const r = await maintain(store, dir, { fns });
  assert.equal(r.capped, true); assert.equal(verifyCalls, 0); assert.equal(r.phrased, 0);
  assert.equal(r.cochange, true, 'co-change costs nothing and still runs');
  assert.equal(maintenanceNotice(store), '🧠 thinker: in the background, co-change index refreshed');
  // a run in progress
  fs.writeFileSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), '1');
  assert.deepEqual(await maintain(store, dir, { fns }), { skipped: 'locked' });
  // off in the repo's config
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'));
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ maintain: { enabled: false } }));
  assert.deepEqual(await maintain(store, dir, { fns }), { skipped: 'disabled' });
  // dry: counts, no calls, no state
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ maintain: { dailyCap: 5 } }));
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.json'));
  const d = await maintain(store, dir, { dry: true, fns: { ...fns, spentToday: () => 0 } });
  assert.equal(d.verified, 1); assert.equal(verifyCalls, 0);
  assert.equal(fs.existsSync(path.join(dir, '.thinker', 'state', 'maintain.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('spentToday sums reported learning and maintenance model cost since local midnight', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-maintain-home-'));
  const { dir, store } = staleRepo();
  const prev = { THINKER_HOME: process.env.THINKER_HOME, THINKER_LOG: process.env.THINKER_LOG, THINKER_NOTES_DIR: process.env.THINKER_NOTES_DIR };
  process.env.THINKER_HOME = home; delete process.env.THINKER_LOG; delete process.env.THINKER_NOTES_DIR;
  try {
    const now = new Date();
    const today = new Date(now); today.setHours(12, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86400_000);
    const line = (t, e) => JSON.stringify({ t: t.toISOString(), op: 'model', ...e }) + '\n';
    const origin = repoId(dir);
    fs.writeFileSync(path.join(home, 'log.jsonl'),
      line(today, { origin, phase: 'maintenance', cost: 0.2 }) +
      line(today, { origin, phase: 'learning', cost: 0.3 }) +
      line(today, { origin, phase: 'init', cost: 5 }) +
      line(today, { origin, phase: 'maintenance', cost: null }) +
      line(yesterday, { origin, phase: 'maintenance', cost: 7 }) +
      line(today, { origin: 'elsewhere', phase: 'maintenance', cost: 9 }));
    assert.ok(Math.abs(spentToday(store, now) - 0.5) < 1e-9);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('postCommitHook maintains with learning on and only re-checks with it off', () => {
  const on = postCommitHook('/x/cli.js', '/r', true), off = postCommitHook('/x/cli.js', '/r', false);
  assert.match(on, /nohup node "\/x\/cli.js" maintain --quiet --repo "\$repo"/);
  assert.match(on, /git rev-parse --show-toplevel 2>\/dev\/null \|\| echo "\/r"/);
  assert.match(off, /nohup node "\/x\/cli.js" check --quiet --repo "\$repo"/);
});
