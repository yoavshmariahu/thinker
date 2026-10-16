import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { normalize, outcome, invalidReason } from '../bench/evals/normalize.js';
import { bootstrap } from '../bench/evals/stats.js';
import { compare, resolveMeta, writeMeta, readMeta } from '../bench/evals/experiment.js';
import { openDb } from '../bench/evals/db.js';
import { ingest } from '../bench/evals/ingest.js';
import { plan, launch, cancel, alive, jobsView, liveSessions, RUNNERS, OPTIONS } from '../bench/evals/jobs.js';
import { createPrset, readPrset, updatePrset, freezePrset } from '../bench/evals/prsets.js';
import { importTaskSet, setAcceptance, getTaskSet, writeRunTasks, listTaskSets } from '../bench/evals/tasksets.js';
import { checkCache, planCache, readReceipt, notesDir, cacheDir, hashNotes, stepsOf } from '../bench/evals/caches.js';
import { takeSnapshot, restoreSnapshot } from '../bench/evals/snapshot.js';
import { parseClaude, parseCodex, stepStats } from '../bench/evals/transcripts.js';
import { createApp } from '../bench/evals/server.js';
import { defineArm, armDefsFile } from '../bench/evals/arms.js';

const rec = (o = {}) => ({ id: `${o.task || 'T1'}-${o.arm || 'nocache'}-${o.rep ?? 0}`, task: 'T1', arm: 'nocache', rep: 0, model: 'sonnet', turns: 10, wall_ms: 1000, cost: 0.1, in_tokens: 1000, out_tokens: 10, tools: { calls: 5, injected: [] }, ...o });

test('outcome prefers the PR tests, then a criteria judge, then the patch score, and names the grader', () => {
  assert.deepEqual(outcome({ grade: { tests: 'fail', criteria: { pass: true }, score: 1 } }), { pass: false, source: 'tests', judge: null });
  const c = outcome({ grade: { criteria: { pass: true, judge: 'opus', essential: 1, all: 0.5 }, score: 0 } });
  assert.equal(c.pass, true); assert.equal(c.source, 'criteria'); assert.equal(c.judge, 'opus');
  assert.equal(outcome({ grade: { criteria: { pass: false } } }).judge, 'sonnet (default)');
  assert.equal(outcome({ grade: { score: 0.5 }, diff: '' }).pass, false);
  assert.equal(outcome({ grade: { score: 0.85 } }).pass, null, 'an orientation answer has a score, not a pass');
  assert.equal(outcome({}, { pass: true, model: 'claude-sonnet-5' }).judge, 'claude-sonnet-5', 'a .judge.json sidecar grades its record');
});

test('invalid results carry their reason', () => {
  assert.equal(invalidReason(rec({ error: 'You’ve hit your usage limit' }), 'r'), 'usage limit');
  assert.match(invalidReason(rec({ leak: ['test_x'] }), 'r'), /leak/);
  assert.match(invalidReason(rec({ turns: 60 }), 'r'), /turn cap/);
  assert.equal(invalidReason(rec(), 'invalid/old'), 'diagnosis-only directory');
  assert.equal(invalidReason(rec(), 'r'), null);
});

test('gemini usage maps onto the token classes', () => {
  const r = normalize({ ...rec(), in_tokens: undefined, out_tokens: undefined, usage: { input_tokens: 100, cache_read_tokens: 900, output_tokens: 5, thinking_tokens: 3 } }, { dir: 'r', file: 'x.json', mtime: 1 });
  assert.equal(r.in_tokens, 1000); assert.equal(r.cache_read, 900); assert.equal(r.out_tokens, 8);
});

test('bootstrap interval brackets the mean and is reproducible', () => {
  const d = [1, 2, 3, 4, 5, 6, 7, 8];
  const a = bootstrap(d), b = bootstrap(d);
  assert.equal(a.mean, 4.5); assert.ok(a.lo < 4.5 && a.hi > 4.5); assert.deepEqual(a, b);
  assert.equal(bootstrap([3]).lo, null, 'one pair has no interval');
});

test('the comparison pairs PR and rep across cache off and on, valid on both sides, split by served', () => {
  const n = x => normalize(x, { dir: 'r', file: x.id + '.json', mtime: 1 });
  const rows = [
    n(rec({ task: 'A', arm: 'nocache', grade: { tests: 'fail' }, in_tokens: 1000 })),
    n(rec({ task: 'A', arm: 'cache', grade: { tests: 'pass' }, in_tokens: 600, tools: { calls: 3, injected: ['n1'] } })),
    n(rec({ task: 'B', arm: 'nocache', grade: { tests: 'pass' }, in_tokens: 1000 })),
    n(rec({ task: 'B', arm: 'cache', grade: { tests: 'pass' }, in_tokens: 1200 })),
    n(rec({ task: 'C', arm: 'nocache', grade: { tests: 'pass' } })),
    n(rec({ task: 'C', arm: 'cache', error: 'boom' })),
    n(rec({ task: 'A', arm: 'irrelevant', grade: { tests: 'fail' } })),
  ];
  const c = compare(rows, 'nocache', 'cache', new Map([['A', { title: 'Fix A', pr: '1' }]]));
  assert.equal(c.pairs, 2);
  assert.equal(c.delta.pass.mean, 0.5);
  assert.equal(c.delta.in_tokens.mean, -100);
  assert.equal(c.served, 1); assert.equal(c.deltaServed.in_tokens.mean, -400);
  assert.equal(c.offSide.passed, 1, 'both columns are over the pairs'); assert.equal(c.onSide.valid, 2);
  assert.deepEqual(c.unpaired, { off: 1, on: 0 }, 'C has no valid cache-on partner');
  const a = c.prs.find(p => p.task === 'A');
  assert.equal(a.change, 'gained'); assert.equal(a.title, 'Fix A'); assert.equal(a.d_in_tokens, -400);
  assert.equal(c.prs.find(p => p.task === 'B').change, 'both pass');
  assert.equal(c.counts.gained, 1);
});

test('an experiment without a definition infers cache off and on from its arms', () => {
  assert.deepEqual([resolveMeta(null, ['hook', 'irrelevant', 'nocache']).off, resolveMeta(null, ['hook', 'irrelevant', 'nocache']).on], ['nocache', 'hook']);
  assert.equal(resolveMeta(null, ['qartez', 'thinker']).off, null, 'two tools side by side have no cache-off arm');
  const m = resolveMeta({ name: 'X', off: 'qartez', on: 'thinker', kind: 'behavior' }, ['qartez', 'thinker']);
  assert.equal(m.off, 'qartez'); assert.equal(m.defined, true);
});

