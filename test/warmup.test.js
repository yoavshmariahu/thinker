import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { headless, SHOWN, PICKED } from '../src/commands/warmup.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
test('ten rows, the top five picked; a machine without a display is not offered the browser: ssh, or linux with no DISPLAY', () => {
  assert.equal(SHOWN, 10); assert.equal(PICKED, 5);
  assert.equal(headless({ SSH_CONNECTION: '1.2.3.4 22' }, 'darwin'), true);
  assert.equal(headless({}, 'linux'), true);
  assert.equal(headless({ DISPLAY: ':0' }, 'linux'), false);
  assert.equal(headless({}, 'darwin'), false);
});

// A fresh machine: a git repository with no merged pull requests, no agent session records, piped stdin.
const machine = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-warmup-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: repo });
  const env = { ...process.env, HOME: dir, THINKER_HOME: path.join(dir, 'home'), THINKER_TELEMETRY: 'off', THINKER_LOG: 'off', THINKER_NO_LEARN: '1', CODEX_HOME: path.join(dir, '.codex'), NO_COLOR: '1' };
  delete env.CLAUDE_CONFIG_DIR; delete env.SSH_CONNECTION; delete env.SSH_TTY; delete env.SSH_CLIENT;
  const run = (args, input = '') => spawnSync(process.execPath, [CLI, 'warmup', ...args], { cwd: repo, env, encoding: 'utf8', input, timeout: 60_000 });
  return { dir, repo, run };
};

test('--skip and a pipe with no answer say how to come back; --browser --dry says what it would open', t => {
  const { run } = machine(t);
  const skip = run(['--skip']);
  assert.equal(skip.status, 0, skip.stderr);
  assert.match(skip.stdout, /Skipped/); assert.match(skip.stdout, /thinker warmup/); assert.match(skip.stdout, /thinker ui/);
  const quiet = run([]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /thinker warmup/);
  assert.ok(!/Repositories to warm up/.test(quiet.stdout), 'nothing is asked of a pipe');
  const browser = run(['--browser', '--dry']);
  assert.match(browser.stdout, /would open: thinker ui --from-setup --tab warmup/);
});

test('in the terminal the current repository is listed; one with no merged pull requests is not built, and says so', t => {
  const { repo, run } = machine(t);
  const r = run(['--terminal', '--dry'], 'y\n');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, new RegExp(`\\[ \\] ${path.basename(repo)}`));
  assert.match(r.stdout, /no merged pull requests to read/);
  assert.match(r.stdout, /Nothing to warm up/);
  assert.ok(!/Warm up the/.test(r.stdout), 'nothing picked, nothing asked');
  assert.ok(!/would run/.test(r.stdout));
  // --yes takes the picked ones: none here
  const yes = run(['--yes', '--dry']);
  assert.match(yes.stdout, /Nothing to warm up/);
  // --repos names one that is not on the list
  const named = run(['--repos', 'nope', '--dry']);
  assert.equal(named.status, 1);
  assert.match(named.stdout, /Not on this machine's list: nope/);
  // the cache is not created by looking
  assert.ok(!fs.existsSync(path.join(repo, '.thinker', 'notes')) || fs.readdirSync(path.join(repo, '.thinker', 'notes')).length === 0);
});
