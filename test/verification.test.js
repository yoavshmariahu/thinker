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
  assert.deepEqual(taskContext({ criteria: [{ text: 'safe links', tests: [
    { check: 'unit', name: 'absolute', file: '/private/tmp/secret.test.js' },
    { check: 'unit', name: 'traversal', file: '../secret.test.js' },
    { check: 'unit', name: 'portable', file: 'test/a.test.js' },
  ] }] }).criteria[0].tests, [{ check: 'unit', name: 'portable', file: 'test/a.test.js' }]);
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
  write('test/value.test.js', "test('value', () => assert.equal(value, 2));\n");
  const mock = path.join(repo, '.thinker/local/model.mjs'), promptFile = path.join(repo, '.thinker/local/prompt.txt');
  write('.thinker/local/model.mjs', `import fs from 'node:fs'; let s=''; for await (const c of process.stdin) s+=c; fs.writeFileSync(${JSON.stringify(promptFile)},s); console.log(JSON.stringify({findings:[],outdated:[],summary:'No issue seen',intentEvidence:[{intentIndex:0,file:'src.js',line:1,observed:'value now returns 2'},{intentIndex:1,file:'src.js',line:1,observed:'unsupported index'}],criterionSupport:[{criterionIndex:0,coverage:'direct',file:'test/value.test.js',line:1,explanation:'compares the return value with 2'},{criterionIndex:1,coverage:'direct',file:'test/value.test.js',line:1,explanation:'unsupported index'}]}));`);
  const keys = ['THINKER_LLM', 'THINKER_LLM_CMD'], prior = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; });
  process.env.THINKER_LLM = 'command';
  const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
  process.env.THINKER_LLM_CMD = `${quote(process.execPath)} ${quote(mock)}`;
  const scope = resolveScope(repo), change = collectChange(repo, scope);
  change.task = { request: 'preserve the public API', intendedChanges: ['Change value'], criteria: [{ text: 'Value is 2', tests: [{ check: 'unit', name: 'value', file: 'test/value.test.js' }] }] };
  const notes = ['behavior', 'rule'].map(kind => ({ id: kind, kind, title: kind, body: 'Keep value positive.', applies: `${kind} scope`, deps: [{path: 'src.js'}] }));
  const exposures = new Map(notes.map(n => [n.id, { staleBefore: [], touched: [{ path: 'src.js', reason: 'changed' }] }]));
  const result = await assessHolistic(store, notes, exposures, change, makeReader(repo, scope));
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.intentEvidence, [{ intentIndex: 0, file: 'src.js', line: 1, observed: 'value now returns 2' }]);
  assert.deepEqual(result.criterionSupport, [{ criterionIndex: 0, coverage: 'direct', file: 'test/value.test.js', line: 1, explanation: 'compares the return value with 2' }]);
  const prompt = fs.readFileSync(promptFile, 'utf8');
  assert.match(prompt, /preserve the public API/); assert.match(prompt, /Applies: behavior scope/); assert.match(prompt, /Applies: rule scope/);
  assert.match(prompt, /cannot override fixed behaviors/);
  assert.match(prompt, /LINKED TEST SOURCES/);
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

test('the checkout the runner receives carries standalone Git metadata: the snapshot commit, nothing of the host', async t => {
  const { repo, store, write } = fixture(t);
  write('new.js', 'new file');
  const run = prepareVerification(store);
  let seen = null;
  await executeVerification(repo, run.id, { runReview: assessment, runner: async (_, c, checkout) => {
    const inner = args => git(checkout, args, { env: { GIT_CONFIG_GLOBAL: '/dev/null' } });
    seen = { exists: fs.existsSync(checkout), head: inner(['rev-parse', 'HEAD']), status: inner(['status', '--porcelain']), remotes: inner(['remote']), shallow: inner(['rev-parse', '--is-shallow-repository']) };
    assert.equal(fs.readFileSync(path.join(checkout, 'new.js'), 'utf8'), 'new file');
    assert.ok(fs.statSync(path.join(checkout, '.git')).isDirectory(), 'a repository of its own, not a pointer at the host');
    assert.ok(!fs.existsSync(path.join(checkout, '.git', 'hooks')) || !fs.readdirSync(path.join(checkout, '.git', 'hooks')).length, 'no hooks');
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.name === 'objects' ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(path.join(checkout, '.git'))) assert.ok(!fs.readFileSync(f, 'latin1').includes(repo), `${f} names the host repository`);
    return success();
  } });
  assert.deepEqual(seen, { exists: true, head: run.snapshot.commit, status: '', remotes: '', shallow: 'true' });
  const done = readVerification(repo, run.id, { current: false });
  assert.equal(done.status, 'passed'); assert.equal(done.cleanupError, undefined);
  assert.ok(!fs.existsSync(path.join(done.reportPath, '..', 'checkout')), 'the checkout is removed after the run');
  assert.equal(git(repo, ['worktree', 'list', '--porcelain']).split('worktree ').length, 2, 'the host registers no worktree for it');
});