// A bench dir with a real checkout: anchor commit c1, the PR set's base c2 (HEAD), and the PRs'
// fixes on a branch the checkout does not contain.
function fixture() {
  const bench = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-'));
  const repo = path.join(bench, 'repos', 'click');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1'); g('add', '.'); g('commit', '-qm', 'c1');
  const c1 = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2'); g('commit', '-qam', 'c2');
  const c2 = g('rev-parse', 'HEAD');
  g('checkout', '-qb', 'fix'); fs.writeFileSync(path.join(repo, 'a.txt'), '3'); g('commit', '-qam', 'fix T1');
  const fix = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main');
  fs.mkdirSync(path.join(bench, 'tasks'));
  fs.writeFileSync(path.join(bench, 'tasks', 'click.json'), JSON.stringify({ repo: 'pallets/click', base: c2, tasks: [
    { id: 'T1', type: 'change', testCmd: 'true', mergeCommit: fix, goldTitle: 'Fix one' }, { id: 'T2', type: 'change', testCmd: 'true', goldTitle: 'Fix two' }] }));
  const run = path.join(bench, 'runs', 'click-v9');
  fs.mkdirSync(run, { recursive: true });
  fs.writeFileSync(path.join(run, 'T1-nocache-0.json'), JSON.stringify(rec({ grade: { tests: 'pass' } })));
  fs.writeFileSync(path.join(run, 'T1-cache-0.json'), JSON.stringify(rec({ arm: 'cache', id: 'T1-cache-0', grade: { tests: 'pass' } })));
  fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify([rec({ grade: { tests: 'fail' } })]));
  return { bench, c1, c2, fix };
}

// A built cache, as build-cache.js leaves it: notes in the snapshot, a receipt with their hash.
function fakeCache(bench, name, { anchor, model = 'sonnet', source = 'pr', kind, db = null }) {
  const notes = notesDir(bench, name);
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'n1.json'), JSON.stringify({ id: 'n1', title: 'A note', source: { type: source, ref: 'pr-1' }, search: 'x' }));
  const receipt = { name, repo: 'click', anchor, llm: 'claude', model, limit: 60, status: 'ok', notes: 1, described: 1, notes_hash: hashNotes(notes), created_at: 1, ...(kind ? { kind } : {}) };
  // a receipt from before the database held them, imported on the next scan; or straight into a database
  if (db) db.putCache(receipt); else fs.writeFileSync(path.join(cacheDir(bench, name), 'receipt.json'), JSON.stringify(receipt));
  return receipt;
}

const exp = { name: 'Hook', question: 'Does the hook help?', kind: 'behavior' };
// a bench with a PR set and a cache that pass every check
// (as files from before the database, so every app and database made from it imports them)
function ready() {
  const f = fixture();
  const ps = createPrset(f.bench, openDb(':memory:'), { name: 'ps', tasks: 'click.json', rule: 'both PRs' });
  fs.mkdirSync(path.join(f.bench, 'prsets'), { recursive: true });
  fs.writeFileSync(path.join(f.bench, 'prsets', 'ps.json'), JSON.stringify(ps));
  fakeCache(f.bench, 'c-sonnet', { anchor: f.c1 });
  return f;
}

test('ingest indexes run directories, lets the per-result file win over summary.json, and skips unchanged runs', () => {
  const { bench } = fixture();
  const db = openDb(':memory:');
  assert.deepEqual(ingest(db, bench), ['click-v9']);
  const rows = db.all('SELECT * FROM results ORDER BY arm');
  assert.equal(rows.length, 2);
  assert.equal(rows.find(r => r.arm === 'nocache').pass, 1);
  assert.equal(rows[0].repo, 'click');
  assert.deepEqual(ingest(db, bench), [], 'an unchanged directory is not rescanned');
});

test('an experiment definition is kept in the database and validated; an old experiment.json is imported', () => {
  const { bench } = fixture();
  fs.writeFileSync(path.join(bench, 'runs', 'click-v9', 'experiment.json'), JSON.stringify({ name: 'From a file', off: 'nocache', on: 'cache' }));
  const db = openDb(':memory:');
  ingest(db, bench);
  assert.equal(db.get('SELECT count(*) n FROM results').n, 2, 'experiment.json is not a result');
  assert.equal(readMeta(db, 'click-v9').name, 'From a file');
  writeMeta(db, 'click-v9', { name: 'Hook on click', question: 'Does it help?', kind: 'behavior', off: 'nocache', on: 'cache' }, ['nocache', 'cache']);
  assert.equal(readMeta(db, 'click-v9').name, 'Hook on click');
  fs.rmSync(path.join(bench, 'runs', 'click-v9', 'experiment.json'));
  ingest(db, bench, { force: true });
  assert.equal(readMeta(db, 'click-v9').name, 'Hook on click', 'the database is the record: a scan does not undo an edit');
  assert.throws(() => writeMeta(db, 'click-v9', { on: 'nocache' }, ['nocache', 'cache']), /different arms/);
  assert.throws(() => writeMeta(db, 'click-v9', { off: 'hook' }, ['nocache', 'cache']), /not an arm/);
  assert.throws(() => writeMeta(db, 'nope', { name: 'x' }, []), /no such experiment/);
});

test('sessions are imported once with their full record and stay when their files go', () => {
  const { bench } = fixture();
  const db = openDb(':memory:');
  ingest(db, bench);
  assert.equal(db.record('click-v9/T1-cache-0').arm, 'cache');
  const f = path.join(bench, 'runs', 'click-v9', 'T1-cache-0.json');
  fs.writeFileSync(f, JSON.stringify(rec({ arm: 'cache', id: 'T1-cache-0', grade: { tests: 'fail' } })));
  ingest(db, bench);
  assert.equal(db.get("SELECT pass FROM results WHERE id = 'click-v9/T1-cache-0'").pass, 1, 'a rewritten file does not overwrite the record');
  ingest(db, bench, { force: true, only: 'click-v9' });
  assert.equal(db.get("SELECT pass FROM results WHERE id = 'click-v9/T1-cache-0'").pass, 0, 'an explicit re-import does');
  fs.rmSync(path.join(bench, 'runs', 'click-v9'), { recursive: true });
  ingest(db, bench);
  assert.equal(db.get("SELECT count(*) n FROM results WHERE run = 'click-v9'").n, 2, 'a removed folder stays in the database');
});

