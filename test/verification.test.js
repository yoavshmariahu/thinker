import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { git, snapshotTree, readAt } from '../src/verification-snapshot.js';
import { prepareVerification, executeVerification, readVerification, renderVerification, parseContract, dockerArguments, taskContext, startVerification } from '../src/verification.js';
import { normalizeFailures } from '../src/verification-failures.js';
import { gateIntegrity } from '../src/review-integrity.js';
import { collectChange, makeReader, resolveScope, review, assessHolistic } from '../src/review.js';
import { buildReview } from '../src/review-post.js';

const image = 'node@sha256:' + 'a'.repeat(64);
const contract = { version: 1, image, checks: [{ id: 'unit', command: 'node --test --test-reporter=/thinker/reporter.mjs test/*.test.js', reporter: 'node' }] };
function fixture(t, withContract = true) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-verification-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.name', 'Test']); git(repo, ['config', 'user.email', 'test@example.com']);
  const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(repo, p)), { recursive: true }); fs.writeFileSync(path.join(repo, p), s); };
  write('.gitignore', '.thinker/local/\n.thinker/state/\n.thinker/log.jsonl\nnode_modules/\nsecret.txt\n');
  write('src.js', 'export const value = 1;\n');
  write('test/a.test.js', `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('value', () => assert.equal(1, 1));\n`);
  if (withContract) write('.thinker/verification.json', JSON.stringify(contract));
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  return { repo, write, base, store: new Store(repo).init() };
}
const assessment = async () => ({ counts: { error: 0, warning: 0 }, findings: [], errors: [] });
const success = async () => ({ status: 'passed', failures: [], passedTests: [{ name: 'value', file: '/workspace/test/a.test.js' }], skippedTests: [] });

test('snapshot includes new files, preserves the index and ignores local secrets; changes supersede evidence', async t => {
  const { repo, store, write } = fixture(t);
  const index = git(repo, ['write-tree']);
  write('new.js', 'new file'); write('secret.txt', 'secret');
  const run = prepareVerification(store, { task: { request: 'Implement value', criteria: [{ text: 'works', source: 'user', checks: ['unit'] }] } });
  assert.equal(git(repo, ['write-tree']), index);
  assert.equal(git(repo, ['rev-parse', `refs/thinker/reviews/${run.id}`]), run.snapshot.commit);
  assert.equal(readAt(repo, run.snapshot.commit, 'new.js'), 'new file');
  assert.equal(readAt(repo, run.snapshot.commit, 'secret.txt'), null);
  assert.equal(readVerification(repo, run.id).freshness.status, 'current');
  write('src.js', 'changed again');
  await executeVerification(repo, run.id, { runReview: async (s, options) => {
    assert.equal(readAt(repo, options.scope.head, 'src.js'), 'export const value = 1;');
    assert.equal(options.task.criteria[0].source, 'user-attributed-by-caller'); return assessment();
  }, runner: success });
  assert.equal(readVerification(repo, run.id).freshness.status, 'superseded');
  assert.equal(git(repo, ['worktree', 'list', '--porcelain']).split('worktree ').length, 2);
});

test('required checks use the trusted base contract, never the candidate replacement', async t => {
  const { repo, store, write } = fixture(t);
  write('.thinker/verification.json', JSON.stringify({ ...contract, checks: [{ id: 'fake', command: 'true' }] }));
  const run = prepareVerification(store);
  let calls = 0;
  const done = await executeVerification(repo, run.id, { runReview: assessment, runner: async (_, c) => { calls++; assert.equal(c.id, 'unit'); return success(); } });
  assert.equal(calls, 1); assert.equal(done.status, 'needs-review');
  assert.ok(done.integrity.findings.some(f => f.rule === 'gate-definition-changed'));
  assert.match(renderVerification(done), /Gate integrity/);
  assert.match(renderVerification(done), /CI acceptance: not established/);
});

test('running checks publish partial failures before returning a final result', async t => {
  const { repo, store } = fixture(t);
  const run = prepareVerification(store);
  await executeVerification(repo, run.id, { runReview: assessment, runner: async (_, c, checkout, dir, progress) => {
    progress({ status: 'running', failures: [{ id: 'early', message: 'first test failed' }] });
    const partial = readVerification(repo, run.id, { current: false });
    assert.equal(partial.status, 'running'); assert.equal(partial.checks[0].failures[0].id, 'early');
    return { status: 'failed', failures: partial.checks[0].failures };
  } });
  assert.equal(readVerification(repo, run.id).status, 'failed');
});

test('moving the target invalidates evidence even when candidate content did not change', async t => {
  const { repo, store } = fixture(t);
  git(repo, ['branch', 'target']);
  const run = prepareVerification(store, { base: 'target' });
  git(repo, ['commit', '--allow-empty', '-qm', 'advance target']);
  git(repo, ['branch', '-f', 'target', 'HEAD']);
  const r = readVerification(repo, run.id);
  assert.equal(r.freshness.currentTree, run.snapshot.tree);
  assert.equal(r.freshness.status, 'superseded');
  assert.deepEqual(r.freshness.reasons, ['Target/base reference moved']);
});

