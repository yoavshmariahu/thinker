// Passive test-output parsing for the context diet: parsers, cause grouping and command recognition.
//
// The fixtures under test/fixtures/test-output/ are real runs captured on this machine from tiny
// sample projects (pytest 8.4.2, jest 29.7.0, vitest 2.1.8, go 1.27.1, node 24 in both its spec
// and TAP reporters); only the absolute paths were shortened to /repo. cargo.txt is the one
// exception: no Rust toolchain was available, so it is written to the format cargo test prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TESTS, testsConfig, detectRunner, runnerOfOutput, parseTestOutput, summarize,
  causeOf, groupCauses, stripAnsi, classifyTestCommand,
  shellSegments, renderSegments,
  logPathFor, pruneLogs,
} from '../src/test-output.js';
import { Store } from '../src/store.js';

process.env.THINKER_TELEMETRY = 'off';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.js');
const fixture = name => fs.readFileSync(path.join(HERE, 'fixtures', 'test-output', name), 'utf8');
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function gitRepo(prefix = 'thinker-tests-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  git(dir, 'init', '-q');
  return dir;
}

// --- parsers ---------------------------------------------------------------

test('pytest: counts, every failure with its message, and frames from the short traceback', () => {
  const r = parseTestOutput(fixture('pytest.txt'), { runner: 'pytest' });
  assert.deepEqual([r.runner, r.failed, r.passed, r.skipped, r.warnings], ['pytest', 3, 2, 1, 1]);
  assert.deepEqual(r.failures.map(f => f.name).sort(), ['test_deep.py::test_deep', 'test_math.py::test_raises', 'test_math.py::test_rejects_empty']);
  const deep = r.failures.find(f => f.name.endsWith('test_deep'));
  assert.equal(deep.message, 'ValueError: boom in inner');
  assert.deepEqual(deep.frames.map(f => `${f.file}:${f.line} ${f.fn}`),
    ['test_deep.py:4 test_deep', 'app/calc.py:5 outer', 'app/calc.py:2 inner']);
  assert.equal(r.failures.find(f => f.name.endsWith('test_rejects_empty')).message, 'assert 2 == 3');
});

test('pytest with colour: the escapes are stripped and nine failures come to two causes', () => {
  const raw = fixture('pytest-color.txt');
  assert.ok(raw.includes('\x1b['), 'the fixture is a coloured run');
  const r = parseTestOutput(raw, { runner: 'pytest' });
  assert.deepEqual([r.failed, r.passed], [9, 0]);
  assert.equal(r.failures.length, 9);
  assert.ok(!JSON.stringify(r).includes('\\u001b'), 'no escape survives into the parse');
  const groups = groupCauses(r.failures);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(g => g.count), [8, 1]);
  // the message is taken from the traceback, not from the short summary, which pytest cuts to
  // the terminal width: a cut message would split this one cause in two
  assert.equal(groups[0].message, 'ConnectionError: could not reach the rows database at 127.0.0.1:5432');
  assert.deepEqual(groups[0].names.slice(0, 2), ['test_rows.py::test_fetch_rows[1]', 'test_rows.py::test_fetch_rows[2]']);
  assert.deepEqual(groups[0].frames.map(f => `${f.file}:${f.line}`), ['test_rows.py:8', 'app/rows.py:6', 'app/rows.py:2']);
  assert.equal(groups[1].message, "ModuleNotFoundError: No module named 'app.gone'");
});

test('jest: the text report and the --json payload give the same counts and failures', () => {
  const t = parseTestOutput(fixture('jest.txt'), { runner: 'jest' });
  assert.deepEqual([t.runner, t.failed, t.passed, t.skipped], ['jest', 2, 1, 1]);
  assert.deepEqual(t.failures.map(f => f.name), ['sum > rejects empty', 'sum > throws deep']);
  assert.match(t.failures[0].message, /^expect\(received\)\.toBe\(expected\)/);
  assert.deepEqual(t.failures[0].frames.map(f => `${f.file}:${f.line}`), ['sum.test.js:9']);
  assert.deepEqual(t.failures[1].frames.map(f => `${f.file}:${f.line}`), ['lib.js:2', 'lib.js:5', 'sum.test.js:13']);

  const j = parseTestOutput(fixture('jest.json'), { runner: 'jest' });
  assert.deepEqual([j.failed, j.passed, j.skipped], [2, 1, 1]);
  assert.deepEqual(j.failures.map(f => f.name), ['sum rejects empty', 'sum throws deep']);
  assert.equal(j.failures[1].message, 'boom in inner');
});