test('a snapshot is a consistent, restorable copy of the database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-snap-'));
  const dbFile = path.join(dir, 'evals.db');
  const { bench } = fixture();
  const db = openDb(dbFile);
  ingest(db, bench);
  const snap = takeSnapshot(dbFile, { dir: path.join(dir, 'snaps'), s3: null });
  assert.equal(snap.counts.results, 2);
  db.run('DELETE FROM results');
  db.raw.close();
  const r = restoreSnapshot(snap.file, dbFile);
  assert.equal(r.results, 2);
  assert.equal(openDb(dbFile).get('SELECT count(*) n FROM results').n, 2);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('evals.db.replaced-')), 'the replaced database is kept');
});

test('a PR set is frozen with its rule and checked against the checkout', () => {
  const { bench, c2 } = fixture();
  const db = openDb(':memory:');
  assert.throws(() => createPrset(bench, db, { name: 'p', tasks: 'click.json' }), /selection rule/);
  assert.throws(() => createPrset(bench, db, { name: 'p', tasks: 'click.json', rule: 'r', ids: ['T9'] }), /not in the task set/);
  const s = createPrset(bench, db, { name: 'p', tasks: 'click.json', rule: 'all', ids: ['T1'] });
  assert.equal(s.repo, 'click'); assert.equal(s.base, c2); assert.deepEqual(s.ids, ['T1']); assert.ok(s.hash);
  assert.ok(s.checks.every(c => c.ok), JSON.stringify(s.checks));
  assert.throws(() => createPrset(bench, db, { name: 'p', tasks: 'click.json', rule: 'again' }), /exists/);
  assert.equal(readPrset(db, 'p').prs[0].oracle, 'tests');
  // tests that call the merged patch's own functions fail the set
  // (a re-import of the changed file is a new version; the frozen set p keeps its own)
  const spec = JSON.parse(fs.readFileSync(path.join(bench, 'tasks', 'click.json'), 'utf8'));
  spec.tasks[0].testNeedsGoldSymbols = true;
  fs.writeFileSync(path.join(bench, 'tasks', 'click.json'), JSON.stringify(spec));
  assert.equal(importTaskSet(bench, db, { name: 'click', file: 'bench/tasks/click.json' }).version, 2);
  const g = createPrset(bench, db, { name: 'g', tasks: 'click', rule: 'all' });
  assert.deepEqual(g.checks.filter(c => !c.ok).map(c => c.check), ["tests passable without the merged patch's own API"]);
});

test('a PR set is composed as a draft, changed, frozen, and only then run', () => {
  const { bench } = ready();
  const db = openDb(':memory:');
  ingest(db, bench);
  const d = createPrset(bench, db, { name: 'd', tasks: 'click.json', ids: ['T1'], draft: true });
  assert.equal(d.status, 'draft');
  const u = updatePrset(bench, db, 'd', { ids: ['T1', 'T2'], rule: 'both' });
  assert.deepEqual(u.ids, ['T1', 'T2']);
  assert.throws(() => plan({ ...exp, prset: 'd', cache: 'c-sonnet', runner: 'claude', model: 'sonnet', tag: 't' }, { benchDir: bench, db }), /draft/);
  const f = freezePrset(bench, db, 'd');
  assert.equal(f.status, 'frozen'); assert.ok(f.frozen_at);
  assert.throws(() => updatePrset(bench, db, 'd', { ids: ['T1'] }), /frozen/);
  assert.equal(plan({ ...exp, prset: 'd', cache: 'c-sonnet', runner: 'claude', model: 'sonnet', tag: 't' }, { benchDir: bench, db }).sessions, 4);
  assert.equal(readPrset(db, 'ps').status, 'frozen', 'a set from before drafts is frozen');
});

test('a build goes through its own kind\'s steps', () => {
  assert.deepEqual(stepsOf({ kind: 'understanding' }), ['snapshot', 'understand', 'phrase', 'relink', 'export']);
  assert.deepEqual(stepsOf({}), ['snapshot', 'mine-prs', 'phrase', 'relink', 'export'], 'a receipt from before kinds is mined');
});