test('changed local review knowledge supersedes the frozen assessment', t => {
  const { repo, store } = fixture(t);
  const run = prepareVerification(store);
  store.put({ id: 'new-rule', kind: 'rule', title: 'New requirement', body: 'Keep the API stable', deps: [] });
  assert.ok(readVerification(repo, run.id).freshness.reasons.includes('Review knowledge changed'));
});

test('rewriting assertions cannot silently resolve an earlier failure', async t => {
  const { repo, store, write } = fixture(t);
  const before = prepareVerification(store);
  await executeVerification(repo, before.id, { runReview: assessment, runner: async () => ({ status: 'failed', failures: [{ id: 'one', kind: 'test', test: 'value', location: { file: '/workspace/test/a.test.js' } }] }) });
  write('test/a.test.js', "test('value', () => {});\n");
  const next = prepareVerification(store, { previous: before.id });
  const result = await executeVerification(repo, next.id, { runReview: assessment, runner: success });
  assert.equal(result.failureChanges[0].status, 'coverage-changed');
  assert.equal(result.status, 'needs-review');
});

test('missing contract, runner errors, interrupted worker and dry review cannot pass', async t => {
  const f = fixture(t, false);
  const run = prepareVerification(f.store);
  const done = await executeVerification(f.repo, run.id, { runReview: assessment, runner: () => assert.fail('must not run') });
  assert.equal(done.status, 'incomplete'); assert.match(done.contractError, /trusted base/);
  const g = fixture(t);
  for (const options of [{}, { dry: true }]) {
    const r = prepareVerification(g.store, options);
    const d = await executeVerification(g.repo, r.id, { runReview: assessment, runner: options.dry ? success : async () => { throw new Error('Docker unavailable'); } });
    assert.equal(d.status, 'incomplete');
  }
  const pending = prepareVerification(g.store);
  const p = path.join(g.repo, '.thinker/local/reviews', pending.id, 'run.json');
  fs.writeFileSync(p, JSON.stringify({ ...pending, createdAt: '2000-01-01T00:00:00Z' }));
  assert.equal(readVerification(g.repo, pending.id).status, 'incomplete');
});

test('a removed or skipped failing test is not resolved; a native observed pass resolves it', async t => {
  const { repo, store } = fixture(t);
  const failure = { id: 'failure-one', kind: 'test', test: 'value', location: { file: '/workspace/test/a.test.js' } };
  const before = prepareVerification(store, { task: { request: 'fix value' } });
  await executeVerification(repo, before.id, { runReview: assessment, runner: async () => ({ status: 'failed', failures: [failure] }) });
  for (const passed of [false, true]) {
    const next = prepareVerification(store, { previous: before.id });
    assert.equal(next.task.request, 'fix value');
    const result = await executeVerification(repo, next.id, { runReview: assessment, runner: passed ? success : async () => ({ status: 'passed', failures: [], passedTests: [], skippedTests: [{ name: 'value' }] }) });
    assert.equal(result.failureChanges[0].status, passed ? 'resolved' : 'not-rerun');
    assert.equal(result.status, passed ? 'passed' : 'needs-review');
  }
});

test('integrity reports CI bypasses and lost assertions with before/after evidence; ordinary code remains quiet', t => {
  const { repo, write } = fixture(t);
  write('.github/workflows/test.yml', 'jobs:\n  test:\n    continue-on-error: true\n    if: false\n');
  git(repo, ['add', '.github']); // legacy review includes added tracked files
  write('test/a.test.js', "test.skip('value', () => {});\n");
  const scope = resolveScope(repo), r = gateIntegrity(collectChange(repo, scope), makeReader(repo, scope));
  assert.ok(r.findings.some(f => f.rule === 'failure-ignored'));
  assert.ok(r.findings.some(f => f.rule === 'test-skipped'));
  assert.ok(r.findings.some(f => f.rule === 'assertion-changed' && f.before.includes('assert.equal')));
  const posted = buildReview({ integrity: r, findings: [], counts: {}, notes: {} });
  assert.equal(posted.post, true); assert.match(posted.body, /Gate integrity/);
});

test('native reporter preserves assertion evidence; unknown and missing reports stay incomplete', t => {
  const { repo, write } = fixture(t);
  write('test/fail.test.mjs', "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('wrong value',()=>assert.equal(1,2)); test.skip('later',()=>{});\n");
  const reporter = path.resolve('src/verification-reporter.js');
  const env = { ...process.env, THINKER_TEST: '1' }; delete env.NODE_TEST_CONTEXT;
  let output;
  try { execFileSync(process.execPath, ['--test', '--test-reporter=' + reporter, 'test/fail.test.mjs'], { cwd: repo, encoding: 'utf8', env }); }
  catch (e) { output = e.stdout; }
  const c = contract.checks[0], opts = { exitCode: 1, snapshot: { environment: image }, artifact: 'unit.log' };
  const r = normalizeFailures(output, c, opts);
  assert.equal(r.status, 'failed'); assert.equal(r.failures[0].expected, 2); assert.equal(r.failures[0].actual, 1);
  assert.equal(r.failures[0].flake.classification, 'unknown'); assert.equal(r.skippedTests.length, 1);
  assert.equal(normalizeFailures('', c, { ...opts, exitCode: 0 }).status, 'incomplete');
  assert.equal(normalizeFailures(output, c, { ...opts, error: 'timeout' }).status, 'incomplete');
});