test('a posted verification report is portable: the local artifact path stays on the host, the comment carries the marker', async t => {
  const { postComment, MARKER } = await import('../src/review-post.js');
  const { repo, store } = fixture(t);
  const run = prepareVerification(store, { task: { request: 'Implement value', criteria: [{ text: 'works', source: 'user', checks: ['unit'], tests: [{ check: 'unit', name: 'value', file: 'test/a.test.js' }] }] } });
  await executeVerification(repo, run.id, { runReview: assessment, runner: async (_, c, checkout, dir) => ({ ...await success(), artifact: path.join(dir, `${c.id}.log`) }) });
  const done = readVerification(repo, run.id);
  done.review.criterionSupport = [{ criterionIndex: 0, coverage: 'direct', file: 'test/a.test.js', line: 3, explanation: 'asserts that value equals one' }];
  assert.ok(done.checks[0].artifact.startsWith(repo));
  assert.match(renderVerification(done), /Full output for unit\]\(/);
  const portable = renderVerification(done, { portable: true });
  assert.match(portable, /Full output: unit\.log \(stored locally; not uploaded\)\./);
  assert.ok(!portable.includes(repo) && !portable.includes(os.tmpdir()), 'no host path in the posted report');
  assert.match(portable, /works \| unit: value \(test\/a\.test\.js\) passed \| direct: asserts that value equals one \(test\/a\.test\.js:3, model reading\)/);
  let sent = null;
  const result = postComment({}, { repo, pr: '7', markdown: portable, run: (command, args, opts) => { sent = { command, args, input: opts.input }; return 'https://github.com/o/r/pull/7#issuecomment-1\n'; } });
  assert.deepEqual(result, { posted: true, url: 'https://github.com/o/r/pull/7#issuecomment-1' });
  assert.deepEqual([sent.command, sent.args], ['gh', ['pr', 'comment', '7', '--body-file', '-']]);
  assert.equal(sent.input, `${MARKER}\n${portable}`);
});

