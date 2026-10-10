import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// the helpers color their output when stdout is a terminal or npm sets FORCE_COLOR: the assertions below are on plain text
process.env.NO_COLOR = '1';
// setup wires the agents' own settings: a home of its own, so this machine's are never touched
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-setup-home-'));
process.env.CODEX_HOME = path.join(process.env.HOME, '.codex');
delete process.env.CLAUDE_CONFIG_DIR;
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import {
  c,
  stripAnsi,
  box,
  banner,
  stepBanner,
  formatDuration,
  formatBytes,
  estimateCacheBuild,
  findRecentPrChange,
  buildPrBenchmarkTask,
  renderPrBenchmarkReport,
  runSetup,
  BUILD_AGENTS,
  getAgentDisplayName,
  getAgentLoginCommand,
  getAgentLoginArgs,
  checkAgentAuth,
  selectAndAuthenticateAgent,
  selectMenu,
  stepPrBenchmark,
  stepBuildCache,
  depthLimits,
  spinner,
  finishBox,
} from '../src/setup.js';
import { isAuthError, cleanErrorMessage } from '../src/benchmark.js';

// Auth and build execution are mocked below; binary discovery must also be
// deterministic on machines without agent CLIs. Unexpected execution fails.
const agentBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-setup-bins-'));
const originalPath = process.env.PATH;
for (const name of ['claude', 'codex', 'agy', 'gemini', 'agent']) {
  fs.writeFileSync(path.join(agentBinDir, name), '#!/bin/sh\n[ "$1" = --version ] && exit 0\necho "Unexpected agent execution in setup test" >&2\nexit 1\n', { mode: 0o755 });
}
process.env.PATH = `${agentBinDir}${path.delimiter}${originalPath || ''}`;
after(() => { process.env.PATH = originalPath; fs.rmSync(agentBinDir, { recursive: true, force: true }); });


function createMockGitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-setup-test-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Thinker Test'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@thinker.dev'], { cwd: dir });

  // Initial commit
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/index.js'), 'export const greeting = "hello";\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial commit', '-q'], { cwd: dir });

  // Feature commit representing PR #42
  fs.writeFileSync(path.join(dir, 'src/api.js'), 'export function handleRequest() { return 200; }\n');
  fs.writeFileSync(path.join(dir, 'src/index.js'), 'export const greeting = "hello world";\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'feat(api): add request handler (#42)', '-q'], { cwd: dir });

  return dir;
}

test('cache build reports partial failures without a success summary', async () => {
  const repo = createMockGitRepo();
  try {
    const store = new Store(repo).init(), lines = [];
    const estimates = estimateCacheBuild(repo, { prs: 2, areas: 2, agent: 'codex' });
    estimates.canMine = estimates.canSeed = true;
    const result = await stepBuildCache({
      repo, store, estimates, yes: true, noPhrase: true, agent: 'codex', out: line => lines.push(stripAnsi(line)),
      minePrsFn: async () => ({ saved: 0, processed: 2, failed: 2 }),
      seedFn: async () => ({ ok: 0, total: 2, saved: 0, failures: [{ area: 'src', error: 'timed out' }] }),
    });
    assert.equal(result.warnings, 2);
    assert.match(lines.join('\n'), /Cache build finished with warnings/);
    assert.match(lines.join('\n'), /0\/2 areas completed/);
    assert.doesNotMatch(lines.join('\n'), /Knowledge cache ready|notes generated|Mined.*notes created/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('behavior proposal stage runs on every cache build', async () => {
  const repo = createMockGitRepo();
  try {
    const store = new Store(repo).init();
    const estimates = estimateCacheBuild(repo, { prs: 0, areas: 0, agent: 'codex' });
    let calls = 0;
    const options = { repo, store, estimates, noPhrase: true, agent: 'codex',
      proposeFn: async () => { calls++; return { proposals: [{ id: 'proposal-example' }], sources: 1 }; },
      out: () => {} };
    await stepBuildCache(options);
    assert.equal(calls, 1);
    await stepBuildCache({ ...options, noSeed: true, noPrs: true });
    assert.equal(calls, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a build that was not asked to explore says so once and lists no exploration stage', async () => {
  const repo = createMockGitRepo();
  try {
    const store = new Store(repo).init(), lines = [];
    const estimates = estimateCacheBuild(repo, { prs: 2, noSeed: true, agent: 'codex' });
    estimates.canMine = true;
    await stepBuildCache({ repo, store, estimates, noSeed: true, noPhrase: true, agent: 'codex', out: line => lines.push(stripAnsi(line)),
      minePrsFn: async () => ({ saved: 0, processed: 2, failed: 0 }),
      seedFn: async () => { throw new Error('must not explore'); },
      proposeFn: async () => ({ proposals: [], sources: 0 }) });
    const text = lines.join('\n');
    assert.match(text, /merged pull requests only; the code itself is not explored/);
    assert.match(text, /\[1\/2\]/);
    assert.match(text, /\[2\/2\]/);
    assert.doesNotMatch(text, /Skipped|--areas|thinker seed|explore skipped|\/3\]/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a failed last stage names the command that retries that stage alone', async () => {
  const repo = createMockGitRepo();
  try {
    const store = new Store(repo).init(), lines = [];
    store.put({ id: 'n1', title: 'A note', kind: 'rule', body: 'Body of the note.', deps: [], status: 'fresh' });
    const estimates = estimateCacheBuild(repo, { prs: 2, noSeed: true, agent: 'codex' });
    estimates.canMine = true;
    const options = { repo, store, estimates, noSeed: true, agent: 'codex', out: line => lines.push(stripAnsi(line)),
      minePrsFn: async () => ({ saved: 1, processed: 2, failed: 0 }) };
    // a provider is named so the phrasing step runs on a machine with no agent CLI; phraseFn never calls it
    const before = process.env.THINKER_LLM; process.env.THINKER_LLM = 'command';
    const r = await stepBuildCache({ ...options,
      phraseFn: async (s, notes) => ({ done: [], tokens: 0, failed: notes.length, lastError: new Error('claude -p exited 1') }),
      proposeFn: async () => { throw new Error('claude -p exited 1'); } })
      .finally(() => { if (before === undefined) delete process.env.THINKER_LLM; else process.env.THINKER_LLM = before; });
    const text = lines.join('\n');
    assert.equal(r.warnings, 2);
    assert.match(text, /Retry the rest: thinker phrase/);
    assert.match(text, /Retry this step alone: thinker system propose --refresh/);
    assert.doesNotMatch(text, /Retry with thinker setup --build/);
    lines.length = 0;
    await stepBuildCache({ ...options, noPhrase: true,
      proposeFn: async () => ({ proposals: [{ id: 'p' }], sources: 8, failed: 4, lastError: new Error('over the cap') }) });
    assert.match(lines.join('\n'), /1 behavior drafts; 4 of 8 source notes not read \(over the cap\)\. Retry: thinker system propose --refresh/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('visual formatting helpers: stripAnsi, box, stepBanner', () => {
  const colored = c.bold(c.cyan('hello world'));
  assert.equal(stripAnsi(colored), 'hello world');

  const b = box(['line 1', 'line 2'], { title: 'Test Box', width: 40 });
  assert.match(b, /╭─ Test Box ─+/);
  assert.match(b, /│\s+line 1\s+│/);
  assert.match(b, /│\s+line 2\s+│/);
  assert.match(b, /╰─+╯/);

  const bannerText = banner();
  assert.match(bannerText, /Thinker/);

  const step = stepBanner(1, 3, 'Connect Harness CLIs', 'Test subtitle');
  assert.match(step, /1\/3/);
  assert.match(step, /Connect Harness CLIs/);
  assert.match(step, /Test subtitle/);

  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(90), '1m 30s');
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(1500), '1 KB');
});

test('estimateCacheBuild computes time, size, and storage locations', () => {
  const repo = createMockGitRepo();
  try {
    const est = estimateCacheBuild(repo, { areas: 10, prs: 20 });
    assert.equal(est.repoName, path.basename(repo));
    assert.ok(est.commitCount >= 2);
    assert.ok(est.fileCount >= 2);

    // Storage paths
    assert.match(est.storage.rootDir, /\.thinker/);
    assert.match(est.storage.notesDir, /notes/);
    assert.match(est.storage.prsFile, /prs\.json/);

    // Size range
    assert.ok(est.size.minNotes > 0);
    assert.ok(est.size.maxNotes >= est.size.minNotes);
    assert.match(est.size.notesRange, /notes/);
    assert.match(est.size.bytesRange, /KB/);

    // Timing
    assert.ok(est.timing.totalSeconds > 0);
    assert.ok(est.timing.formatted.length > 0);

    // When skipped with flags
    const estNoSeed = estimateCacheBuild(repo, { areas: 10, prs: 20, noSeed: true, noPrs: true });
    assert.equal(estNoSeed.timing.breakdown.prs, 'skipped');
    assert.equal(estNoSeed.timing.breakdown.exploration, 'skipped');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('findRecentPrChange extracts PR info from commit history', () => {
  const repo = createMockGitRepo();
  try {
    const pr = findRecentPrChange(repo);
    assert.ok(pr, 'Found recent change');
    assert.equal(pr.number, 42);
    assert.match(pr.title, /feat\(api\): add request handler/);
    assert.ok(pr.files.includes('src/api.js'));
    assert.ok(pr.files.includes('src/index.js'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('findRecentPrChange extracts specific prNumber when requested', () => {
  const repo = createMockGitRepo();
  try {
    const pr = findRecentPrChange(repo, { prNumber: 42 });
    assert.ok(pr);
    assert.equal(pr.number, 42);
    assert.ok(pr.files.length >= 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('buildPrBenchmarkTask creates read-only architectural prompt', () => {
  const pr = {
    number: 105,
    title: 'Fix race condition in session refresh',
    body: 'Resolves token expiration collision under high concurrency.',
    files: ['src/session.js', 'src/auth.js'],
  };
  const task = buildPrBenchmarkTask(pr);
  assert.match(task, /PR #105: Fix race condition in session refresh/);
  assert.match(task, /Resolves token expiration collision/);
  assert.match(task, /Identify which specific files and symbols/);
  assert.match(task, /invariants or conventions/);
});

test('renderPrBenchmarkReport formats side-by-side comparison table with target files metric', () => {
  const record = {
    task: 'PR #42: add request handler',
    pr: {
      number: 42,
      title: 'add request handler',
      files: ['src/api.js', 'src/index.js'],
    },
    agent: 'claude',
    model: 'sonnet',
    notes: ['api-endpoints'],
    dir: '/tmp/thinker-benchmark-run',
    runs: {
      baseline: {
        wallMs: 14_000,
        turns: 4,
        toolCalls: 8,
        inputTokens: 12_000,
        outputTokens: 1_200,
        targetFilesFound: 1,
        targetFilesTotal: 2,
      },
      cache: {
        wallMs: 7_000,
        turns: 2,
        toolCalls: 3,
        inputTokens: 4_500,
        outputTokens: 900,
        targetFilesFound: 2,
        targetFilesTotal: 2,
      },
    },
  };

  const report = renderPrBenchmarkReport(record);
  assert.match(report, /PR Change Benchmark Results/);
  assert.match(report, /PR #42: add request handler/);
  assert.match(report, /Wall Time\s+14\.0s\s+7\.0s\s+-50%/);
  assert.match(report, /Agent Turns\s+4\s+2\s+-50%/);
  assert.match(report, /Tool Calls\s+8\s+3\s+-62%/);
  assert.match(report, /Input Tokens\s+12,000\s+4,500\s+-62%/);
  assert.match(report, /Target Files Found\s+1\/2\s+2\/2\s+\+100%/);
  assert.match(report, /Net Savings:\s+7,800 tokens saved · 7s faster/);
});

test('runSetup completes compact setup flow in clean repo', async () => {
  const repo = createMockGitRepo();
  const store = new Store(repo);
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  try {
    await runSetup({
      repo,
      store,
      cliPath: path.resolve('src/cli.js'),
      mcpEntry: { command: 'node', args: ['/path/to/mcp.js'] },
      clients: ['claude'],
      areas: 2,
      prs: 2,
      noSeed: true,
      noBenchmark: true,
      yes: true,
      out,
      checkAuthFn: () => ({ authenticated: true, account: 'test@thinker.dev' }),
      minePrsFn: async () => ({ saved: 0, processed: 0 }),
    });

    const fullOutput = outLines.join('\n');
    assert.match(fullOutput, /thinker/);
    assert.match(fullOutput, /1\/2  Connect your agents/);
    assert.match(fullOutput, /Claude Code\s+Connected/);
    assert.match(fullOutput, /2\/2  Choose how to start/);
    assert.match(fullOutput, /Pre-flight estimates for this repository/);
    assert.match(fullOutput, /Target storage:/);
    assert.match(fullOutput, /Estimated size:/);
    assert.match(fullOutput, /Estimated build:/);
    assert.doesNotMatch(fullOutput, /Optional PR Change Benchmark/);
    assert.doesNotMatch(fullOutput, /PR change benchmark skipped/);
    assert.match(fullOutput, /Thinker is ready\./);

    // Verify .thinker storage on disk
    assert.ok(fs.existsSync(path.join(repo, '.thinker')));
    assert.ok(fs.existsSync(path.join(repo, '.thinker', 'notes')));
    // the hooks go into the user's own settings, for every checkout
    assert.ok(fs.existsSync(path.join(process.env.HOME, '.claude', 'settings.json')));
    assert.ok(!fs.existsSync(path.join(repo, '.claude')));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// The local page opens once, after the first setup of a repository; running setup again leaves it closed.
test('runSetup opens the local page after a repository\'s first setup only', async () => {
  const repo = createMockGitRepo();
  const opened = [];
  const run = () => runSetup({
    repo,
    store: new Store(repo),
    cliPath: path.resolve('src/cli.js'),
    mcpEntry: { command: 'node', args: ['/path/to/mcp.js'] },
    clients: ['claude'],
    build: false,
    noSeed: true,
    noPrs: true,
    noBenchmark: true,
    behaviors: false,
    yes: true,
    out: () => {},
    dashboard: true,
    openDashboardFn: o => { opened.push(o); return true; },
  });
  try {
    await run();
    assert.deepEqual(opened.map(o => o.repo), [repo]);
    await run();
    assert.equal(opened.length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('runSetup mines git history when GitHub origin is unavailable', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-setup-gitmine-')));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repo });

  for (let i = 1; i <= 6; i++) {
    fs.writeFileSync(path.join(repo, `file${i}.js`), `export const v${i} = ${i};\n`);
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['commit', '-m', `commit ${i} description`, '-q'], { cwd: repo });
  }

  const est = estimateCacheBuild(repo, { prs: 10, noPrs: false, slug: null });
  assert.equal(est.canMine, true);
  assert.equal(est.mineSource, 'git');

  const store = new Store(repo);
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));
  let minedPrsArgs = null;

  try {
    await runSetup({
      repo,
      store,
      cliPath: path.resolve('src/cli.js'),
      mcpEntry: { command: 'node', args: ['/path/to/mcp.js'] },
      clients: ['claude'],
      areas: 2,
      prs: 10,
      noSeed: true,
      noBenchmark: true,
      yes: true,
      out,
      // mining needs an authenticated agent; do not depend on this machine's real login state
      checkAuthFn: () => ({ authenticated: true, account: 'test@thinker.dev' }),
      minePrsFn: async (slug, opts) => {
        minedPrsArgs = { slug, opts };
        return { saved: 3 };
      },
    });

    const fullOutput = outLines.join('\n');
    assert.match(fullOutput, /\[1\/2\] Mining merged changes from git history \(GitHub CLI unavailable\)\.\.\./);
    assert.match(fullOutput, /Mined git history changes → 3 notes created/);
    assert.equal(minedPrsArgs.slug, null);
    assert.equal(minedPrsArgs.opts.limit, 10);
    assert.equal(minedPrsArgs.opts.repo, repo);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('runSetup wires the repository up and leaves the cache unbuilt when no agent is authenticated', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-test-setup-halt-'));
  execFileSync('git', ['init', repo]);
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'index.js'), 'export function hello() { return "world"; }\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repo });

  const store = new Store(repo);
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  try {
    const res = await runSetup({
      repo,
      store,
      cliPath: path.resolve('src/cli.js'),
      mcpEntry: { command: 'node', args: ['/path/to/mcp.js'] },
      clients: ['claude'],
      areas: 2,
      prs: 2,
      noSeed: false,
      noPrs: true,
      noBenchmark: true,
      agent: 'nonexistent-agent',
      yes: true,
      out,
    });

    assert.equal(res.built, false);
    assert.ok(res.error);
    const fullOut = outLines.join('\n');
    assert.match(fullOut, /Requested agent "nonexistent-agent" is not installed/);
    // the repository is set up either way: the wiring is done and the footer is reached
    assert.match(fullOut, /Cache not built here/);
    assert.match(fullOut, /thinker setup --build/);
    assert.match(fullOut, /Thinker is ready\./);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('setup offers the cache build and takes no for an answer outside a terminal', async () => {
  const repo = createMockGitRepo();
  const store = new Store(repo);
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));
  try {
    const res = await runSetup({
      repo,
      store,
      cliPath: path.resolve('src/cli.js'),
      mcpEntry: { command: 'node', args: ['/path/to/mcp.js'] },
      clients: ['claude'],
      areas: 2,
      prs: 2,
      noBenchmark: true,
      out,
      // no `build` and no `yes`: the question is asked, and tests are not a terminal
      seedFn: async () => { throw new Error('must not explore without an answer'); },
      minePrsFn: async () => { throw new Error('must not mine without an answer'); },
      checkAuthFn: () => { throw new Error('must not ask for a login for a build nobody asked for'); },
    });
    const fullOut = outLines.join('\n');
    assert.equal(res.built, false);
    assert.match(fullOut, /Build the cache from this repository now\?/);
    assert.match(fullOut, /Not a terminal/);
    assert.match(fullOut, /Thinker is ready\./);
    // wiring and the free part of the cache still happened
    assert.ok(fs.existsSync(path.join(process.env.HOME, '.claude', 'settings.json')), 'the agents are wired up, in the user\'s own settings');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('getAgentDisplayName, getAgentLoginCommand, and getAgentLoginArgs return expected metadata', () => {
  assert.equal(getAgentDisplayName('claude'), 'Claude Code');
  assert.equal(getAgentDisplayName('codex'), 'Codex CLI');
  assert.equal(getAgentDisplayName('cursor'), 'Cursor Agent');
  assert.equal(getAgentDisplayName('gemini', '/path/to/agy'), 'Antigravity (agy)');
  assert.equal(getAgentDisplayName('gemini', '/path/to/gemini'), 'Gemini CLI');

  assert.equal(getAgentLoginCommand('claude'), 'claude auth login');
  assert.equal(getAgentLoginCommand('codex'), 'codex login');
  assert.equal(getAgentLoginCommand('cursor'), 'agent login');
  assert.equal(getAgentLoginCommand('cursor', '/usr/bin/cursor-agent'), 'cursor-agent login');
  assert.equal(getAgentLoginCommand('gemini', '/usr/bin/agy'), 'agy');
  assert.equal(getAgentLoginCommand('gemini', '/usr/bin/gemini'), 'gemini');

  assert.deepEqual(getAgentLoginArgs('claude'), ['claude', 'auth', 'login']);
  assert.deepEqual(getAgentLoginArgs('codex'), ['codex', 'login']);
  assert.deepEqual(getAgentLoginArgs('cursor'), ['agent', 'login']);
  assert.deepEqual(getAgentLoginArgs('gemini', '/usr/bin/agy'), ['/usr/bin/agy']);
});

test('checkAgentAuth checks Claude authentication correctly', () => {
  const mockSpawnAuthed = (bin, args) => {
    assert.deepEqual(args, ['auth', 'status']);
    return { status: 0, stdout: JSON.stringify({ loggedIn: true, email: 'dev@example.com' }) };
  };
  const resAuthed = checkAgentAuth('claude', { spawnFn: mockSpawnAuthed });
  assert.equal(resAuthed.authenticated, true);
  assert.equal(resAuthed.account, 'dev@example.com');
  assert.match(resAuthed.details, /Signed in as dev@example\.com/);

  const mockSpawnUnauthed = () => {
    return { status: 0, stdout: JSON.stringify({ loggedIn: false }) };
  };
  const resUnauthed = checkAgentAuth('claude', { spawnFn: mockSpawnUnauthed });
  assert.equal(resUnauthed.authenticated, false);
  assert.equal(resUnauthed.details, 'Not signed in');
  assert.equal(resUnauthed.loginCmd, 'claude auth login');

  const mockSpawnTimeout = () => {
    return { error: { code: 'ETIMEDOUT' } };
  };
  const resTimeout = checkAgentAuth('claude', { spawnFn: mockSpawnTimeout });
  assert.equal(resTimeout.authenticated, false);
  assert.equal(resTimeout.details, 'Auth check timed out');
});

test('checkAgentAuth checks Codex authentication correctly', () => {
  const mockSpawnAuthed = () => {
    return { status: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
  };
  const resAuthed = checkAgentAuth('codex', { spawnFn: mockSpawnAuthed });
  assert.equal(resAuthed.authenticated, true);
  assert.match(resAuthed.details, /Logged in using ChatGPT/);

  const mockSpawnUnauthed = () => {
    return { status: 0, stdout: 'Not logged in\n' };
  };
  const resUnauthed = checkAgentAuth('codex', { spawnFn: mockSpawnUnauthed });
  assert.equal(resUnauthed.authenticated, false);
  assert.equal(resUnauthed.loginCmd, 'codex login');
});

test('checkAgentAuth checks Cursor authentication correctly', () => {
  const mockSpawnAuthed = () => {
    return {
      status: 0,
      stdout: JSON.stringify({
        status: 'authenticated',
        isAuthenticated: true,
        userInfo: { email: 'cursor-dev@example.com' },
      }),
    };
  };
  const resAuthed = checkAgentAuth('cursor', { spawnFn: mockSpawnAuthed });
  assert.equal(resAuthed.authenticated, true);
  assert.equal(resAuthed.account, 'cursor-dev@example.com');

  const mockSpawnUnauthed = () => {
    return {
      status: 0,
      stdout: JSON.stringify({ status: 'unauthenticated', isAuthenticated: false }),
    };
  };
  const resUnauthed = checkAgentAuth('cursor', { spawnFn: mockSpawnUnauthed });
  assert.equal(resUnauthed.authenticated, false);
  assert.match(resUnauthed.loginCmd, /login/);
});

test('checkAgentAuth checks Gemini authentication correctly', () => {
  const resEnv = checkAgentAuth('gemini', { env: { GEMINI_API_KEY: 'test-key-123' } });
  assert.equal(resEnv.authenticated, true);
  assert.match(resEnv.details, /GEMINI_API_KEY/);

  const mockSpawnAgy = () => {
    return { status: 0, stdout: 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' };
  };
  const resAgy = checkAgentAuth('gemini', { spawnFn: mockSpawnAgy, env: {} });
  assert.equal(resAgy.authenticated, true);

  const mockSpawnAgyUnauthed = () => {
    return { status: 0, stdout: 'Error: Please sign in to view available models.\n' };
  };
  const resAgyUnauthed = checkAgentAuth('gemini', { spawnFn: mockSpawnAgyUnauthed, env: {} });
  assert.equal(resAgyUnauthed.authenticated, false);
  assert.equal(resAgyUnauthed.loginCmd, 'agy');
});

test('selectAndAuthenticateAgent handles explicit requestedAgent', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    return { agent, installed: true, authenticated: true, account: 'explicit@test.com' };
  };

  const res = await selectAndAuthenticateAgent({
    requestedAgent: 'codex',
    yes: true,
    out,
    checkAuthFn: mockCheckAuth,
  });

  assert.equal(res.ok, true);
  assert.equal(res.agent, 'codex');
  assert.match(outLines.join('\n'), /Codex CLI is authenticated/);
});

test('selectAndAuthenticateAgent prompts user when multiple agents installed in interactive mode', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    return {
      agent,
      installed: true,
      authenticated: true,
      account: `${agent}@test.com`,
    };
  };

  const mockReadline = () => ({
    question: async (prompt) => '2',
    close: () => {},
  });

  const res = await selectAndAuthenticateAgent({
    yes: false,
    out,
    checkAuthFn: mockCheckAuth,
    readlineFn: mockReadline,
  });

  assert.equal(res.ok, true);
  assert.ok(res.agent);
  const fullOut = outLines.join('\n');
  assert.match(fullOut, /Available agents to build the knowledge cache:/);
  assert.match(fullOut, /Signed in/);
});

test('selectAndAuthenticateAgent asks unauthenticated user to sign in and re-checks', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  let callCount = 0;
  const mockCheckAuth = (agent) => {
    callCount++;
    return {
      agent,
      installed: true,
      authenticated: callCount > 1,
      loginCmd: `${agent} login`,
    };
  };

  let execCalled = false;
  const mockExecFile = (cmd, args) => {
    execCalled = true;
  };

  const mockReadline = () => ({
    question: async (prompt) => 'Y',
    close: () => {},
  });

  const res = await selectAndAuthenticateAgent({
    requestedAgent: 'claude',
    yes: false,
    out,
    checkAuthFn: mockCheckAuth,
    execFileFn: mockExecFile,
    readlineFn: mockReadline,
  });

  assert.equal(res.ok, true);
  assert.equal(res.agent, 'claude');
  assert.equal(execCalled, true);
  assert.match(outLines.join('\n'), /Successfully authenticated with Claude Code!/);
});

test('selectAndAuthenticateAgent allows switching to another signed-in agent if sign-in declined', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    if (agent === 'codex') {
      return { agent, installed: true, authenticated: true, account: 'codex@example.com' };
    }
    return { agent, installed: true, authenticated: false, loginCmd: `${agent} auth login` };
  };

  let promptStep = 0;
  const mockReadline = () => ({
    question: async (prompt) => {
      promptStep++;
      if (promptStep === 1) return 'n'; // Decline sign in to claude
      if (promptStep === 2) return 'codex'; // Explicitly choose codex from alternatives
      return 'n';
    },
    close: () => {},
  });

  const res = await selectAndAuthenticateAgent({
    requestedAgent: 'claude',
    yes: false,
    out,
    checkAuthFn: mockCheckAuth,
    readlineFn: mockReadline,
  });

  assert.equal(res.ok, true);
  assert.equal(res.agent, 'codex');
  assert.match(outLines.join('\n'), /Switched to Codex CLI/);
});

test('selectAndAuthenticateAgent pauses setup when user declines sign-in and chooses exit', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    return { agent, installed: true, authenticated: false, loginCmd: `${agent} login` };
  };

  let promptStep = 0;
  const mockReadline = () => ({
    question: async (prompt) => {
      promptStep++;
      if (promptStep === 1) return 'n'; // Decline sign in
      return 'e'; // Choose exit
    },
    close: () => {},
  });

  const res = await selectAndAuthenticateAgent({
    requestedAgent: 'claude',
    yes: false,
    out,
    checkAuthFn: mockCheckAuth,
    readlineFn: mockReadline,
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'cancelled');
  assert.match(outLines.join('\n'), /Exit requested by user/);
});

test('selectAndAuthenticateAgent allows proceeding without exploration when the user elects to', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    return { agent, installed: true, authenticated: false, loginCmd: `${agent} login` };
  };

  let promptStep = 0;
  const mockReadline = () => ({
    question: async (prompt) => {
      promptStep++;
      if (promptStep === 1) return 'n'; // Decline sign in
      return 'y'; // Accept proceeding without exploration
    },
    close: () => {},
  });

  const res = await selectAndAuthenticateAgent({
    requestedAgent: 'claude',
    yes: false,
    out,
    checkAuthFn: mockCheckAuth,
    readlineFn: mockReadline,
    allowSkip: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.skipExploration, true);
  assert.match(outLines.join('\n'), /Proceeding with subsystem exploration skipped/);
});

test('selectAndAuthenticateAgent non-interactive errors instead of auto-fallback when chosen agent is unauthenticated', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    if (agent === 'codex') {
      return { agent, installed: true, authenticated: true, account: 'codex@test.com' };
    }
    return { agent, installed: true, authenticated: false, loginCmd: `${agent} auth login` };
  };

  const res = await selectAndAuthenticateAgent({
    requestedAgent: 'claude',
    yes: true,
    out,
    checkAuthFn: mockCheckAuth,
    allowSkip: false,
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'unauthenticated');
  assert.equal(res.agent, 'claude');
  assert.match(outLines.join('\n'), /The selected tool \(Claude Code\) is not signed in/);
});

test('selectAndAuthenticateAgent non-interactive halts when allowSkip is false and no agent authenticated', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    return { agent, installed: true, authenticated: false, loginCmd: `${agent} login` };
  };

  const res = await selectAndAuthenticateAgent({
    requestedAgent: 'claude',
    yes: true,
    out,
    checkAuthFn: mockCheckAuth,
    allowSkip: false,
  });

  assert.equal(res.ok, false);
  assert.equal(res.error, 'unauthenticated');
  assert.match(outLines.join('\n'), /Authentication required/);
  assert.match(outLines.join('\n'), /The selected tool \(Claude Code\) is not signed in/);
});

test('selectAndAuthenticateAgent non-interactive skips exploration when allowSkip is true and no agent authenticated', async () => {
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    return { agent, installed: true, authenticated: false, loginCmd: `${agent} login` };
  };

  const res = await selectAndAuthenticateAgent({
    requestedAgent: 'claude',
    yes: true,
    out,
    checkAuthFn: mockCheckAuth,
    allowSkip: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.skipExploration, true);
  assert.match(outLines.join('\n'), /Proceeding with subsystem exploration skipped/);
});

test('isAuthError and cleanErrorMessage correctly identify and format auth failure messages', () => {
  const claudeRawErr = new Error(
    'claude exited 1: {"type":"result","subtype":"success","is_error":true,"api_error_status":null,"duration_ms":238,"duration_api_ms":0,"num_turns":1,"result":"Not logged in · Please run /login","stop_reason":"stop_sequence","session_id":"a69454ff-5796-4961-8602-2bbd52bb8b97","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation":{"ephemeral'
  );
  assert.equal(isAuthError(claudeRawErr), true);
  assert.equal(cleanErrorMessage(claudeRawErr), 'Not logged in · Please run /login');

  const codexErr = new Error('Codex run failed: {"error":"401 Unauthorized"}');
  assert.equal(isAuthError(codexErr), true);

  const geminiErr = new Error('Gemini run failed: {"error":{"message":"Please sign in to continue"}}');
  assert.equal(isAuthError(geminiErr), true);
  assert.equal(cleanErrorMessage(geminiErr), 'Please sign in to continue');

  const genericErr = new Error('File not found: math.js');
  assert.equal(isAuthError(genericErr), false);
  assert.equal(cleanErrorMessage(genericErr), 'File not found: math.js');
});

test('stepPrBenchmark non-interactive skips benchmark when no agent authenticated without throwing error', async () => {
  const repo = createMockGitRepo();
  const store = new Store(repo).init();
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = () => ({
    installed: true,
    authenticated: false,
    loginCmd: 'claude auth login',
  });

  try {
    const res = await stepPrBenchmark({
      repo,
      store,
      benchmarkFlag: true,
      yes: true,
      out,
      checkAuthFn: mockCheckAuth,
    });

    assert.equal(res, null);
    const fullOut = outLines.join('\n');
    assert.match(fullOut, /is not signed in/);
    assert.match(fullOut, /Benchmark skipped/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('stepPrBenchmark interactive prompts user to sign in and switches to alternative when declined', async () => {
  const repo = createMockGitRepo();
  const store = new Store(repo).init();
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => {
    if (agent === 'codex') {
      return { agent, installed: true, authenticated: true, account: 'dev@test.com' };
    }
    return { agent, installed: true, authenticated: false, loginCmd: `${agent} auth login` };
  };

  let promptStep = 0;
  const mockReadline = () => ({
    question: async () => {
      promptStep++;
      if (promptStep === 1) return 'n'; // Decline sign in to claude
      if (promptStep === 2) return 'codex'; // Choose codex from alternatives
      return 'y';
    },
    close: () => {},
  });

  const mockRunBenchmark = async (agent) => {
    assert.equal(agent, 'codex');
    return {
      wallMs: 5000,
      turns: 2,
      toolCalls: 3,
      inputTokens: 1000,
      outputTokens: 200,
      answer: 'Mock answer',
    };
  };

  try {
    const res = await stepPrBenchmark({
      repo,
      store,
      agent: 'claude',
      benchmarkFlag: true,
      yes: false,
      out,
      checkAuthFn: mockCheckAuth,
      readlineFn: mockReadline,
      runBenchmarkFn: mockRunBenchmark,
    });

    assert.ok(res);
    assert.equal(res.agent, 'codex');
    const fullOut = outLines.join('\n');
    assert.match(fullOut, /Switched to Codex CLI/);
    assert.match(fullOut, /Running paired benchmark with Codex CLI/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('stepPrBenchmark catches runtime auth errors from runBenchmarkAgent and reports actionable login command', async () => {
  const repo = createMockGitRepo();
  const store = new Store(repo).init();
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = () => ({
    installed: true,
    authenticated: true,
    loginCmd: 'claude auth login',
  });

  const mockRunBenchmarkFailsAuth = async () => {
    throw new Error(
      'claude exited 1: {"type":"result","subtype":"success","is_error":true,"api_error_status":null,"duration_ms":238,"duration_api_ms":0,"num_turns":1,"result":"Not logged in · Please run /login","stop_reason":"stop_sequence","session_id":"a69454ff-5796-4961-8602-2bbd52bb8b97","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation":{"ephemeral'
    );
  };

  try {
    const res = await stepPrBenchmark({
      repo,
      store,
      agent: 'claude',
      benchmarkFlag: true,
      yes: true,
      out,
      checkAuthFn: mockCheckAuth,
      runBenchmarkFn: mockRunBenchmarkFailsAuth,
    });

    assert.equal(res, null); // Gracefully returns null, does not crash!
    const fullOut = outLines.join('\n');
    assert.match(fullOut, /Benchmark stopped: .* reported an authentication issue/);
    assert.match(fullOut, /Not logged in · Please run \/login/);
    assert.match(fullOut, /claude auth login/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

class MockTTYStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
  }
  setRawMode(v) { this.isRaw = v; }
  resume() {}
  pause() {}
}

class MockTTYStdout {
  constructor() {
    this.isTTY = true;
    this.writes = [];
  }
  write(str) { this.writes.push(str); }
}

test('estimateCacheBuild calculates bigger, realistic timing estimates', () => {
  const repo = createMockGitRepo();
  try {
    const est = estimateCacheBuild(repo, { areas: 12, prs: 40, agent: 'claude' });
    // In mock repo with 1 discovered area and commitCount <= 5 (no git PR mining):
    // 1 area * 55s + 8s indexing = 63s (compared to old ~15s)
    assert.ok(est.timing.totalSeconds >= 60, `Expected totalSeconds >= 60, got ${est.timing.totalSeconds}`);
    if (est.canMine) {
      assert.match(est.timing.breakdown.prs, /[ms]/);
    }
    if (est.canSeed) {
      assert.match(est.timing.breakdown.exploration, /[ms]/);
    }
    assert.match(est.timing.breakdown.indexing, /s/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('selectMenu navigates options with arrow keys and selects with Enter in TTY mode', async () => {
  const stdin = new MockTTYStdin();
  const stdout = new MockTTYStdout();

  const promise = selectMenu({
    header: 'Select an agent:',
    items: [
      { label: 'Claude Code', value: 'claude', key: '1' },
      { label: 'Codex CLI', value: 'codex', key: '2' },
      { label: 'Cursor Agent', value: 'cursor', key: '3' },
    ],
    defaultIndex: 0,
    stdin,
    stdout,
  });

  // Navigate down to Codex CLI, then hit Enter
  stdin.emit('keypress', null, { name: 'down' });
  stdin.emit('keypress', null, { name: 'return' });

  const res = await promise;
  assert.ok(res);
  assert.equal(res.value, 'codex');
  assert.equal(res.label, 'Codex CLI');
});

test('selectMenu wraps around when navigating up past the top or down past the bottom', async () => {
  const stdin = new MockTTYStdin();
  const stdout = new MockTTYStdout();

  const promise = selectMenu({
    items: [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
      { label: 'Option C', value: 'c' },
    ],
    defaultIndex: 0,
    stdin,
    stdout,
  });

  // Up from index 0 wraps to Option C (last item)
  stdin.emit('keypress', null, { name: 'up' });
  stdin.emit('keypress', null, { name: 'return' });

  const res = await promise;
  assert.ok(res);
  assert.equal(res.value, 'c');
});

test('selectMenu supports direct shortcut keys in interactive mode', async () => {
  const stdin = new MockTTYStdin();
  const stdout = new MockTTYStdout();

  const promise = selectMenu({
    items: [
      { label: 'Option A', value: 'a', key: '1' },
      { label: 'Option B', value: 'b', key: '2' },
      { label: 'Skip Option', value: 'skip', key: 's' },
      { label: 'Exit Option', value: 'exit', key: 'e' },
    ],
    defaultIndex: 0,
    stdin,
    stdout,
  });

  // Pressing 's' directly selects skip
  stdin.emit('keypress', 's', { name: 's' });

  const res = await promise;
  assert.ok(res);
  assert.equal(res.value, 'skip');
});

test('selectAndAuthenticateAgent uses arrow key navigation when stdin is interactive TTY', async () => {
  const stdin = new MockTTYStdin();
  const stdout = new MockTTYStdout();
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  const mockCheckAuth = (agent) => ({
    agent,
    installed: true,
    authenticated: true,
    account: 'user@example.com',
  });

  const promise = selectAndAuthenticateAgent({
    yes: false,
    out,
    checkAuthFn: mockCheckAuth,
    stdin,
    stdout,
  });

  // Move down once to select the second installed agent
  stdin.emit('keypress', null, { name: 'down' });
  stdin.emit('keypress', null, { name: 'return' });

  const res = await promise;
  assert.ok(res.ok);
  assert.ok(res.agent);
  assert.match(outLines.join('\n'), /Available agents to build the knowledge cache:/);
  assert.match(outLines.join('\n'), /Selected agent:/);
});

test('a shallow build is 30% of the full one: areas and pull requests, rounded up, at least one', () => {
  const repo = createMockGitRepo();
  try {
    for (let i = 0; i < 12; i++) {
      fs.mkdirSync(path.join(repo, `pkg${i}`));
      fs.writeFileSync(path.join(repo, `pkg${i}`, 'index.js'), `export const v${i} = ${i};\n`.repeat(400));
    }
    execFileSync('git', ['add', '.'], { cwd: repo }); execFileSync('git', ['commit', '-qm', 'packages'], { cwd: repo });
    const full = depthLimits(repo, { depth: 'full', areas: undefined, prs: 60 });
    assert.deepEqual(full, { areas: undefined, prs: 60 }, 'full leaves the build to determine itself');
    const fullAreas = estimateCacheBuild(repo, { prs: 60 }).candidateAreasCount;
    const shallow = depthLimits(repo, { depth: 'shallow', areas: undefined, prs: 60 });
    assert.equal(shallow.prs, 18);
    assert.equal(shallow.areas, Math.max(1, Math.ceil(fullAreas * 0.3)));
    assert.ok(shallow.areas <= fullAreas);
    assert.deepEqual(depthLimits(repo, { depth: 'shallow', areas: 0, prs: 0 }), { areas: 0, prs: 0 }, 'nothing to build stays nothing');
    assert.equal(depthLimits(repo, { depth: 'shallow', areas: 2, prs: 1 }).prs, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('the spinner draws nothing off a terminal and the finish box says whether setup is done', () => {
  const written = [];
  const stream = { isTTY: false, write: s => { written.push(s); return true; } };
  const spin = spinner('Working', { stream });
  assert.equal(spin.active, false);
  spin.set('Still working');
  spin.stop('done line');
  assert.deepEqual(written, ['done line\n']);
  assert.match(stripAnsi(finishBox(['Thinker is ready.'])), /Setup complete[\s\S]*Thinker is ready\./);
  assert.match(stripAnsi(finishBox(['x'], { ok: false })), /Setup finished with items to review/);
});

test('on a terminal the spinner redraws in place and gives the stream back when stopped', () => {
  const written = [];
  const stream = { isTTY: true, columns: 80, write(s) { written.push(String(s)); return true; } };
  const original = stream.write;
  const spin = spinner('Fetching', { stream, enabled: true });
  assert.equal(spin.active, true);
  stream.write('another line\n');
  spin.stop('✓ Fetched');
  assert.equal(stream.write, original);
  const text = written.join('');
  assert.match(stripAnsi(text), /Fetching/);
  assert.match(text, /\r\x1b\[2K/, 'the line is cleared before other output');
  assert.ok(text.indexOf('another line') < text.indexOf('✓ Fetched'));
});
