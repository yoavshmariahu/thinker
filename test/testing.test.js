// Test economy (src/testing.js, src/commands/testing.js, the `pre` hook): the output parsers, the
// cause grouping, the colour handling, the command classifier and the hook's per-client protocol.
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
  TESTS, testsConfig, detectRunner, runnerOfOutput, machineReadable, parseTestOutput, summarize,
  causeOf, groupCauses, stripAnsi, ansiStripper, classifyTestCommand, wrappedCommand, wrapperBin,
  logPathFor, pruneLogs, NO_COLOR_ENV,
} from '../src/testing.js';
import { preToolOutput, rewritesCommands, PRE_TOOL_CLIENTS, installClient } from '../src/clients.js';
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

test('ANSI is stripped even when an escape is split across two chunks', () => {
  const s = ansiStripper();
  assert.equal(s.push('a\x1b[3'), 'a');
  assert.equal(s.push('1mred\x1b[0m\n'), 'red\n');
  assert.equal(s.end(), '');
  assert.equal(stripAnsi('\x1b[1m\x1b[31mFAIL\x1b[0m x'), 'FAIL x');
  // a lone escape at the end is not held for ever
  const t = ansiStripper();
  t.push('x\x1b');
  assert.equal(t.end(), '\x1b');
});

test('colour is forced off and the machine-readable flags are added once', () => {
  assert.equal(machineReadable('pytest tests/', 'pytest'), 'pytest tests/ -q --tb=short -rfE --color=no -p no:cacheprovider');
  assert.equal(machineReadable('pytest -q --tb=long --color=no -rN tests/', 'pytest'), 'pytest -q --tb=long --color=no -rN tests/ -p no:cacheprovider');
  assert.equal(machineReadable('npx jest src', 'jest'), 'npx jest src --colors=false');
  assert.equal(machineReadable('npx jest --colors=false src', 'jest'), 'npx jest --colors=false src');
  assert.equal(machineReadable('go test ./...', 'go'), 'go test ./...', 'go test prints no colour');
  assert.equal(machineReadable('pytest tests/', 'pytest', { color: false }), 'pytest tests/ -q --tb=short -rfE');
  assert.deepEqual([NO_COLOR_ENV.NO_COLOR, NO_COLOR_ENV.FORCE_COLOR], ['1', '0']);
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
  // a command already going through the wrapper is never answered again
  assert.equal(classifyTestCommand('thinker test -- pytest tests/'), null);
  assert.equal(classifyTestCommand(wrappedCommand('pytest tests/')), null);
});

test('the wrapper is named by PATH, or by this copy of cli.js', () => {
  assert.equal(wrappedCommand('pytest -q', 'thinker'), 'thinker test -- pytest -q');
  const bin = wrapperBin('/x/src/cli.js', { PATH: '' });
  assert.equal(bin, 'node "/x/src/cli.js"');
  assert.equal(wrappedCommand('pytest', bin), 'node "/x/src/cli.js" test -- pytest');
});

// --- the config switch -----------------------------------------------------

test('the whole feature is off until the config turns it on', () => {
  const store = new Store(gitRepo()).init();
  assert.equal(TESTS.nudge, false);
  assert.equal(testsConfig(store).nudge, false);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ tests: { nudge: true, causes: 3 } }));
  assert.deepEqual(testsConfig(store), { ...TESTS, nudge: true, causes: 3 });
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ tests: true }));
  assert.equal(testsConfig(store).nudge, true);
  assert.equal(testsConfig(store, { nudge: false }).nudge, false, 'a caller option wins');
});

// --- the per-client pre-tool protocol --------------------------------------

