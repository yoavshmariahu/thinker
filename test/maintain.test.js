import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, repoId } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { maintain, maintenanceNotice, renderMaintain, spentToday, withinDailyCap, reportCapped, postCommitHook, pickStale, DEFAULTS, MAINTENANCE_INTERVAL_MS } from '../src/maintain.js';

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
  // served lately: maintenance re-verifies ahead of time only what is being served
  a.uses = 1; a.lastUsed = new Date().toISOString(); store.put(a);
  fs.writeFileSync(path.join(dir, 'src/a.py'), 'def foo():\n    return 11\n');
  return { dir, store, a, b };
}

const env = { THINKER_LOG: 'off', THINKER_TELEMETRY: 'off' };
function withEnv(fn) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('maintain verifies stale notes, phrases unphrased ones, and reports once', () => withEnv(async () => {
  const { dir, store, a, b } = staleRepo();
  const verified = [], phrased = [];
  const r = await maintain(store, dir, { fns: {
    spentToday: () => 0,
    verify: async (s, n) => { verified.push(n.id); return { verdict: n.id === a.id ? 'update' : 'still_valid', tokens: 10000 }; },
    phrase: async (s, notes) => { phrased.push(...notes.map(n => n.id)); return { done: notes, tokens: 5000 }; },
    minePrs: async () => ({ saved: 9 }),
  } });
  assert.deepEqual(verified, [a.id], 'only the stale note is sent to the model');
  assert.equal(r.verified, 1); assert.equal(r.updated, 1); assert.equal(r.retired, 0);
  assert.deepEqual(phrased.sort(), [a.id, b.id].sort(), 'both notes lack phrasings');
  assert.equal(r.prs, 0, 'the first run only marks where PR mining starts');
  assert.equal(r.tokens, 15000);
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'state', 'maintain.json'), 'utf8'));
  assert.ok(state.prsAfter);
  // the user hears about it once
  const notice = maintenanceNotice(store);
  assert.match(notice, /1 checked, 1 updated; 2 phrased/);
  assert.equal(maintenanceNotice(store), '');
  assert.match(renderMaintain(r), /1 re-verified, 1 updated, 2 phrased, 0 from pull requests \(~15k tokens\)/);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('maintain mines pull requests merged since its first run', () => withEnv(async () => {
  const { dir, store } = staleRepo();
  const calls = [];
  const fns = { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid', cost: 0 }), phrase: async (s, n) => ({ done: n, cost: 0 }), minePrs: async o => { calls.push(o); return { saved: 2, cost: 0.1 }; } };
  await maintain(store, dir, { fns });
  const first = JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'state', 'maintain.json'), 'utf8')).prsAfter;
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  const r = await maintain(store, dir, { fns, now: Date.now() + MAINTENANCE_INTERVAL_MS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].after, first);
  assert.equal(calls[0].limit, DEFAULTS.prsPerRun);
  assert.equal(r.prs, 2);
  assert.match(maintenanceNotice(store), /2 PR notes/);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('maintain stops at the daily cap, honours the lock, and can be switched off', () => withEnv(async () => {
  const { dir, store } = staleRepo();
  let verifyCalls = 0;
  const fns = { spentToday: () => DEFAULTS.dailyTokens, verify: async () => { verifyCalls++; return { verdict: 'still_valid', cost: 0 }; }, phrase: async (s, n) => ({ done: n, cost: 0 }) };
  const r = await maintain(store, dir, { fns });
  assert.equal(r.capped, true); assert.equal(verifyCalls, 0); assert.equal(r.phrased, 0);
  assert.equal(maintenanceNotice(store), '', 'nothing happened, nothing to say');
  // a run in progress
  fs.writeFileSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), '1');
  assert.deepEqual(await maintain(store, dir, { fns }), { skipped: 'locked' });
  // off in the repo's config
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'));
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ maintain: { enabled: false } }));
  assert.deepEqual(await maintain(store, dir, { fns }), { skipped: 'disabled' });
  // dry: counts, no calls, no state
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ maintain: { dailyTokens: 5_000_000 } }));
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.json'));
  const d = await maintain(store, dir, { dry: true, fns: { ...fns, spentToday: () => 0 } });
  assert.equal(d.verified, 1); assert.equal(verifyCalls, 0);
  assert.equal(fs.existsSync(path.join(dir, '.thinker', 'state', 'maintain.json')), false);
  fs.rmSync(dir, { recursive: true, force: true });
}));

