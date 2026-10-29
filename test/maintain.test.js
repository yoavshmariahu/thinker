import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store, repoId } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { phraseKey } from '../src/note-search.js';
import { maintain, maintenanceNotice, renderMaintain, spentToday, withinDailyCap, reportCapped, postCommitHook, pickStale, DEFAULTS, DAILY_TOKENS_COSTLY, MAINTENANCE_INTERVAL_MS } from '../src/maintain.js';

// a git repo with one note whose dependency is then changed, so the note is stale
const servedAt = (store, id, t) => store.put({ ...store.get(id), uses: (store.get(id).uses || 0) + 1, lastUsed: new Date(t).toISOString() });
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
  } });
  assert.deepEqual(verified, [a.id], 'only the stale note is sent to the model');
  assert.equal(r.verified, 1); assert.equal(r.updated, 1); assert.equal(r.retired, 0);
  assert.deepEqual(phrased.sort(), [a.id, b.id].sort(), 'both notes lack phrasings');
  assert.equal(r.tokens, 15000);
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'state', 'maintain.json'), 'utf8'));
  assert.equal(state.prsAfter, undefined, 'maintenance mines nothing, so no window opens');
  // the user hears about it once
  const notice = maintenanceNotice(store);
  assert.match(notice, /1 checked, 1 updated; 2 phrased/);
  assert.equal(maintenanceNotice(store), '');
  assert.match(renderMaintain(r), /1 re-verified, 1 updated, 2 phrased \(~15k tokens\)/);
  fs.rmSync(dir, { recursive: true, force: true });
}));

// Since 2026-10-21 the steps that read history, documents and skill files are off by default: the cache
// grows from the sessions, and a repository that wants them says so in its config.
test('by default maintenance verifies and phrases only: no documents, no skills, no duplicate pass, and never any mining', () => withEnv(async () => {
  assert.equal(DEFAULTS.prs, undefined); assert.equal(DEFAULTS.docs, false); assert.equal(DEFAULTS.skills, false); assert.equal(DEFAULTS.dedupe, false);
  // one verification batch every three days, of the notes served in those days; unused notes deleted after two weeks
  assert.equal(DEFAULTS.verifyEveryDays, 3); assert.equal(DEFAULTS.verifyServedDays, 3); assert.equal(DEFAULTS.verifyPerRun, 50); assert.equal(DEFAULTS.deleteUnusedDays, 30);
  const { dir, store } = staleRepo();
  const called = [];
  const fns = { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid', tokens: 0 }), phrase: async (s, n) => ({ done: n, tokens: 0 }),
    minePrs: async () => { called.push('prs'); return { saved: 1 }; }, mineAreaHistory: async () => { called.push('walk'); return { saved: 1 }; },
    docs: async () => { called.push('docs'); return { saved: [{ id: 'a' }] }; }, skills: async () => { called.push('skills'); return { saved: [{ id: 'a' }] }; },
    dedupe: async () => { called.push('dedupe'); return { merged: [] }; }, commitsOffer: () => { called.push('commits'); return 1; } };
  await maintain(store, dir, { fns });
  fs.rmSync(path.join(dir, '.thinker', 'state', 'maintain.lock'), { force: true });
  const t2 = Date.now() + 3 * 86400_000;
  for (const n of store.list()) if (n.lastUsed) servedAt(store, n.id, t2 - 1000);
  const r = await maintain(store, dir, { fns, now: t2 });
  assert.deepEqual(called, []);
  assert.equal(r.verified, 1); assert.equal(r.prs, undefined); assert.equal(r.docs, 0); assert.equal(r.skills, 0); assert.equal(r.merged, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'state', 'maintain.json'), 'utf8')).prsAfter, undefined, 'no mining window is opened');
  fs.rmSync(dir, { recursive: true, force: true });
}));

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
  r = pickStale(notes, { ...DEFAULTS, verifyServedDays: 0, verifyChurn: 0, verifyPerRun: 10 }, { counts, now });
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
  const t2 = Date.now() + 3 * 86400_000;
  servedAt(store, a.id, t2 - 1000);
  run = await maintain(store, dir, { fns, now: t2 });
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
    assert.equal(withinDailyCap(store, { spentFn: () => 2_500_000 }).cap, DAILY_TOKENS_COSTLY, 'a new cache distills on Sonnet');
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ distillModel: 'haiku' }));
    assert.equal(withinDailyCap(store, { spentFn: () => 400_000 }).ok, true);
    assert.equal(withinDailyCap(store, { spentFn: () => 2_500_000 }).ok, true, 'a Haiku-class distill model gets the 50M default');
    const over = withinDailyCap(store, { spentFn: () => 60_000_000 });
    assert.equal(over.ok, false);
    assert.equal(over.cap, DEFAULTS.dailyTokens);
    // a costlier distillation model gets the smaller default
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ distillModel: 'sonnet' }));
    assert.equal(withinDailyCap(store, { spentFn: () => 2_500_000 }).ok, false);
    assert.equal(withinDailyCap(store, { spentFn: () => 2_500_000 }).cap, DAILY_TOKENS_COSTLY);
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ distillModel: 'haiku' }));
    // no cap configured: nothing is withheld
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyTokens: 0 } }));
    assert.equal(withinDailyCap(store, { spentFn: () => 99e6 }).ok, true);
    // the old dollar key: switched off stays switched off; any other value is ignored for the default
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ maintain: { dailyCap: 0 } }));
    assert.equal(withinDailyCap(store, { spentFn: () => 99e6 }).ok, true);
    fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ distillModel: 'haiku', maintain: { dailyCap: 5 } }));
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
    // the next batch is a verification batch only three days after the last one
    const later = await maintain(reopened, dir, { fns, now: now + MAINTENANCE_INTERVAL_MS });
    assert.equal(later.verified, 0); assert.ok(later.verifyNext);
    assert.equal(calls, 1);
    servedAt(reopened, a.id, now + 3 * 86400_000 - 1000);
    assert.equal((await maintain(reopened, dir, { fns, now: now + 3 * 86400_000 })).verified, 1);
    assert.equal(calls, 2);
    // A code change reverted before the next batch needs no model call.
    fs.writeFileSync(path.join(dir, 'src/a.py'), 'def foo():\n    return 1\n');
    assert.equal((await maintain(reopened, dir, { fns, now: now + 6 * 86400_000 + MAINTENANCE_INTERVAL_MS })).verified, 0);
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