test('vitest: counts and failures from the coloured default reporter', () => {
  const r = parseTestOutput(fixture('vitest.txt'), { runner: 'vitest' });
  assert.deepEqual([r.runner, r.failed, r.passed, r.skipped], ['vitest', 2, 1, 1]);
  assert.deepEqual(r.failures.map(f => f.name), ['sum.test.js > sum > rejects empty', 'sum.test.js > sum > throws deep']);
  assert.equal(r.failures[0].message, 'AssertionError: expected 2 to be 3 // Object.is equality');
  assert.deepEqual(r.failures[1].frames.map(f => `${f.file}:${f.line}`), ['lib.js:2', 'lib.js:5', 'sum.test.js:14']);
});

test('go: text output gives no passed count, -json gives all four', () => {
  const t = parseTestOutput(fixture('go.txt'), { runner: 'go' });
  assert.deepEqual([t.runner, t.failed, t.passed, t.skipped], ['go', 2, null, 0], 'go test without -v says nothing about the tests that passed');
  assert.deepEqual(t.failures.map(f => f.name), ['TestSub', 'TestFatal']);
  assert.equal(t.failures[0].message, 'got 2, want 3');
  assert.deepEqual(t.failures[1].frames.map(f => `${f.file}:${f.line}`), ['calc_test.go:22']);

  const j = parseTestOutput(fixture('go-json.txt'), { runner: 'go' });
  assert.deepEqual([j.failed, j.passed, j.skipped], [2, 2, 1]);
  assert.deepEqual(j.failures.map(f => f.name).sort(), ['TestFatal', 'TestSub']);
  assert.equal(j.failures.find(f => f.name === 'TestSub').message, 'got 2, want 3');
});

test('node --test: both the spec reporter and TAP', () => {
  for (const [file, name] of [['node.txt', 'spec'], ['node-tap.txt', 'TAP']]) {
    const r = parseTestOutput(fixture(file), { runner: 'node' });
    assert.deepEqual([r.runner, r.failed, r.passed, r.skipped], ['node', 1, 2, 1], name);
    assert.deepEqual(r.failures.map(f => f.name), ['rejects empty'], name);
    assert.match(r.failures[0].message, /boom in inner/, name);
    // node's own frames are dropped; only the repository's files are printed
    const repoFrames = summarize(r, { repo: '/repo', exitCode: 1 });
    assert.match(repoFrames, /\/repo\/lib\.js:2|lib\.js:2/, name);
    assert.ok(!repoFrames.includes('node:internal'), name);
  }
});

test('cargo: counts summed over the test binaries, failures from the stdout blocks', () => {
  const r = parseTestOutput(fixture('cargo.txt'), { runner: 'cargo' });
  assert.deepEqual([r.runner, r.failed, r.passed, r.skipped], ['cargo', 2, 1, 1]);
  assert.deepEqual(r.failures.map(f => f.name), ['tests::rejects_empty', 'tests::throws_deep']);
  assert.equal(r.failures[0].message, 'assertion `left == right` failed');
  assert.deepEqual(r.failures[0].frames.map(f => `${f.file}:${f.line}`), ['src/lib.rs:17']);
});

test('the runner is recognised from the output when the command did not say (npm test)', () => {
  assert.equal(runnerOfOutput(fixture('pytest.txt')), 'pytest');
  assert.equal(runnerOfOutput(fixture('jest.txt')), 'jest');
  assert.equal(runnerOfOutput(fixture('vitest.txt')), 'vitest');
  assert.equal(runnerOfOutput(fixture('go.txt')), 'go');
  assert.equal(runnerOfOutput(fixture('cargo.txt')), 'cargo');
  assert.equal(runnerOfOutput(fixture('node.txt')), 'node');
  assert.equal(runnerOfOutput('hello world'), null);
  // an npm script: the command names no runner, the output does
  assert.equal(detectRunner('npm test'), 'script');
  assert.equal(parseTestOutput(fixture('vitest.txt'), { runner: 'script' }).runner, 'vitest');
});

test('output that is not a test report is not summarised as an empty run', () => {
  assert.equal(parseTestOutput('pytest 8.4.2\n', { runner: 'pytest' }), null);
  assert.equal(parseTestOutput('', { runner: 'jest' }), null);
});

// --- causes, colour, summary -----------------------------------------------

test('a cause is the message with its values normalised away', () => {
  assert.equal(causeOf({ message: 'ConnectionError: no route to 10.0.0.3:5432 after 1.25s' }),
    causeOf({ message: 'ConnectionError: no route to 10.2.0.9:5433 after 30s' }));
  assert.equal(causeOf({ message: 'KeyError: 0x7f2a1b' }), causeOf({ message: 'KeyError: 0xdeadbeef' }));
  assert.notEqual(causeOf({ message: 'KeyError: rows' }), causeOf({ message: 'ValueError: rows' }));
  assert.equal(causeOf({ message: '' }), '(no message)');
});