test('the clients that rewrite a command do, and the one that cannot is given a reason', () => {
  assert.deepEqual(PRE_TOOL_CLIENTS, ['claude', 'codex', 'cursor']);
  for (const client of ['claude', 'codex']) {
    assert.equal(rewritesCommands(client), true);
    const o = JSON.parse(preToolOutput(client, { command: 'thinker test -- pytest', reason: 'run this instead: …' }));
    assert.equal(o.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.deepEqual(o.hookSpecificOutput.updatedInput, { command: 'thinker test -- pytest' });
    assert.equal(o.hookSpecificOutput.permissionDecision, undefined, 'no decision: the host still asks as it would have');
    assert.match(o.hookSpecificOutput.additionalContext, /run this instead/);
  }
  assert.equal(rewritesCommands('cursor'), false);
  assert.deepEqual(JSON.parse(preToolOutput('cursor', { command: 'x', reason: 'run this instead: x' })),
    { permission: 'deny', agent_message: 'run this instead: x' });
  assert.equal(preToolOutput('gemini', { command: 'x', reason: 'y' }), '', 'a client with no pre-tool event gets nothing');
});

test('Claude Code, Codex and Cursor are wired for the pre-tool event on shell commands', () => {
  const dir = gitRepo();
  const o = { repo: dir, cli: CLI, mcpEntry: { command: 'node', args: ['/x'], env: {} }, hooks: true, learn: true, late: true, shared: true, mcp: false };
  for (const c of ['claude', 'codex', 'cursor']) installClient(c, o);
  const read = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const claude = read('.claude/settings.json').hooks.PreToolUse[0];
  assert.equal(claude.matcher, 'Bash', 'only shell commands');
  assert.match(claude.hooks[0].command, / hook pre$/);
  assert.match(read('.codex/hooks.json').hooks.PreToolUse[0].hooks[0].command, / hook pre --client codex --repo "/);
  assert.match(read('.cursor/hooks.json').hooks.beforeShellExecution[0].command, / hook pre --client cursor --repo "/);
});

// --- the hook, end to end --------------------------------------------------

// NODE_TEST_CONTEXT is set for this file by the suite's own runner; left in the environment, a
// `node --test` the wrapper starts would take itself for one of its children and report nothing.
const hookEnv = () => {
  const env = { ...process.env, THINKER_TEST: '1', THINKER_NO_BG_VERIFY: '1', THINKER_TELEMETRY: 'off', HOME: gitRepo('thinker-home-') };
  delete env.NODE_TEST_CONTEXT;
  return env;
};
const runHook = (repo, client, ev, env) => execFileSync('node', [CLI, 'hook', 'pre', '--client', client, '--repo', repo],
  { input: JSON.stringify(ev), encoding: 'utf8', env }).trim();
const bash = (session, command) => ({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
const logLines = store => (fs.existsSync(path.join(store.dir, 'log.jsonl')) ? fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);

test('the pre hook says nothing until the config asks for it, then answers each command once', () => {
  const repo = gitRepo();
  const store = new Store(repo).init();
  const env = hookEnv();
  assert.equal(runHook(repo, 'claude', bash('s1', 'pytest tests/test_a.py'), env), '', 'off by default');

  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ tests: { nudge: true } }));
  assert.equal(runHook(repo, 'claude', bash('s1', 'ls -la'), env), '', 'not a test command');
  assert.equal(runHook(repo, 'codex', { session_id: 's1', tool_name: 'apply_patch', tool_input: { command: 'pytest tests/' } }, env), '', 'not a shell command');

  const first = JSON.parse(runHook(repo, 'claude', bash('s1', 'pytest tests/test_a.py'), env));
  assert.match(first.hookSpecificOutput.updatedInput.command, /test -- pytest tests\/test_a\.py$/);
  assert.match(first.hookSpecificOutput.additionalContext, /^run this instead: /);

  // the agent re-issues the command it was given; the same command is never answered twice
  assert.equal(runHook(repo, 'claude', bash('s1', 'pytest tests/test_a.py'), env), '');
  assert.equal(runHook(repo, 'claude', bash('s1', first.hookSpecificOutput.updatedInput.command), env), '', 'nor the wrapped one');
  // another command in the same session is still answered, and so is the first one in a new session
  assert.notEqual(runHook(repo, 'claude', bash('s1', 'go test ./...'), env), '');
  assert.notEqual(runHook(repo, 'claude', bash('s2', 'pytest tests/test_a.py'), env), '');

  // Cursor: the same decision, delivered as a denial with the command to run
  const cursor = JSON.parse(runHook(repo, 'cursor', { conversation_id: 'c1', hook_event_name: 'beforeShellExecution', command: 'npm test' }, env));
  assert.equal(cursor.permission, 'deny');
  assert.match(cursor.agent_message, /^run this instead: \S*thinker\S* test -- npm test|^run this instead: node ".*" test -- npm test/);

  const nudges = logLines(new Store(repo)).filter(e => e.op === 'test-nudge');
  assert.deepEqual(nudges.map(e => e.how), ['rewrite', 'rewrite', 'rewrite', 'deny']);
  assert.deepEqual(nudges.map(e => e.command), ['pytest tests/test_a.py', 'go test ./...', 'pytest tests/test_a.py', 'npm test']);
});

// --- the wrapper, end to end -----------------------------------------------

test('thinker test runs the command, keeps the log out of the way and prints the summary', () => {
  const repo = gitRepo();
  new Store(repo).init();
  fs.writeFileSync(path.join(repo, 'lib.js'), 'export function outer() {\n  throw new Error("boom in inner");\n}\n');
  fs.writeFileSync(path.join(repo, 'a.test.js'), [
    "import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { outer } from './lib.js';",
    "test('passes', () => { assert.ok(true); });",
    "test('one', () => { outer(); });",
    "test('two', () => { outer(); });", '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');

  const env = hookEnv();
  let out = '', code = 0;
  try { out = execFileSync('node', [CLI, 'test', '--', 'node', '--test'], { cwd: repo, encoding: 'utf8', env }); }
  catch (e) { out = e.stdout; code = e.status; }
  assert.equal(code, 1, "the test command's exit code is passed through");
  const ls = out.trim().split('\n');
  assert.equal(ls[0], 'node: 2 failed, 1 passed — exit 1');
  assert.equal(ls[1], '1 distinct cause in 2 failing tests:');
  assert.match(ls[2], /^2× Error: boom in inner/);
  assert.match(ls[3], /^ {4}one, two$/);
  assert.ok(ls.some(l => /^ {4}lib\.js:2/.test(l)), out);
  const logLine = ls.at(-1);
  assert.match(logLine, /^full log \(\d+ lines\): \.thinker\/state\/tests\/.*-node\.log$/);

  // the log holds the whole run, and the summary is a fraction of it
  const log = fs.readFileSync(path.join(repo, logLine.replace(/^.*: /, '')), 'utf8');
  assert.ok(log.includes('boom in inner') && log.length > out.length);
  assert.ok(!log.includes('\x1b['), 'the log is free of colour escapes');
  // a log file is scratch output: it is not in the repository's git status
  assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(l => l.includes('.thinker')).length, 0);

  // a passing run reports the counts and no causes, and exits 0
  fs.writeFileSync(path.join(repo, 'a.test.js'), "import { test } from 'node:test';\ntest('passes', () => {});\n");
  const ok = execFileSync('node', [CLI, 'test', '--', 'node', '--test'], { cwd: repo, encoding: 'utf8', env }).trim().split('\n');
  assert.equal(ok[0], 'node: 0 failed, 1 passed — exit 0');
  assert.match(ok[1], /^full log/);

  const e = logLines(new Store(repo)).filter(x => x.op === 'test-run');
  assert.deepEqual(e.map(x => [x.runner, x.exit, x.failed, x.causes]), [['node', 1, 2, 1], ['node', 0, 0, 0]]);
});

test('an unknown runner is run as given and reported by the tail of its log', () => {
  const repo = gitRepo();
  new Store(repo).init();
  const env = hookEnv();
  let out = '', code = 0;
  try { out = execFileSync('node', [CLI, 'test', '--', 'sh', '-c', 'printf "a\\nb\\nc\\n"; exit 3'], { cwd: repo, encoding: 'utf8', env }); }
  catch (e) { out = e.stdout; code = e.status; }
  assert.equal(code, 3);
  const ls = out.trim().split('\n');
  assert.match(ls[0], /exit 3, last 3 lines of output$/);
  assert.deepEqual(ls.slice(1, 4), ['a', 'b', 'c']);
  assert.match(ls.at(-1), /^full log \(\d+ lines\): \.thinker\/state\/tests\//);
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