test('spentToday sums the tokens of learning and maintenance model calls since local midnight', () => {
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
      line(today, { origin, phase: 'maintenance', tokens: { totalTokens: 200 }, cost: 0.2 }) +
      line(today, { origin, phase: 'learning', tokens: { totalTokens: 300 }, cost: 0.3 }) +
      line(today, { origin, phase: 'init', tokens: { totalTokens: 5000 } }) +
      line(today, { origin, phase: 'maintenance', tokens: { totalTokens: null }, cost: 0.4 }) +  // no counters: nothing, not an estimate
      line(yesterday, { origin, phase: 'maintenance', tokens: { totalTokens: 7000 } }) +
      line(today, { origin: 'elsewhere', phase: 'maintenance', tokens: { totalTokens: 9000 } }));
    assert.equal(spentToday(store, now), 500);
  } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
  }
});

test('postCommitHook maintains with learning on and only re-checks with it off', () => {
  const on = postCommitHook('/x/cli.js', '/r', true), off = postCommitHook('/x/cli.js', '/r', false);
  assert.match(on, /nohup node '\/x\/cli.js' maintain --quiet --repo "\$repo"/);
  assert.match(on, /git rev-parse --show-toplevel/);
  assert.match(on, /THINKER_NO_LEARN/);
  assert.match(off, /nohup node '\/x\/cli.js' check --quiet --repo "\$repo"/);
});

test('maintenance re-verifies only notes served lately, and leaves a churning note stale, named once', () => withEnv(async () => {
  const day = 86400_000, now = Date.now();
  const stale = (id, lastUsed, uses = 1) => ({ id, status: 'stale', uses, lastUsed: lastUsed && new Date(lastUsed).toISOString() });
  const notes = [stale('served-today', now), stale('served-last-month', now - 30 * day), stale('never-served', null), stale('churner', now - day, 9), { id: 'fresh', status: 'fresh', lastUsed: new Date(now).toISOString() }];
  const counts = new Map([['churner', 3], ['served-today', 2]]);
  let r = pickStale(notes, DEFAULTS, { counts, now });
  assert.deepEqual(r.stale.map(n => n.id), ['served-today']);
  assert.deepEqual(r.churning.map(n => n.id), ['churner']);
  // verifyServedDays 0: every stale note is a candidate, most served first; verifyChurn 0: nothing is held back
  r = pickStale(notes, { ...DEFAULTS, verifyServedDays: 0, verifyChurn: 0 }, { counts, now });
  assert.deepEqual(r.stale.map(n => n.id), ['churner', 'served-today', 'served-last-month', 'never-served']);
  assert.deepEqual(r.churning, []);
  // the cap still applies
  assert.equal(pickStale(notes, { ...DEFAULTS, verifyServedDays: 0, verifyChurn: 0, verifyPerRun: 2 }, { now }).stale.length, 2);

  // in a run: the churning note is not sent to the model, and the user hears of it once
  const { dir, store, a } = staleRepo();
  const verified = [];
  const fns = { spentToday: () => 0, verify: async (s, n) => { verified.push(n.id); return { verdict: 'still_valid', cost: 0.01 }; }, phrase: async (s, n) => ({ done: n, cost: 0 }), verifyCounts: () => new Map([[a.id, 3]]) };
  let run = await maintain(store, dir, { fns });
  assert.deepEqual(verified, []); assert.deepEqual(run.churning, [a.id]);
  assert.match(renderMaintain(run), /1 churning left stale/);
  assert.match(maintenanceNotice(store), /1 note repeatedly stale; narrow pointers or retire them/);
  run = await maintain(store, dir, { fns, now: Date.now() + MAINTENANCE_INTERVAL_MS });
  assert.deepEqual(run.churning, [a.id]);
  assert.doesNotMatch(maintenanceNotice(store), /left stale/, 'named once, not on every run');
  fs.rmSync(dir, { recursive: true, force: true });
}));