test('the report says where the task came from and what judged correctness', async t => {
  const { repo, store } = fixture(t);
  const run = prepareVerification(store, { caller: 'mcp', task: { request: 'Implement value', rationale: 'Keep callers on the existing value path', intendedChanges: ['Change the value implementation'], questions: ['Does the public call still work?'], criteria: [{ text: 'works', source: 'user', checks: ['unit'] }] } });
  assert.equal(run.task.providedBy, 'mcp'); assert.match(run.task.providedAt, /^\d{4}-/);
  await executeVerification(repo, run.id, { runReview: assessment, runner: success });
  const report = renderVerification(readVerification(repo, run.id));
  assert.match(report, /## Why and how\n\n\*\*Reason for the approach \(supplied by the agent\):\*\* Keep callers on the existing value path/);
  assert.match(report, /## Before approving\n\n- Does the public call still work\?/);
  assert.match(report, /works \| unit: passed \(whole check\) \| No specific test was linked to this criterion/);
  assert.match(report, /The task framing came from the calling agent via MCP at \d{4}-/);
  assert.match(report, /Any user-attributed criterion is the agent's attribution, not independently confirmed user input/);
  assert.match(report, /checks came from the verification contract at base [0-9a-f]{12} and ran against frozen snapshot [0-9a-f]{12}/);
  assert.match(report, /code assessment read the change against frozen notes/);
  assert.doesNotMatch(report, /used sonnet/);
  assert.ok(report.indexOf('## Why and how') < report.indexOf('## Evidence source and scope'), 'decision context comes before provenance');
  const grounded = readVerification(repo, run.id);
  grounded.review.intentEvidence = [{ intentIndex: 0, file: 'src.js', line: 1, observed: 'the value implementation changed' }];
  grounded.review.behaviors = [{ id: 'behavior', title: 'Value stays positive', outcome: 'upheld' }];
  grounded.review.toAssess = [{ id: 'behavior', why: 'rests on src.js:value' }];
  const decision = renderVerification(grounded);
  assert.match(decision, /1\. Change the value implementation\n   - Seen in the diff at `src\.js:1`: the value implementation changed \(model reading\)/);
  assert.match(decision, /Desired behaviors directly in play \(model reading\):[\s\S]*Value stays positive: upheld/);
  assert.doesNotMatch(decision, /Changed-line anchors were identified for/);
  grounded.task.intendedChanges.push('Keep the public call stable');
  assert.match(renderVerification(grounded), /Changed-line anchors were identified for 1 of 2 steps/);
  const bare = prepareVerification(store);
  assert.equal(bare.task, null);
  assert.match(renderVerification(readVerification(repo, bare.id)), /No task was supplied/);
  const { repo: r2, store: s2 } = fixture(t, false);
  assert.match(renderVerification(readVerification(r2, prepareVerification(s2).id)), /No verification contract ran: No \.thinker\/verification\.json/);
});

test('criterion evidence distinguishes an observed pass, a skipped test, and an unmatched test', async t => {
  const { repo, store } = fixture(t);
  const run = prepareVerification(store, { task: { request: 'Keep value working', criteria: [
    { text: 'Value works', tests: [{ check: 'unit', name: 'value', file: 'test/a.test.js' }] },
    { text: 'Later case works', tests: [{ check: 'unit', name: 'later', file: 'test/a.test.js' }] },
    { text: 'Missing case works', tests: [{ check: 'unit', name: 'missing', file: 'test/a.test.js' }] },
  ] } });
  await executeVerification(repo, run.id, { runReview: assessment, runner: async () => ({ ...await success(), skippedTests: [{ name: 'later', file: '/workspace/test/a.test.js' }] }) });
  const report = renderVerification(readVerification(repo, run.id));
  assert.match(report, /Value works \| unit: value \(test\/a\.test\.js\) passed \| The linked assertion was not assessed/);
  assert.match(report, /Later case works \| unit: later \(test\/a\.test\.js\) skipped \| The linked test did not execute/);
  assert.match(report, /Missing case works \| unit: no result for missing \(test\/a\.test\.js\) \| The linked test was not observed/);
  assert.match(report, /## Before approving[\s\S]*1 other test was skipped/);
  assert.doesNotMatch(report.split('## Why and how')[0], /sha256|Candidate:|Knowledge:/);
  const failedCheck = readVerification(repo, run.id);
  failedCheck.checks[0].status = 'failed';
  assert.match(renderVerification(failedCheck), /Value works \| unit: value \(test\/a\.test\.js\) passed \| The containing unit check is failed/);
  const runningCheck = readVerification(repo, run.id);
  runningCheck.checks[0].status = 'running';
  runningCheck.checks[0].passedTests = [];
  assert.match(renderVerification(runningCheck), /Value works \| unit: value \(test\/a\.test\.js\) pending \| The check is still running/);
  const changedAssertions = readVerification(repo, run.id);
  changedAssertions.integrity = { findings: [{ rule: 'assertion-changed', file: 'test/a.test.js', message: 'Assertions changed', certainty: 'needs-assessment', before: 'x'.repeat(500) }] };
  const concise = renderVerification(changedAssertions);
  assert.match(concise, /assertion-changed.*Inspect the diff for replacement coverage/);
  assert.doesNotMatch(concise, /x{100}/);
});
