import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postComment, MARKER } from '../src/review-post.js';
import { commands } from '../src/commands/cache.js';

const report = {
  scope: 'branch since main', counts: { error: 1, warning: 0, info: 0 },
  notes: { consulted: 1 },
  findings: [{ severity: 'error', file: 'src/a.js', line: 12, inChange: true,
    message: 'Guard missing `check()` $(touch unwanted)', evidence: 'return unsafe()',
    locations: [{ file: 'src/b.js', line: 9, inChange: true, message: 'Same guard missing', severity: 'error' }] }],
};

test('gh comment includes all inline findings and sends literal Markdown over stdin', () => {
  let calls = 0;
  const result = postComment(report, { repo: '/checkout', pr: '42', run: (command, args, opts) => {
    calls++;
    assert.equal(command, 'gh');
    assert.deepEqual(args, ['pr', 'comment', '42', '--body-file', '-']);
    assert.equal(opts.cwd, '/checkout');
    assert.equal(opts.shell, undefined);
    assert.ok(opts.input.startsWith(MARKER));
    assert.match(opts.input, /src\/a.js:12/);
    assert.match(opts.input, /src\/b.js:9/);
    assert.ok(opts.input.includes('$(touch unwanted)'));
    assert.match(opts.input, /return unsafe\(\)/);
    assert.doesNotMatch(opts.input, /posted inline/);
    return 'https://github.com/o/r/pull/42#issuecomment-1\n';
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { posted: true, url: 'https://github.com/o/r/pull/42#issuecomment-1' });
});

test('explicit posting includes clean reports', () => {
  postComment({ counts: { error: 0, warning: 0, info: 0 }, notes: { consulted: 1 } }, {
    pr: 42, run: (_command, _args, opts) => {
      assert.match(opts.input, /0 errors, 0 warnings, 0 info/);
      return 'url';
    },
  });
});

test('invalid PRs and dry posting are rejected before review or subprocesses', async () => {
  for (const pr of [undefined, true, '-1', '--web', '0', 'abc']) {
    assert.throws(() => postComment(report, { pr, run: () => assert.fail('must not run') }), /requires --pr/);
    await assert.rejects(commands.review({ flags: { post: true, pr } }), /requires --pr/);
  }
  await assert.rejects(commands.review({ flags: { post: true, pr: '42', dry: true } }), /cannot be combined with --dry/);
});

test('missing gh and authentication errors are surfaced', () => {
  assert.throws(() => postComment(report, { pr: 42, run: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } }), /install GitHub CLI and run gh auth login/);
  assert.throws(() => postComment(report, { pr: 42, run: () => { throw Object.assign(new Error('failed'), { stderr: 'authentication required' }); } }), /Could not post PR comment through gh: authentication required/);
});

test('CLI posts through a fake gh, preserves JSON, and does not post without --post', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-comment-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const env = { ...process.env, THINKER_TEST: '1', THINKER_TELEMETRY: 'off', THINKER_LOG: 'off' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env, stdio: 'pipe' });
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'initial');
  const { Store } = await import('../src/store.js');
  new Store(repo).init();
  const bin = path.join(repo, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst fs = require('fs'); fs.writeFileSync('posted.json', JSON.stringify({ args: process.argv.slice(2), body: fs.readFileSync(0, 'utf8') })); console.log('https://github.com/o/r/pull/42#issuecomment-1');\n`, { mode: 0o755 });
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, 'review', '--repo', repo, '--pr', '42', '--json', ...args], { cwd: repo, env, encoding: 'utf8' }));
  run('src/');
  assert.equal(fs.existsSync(path.join(repo, 'posted.json')), false);
  const result = run('--post', 'src/');
  assert.equal(result.comment.posted, true);
  assert.match(result.comment.url, /issuecomment-1$/);
  const posted = JSON.parse(fs.readFileSync(path.join(repo, 'posted.json'), 'utf8'));
  assert.deepEqual(posted.args, ['pr', 'comment', '42', '--body-file', '-']);
  assert.match(posted.body, /Nothing to review/);
});