test('the summary prints the counts, each cause once with its examples and frames, and the log path', () => {
  const r = parseTestOutput(fixture('pytest-color.txt'), { runner: 'pytest' });
  const text = summarize(r, { repo: '/repo', logPath: '.thinker/state/tests/x.log', logLines: 81, exitCode: 1, cfg: { ...TESTS, examples: 2 } });
  const ls = text.split('\n');
  assert.equal(ls[0], 'pytest: 9 failed, 0 passed — exit 1');
  assert.equal(ls[1], '2 distinct causes in 9 failing tests:');
  assert.equal(ls[2], '8× ConnectionError: could not reach the rows database at 127.0.0.1:5432');
  assert.match(ls[3], /test_rows\.py::test_fetch_rows\[1\], test_rows\.py::test_fetch_rows\[2\], … \+6 more/);
  assert.deepEqual(ls.slice(4, 7), ['    test_rows.py:8 in test_fetch_rows', '    app/rows.py:6 in fetch', '    app/rows.py:2 in connect']);
  assert.equal(ls.at(-1), 'full log (81 lines): .thinker/state/tests/x.log');
  // the whole summary is a fraction of the run it replaces
  assert.ok(text.length < fixture('pytest-color.txt').length / 4, `summary ${text.length} chars`);
});

test('an unknown runner is passed through: the tail of its log and the path', () => {
  const text = summarize(null, { logPath: 'x.log', exitCode: 2, command: 'make check', cfg: { ...TESTS, tail: 2 }, tail: 'one\n\x1b[31mtwo\x1b[0m\nthree\n' });
  assert.deepEqual(text.split('\n'), ['make check: exit 2, last 2 lines of output', 'two', 'three', 'full log: x.log']);
});

// --- the command classifier ------------------------------------------------

test('test commands are recognised, and anything else is left alone', () => {
  for (const [cmd, runner] of [
    ['pytest tests/test_a.py', 'pytest'], ['python -m pytest -k rows', 'pytest'],
    ['npx vitest run src/a.test.ts', 'vitest'], ['./node_modules/.bin/jest sum', 'jest'],
    ['go test ./...', 'go'], ['cargo test rows', 'cargo'], ['node --test test/a.test.js', 'node'],
    ['npm test', 'script'], ['yarn run test', 'script'], ['pnpm test -- -k rows', 'script'],
  ]) assert.equal(classifyTestCommand(cmd)?.runner, runner, cmd);
  for (const cmd of ['ls -la', 'git status', 'node src/cli.js list', 'echo pytest', '', 'npm run build'])
    assert.equal(classifyTestCommand(cmd), null, cmd);
});

test('only the last few logs are kept', () => {
  const repo = gitRepo();
  const store = new Store(repo).init();
  fs.mkdirSync(path.join(store.dir, 'state', 'tests'), { recursive: true });
  for (let i = 0; i < 8; i++) fs.writeFileSync(logPathFor(store, 'pytest', new Date(Date.UTC(2026, 0, 1, 0, 0, i))), 'x');
  pruneLogs(store, 3);
  const left = fs.readdirSync(path.join(store.dir, 'state', 'tests'));
  assert.equal(left.length, 3);
  assert.ok(left.every(f => /00-0[567]-000-pytest\.log$/.test(f)), left.join(','));
});

// --- a shell line is not one command ---------------------------------------

test('a test run is recognised inside the lines agents actually write', () => {
  for (const [cmd, runner] of [
    ['cd packages/web && pytest tests/x.py', 'pytest'],
    ['pytest tests/x.py | tail -50', 'pytest'],
    ['npm test 2>&1 | head -100', 'script'],
    ['cd services/api; go test ./...', 'go'],
    ['pytest a && echo done', 'pytest'],
  ]) assert.equal(classifyTestCommand(cmd)?.runner, runner, cmd);
  // a line thinker will not take apart: rewriting it could change what runs
  for (const cmd of ['pytest $(ls tests)', 'pytest `cat files`', '(cd x && pytest a)'])
    assert.equal(classifyTestCommand(cmd), null, cmd);
});

test('every separator survives a round trip, so a rewrite can be put back together', () => {
  for (const line of [
    'pytest tests/x.py', 'cd packages/web && pytest tests/x.py', 'pytest a | tail -50',
    'npm test 2>&1 | head -100', 'cd x; pytest b', 'pytest a && echo done || echo fail',
    'pytest "a b.py" -k \'one or two\'',
  ]) assert.equal(renderSegments(shellSegments(line)), line, line);
});