// The daily cap covers learning as well as maintenance; distilling a session is where most
// of the tokens go, so it asks before spending. The cap is in tokens: a dollar figure from list
// prices meant nothing to the subscriptions most agents run on.
test('withinDailyCap closes the day once the cap is spent, and the user is told once', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cap-')));
  try {
    const store = new Store(dir).init();
    assert.equal(withinDailyCap(store, { spentFn: () => 400_000 }).ok, true);
    const over = withinDailyCap(store, { spentFn: () => 2_500_000 });
    assert.equal(over.ok, false);
    assert.equal(over.cap, DEFAULTS.dailyTokens);
    // no cap configured: nothing is withheld
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyTokens: 0 } }));
    assert.equal(withinDailyCap(store, { spentFn: () => 99e6 }).ok, true);
    // the old dollar key: switched off stays switched off; any other value is ignored for the default
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyCap: 0 } }));
    assert.equal(withinDailyCap(store, { spentFn: () => 99e6 }).ok, true);
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyCap: 5 } }));
    assert.equal(withinDailyCap(store, { spentFn: () => 2_500_000 }).cap, DEFAULTS.dailyTokens);
    reportCapped(store, over);
    const notice = maintenanceNotice(store);
    assert.match(notice, /learning paused at the daily token limit/);
    assert.doesNotMatch(notice, /2\.5M of the 2M tokens it may use a day/);
    assert.equal(maintenanceNotice(store), '', 'said once');
    reportCapped(store, { ...over, spent: 3_000_000 });
    assert.equal(maintenanceNotice(store), '', 'later hooks cannot requeue the same daily warning');
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    reportCapped(store, over, { now: tomorrow });
    assert.match(maintenanceNotice(store, { now: tomorrow }), /learning paused at the daily token limit/, 'a new daily cap gets one notice');
    reportCapped(store, over, { now: tomorrow });
    assert.equal(maintenanceNotice(store, { now: tomorrow }), '');
    const later = new Date(tomorrow); later.setDate(later.getDate() + 1);
    reportCapped(store, over, { now: later });
    const nextDay = new Date(later); nextDay.setDate(nextDay.getDate() + 1);
    assert.equal(maintenanceNotice(store, { now: nextDay }), '', 'a queued warning expires at local midnight');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('four-hour batches persist across callers; dry previews do not move the deadline', () => withEnv(async () => {
  const { dir, store, a } = staleRepo();
  const now = Date.now();
  let calls = 0;
  const fns = {
    spentToday: () => 0,
    verify: async () => { calls++; return { verdict: 'still_valid', tokens: 1 }; },
    phrase: async (s, notes) => ({ done: notes, tokens: 0 }),
  };
  try {
    assert.equal((await maintain(store, dir, { fns, now })).verified, 1);
    const stateFile = path.join(store.dir, 'state/maintain.json');
    const before = fs.readFileSync(stateFile, 'utf8');
    const reopened = new Store(dir);
    for (const elapsed of [1, 10 * 60_000, MAINTENANCE_INTERVAL_MS - 1]) {
      assert.deepEqual(await maintain(reopened, dir, { fns, now: now + elapsed }), { skipped: 'not-due' });
    }
    assert.equal(calls, 1);
    assert.equal((await maintain(reopened, dir, { fns, dry: true, now: now + 1 })).verified, 1);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    assert.equal(calls, 1, 'dry never calls the verifier');
    assert.equal((await maintain(reopened, dir, { fns, now: now + MAINTENANCE_INTERVAL_MS })).verified, 1);
    assert.equal(calls, 2);
    // A code change reverted before the next batch needs no model call.
    fs.writeFileSync(path.join(dir, 'src/a.py'), 'def foo():\n    return 1\n');
    assert.equal((await maintain(reopened, dir, { fns, now: now + 2 * MAINTENANCE_INTERVAL_MS })).verified, 0);
    assert.equal(calls, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));

test('existing maintenance timestamps delay the first batch after upgrade', () => withEnv(async () => {
  const { dir, store } = staleRepo();
  const now = Date.now();
  try {
    fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(store.dir, 'state/maintain.json'), JSON.stringify({ at: new Date(now - 60_000).toISOString() }));
    assert.deepEqual(await maintain(store, dir, { now, fns: { spentToday() { throw Error('must not start work'); } } }), { skipped: 'not-due' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));