test('a failed maintenance batch stays failed through cooldown until a due batch succeeds', () => withEnv(async () => {
  const { dir, store } = staleRepo(), now = Date.now();
  const fns = { spentToday: () => 0, verify: async () => { throw new Error('session stopped'); }, phrase: async (s, notes) => ({ done: notes, tokens: 0 }) };
  try {
    assert.equal((await maintain(store, dir, { now, fns })).errors, 1);
    assert.deepEqual(await maintain(new Store(dir), dir, { now: now + 30 * 60_000, fns }), { skipped: 'not-due', errors: 1 });
    fns.verify = async () => ({ verdict: 'still_valid', tokens: 0 });
    assert.equal((await maintain(store, dir, { now: now + MAINTENANCE_INTERVAL_MS, fns })).errors, 0);
    assert.deepEqual(await maintain(store, dir, { now: now + MAINTENANCE_INTERVAL_MS + 1, fns }), { skipped: 'not-due' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));

test('notes nobody was served in a month are deleted; behaviors, skill cards, human notes and committed notes stay', () => withEnv(async () => {
  const { deleteUnused } = await import('../src/maintain.js');
  const { dir, store, a, b } = staleRepo();
  // the window is 30 days (deleteUnusedDays, raised from 14 on 2026-10-28)
  const day = 86400_000, now = Date.now(), old = new Date(now - 40 * day).toISOString();
  store.put({ ...a, created: old, lastUsed: new Date(now - 2 * day).toISOString() });        // served lately: kept
  store.put({ ...b, created: old, lastUsed: new Date(now - 31 * day).toISOString() });       // last served 31 days ago: deleted
  const c = createNote(store, { title: 'Never served helper', kind: 'rule', answers: ['x'], body: 'src/b.py:bar returns 2', deps: [{ path: 'src/b.py', symbol: 'bar' }] }).note;
  store.put({ ...c, created: old });                                                          // never served, old: deleted
  const h = createNote(store, { title: 'Human note', kind: 'rule', answers: ['y'], body: 'src/a.py:foo', deps: [{ path: 'src/a.py', symbol: 'foo' }] }, { source: { type: 'human' } }).note;
  store.put({ ...h, created: old });                                                          // a person's: kept
  const young = createNote(store, { title: 'New note', kind: 'rule', answers: ['z'], body: 'src/a.py:foo', deps: [{ path: 'src/a.py', symbol: 'foo' }] }).note; // made today: kept
  assert.deepEqual(deleteUnused(store, { dry: true, now }).sort(), [b.id, c.id].sort());
  assert.ok(store.get(b.id), 'dry deletes nothing');
  assert.deepEqual(deleteUnused(store, { now }).sort(), [b.id, c.id].sort());
  assert.equal(store.get(b.id), null); assert.equal(store.get(c.id), null);
  assert.ok(store.get(a.id) && store.get(h.id) && store.get(young.id));
  fs.rmSync(dir, { recursive: true, force: true });
}));

// A stale note the freshness rule holds back can never be served, so until `heldAt` it could never
// satisfy pickStale's "served recently" gate either: withheld -> never served -> never eligible ->
// stale for good. On this repository on 2026-10-28 that left 318 stale notes with 1 eligible, while
// the verifier was answering still_valid on about half of the notes it did reach.
test('a stale note held back from a request is eligible for verification, and is not deleted as unused', async () => {
  const { pickStale, DEFAULTS, deleteUnused } = await import('../src/maintain.js');
  const now = Date.now(), iso = ms => new Date(ms).toISOString();
  const base = { kind: 'rule', title: 't', body: 'b', status: 'stale', created: iso(now - 90 * 86400_000) };
  const notes = [
    { ...base, id: 'held', heldAt: iso(now - 86400_000) },                       // wanted yesterday, withheld
    { ...base, id: 'served', lastUsed: iso(now - 86400_000) },                   // served yesterday
    { ...base, id: 'forgotten' },                                                // neither: still waits
    { ...base, id: 'stale-held-long-ago', heldAt: iso(now - 60 * 86400_000) },   // wanted, but not lately
  ];
  const { stale } = pickStale(notes, { ...DEFAULTS, verifyServedDays: 3, verifyPerRun: 10 }, { now });
  const ids = stale.map(n => n.id).sort();
  assert.deepEqual(ids, ['held', 'served'], 'being held back counts as demand, as being served does');

  // and the same note is not deleted for not having been served: thinker is what refused to serve it
  assert.equal(DEFAULTS.deleteUnusedDays, 30);
  const store = { list: () => notes, isShared: () => false, remove() { throw new Error('must not delete a held note'); }, config: () => ({}) };
  const removed = deleteUnused(store, { days: 30, dry: true, now });
  assert.ok(!removed.includes('held'), 'a note wanted within the window is kept');
  assert.ok(removed.includes('forgotten'), 'a note nobody asked for is still deleted');
});

test('maintenance reads the pull requests once a day, and records the attempt even when it fails', () => withEnv(async () => {
  const { dir, store } = staleRepo();
  const calls = [];
  const stub = { spentToday: () => 0, verify: async () => ({ verdict: 'still_valid', tokens: 0 }), phrase: async (s, n) => ({ done: n, tokens: 0 }) };
  const fns = { ...stub, syncPrs: async (s, o) => { calls.push(o); return { synced: 3 }; } };
  const now = Date.parse('2026-10-29T12:00:00.000Z');
  const first = await maintain(store, dir, { fns, now });
  assert.equal(first.prSynced, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].days, 7, 'the first sync looks back a week');

  // A run four hours later is due for maintenance but not for GitHub.
  const soon = now + 5 * 3600_000;
  assert.equal((await maintain(store, dir, { fns, now: soon })).prSynced, 0);
  assert.equal(calls.length, 1);

  // A day later it goes again, back only to the last sync.
  const later = now + 30 * 3600_000;
  await maintain(store, dir, { fns, now: later });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].days, 3);

  // A repository GitHub refuses must not try again on every run.
  const broken = { ...stub, syncPrs: async () => { throw new Error('no origin'); } };
  const after = now + 60 * 3600_000;
  const r = await maintain(store, dir, { fns: broken, now: after });
  assert.equal(r.prSynced, 0);
  assert.ok(r.errors >= 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.thinker', 'state', 'maintain.json'), 'utf8')).prsSyncedAt, new Date(after).toISOString());

  // And the switch in the config stops it.
  fs.writeFileSync(path.join(dir, '.thinker', 'config.json'), JSON.stringify({ maintain: { prSync: false } }));
  await maintain(store, dir, { fns, now: now + 90 * 3600_000 });
  assert.equal(calls.length, 2);
}));
