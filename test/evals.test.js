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
import { plan, launch, cancel, alive, jobsView } from '../bench/evals/jobs.js';
import { createPrset, readPrset } from '../bench/evals/prsets.js';
import { checkCache, planCache, readReceipt, notesDir, cacheDir, hashNotes } from '../bench/evals/caches.js';
import { parseClaude, parseCodex, stepStats } from '../bench/evals/transcripts.js';
import { createApp } from '../bench/evals/server.js';

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
function fakeCache(bench, name, { anchor, model = 'sonnet', source = 'pr' }) {
  const notes = notesDir(bench, name);
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'n1.json'), JSON.stringify({ id: 'n1', title: 'A note', source: { type: source, ref: 'pr-1' }, search: 'x' }));
  const receipt = { name, repo: 'click', anchor, llm: 'claude', model, limit: 60, status: 'ok', notes: 1, described: 1, notes_hash: hashNotes(notes), created_at: 1 };
  fs.writeFileSync(path.join(cacheDir(bench, name), 'receipt.json'), JSON.stringify(receipt));
  return receipt;
}

const exp = { name: 'Hook', question: 'Does the hook help?', kind: 'behavior' };
// a bench with a PR set and a cache that pass every check
function ready() {
  const f = fixture();
  createPrset(f.bench, { name: 'ps', tasks: 'click.json', rule: 'both PRs' });
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

test('an experiment definition is written beside its results and validated', () => {
  const { bench } = fixture();
  writeMeta(bench, 'click-v9', { name: 'Hook on click', question: 'Does it help?', kind: 'behavior', off: 'nocache', on: 'cache' }, ['nocache', 'cache']);
  assert.equal(readMeta(bench, 'click-v9').name, 'Hook on click');
  assert.throws(() => writeMeta(bench, 'click-v9', { on: 'nocache' }, ['nocache', 'cache']), /different arms/);
  assert.throws(() => writeMeta(bench, 'click-v9', { off: 'hook' }, ['nocache', 'cache']), /not an arm/);
  assert.throws(() => writeMeta(bench, '../../etc', { name: 'x' }, []), /no such experiment/);
  const db = openDb(':memory:');
  ingest(db, bench);
  assert.equal(db.get('SELECT count(*) n FROM results').n, 2, 'experiment.json is not a result');
});

test('a PR set is frozen with its rule and checked against the checkout', () => {
  const { bench, c2 } = fixture();
  assert.throws(() => createPrset(bench, { name: 'p', tasks: 'click.json' }), /selection rule/);
  assert.throws(() => createPrset(bench, { name: 'p', tasks: 'click.json', rule: 'r', ids: ['T9'] }), /not in the task set/);
  const s = createPrset(bench, { name: 'p', tasks: 'click.json', rule: 'all', ids: ['T1'] });
  assert.equal(s.repo, 'click'); assert.equal(s.base, c2); assert.deepEqual(s.ids, ['T1']); assert.ok(s.hash);
  assert.ok(s.checks.every(c => c.ok), JSON.stringify(s.checks));
  assert.throws(() => createPrset(bench, { name: 'p', tasks: 'click.json', rule: 'again' }), /frozen/);
  assert.equal(readPrset(bench, 'p').prs[0].oracle, 'tests');
});

test('a cache passes only if mined from PRs, unchanged, before the base, without the PRs\' fixes, by the agent\'s model', () => {
  const { bench, c1, fix } = fixture();
  const prset = createPrset(bench, { name: 'ps', tasks: 'click.json', rule: 'r' });
  const ok = fakeCache(bench, 'good', { anchor: c1 });
  assert.ok(checkCache(bench, ok, prset, 'sonnet').every(c => c.ok), JSON.stringify(checkCache(bench, ok, prset, 'sonnet')));
  const failing = (r, model = 'sonnet') => checkCache(bench, r, prset, model).filter(c => !c.ok).map(c => c.check);
  assert.deepEqual(failing(ok, 'opus'), ["mined by the agent's model"]);
  assert.ok(failing(fakeCache(bench, 'late', { anchor: fix })).includes("no PR fix in the cache's history"));
  assert.deepEqual(failing(fakeCache(bench, 'hand', { anchor: c1, source: 'agent' })), ['every note mined from a PR']);
  fs.writeFileSync(path.join(notesDir(bench, 'good'), 'n2.json'), '{}');
  assert.ok(failing(ok).includes('unchanged since built'));
  assert.throws(() => planCache({ name: 'good', repo: 'click', model: 'sonnet' }, bench), /exists/);
  const pc = planCache({ name: 'new', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet' }, bench);
  assert.equal(pc.anchor, c1); assert.equal(pc.limit, 60);
  assert.throws(() => planCache({ name: 'x', repo: 'click', anchor: 'nope', model: 'sonnet' }, bench), /not a commit/);
});

test('a cache build snapshots the checkout at the anchor and fails closed when mining cannot run', () => {
  const { bench, c1 } = fixture();
  const p = planCache({ name: 'nomine', repo: 'click', anchor: c1, llm: 'claude', model: 'sonnet', limit: 5 }, bench);
  fs.mkdirSync(cacheDir(bench, 'nomine'), { recursive: true });
  const planFile = path.join(cacheDir(bench, 'nomine'), 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(p));
  // node alone on PATH and an empty HOME: no agent CLI and no login, so no model is ever called
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-bin-'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'evals-home-')), THINKER_TEST: '1' };
  spawnSync(process.execPath, [path.resolve('bench/evals/build-cache.js'), bench, planFile], { env, encoding: 'utf8' });
  const r = readReceipt(bench, 'nomine');
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
  const p = plan({ ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'claude', off: 'nocache', on: 'cache', model: 'sonnet', reps: 1, tag: 'click-v9' }, { benchDir: bench, db });
  assert.equal(p.expected.length, 4); assert.equal(p.sessions, 2); assert.equal(p.resumed, 2);
  assert.equal(p.blocked, false, JSON.stringify(p.checks.filter(c => !c.ok)));
  assert.equal(p.modules.grading.oracle, 'tests');
  assert.equal(p.modules.prset.prs, 2); assert.equal(p.modules.cache.name, 'c-sonnet');
  assert.ok(p.argv.includes('--notes-dir') && p.argv[p.argv.indexOf('--notes-dir') + 1] === notesDir(bench, 'c-sonnet'));
  assert.equal(p.argv[p.argv.indexOf('--only') + 1], 'T1,T2');
  assert.equal(plan({ ...exp, prset: 'ps', cache: 'c-sonnet', runner: 'claude', model: 'opus', tag: 't' }, { benchDir: bench, db }).blocked, true, 'an agent model other than the mining model blocks');
  fakeCache(bench, 'late', { anchor: fix });
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
  createPrset(bench, { name: 'ps2', tasks: 'click2.json', rule: 'r' });
  assert.throws(() => plan({ ...base, prset: 'ps2', tag: 't' }, { benchDir: bench, db }), /name the judge/);
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
  const spec = JSON.parse(fs.readFileSync(path.join(bench, 'tasks', 'click.json'), 'utf8'));
  spec.tasks.forEach(t => { t.acceptance = [{ id: 'a1', criterion: 'it works' }]; });
  fs.writeFileSync(path.join(bench, 'tasks', 'click.json'), JSON.stringify(spec));
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
  const app = createApp({ bench, dbFile: ':memory:' });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  try {
    for (let i = 0; i < 50 && !fs.existsSync(path.join(run, 'transcripts', 'T1-cache-0.jsonl.gz')); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(fs.existsSync(path.join(run, 'transcripts', 'T1-cache-0.jsonl.gz')), 'the transcript is archived into the run folder');
    const x = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/session?id=${encodeURIComponent('click-v9/T1-cache-0')}`)).json();
    assert.equal(x.transcript.archived, true); assert.equal(x.transcript.steps[0].text, 'done');
    assert.equal(x.partners[0].arm, 'nocache');
    assert.equal(x.row.tool_calls, 5);
  } finally { app.close(); }
});

test('the server refuses an unconfirmed launch, a cross-origin one, and a foreign Host', async () => {
  const { bench } = ready();
  const app = createApp({ bench, dbFile: ':memory:' });
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
  const p = plan({ name: 'Stub', question: 'q', kind: 'behavior', prset: 'ps', cache: 'c-sonnet', runner: 'claude', off: 'nocache', on: 'cache', model: 'sonnet', tag: 'stub' }, { benchDir: bench, db });
  const id = launch(p, { benchDir: bench, db });
  let job;
  for (let i = 0; i < 50; i++) {
    job = jobsView(db, bench).find(j => j.id === id);
    if (job.done === 1 && /turns=3/.test(job.log)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(job.status, 'running'); assert.equal(job.done, 1); assert.equal(job.expected, 4);
  assert.equal(job.name, 'Stub');
  assert.equal(JSON.parse(fs.readFileSync(path.join(bench, 'runs', 'stub', 'T1-nocache-0.json'), 'utf8')).env, '1', 'a launched run is in test mode: no telemetry');
  assert.equal(readMeta(bench, 'stub').on, 'cache', 'the launch writes the definition before the first result');
  assert.equal(readMeta(bench, 'stub').modules.cache.name, 'c-sonnet', 'and the modules it was built from');
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
  const app = createApp({ bench, dbFile: ':memory:' });
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