test('an understanding cache is planned from the most changed files and holds only notes read from the code', () => {
  const { bench, c1 } = fixture();
  const db = openDb(':memory:');
  const prset = createPrset(bench, db, { name: 'ps', tasks: 'click.json', rule: 'r' });
  const u = fakeCache(bench, 'u', { anchor: c1, source: 'understanding', kind: 'understanding', db });
  assert.ok(checkCache(bench, u, prset, 'sonnet').every(c => c.ok), JSON.stringify(checkCache(bench, u, prset, 'sonnet')));
  const mixed = fakeCache(bench, 'u-pr', { anchor: c1, source: 'pr', kind: 'understanding', db });
  assert.deepEqual(checkCache(bench, mixed, prset, 'sonnet').filter(c => !c.ok).map(c => c.check), ['every note read from the code at the anchor'], 'a PR note in an understanding cache is from elsewhere');
  const p = planCache({ name: 'u2', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet', kind: 'understanding', areas: 'src,lib' }, bench, db);
  assert.equal(p.kind, 'understanding'); assert.equal(p.top, 200); assert.equal(p.limit, null); assert.deepEqual(p.areas, ['src', 'lib']);
  assert.ok(p.steps.some(x => /thinker understand --top 200 --areas src,lib/.test(x)) && !p.steps.some(x => /mine-prs/.test(x)));
  assert.equal(planCache({ name: 'u3', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet', kind: 'understanding', top: 5 }, bench, db).top, 10, 'top is clamped');
  assert.throws(() => planCache({ name: 'u4', repo: 'click', anchor: c1, model: 'sonnet', kind: 'understanding', areas: '../etc' }, bench, db), /areas/);
  assert.throws(() => planCache({ name: 'u5', repo: 'click', anchor: c1, model: 'sonnet', kind: 'explored' }, bench, db), /mined or understanding/);
  db.putCache({ ...u, name: 'uhalf', status: 'failed', top: 200, effort: null, steps_done: ['snapshot'] });
  assert.throws(() => planCache({ name: 'uhalf', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet', resume: true }, bench, db), /kind/, 'resuming an understanding build as a mined one is refused');
});

test('a cache passes only if mined from PRs, unchanged, before the base, without the PRs\' fixes, by the agent\'s model', () => {
  const { bench, c1, fix } = fixture();
  const db = openDb(':memory:');
  const prset = createPrset(bench, db, { name: 'ps', tasks: 'click.json', rule: 'r' });
  const ok = fakeCache(bench, 'good', { anchor: c1, db });
  assert.ok(checkCache(bench, ok, prset, 'sonnet').every(c => c.ok), JSON.stringify(checkCache(bench, ok, prset, 'sonnet')));
  const failing = (r, model = 'sonnet') => checkCache(bench, r, prset, model).filter(c => !c.ok).map(c => c.check);
  assert.deepEqual(failing(ok, 'opus'), ["built by the agent's model"]);
  assert.ok(failing(fakeCache(bench, 'late', { anchor: fix, db })).includes("no PR fix in the cache's history"));
  assert.deepEqual(failing(fakeCache(bench, 'hand', { anchor: c1, source: 'agent', db })), ['every note mined from a PR']);
  fs.writeFileSync(path.join(notesDir(bench, 'good'), 'n2.json'), '{}');
  assert.ok(failing(ok).includes('unchanged since built'));
  assert.throws(() => planCache({ name: 'good', repo: 'click', model: 'sonnet' }, bench, db), /exists/);
  const pc = planCache({ name: 'new', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet' }, bench, db);
  assert.equal(pc.anchor, c1); assert.equal(pc.limit, 60);
  assert.throws(() => planCache({ name: 'x', repo: 'click', anchor: 'nope', model: 'sonnet' }, bench, db), /not a commit/);
  // an unfinished build resumes only as the same build
  assert.throws(() => planCache({ name: 'good', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet', resume: true }, bench, db), /already built/);
  const half = fakeCache(bench, 'half', { anchor: c1, db });
  db.putCache({ ...half, status: 'failed', effort: null, steps_done: ['snapshot', 'mine-prs'] });
  const rp = planCache({ name: 'half', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet', limit: 60, resume: true }, bench, db);
  assert.deepEqual(rp.done, ['snapshot', 'mine-prs']); assert.equal(rp.steps.length, 3);
  assert.throws(() => planCache({ name: 'half', repo: 'click', anchor: c1, llm: 'claude', model: 'opus', limit: 60, resume: true }, bench, db), /differs in model/);
});

test('a cache build snapshots the checkout at the anchor and fails closed when mining cannot run', () => {
  const { bench, c1 } = fixture();
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evals-db-')), 'evals.db');
  const p = planCache({ name: 'nomine', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet', limit: 5 }, bench, openDb(dbFile));
  fs.mkdirSync(cacheDir(bench, 'nomine'), { recursive: true });
  const planFile = path.join(cacheDir(bench, 'nomine'), 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(p));
  // node alone on PATH and an empty HOME: no agent CLI and no login, so no model is ever called
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-bin-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'evals-home-')), THINKER_TEST: '1' };
  spawnSync(process.execPath, [path.resolve('bench/evals/build-cache.js'), bench, planFile, dbFile], { env, encoding: 'utf8' });
  const r = readReceipt(openDb(dbFile), 'nomine');
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.steps_done, ['snapshot'], r.error);
  assert.match(r.error, /mine-prs|agent CLI|no notes/);
  assert.equal(execFileSync('git', ['-C', path.join(cacheDir(bench, 'nomine'), 'repo'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), c1);
  assert.equal(execFileSync('git', ['-C', path.join(bench, 'repos', 'click'), 'branch', '--list', 'evals-anchor-*'], { encoding: 'utf8' }).trim(), '', 'the temporary branch is removed');
});

test('plan builds the experiment from its modules and blocks a failing check', () => {
  const { bench, fix } = ready();
  const db = openDb(':memory:');
  ingest(db, bench);
  assert.ok(db.getPrset('ps') && db.getCache('c-sonnet'), 'PR sets and receipts from files are imported');
  const p = plan({ ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'claude', off: 'nocache', on: 'cache', model: 'sonnet', reps: 1, tag: 'click-v9' }, { benchDir: bench, db });
  assert.equal(p.expected.length, 4); assert.equal(p.sessions, 2); assert.equal(p.resumed, 2);
  assert.equal(p.blocked, false, JSON.stringify(p.checks.filter(c => !c.ok)));
  assert.equal(p.modules.grading.oracle, 'tests');
  assert.ok(p.argv.includes('--no-judge'), 'tests grade every session: no judge is called');
  assert.ok(p.argv.includes('--isolated-settings'), "a session never loads this machine's own settings and hooks");
  assert.throws(() => plan({ ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'claude', model: 'sonnet', tag: 't', flags: { 'strict-model': true } }, { benchDir: bench, db }), /exact model id/);
  assert.equal(p.modules.prset.prs, 2); assert.equal(p.modules.cache.name, 'c-sonnet');
  assert.ok(p.argv.includes('--notes-dir') && p.argv[p.argv.indexOf('--notes-dir') + 1] === notesDir(bench, 'c-sonnet'));
  assert.equal(p.argv[p.argv.indexOf('--only') + 1], 'T1,T2');
  assert.equal(p.argv[p.argv.indexOf('--tasks') + 1], path.join(bench, 'runs', 'click-v9', 'tasks.json'), 'the runner reads the task set as the launch writes it into the run');
  assert.equal(p.taskset.name, 'click'); assert.ok(p.taskset.hash);
  assert.equal(plan({ ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'claude', model: 'opus', tag: 't' }, { benchDir: bench, db }).blocked, true, 'an agent model other than the mining model blocks');
  fakeCache(bench, 'late', { anchor: fix, db });
  assert.equal(plan({ ...exp, prset: 'ps', cache: 'late', runner: 'claude', model: 'sonnet', tag: 't' }, { benchDir: bench, db }).blocked, true);
  const base = { ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'claude', model: 'sonnet' };
  assert.throws(() => plan({ ...base, tag: 'x; rm -rf /' }, { benchDir: bench, db }), /tag/);
  assert.throws(() => plan({ ...base, tag: 't', model: '$(id)' }, { benchDir: bench, db }), /model/);
  assert.throws(() => plan({ ...base, tag: 't', prset: 'nope' }, { benchDir: bench, db }), /no PR set/);
  assert.throws(() => plan({ ...base, tag: 't', cache: undefined }, { benchDir: bench, db }), /pick a cache/);
  assert.throws(() => plan({ ...base, tag: 't', off: 'cache', on: 'cache' }, { benchDir: bench, db }), /different arms/);
  assert.throws(() => plan({ ...base, question: '', tag: 't' }, { benchDir: bench, db }), /what the experiment tests/);
  // PRs without tests need a named judge
  const spec = JSON.parse(fs.readFileSync(path.join(bench, 'tasks', 'click.json'), 'utf8'));
  spec.tasks.forEach(t => delete t.testCmd);
  fs.writeFileSync(path.join(bench, 'tasks', 'click2.json'), JSON.stringify(spec));
  createPrset(bench, db, { name: 'ps2', tasks: 'click2.json', rule: 'r' });
  assert.throws(() => plan({ ...base, prset: 'ps2', tag: 't' }, { benchDir: bench, db }), /name the judge/);
});

test('an arm defined as data runs against the cache off with no cache, and its definition is recorded and handed to the runner', () => {
  const { bench } = ready();
  const db = openDb(':memory:');
  ingest(db, bench);
  const tool = { name: 'tool', description: 'another tool', notes: false, mcpServers: { tool: { command: 'tool-mcp', args: ['{cwd}'] } }, system: 'use the tool',
    before: { command: ['tool', 'index', '{cwd}'], failIf: 'limit reached' }, exclude: ['.tool'] };
  assert.throws(() => defineArm(db, { ...tool, name: 'cache' }), /runners' own arms/);
  assert.throws(() => defineArm(db, { ...tool, notes: undefined }), /notes/);
  assert.throws(() => defineArm(db, { ...tool, before: { command: [] } }), /before.command/);
  assert.throws(() => defineArm(db, { ...tool, runner: 'gemini' }), /claude, codex only/);
  assert.throws(() => defineArm(db, { ...tool, name: 'tool-codex', runner: 'codex', hooks: { Stop: [] } }), /takes no hooks/);
  assert.throws(() => defineArm(db, { ...tool, name: 'tool-codex', runner: 'codex', mcpServers: { t: { args: [] } } }), /needs a command/);
  assert.equal(defineArm(db, { ...tool, name: 'tool-codex', runner: 'codex', mcpServers: { t: { command: 'x', enabled_tools: ['find'] } } }).runner, 'codex');
  const arm = defineArm(db, tool);
  assert.equal(db.getArm('tool').hash, arm.hash);
  const base = { ...exp, prset: 'ps', runner: 'claude', off: 'nocache', on: 'tool', model: 'sonnet', reps: 1, tag: 'click-tool' };
  const p = plan(base, { benchDir: bench, db });
  assert.equal(p.blocked, false, JSON.stringify(p.checks.filter(c => !c.ok)));
  assert.equal(p.modules.cache, null);
  assert.ok(!p.argv.includes('--notes-dir'), 'no notes are handed to the runner');
  assert.equal(p.argv[p.argv.indexOf('--arm-defs') + 1], armDefsFile(bench, 'click-tool'));
  assert.equal(p.modules.arms.defined.tool.hash, arm.hash);
  assert.deepEqual(p.modules.arms.defined.tool.before.command, ['tool', 'index', '{cwd}'], 'the plan records the whole definition');
  assert.throws(() => plan({ ...base, cache: 'c-sonnet' }, { benchDir: bench, db }), /leave the cache out/);
  assert.throws(() => plan({ ...base, extra: 'hook' }, { benchDir: bench, db }), /pick a cache/, 'an arm served notes still needs one');
  assert.throws(() => plan({ ...base, runner: 'codex' }, { benchDir: bench, db }), /defined for claude/);
  // launch writes the definitions where the runner reads them
  fs.writeFileSync(path.join(bench, 'run.js'), 'setTimeout(() => {}, 10)');
  launch(p, { benchDir: bench, db });
  assert.equal(JSON.parse(fs.readFileSync(armDefsFile(bench, 'click-tool'), 'utf8')).tool.system, 'use the tool');
});

test('a loop experiment names its checker, needs acceptance criteria on every PR, and says its estimate is a guess', () => {
  const { bench } = ready();
  const db = openDb(':memory:');
  ingest(db, bench);
  const base = { ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'codex', off: 'nocache', on: 'full', model: 'sonnet', reps: 1, tag: 'click-loop', flags: { loop: true } };
  assert.throws(() => plan(base, { benchDir: bench, db }), /checker/);
  assert.throws(() => plan({ ...base, runner: 'claude', on: 'cache', values: { checker: 'sonnet' } }, { benchDir: bench, db }), /no loop mode/);
  assert.throws(() => plan({ ...base, values: { checker: 'sonnet', iterations: '0' } }, { benchDir: bench, db }), /iterations/);
  const missing = plan({ ...base, values: { checker: 'sonnet' } }, { benchDir: bench, db });
  assert.equal(missing.blocked, true);
  assert.match(missing.checks.find(c => c.module === 'loop').detail, /missing on T1, T2/);
  // criteria are set in Artemis (a new task set version), and a PR set drawn from that version runs with them
  for (const t of ['T1', 'T2']) setAcceptance(db, 'click', t, [{ id: 'a1', criterion: 'it works' }]);
  createPrset(bench, db, { name: 'ps-acc', tasks: 'click', rule: 'both PRs' });
  base.prset = 'ps-acc';
  const p = plan({ ...base, values: { checker: 'sonnet', iterations: '3' } }, { benchDir: bench, db });
  assert.equal(p.blocked, false, JSON.stringify(p.checks.filter(c => !c.ok)));
  assert.deepEqual(p.modules.loop, { checker: 'sonnet', iterations: 3, iterationMin: 10, sessionMin: 30, tokenCap: null });
  for (const a of ['--loop', '--checker', '--iterations']) assert.ok(p.argv.includes(a), a);
  if (p.estimate) assert.match(p.estimate.basis, /guess/);
});

test('loop sessions normalize to done, iterations and false done, and a checker failure is invalid', () => {
  const loop = (stop, n, extra = {}) => ({ limits: {}, checker: 'gpt-x', iterations: Array.from({ length: n }, (_, i) => ({ n: i + 1 })), stop, checker_in_tokens: 500, ...extra });
  const row = (o, l) => normalize(rec({ ...o, loop: l }), { dir: 'r', file: 'x.json', mtime: 1 });
  const done = row({ grade: { tests: 'pass' } }, loop('done', 2));
  assert.equal(done.done, 1); assert.equal(done.iterations, 2); assert.equal(done.false_done, 0); assert.equal(done.checker, 'gpt-x'); assert.equal(done.checker_tokens, 500);
  assert.equal(row({ grade: { tests: 'fail' } }, loop('done', 1)).false_done, 1, 'the checker said done, the PR tests fail');
  const capped = row({ grade: { tests: 'fail' } }, loop('max_iterations', 4));
  assert.equal(capped.done, 0); assert.equal(capped.false_done, null); assert.equal(capped.invalid, null, 'a limit hit is an outcome, not an invalid session');
  assert.match(row({}, loop('checker_error', 1, { checkerError: 'checker timed out' })).invalid, /checker failed/);
  const plain = normalize(rec(), { dir: 'r', file: 'x.json', mtime: 1 });
  assert.equal(plain.done, null); assert.equal(plain.iterations, null);
  // an index made before loop sessions gains the columns on open
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evals-db-')), 'old.db');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE results (id TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT, area TEXT, arm TEXT, rep INTEGER, repo TEXT,
    model TEXT, effort TEXT, actual_models TEXT, turns INTEGER, wall_ms REAL, cost REAL, in_tokens REAL, fresh_in REAL, cache_read REAL,
    cache_write REAL, out_tokens REAL, tool_calls INTEGER, files_read INTEGER, calls_before_edit INTEGER, thinker_calls INTEGER,
    injected INTEGER, served INTEGER, pass INTEGER, score REAL, outcome_source TEXT, judge TEXT, invalid TEXT, mtime INTEGER, file TEXT)`);
  old.close();
  const db = openDb(file);
  assert.ok(db.all('PRAGMA table_info(results)').some(c => c.name === 'false_done'));
});

test('a loop comparison reports done and false done per arm over the pairs', () => {
  const r = (arm, rep, done, pass) => ({ ...normalize(rec({ arm, rep, grade: { tests: pass ? 'pass' : 'fail' }, loop: { stop: done ? 'done' : 'max_iterations', iterations: [{}, {}], checker: 'c' } }), { dir: 'r', file: `${arm}${rep}.json`, mtime: 1 }) });
  const c = compare([r('nocache', 0, false, false), r('nocache', 1, true, true), r('full', 0, true, true), r('full', 1, true, false)], 'nocache', 'full');
  assert.equal(c.offSide.done, 0.5); assert.equal(c.onSide.done, 1);
  assert.equal(c.onSide.false_done, 0.5);
  assert.equal(c.delta.done.mean, 0.5);
});

test('transcripts parse into steps from Claude Code and Codex, are archived into the run, and serve the session page', async () => {
  const steps = parseClaude([
    { type: 'user', message: { role: 'user', content: 'Fix it' }, timestamp: '2026-10-01T00:00:00Z' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 'u1', name: 'mcp__thinker__orient', input: { task: 'x' } }], usage: { input_tokens: 10, output_tokens: 2 } } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'Cached knowledge for this task' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u2', name: 'Edit', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'boom', is_error: true }] } },
  ]);
  assert.deepEqual(steps.map(s => s.kind), ['user', 'assistant', 'tool', 'tool']);
  assert.equal(steps[2].thinker, true); assert.equal(steps[3].error, true); assert.equal(steps[1].usage.in, 10);
  const st = stepStats(steps);
  assert.equal(st.tool_calls, 2); assert.equal(st.calls_before_first_edit, 1); assert.equal(st.thinker_steps, 1);
  const codex = parseCodex([{ type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 0 } }, { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'thinker', tool: 'orient', arguments: {}, result: { content: [{ type: 'text', text: 'notes' }] } } }]);
  assert.deepEqual(codex.map(s => s.name), ['shell', 'thinker.orient']);

  const { bench } = fixture();
  const run = path.join(bench, 'runs', 'click-v9');
  fs.mkdirSync(path.join(run, 'events'));
  fs.writeFileSync(path.join(run, 'events', 'T1-cache-0.jsonl'), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }));
  const app = createApp({ bench, dbFile: ':memory:', snapshots: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    for (let i = 0; i < 50 && !app.db.get("SELECT 1 FROM transcripts WHERE id = 'click-v9/T1-cache-0'"); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(app.db.get("SELECT 1 FROM transcripts WHERE id = 'click-v9/T1-cache-0'"), 'the transcript is stored in the database');
    const x = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/session?id=${encodeURIComponent('click-v9/T1-cache-0')}`)).json();
    assert.equal(x.transcript.archived, true); assert.equal(x.transcript.steps[0].text, 'done');
    assert.equal(x.partners[0].arm, 'nocache');
    assert.equal(x.row.tool_calls, 5);
  } finally { app.close(); }
});

test('any arm can be the reference: two arms that are neither cache off nor on are compared head to head', async () => {
  const { bench } = ready();
  // a third arm, another tool, beside cache off and cache on
  fs.writeFileSync(path.join(bench, 'runs', 'click-v9', 'T1-tool-0.json'), JSON.stringify(rec({ arm: 'tool', id: 'T1-tool-0', grade: { tests: 'fail' } })));
  const app = createApp({ bench, dbFile: ':memory:', snapshots: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const plain = await (await fetch(base + '/api/experiment?dir=click-v9')).json();
    assert.equal(plain.meta.ref, 'nocache');
    assert.deepEqual(plain.all.map(c => [c.off, c.on]).sort(), [['nocache', 'cache'], ['nocache', 'tool']]);
    const x = await (await fetch(base + '/api/experiment?dir=click-v9&ref=tool')).json();
    assert.equal(x.meta.ref, 'tool'); assert.equal(x.meta.cacheOff, 'nocache');
    assert.deepEqual(x.all.map(c => [c.off, c.on]).sort(), [['tool', 'cache'], ['tool', 'nocache']], 'every other arm against the reference');
    assert.equal(x.all.find(c => c.on === 'cache').pairs, 1);
    assert.equal(x.all.find(c => c.on === 'cache').onSide.passed, 1, 'cache passes where the tool failed, on the same pair');
    const bogus = await (await fetch(base + '/api/experiment?dir=click-v9&ref=nope')).json();
    assert.equal(bogus.meta.ref, 'nocache', 'an arm the experiment did not run falls back to cache off');
  } finally { app.server.close(); app.stop?.(); }
});

test('the server refuses an unconfirmed launch, a cross-origin one, and a foreign Host', async () => {
  const { bench } = ready();
  const app = createApp({ bench, dbFile: ':memory:', snapshots: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const s = await (await fetch(base + '/api/experiments')).json();
    assert.equal(s.experiments.length, 1);
    assert.equal(s.experiments[0].cmp.pairs, 1);
    const body = JSON.stringify({ ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'claude', tag: 'new', model: 'sonnet' });
    let r = await fetch(base + '/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(r.status, 400);
    r = await fetch(base + '/api/launch', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: JSON.stringify({ ...JSON.parse(body), confirm: true }) });
    assert.equal(r.status, 403);
    // fetch will not send a forged Host header; a raw request does
    const status = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: app.server.address().port, path: '/api/experiments', headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(status, 403);
  } finally { app.close(); }
});

test('a launched run reports progress from its result files and can be cancelled', async () => {
  const { bench } = ready();
  // a stand-in runner: writes one result, then waits to be cancelled
  fs.writeFileSync(path.join(bench, 'run.js'), `
    import fs from 'node:fs'; import path from 'node:path';
    const a = process.argv.slice(2), tag = a[a.indexOf('--tag') + 1];
    const out = path.join(${JSON.stringify(bench)}, 'runs', tag); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'T1-nocache-0.json'), JSON.stringify({ id: 'T1-nocache-0', task: 'T1', arm: 'nocache', rep: 0, turns: 3, env: process.env.THINKER_TEST }));
    console.log('T1-nocache-0: turns=3'); setInterval(() => {}, 1000);`);
  const db = openDb(':memory:');
  ingest(db, bench);
  const p = plan({ name: 'Stub', question: 'q', kind: 'behavior', prset: 'ps', cache: 'c-sonnet', runner: 'claude', off: 'nocache', on: 'cache', model: 'sonnet', tag: 'stub' }, { benchDir: bench, db });
  const id = launch(p, { benchDir: bench, db });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bench, 'runs', 'stub', 'tasks.json'), 'utf8')).tasks.map(t => t.id), ['T1', 'T2'], 'the launch writes the frozen task set into the run');
  let job;
  for (let i = 0; i < 50; i++) {
    job = jobsView(db, bench).find(j => j.id === id);
    if (job.done === 1 && /turns=3/.test(job.log)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(job.status, 'running'); assert.equal(job.done, 1); assert.equal(job.expected, 4);
  assert.equal(job.name, 'Stub');
  assert.equal(JSON.parse(fs.readFileSync(path.join(bench, 'runs', 'stub', 'T1-nocache-0.json'), 'utf8')).env, '1', 'a launched run is in test mode: no telemetry');
  assert.equal(readMeta(db, 'stub').on, 'cache', 'the launch records the definition before the first result');
  assert.equal(readMeta(db, 'stub').modules.cache.name, 'c-sonnet', 'and the modules it was built from');
  cancel(db, id);
  for (let i = 0; i < 50 && alive(job.pid ?? db.get('SELECT pid FROM jobs WHERE id = ?', id).pid); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(alive(db.get('SELECT pid FROM jobs WHERE id = ?', id).pid), false);
  assert.equal(jobsView(db, bench).find(j => j.id === id).status, 'cancelled');
});

test('the MCP tools read experiments and plan through the app, and start only with the planned session count', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { buildServer } = await import('../bench/evals/mcp.js');
  const { bench } = ready();
  const app = createApp({ bench, dbFile: ':memory:', snapshots: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  process.env.EVALS_URL = `http://127.0.0.1:${app.server.address().port}`;
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer(), client = new Client({ name: 't', version: '0' });
  await server.connect(a); await client.connect(b);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError, body: r.content[0].text }; };
  try {
    const list = JSON.parse((await call('list_experiments', {})).body);
    assert.equal(list[0].tag, 'click-v9'); assert.equal(list[0].headline.pairs, 1);
    const got = JSON.parse((await call('get_experiment', { tag: 'click-v9' })).body);
    assert.equal(got.comparisons[0].arm, 'cache'); assert.equal(got.comparisons[0].metrics.pass.off, 1);
    assert.equal(got.per_pr[0].task, 'T1');
    const args = { tag: 'mcp-new', ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'claude', model: 'sonnet' };
    const planned = JSON.parse((await call('plan_experiment', args)).body);
    assert.equal(planned.sessions, 4); assert.equal(planned.blocked, false); assert.equal(planned.modules.cache.name, 'c-sonnet');
    assert.equal(JSON.parse((await call('list_pr_sets', {})).body)[0].name, 'ps');
    assert.equal(JSON.parse((await call('list_caches', {})).body)[0].fits[0].ok, true);
    const session = JSON.parse((await call('get_session', { id: 'click-v9/T1-cache-0' })).body);
    assert.equal(session.arm, 'cache'); assert.equal(session.other_arms[0].arm, 'nocache');
    const refused = await call('start_experiment', { ...args, sessions: 3 });
    assert.ok(refused.error); assert.match(refused.body, /plan changed/);
    assert.equal(fs.existsSync(path.join(bench, 'runs', 'mcp-new')), false, 'a refused start writes nothing');
    assert.ok(JSON.parse((await call('define_experiment', { tag: 'click-v9', name: 'Named' })).body).meta.name === 'Named');
  } finally { delete process.env.EVALS_URL; await client.close(); app.close(); }
});

test('a running experiment shows each session live, read from the transcript its agent is writing', () => {
  const bench = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-live-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-home-'));
  const wt = path.join(bench, 'worktrees', 'click-t-0');
  fs.mkdirSync(wt, { recursive: true });
  const proj = path.join(home, '.claude', 'projects', fs.realpathSync(wt).replace(/[/.]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's1.jsonl'), [
    { type: 'user', message: { role: 'user', content: 'Fix the flag parser\nmore' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'rg flag' } }], usage: { input_tokens: 5, cache_read_input_tokens: 1000 } } },
  ].map(j => JSON.stringify(j)).join('\n'));
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    const [l] = liveSessions(bench, { runner: 'claude', repo: 'click', tag: 't', conc: 1 });
    assert.equal(l.state, 'working'); assert.equal(l.request, 'Fix the flag parser');
    assert.equal(l.tools, 1); assert.equal(l.last_tool.name, 'Bash'); assert.equal(l.last_tool.input, 'rg flag'); assert.equal(l.context_tokens, 1005);
    assert.deepEqual(liveSessions(bench, { runner: 'codex', repo: 'click', tag: 't' }), [], 'Codex writes its sessions at the end');
  } finally { process.env.HOME = was; }
});

test('snapshots go to the S3 location in the evals config, the environment overriding it', async () => {
  const { s3Uri } = await import('../bench/evals/snapshot.js');
  const cfg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'evals-cfg-')), 'config.json');
  const was = process.env.EVALS_S3_URI;
  delete process.env.EVALS_S3_URI;
  try {
    assert.equal(s3Uri(cfg), null, 'no config: local snapshots only');
    fs.writeFileSync(cfg, JSON.stringify({ s3: 's3://bucket-x/evals' }));
    assert.equal(s3Uri(cfg), 's3://bucket-x/evals');
    fs.writeFileSync(cfg, JSON.stringify({ s3: 'http://not-s3' }));
    assert.equal(s3Uri(cfg), null, 'anything but an s3:// location is ignored');
    process.env.EVALS_S3_URI = 's3://from-env/p';
    assert.equal(s3Uri(cfg), 's3://from-env/p');
  } finally { if (was) process.env.EVALS_S3_URI = was; else delete process.env.EVALS_S3_URI; }
});

test('the home from before the name moves to ~/.artemis once, its database renamed', async () => {
  const { migrateHome } = await import('../bench/evals/db.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-home-'));
  fs.mkdirSync(path.join(home, '.thinker-evals', 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(home, '.thinker-evals', 'evals.db'), 'db');
  fs.writeFileSync(path.join(home, '.thinker-evals', 'config.json'), '{"s3":"s3://b/p"}');
  assert.equal(migrateHome(home), true);
  assert.equal(fs.readFileSync(path.join(home, '.artemis', 'artemis.db'), 'utf8'), 'db');
  assert.ok(fs.existsSync(path.join(home, '.artemis', 'config.json')) && fs.existsSync(path.join(home, '.artemis', 'snapshots')));
  assert.equal(fs.existsSync(path.join(home, '.thinker-evals')), false);
  assert.equal(migrateHome(home), false, 'once');
});

test('task sets live in Artemis: imported with their gold diffs, versioned, and written into a run for the runner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasksets-'));
  const bench = path.join(root, 'bench');
  fs.mkdirSync(path.join(bench, 'tasks'), { recursive: true }); fs.mkdirSync(path.join(bench, 'data'), { recursive: true });
  const diff = 'diff --git a/src/a.py b/src/a.py\n+x\ndiff --git a/tests/test_a.py b/tests/test_a.py\n+def test_a(): pass\n';
  fs.writeFileSync(path.join(bench, 'data', 'PR1.diff'), diff);
  const set = { repo: 'org/proj', base: 'abc123', tasks: [{ id: 'PR1-hard', prompt: 'Fix a.', goldDiff: 'bench/data/PR1.diff', testFiles: ['tests/test_a.py'], testCmd: 'pytest tests/test_a.py' }] };
  fs.writeFileSync(path.join(bench, 'tasks', 'proj-hard.json'), JSON.stringify(set));
  const db = openDb(':memory:');
  const v1 = importTaskSet(bench, db, { name: 'proj-hard', file: 'bench/tasks/proj-hard.json' });
  assert.equal(v1.version, 1); assert.equal(v1.repo, 'proj', 'the checkout name, not the GitHub slug');
  assert.equal(getTaskSet(db, 'proj-hard').tasks[0].goldDiffText, diff, 'the gold diff is stored whole');
  assert.equal(importTaskSet(bench, db, { name: 'proj-hard', file: 'bench/tasks/proj-hard.json' }).unchanged, true, 'the same content is not a new version');
  // a task the runner could not grade fails the import
  fs.writeFileSync(path.join(bench, 'tasks', 'bad.json'), JSON.stringify({ ...set, tasks: [{ ...set.tasks[0], testFiles: ['tests/test_b.py'] }] }));
  assert.throws(() => importTaskSet(bench, db, { name: 'bad', file: 'bench/tasks/bad.json' }), /test files not in the gold diff/);
  fs.writeFileSync(path.join(bench, 'tasks', 'gone.json'), JSON.stringify({ ...set, tasks: [{ ...set.tasks[0], goldDiff: 'bench/data/none.diff' }] }));
  assert.throws(() => importTaskSet(bench, db, { name: 'gone', file: 'bench/tasks/gone.json' }), /not found/);
  // acceptance criteria are a new version; the old one stays readable by its hash
  const v2 = setAcceptance(db, 'proj-hard', 'PR1-hard', [{ id: 'a1', criterion: 'a works' }]);
  assert.equal(v2.version, 2); assert.equal(getTaskSet(db, 'proj-hard', { hash: v1.hash }).tasks[0].acceptance, undefined);
  assert.throws(() => setAcceptance(db, 'proj-hard', 'PR1-hard', [{ id: 'a1', criterion: 'x' }, { id: 'a1', criterion: 'y' }]), /repeat/);
  // the run's task file: the frozen version, gold diffs beside it, goldDiff as the oracle reads it
  const out = path.join(bench, 'runs', 'proj-x');
  const file = writeRunTasks(bench, db, { name: 'proj-hard', hash: v1.hash, outDir: out });
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(run.hash, v1.hash); assert.equal(run.tasks[0].goldDiffText, undefined);
  assert.equal(fs.readFileSync(path.join(root, run.tasks[0].goldDiff), 'utf8'), diff);
  // from a git ref: the file and its gold diffs as they were at that commit
  const g = (...a) => execFileSync('git', ['-C', root, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q'); g('add', 'bench/tasks/proj-hard.json', 'bench/data/PR1.diff'); g('commit', '-qm', 'set');
  fs.rmSync(path.join(bench, 'data', 'PR1.diff'));
  const fromGit = importTaskSet(bench, db, { name: 'proj-git', ref: 'HEAD', file: 'bench/tasks/proj-hard.json' });
  assert.equal(fromGit.from.kind, 'git'); assert.equal(getTaskSet(db, 'proj-git').tasks[0].goldDiffText, diff);
  assert.deepEqual(listTaskSets(db).map(s => s.name), ['proj-git', 'proj-hard']);
});

test('every PR Artemis holds is listed, a PR set opens to its PRs, and a PR shows its task before it has run', async () => {
  const { bench } = ready();
  const app = createApp({ bench, dbFile: ':memory:', snapshots: false });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    // the fixture's task set has T1 and T2; one experiment ran T1 only
    const { rows } = await (await fetch(base + '/api/prs')).json();
    const t2 = rows.find(r => r.task === 'T2');
    assert.ok(t2, 'a PR no experiment ran is still listed');
    assert.equal(t2.experiments, 0); assert.deepEqual(t2.tasksets, ['click']); assert.deepEqual(t2.prsets, ['ps']);
    assert.ok(rows.find(r => r.task === 'T1').experiments >= 1);
    const ps = await (await fetch(base + '/api/prset?name=ps')).json();
    assert.deepEqual(ps.prset.prs.map(p => [p.id, p.in_taskset]), [['T1', true], ['T2', true]]);
    assert.equal(ps.taskset.name, 'click'); assert.ok(ps.checks.length);
    assert.equal((await fetch(base + '/api/prset?name=nope')).status, 404);
    const pr = await (await fetch(base + '/api/pr?id=T2')).json();
    assert.deepEqual(pr.spec.tasksets, [{ name: 'click', version: 1 }]); assert.deepEqual(pr.spec.prsets, ['ps']);
    assert.equal(pr.experiments.length, 0);
  } finally { app.close(); }
});

test('every runner option the experiment form shows has a name and says what it does', () => {
  for (const [runner, r] of Object.entries(RUNNERS)) for (const key of [...r.booleans, ...r.values]) {
    const o = OPTIONS[key];
    assert.ok(o && o.label && o.help && !o.label.startsWith('--'), `${runner}: ${key} needs a label and help in jobs.js OPTIONS`);
    assert.equal(o.type, r.booleans.includes(key) ? 'switch' : 'setting', `${runner}: ${key}`);
  }
});
