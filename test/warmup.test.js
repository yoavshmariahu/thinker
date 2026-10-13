import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { headless, SHOWN, PICKED } from '../src/commands/warmup.js';
import { multiSelect } from '../src/setup/ui.js';

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
  assert.match(named.stdout, /Not a git repository on this machine: nope/);
  // the cache is not created by looking
  assert.ok(!fs.existsSync(path.join(repo, '.thinker', 'notes')) || fs.readdirSync(path.join(repo, '.thinker', 'notes')).length === 0);
});

class TtyIn extends EventEmitter { constructor() { super(); this.isTTY = true; this.isRaw = false; } setRawMode(v) { this.isRaw = v; } resume() {} pause() {} }
const ttyOut = () => ({ isTTY: true, columns: 100, writes: [], write(s) { this.writes.push(String(s)); return true; } });

test('the multi-select: arrows move past a disabled row, Space toggles, a picks all, n clears, Enter confirms, Esc gives nothing', async () => {
  const items = [{ label: 'one', picked: true }, { label: 'two' }, { label: 'three', disabled: true }, { label: 'four', picked: true }];
  const drive = async keys => {
    const stdin = new TtyIn(), stdout = ttyOut();
    const p = multiSelect({ items, stdin, stdout, out: () => {} });
    for (const k of keys) stdin.emit('keypress', k.str ?? null, k.key ?? {});
    const r = await p; return { r: r && r.map(x => x.label), raw: stdin.isRaw, drawn: stdout.writes.join('') };
  };
  let d = await drive([{ key: { name: 'return' } }]);
  assert.deepEqual(d.r, ['one', 'four'], 'Enter keeps the picked ones'); assert.equal(d.raw, false, 'raw mode is restored');
  assert.match(d.drawn, /\[x\].*one/); assert.match(d.drawn, /Space toggles/);
  d = await drive([{ key: { name: 'down' } }, { key: { name: 'space' } }, { key: { name: 'return' } }]);
  assert.deepEqual(d.r, ['one', 'two', 'four'], 'Space toggles the row under the cursor');
  d = await drive([{ key: { name: 'down' } }, { key: { name: 'down' } }, { key: { name: 'space' } }, { key: { name: 'return' } }]);
  assert.deepEqual(d.r, ['one'], 'the cursor skips the disabled row and lands on four');
  d = await drive([{ key: { name: 'up' } }, { key: { name: 'space' } }, { key: { name: 'return' } }]);
  assert.deepEqual(d.r, ['one'], 'up from the first row wraps to the last pickable one');
  d = await drive([{ str: 'a' }, { key: { name: 'return' } }]);
  assert.deepEqual(d.r, ['one', 'two', 'four'], 'a picks every row that can be picked');
  d = await drive([{ str: 'n' }, { key: { name: 'return' } }]);
  assert.deepEqual(d.r, [], 'n clears');
  d = await drive([{ key: { name: 'escape' } }]);
  assert.equal(d.r, null, 'Esc picks nothing');
});