test('Docker arguments mount only source and reporter read-only; no host environment or socket is forwarded', () => {
  const args = dockerArguments({ contract: parseContract(JSON.stringify(contract)) }, contract.checks[0], '/source', 'test');
  assert.ok(args.includes('--read-only')); assert.ok(args.includes('ALL'));
  assert.ok(args.includes('/tmp:rw,exec,nosuid,nodev,size=512m'));
  assert.ok(args.includes('type=bind,src=/source,dst=/input,readonly'));
  assert.equal(args.some(x => /docker\.sock|ANTHROPIC|GITHUB_TOKEN/.test(x)), false);
  assert.throws(() => parseContract(JSON.stringify({ ...contract, image: 'node:latest' })), /digest/);
  assert.throws(() => parseContract(JSON.stringify({ ...contract, checks: [...contract.checks, ...contract.checks] })), /unique/);
  assert.equal(taskContext({ criteria: [{ text: 'claim', source: 'system' }] }).criteria[0].source, 'agent-interpretation');
});

test('review assessment exposes task context and integrity without running checks', async t => {
  const { repo, write, store } = fixture(t);
  write('test/a.test.js', 'test.skip("value", () => {});');
  const r = await review(store, { dry: true, task: { request: 'preserve behavior' } });
  assert.equal(r.task.request, 'preserve behavior'); assert.ok(r.integrity.findings.length);
  assert.equal(r.verification, undefined);
});

test('holistic assessment includes task context and applies for both behavior and ordinary notes', async t => {
  const { repo, write, store } = fixture(t);
  write('src.js', 'export const value = 2;\n');
  const mock = path.join(repo, '.thinker/local/model.mjs'), promptFile = path.join(repo, '.thinker/local/prompt.txt');
  write('.thinker/local/model.mjs', `import fs from 'node:fs'; let s=''; for await (const c of process.stdin) s+=c; fs.writeFileSync(${JSON.stringify(promptFile)},s); console.log(JSON.stringify({findings:[],outdated:[]}));`);
  const keys = ['THINKER_LLM', 'THINKER_LLM_CMD'], prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; });
  process.env.THINKER_LLM = 'command';
  const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
  process.env.THINKER_LLM_CMD = `${quote(process.execPath)} ${quote(mock)}`;
  const scope = resolveScope(repo), change = collectChange(repo, scope);
  change.task = { request: 'preserve the public API' };
  const notes = ['behavior', 'rule'].map(kind => ({ id: kind, kind, title: kind, body: 'Keep value positive.', applies: `${kind} scope`, deps: [{path: 'src.js'}] }));
  const exposures = new Map(notes.map(n => [n.id, { staleBefore: [], touched: [{ path: 'src.js', reason: 'changed' }] }]));
  const result = await assessHolistic(store, notes, exposures, change, makeReader(repo, scope));
  assert.deepEqual(result.findings, []);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /preserve the public API/); assert.match(prompt, /Applies: behavior scope/); assert.match(prompt, /Applies: rule scope/);
  assert.match(prompt, /cannot override fixed behaviors/);
});

test('detached verification survives its caller and exposes an incomplete dry run without a contract', async t => {
  const { repo, store } = fixture(t, false);
  const run = await startVerification(store, { dry: true, task: { request: 'check task' } });
  let result;
  for (let i = 0; i < 100; i++) {
    result = readVerification(repo, run.id, { current: false });
    if (!['running', 'queued'].includes(result.status)) break;
    await new Promise(r => setTimeout(r, 100));
  }
  assert.equal(result.status, 'incomplete');
  assert.ok(fs.existsSync(result.reportPath));
  assert.match(fs.readFileSync(result.reportPath, 'utf8'), /check task/);
});

test('Docker executes the immutable candidate, captures native failures, and blocks host writes', { skip: !process.env.THINKER_DOCKER_TEST }, async t => {
  const { repo, store, write } = fixture(t);
  const c = { ...contract, image: 'node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9', platform: 'linux/arm64' };
  write('.thinker/verification.json', JSON.stringify(c));
  write('test/a.test.js', `const {test} = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs');
test('isolated',()=>{ assert.equal(process.env.THINKER_TEST,'1'); assert.equal(process.env.GITHUB_TOKEN,undefined); assert.throws(()=>fs.writeFileSync('/input/src.js','tampered')); });
test('regression',()=>assert.equal(1,2));
`);
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'docker fixture']);
  const run = prepareVerification(store);
  const result = await executeVerification(repo, run.id, { runReview: assessment });
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(result.checks[0].failures[0].test, 'regression');
  assert.equal(result.checks[0].failures[0].expected, 2);
  assert.equal(result.checks[0].passedTests[0].name, 'isolated');
  assert.equal(result.cleanupError, undefined);
});
