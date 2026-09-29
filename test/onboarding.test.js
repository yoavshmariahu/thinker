import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
  runOnboarding,
} from '../src/onboarding.js';

function createMockGitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-onboard-test-')));
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

test('visual formatting helpers: stripAnsi, box, stepBanner', () => {
  const colored = c.bold(c.cyan('hello world'));
  assert.equal(stripAnsi(colored), 'hello world');

  const b = box(['line 1', 'line 2'], { title: 'Test Box', width: 40 });
  assert.match(b, /╭─ Test Box ─+/);
  assert.match(b, /│\s+line 1\s+│/);
  assert.match(b, /│\s+line 2\s+│/);
  assert.match(b, /╰─+╯/);

  const bannerText = banner();
  assert.match(bannerText, /T H I N K E R/);

  const step = stepBanner(1, 3, 'Connect Harness CLIs', 'Test subtitle');
  assert.match(step, /STEP 1 OF 3/);
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
    assert.match(est.storage.cochangeFile, /cochange\.json/);
    assert.match(est.storage.prsFile, /prs\.json/);

    // Size range
    assert.ok(est.size.minNotes > 0);
    assert.ok(est.size.maxNotes >= est.size.minNotes);
    assert.match(est.size.notesRange, /notes/);
    assert.match(est.size.bytesRange, /KB/);

    // Timing
    assert.ok(est.timing.totalSeconds > 0);
    assert.ok(est.timing.formatted.length > 0);
    assert.ok(est.timing.breakdown.cochange.length > 0);

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
  assert.match(task, /invariants, conventions, or co-change patterns/);
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

test('runOnboarding completes 3-step onboarding flow in clean repo', async () => {
  const repo = createMockGitRepo();
  const store = new Store(repo);
  const outLines = [];
  const out = line => outLines.push(stripAnsi(line));

  try {
    await runOnboarding({
      repo,
      store,
      cliPath: path.resolve('src/cli.js'),
      mcpEntry: { command: 'node', args: ['/path/to/mcp.js'] },
      clients: ['claude'],
      areas: 2,
      prs: 2,
      noSeed: true,
      noPrs: true,
      noBenchmark: true,
      yes: true,
      out,
    });

    const fullOutput = outLines.join('\n');
    assert.match(fullOutput, /T H I N K E R/);
    assert.match(fullOutput, /STEP 1 OF 3 · Connect Harness CLIs/);
    assert.match(fullOutput, /Claude Code\s+Connected/);
    assert.match(fullOutput, /STEP 2 OF 3 · Build Knowledge Cache/);
    assert.match(fullOutput, /Pre-flight estimates for this repository/);
    assert.match(fullOutput, /Target storage:/);
    assert.match(fullOutput, /Estimated size:/);
    assert.match(fullOutput, /Estimated build:/);
    assert.match(fullOutput, /STEP 3 OF 3 · Optional PR Change Benchmark/);
    assert.match(fullOutput, /PR change benchmark skipped/);
    assert.match(fullOutput, /Thinker Onboarding Complete!/);

    // Verify .thinker storage on disk
    assert.ok(fs.existsSync(path.join(repo, '.thinker')));
    assert.ok(fs.existsSync(path.join(repo, '.thinker', 'notes')));
    assert.ok(fs.existsSync(path.join(repo, '.thinker', 'cochange.json')));
    assert.ok(fs.existsSync(path.join(repo, '.claude', 'settings.json')));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
