// Who may write or restart the machine's service entries (machine-home.js), held to all three writers: the proxy's
// entry, the telemetry schedule, the update schedule. And the other half: a proxy that is not the machine's service
// goes when its home does.
//
// What happened, 2026-11-21: a test file run outside `npm test` spawned the CLI with HOME in a temporary directory and
// no THINKER_TEST. `<temp>/.thinker` was `os.homedir()/.thinker`, so the run counted as the machine: it booted the
// person's proxy out of launchd and registered a test copy under the same label. The proxy launchd then started had
// the real HOME and the temp THINKER_HOME, and rewrote the person's hourly telemetry job to run the test copy.
//
// No test here may reach a real service manager or a real entry, whatever the code under test does, so each one
// (a) stands a temporary directory in for the account's home (`machine.account`), so every path a writer can come
// up with is under the test's own directory, and (b) leaves nothing on PATH but stubs of launchctl, systemctl and
// crontab that write down what they were asked. The writers run as they do outside test mode, which is the only
// place the fault lived: THINKER_TEST is taken out for the length of one synchronous call and put back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accountHome, ownsMachine, launchAgentPath, systemdUserDir, NOT_THE_MACHINE } from '../src/machine-home.js';
import { installService, uninstallService, restartService, homeGoneWatcher, PROXY_LABEL, freePort, isListening, waitListening, HOME_GONE_CHECK_MS } from '../src/proxy-service.js';
import { scheduleTelemetry, unscheduleTelemetry, isTelemetryScheduled } from '../src/telemetry.js';
import { ensureTelemetryScheduled } from '../src/telemetry-schedule.js';
import { scheduleDaily, unscheduleDaily, isScheduled, ensureSchedule } from '../src/update.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const darwin = process.platform === 'darwin';
const sleep = ms => new Promise(r => setTimeout(r, ms));
// wait for a condition rather than for a length of time: the suite runs many files at once
const until = async (fn, ms = 5000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(5); return fn(); };

// One machine in a directory: an account's home, a `$HOME` pointed somewhere else, and a PATH that holds only the
// stubs. `outside(fn)` runs fn as a command outside test mode would run, and puts the process back.
function machineIn(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-owner-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = path.join(root, 'account'), fakeHome = path.join(root, 'faked-home'), bin = path.join(root, 'bin'), log = path.join(root, 'calls');
  for (const d of [account, fakeHome, bin]) fs.mkdirSync(d);
  // `launchctl print` and `list` answer "no such label", as launchd does for one that is not loaded; `crontab -l`
  // exits 1, as it does where there is no table. Shell builtins only: there is nothing else on this PATH.
  for (const name of ['launchctl', 'systemctl', 'crontab']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\ncase "$1" in print|list) exit 113;; -l) exit 1;; esac\nexit 0\n`, { mode: 0o755 });
  }
  const calls = () => { try { return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const outside = fn => {
    const keys = ['PATH', 'HOME', 'THINKER_TEST', 'NODE_TEST_CONTEXT', 'THINKER_HOME', 'THINKER_TELEMETRY', 'THINKER_NO_TELEMETRY', 'THINKER_NO_LEARN', 'THINKER_IN_LLM', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR'];
    const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    process.env.PATH = bin; process.env.HOME = fakeHome;
    try { return fn(); }
    finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
  // the home a run with `$HOME` pointed away has: `os.homedir()/.thinker`, which the old rule took for the machine's
  const strayHome = path.join(fakeHome, '.thinker'), ownHome = path.join(account, '.thinker');
  for (const h of [strayHome, ownHome]) {
    fs.mkdirSync(path.join(h, 'state'), { recursive: true });
    fs.writeFileSync(path.join(h, 'state', 'proxy-service.json'), JSON.stringify({ enabled: true, port: 6901 }));
  }
  const under = (file, dir) => path.resolve(file).startsWith(path.resolve(dir) + path.sep);
  const accountEntries = () => { try { return fs.readdirSync(path.join(account, 'Library', 'LaunchAgents')); } catch { return []; } };
  return { root, account, fakeHome, strayHome, ownHome, machine: { account }, calls, outside, under, accountEntries };
}

test('the machine\'s home is the account\'s own, from the password database: $HOME cannot move it', t => {
  const account = os.userInfo().homedir;
  assert.equal(accountHome(), account);
  const fake = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-owner-home-')));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  const saved = process.env.HOME;
  try {
    process.env.HOME = fake;
    assert.equal(accountHome(), account, 'the account\'s home is the same whatever $HOME says');
    if (process.platform !== 'win32') {
      assert.equal(os.homedir(), fake, 'os.homedir() follows $HOME, which is how the old rule was faked');
      const home = path.join(os.homedir(), '.thinker');   // what thinkerHome() answers in such a run
      assert.equal(ownsMachine(home, { env: {} }), false, 'a run whose $HOME points at a temporary directory is not the machine');
    }
  } finally { if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved; }
  // the rule itself, with a directory standing in for the account
  const own = path.join(fake, 'account', '.thinker'), machine = { account: path.join(fake, 'account'), env: {} };
  assert.equal(ownsMachine(own, machine), true, 'the account\'s own .thinker is the machine\'s home');
  assert.equal(ownsMachine(own + path.sep, machine), true);
  assert.equal(ownsMachine(own, { ...machine, env: { THINKER_TEST: '1' } }), false, 'never in a test');
  assert.equal(ownsMachine(path.join(fake, 'elsewhere', '.thinker'), machine), false, 'a THINKER_HOME of its own');
  assert.equal(ownsMachine(path.join(own, 'nested'), machine), false);
  assert.equal(ownsMachine('', machine), false);
  // and where each keeps its entries: the account's directories, or a directory under the home
  assert.equal(launchAgentPath(own, 'com.thinker.proxy', machine), path.join(fake, 'account', 'Library', 'LaunchAgents', 'com.thinker.proxy.plist'));
  assert.equal(launchAgentPath('/scratch/t', 'com.thinker.proxy', machine), path.join('/scratch/t', 'LaunchAgents', 'com.thinker.proxy.plist'));
  assert.equal(systemdUserDir(own, machine), path.join(fake, 'account', '.config', 'systemd', 'user'));
  assert.equal(systemdUserDir(own, { ...machine, env: { XDG_CONFIG_HOME: '/xdg' } }), path.join('/xdg', 'systemd', 'user'));
  assert.equal(systemdUserDir('/scratch/t', { ...machine, env: { XDG_CONFIG_HOME: '/xdg' } }), path.join('/scratch/t', 'systemd-user'));
});

test('this account\'s own home still owns its entries outside test mode, so the real service is managed as before', () => {
  const account = os.userInfo().homedir;
  assert.equal(ownsMachine(path.join(account, '.thinker'), { env: {} }), true);
  assert.equal(launchAgentPath(path.join(account, '.thinker'), PROXY_LABEL, { env: {} }), path.join(account, 'Library', 'LaunchAgents', 'com.thinker.proxy.plist'));
});

test('the proxy\'s entry: a run with $HOME pointed away keeps it under itself and never reaches the service manager', t => {
  const m = machineIn(t);
  m.outside(() => {
    assert.equal(path.join(os.homedir(), '.thinker'), m.strayHome, 'the condition the old rule read as "the machine"');
    const svc = installService({ cli: CLI, home: m.strayHome, machine: m.machine });
    if (svc.path) assert.ok(m.under(svc.path, m.strayHome), `the entry is under the run's own home: ${svc.path}`);
    if (darwin) assert.deepEqual(svc, { type: 'launchd', path: path.join(m.strayHome, 'LaunchAgents', `${PROXY_LABEL}.plist`) });
    assert.equal(restartService({ cli: CLI, home: m.strayHome, machine: m.machine }), false, 'nothing of the machine\'s to restart');
    assert.equal(restartService({ cli: CLI, home: m.strayHome, machine: m.machine, whenIdle: false, managedOnly: true }), false);
    const removed = uninstallService({ home: m.strayHome, machine: m.machine });
    if (svc.path) assert.deepEqual(removed, [svc.path]);
  });
  assert.deepEqual(m.calls(), [], 'no launchctl, no systemctl');
  assert.deepEqual(m.accountEntries(), [], 'nothing written among the account\'s own entries');
});

test('the proxy\'s entry: the machine\'s own home writes it among the account\'s entries and loads it', { skip: !darwin }, t => {
  const m = machineIn(t);
  const plist = path.join(m.account, 'Library', 'LaunchAgents', `${PROXY_LABEL}.plist`);
  const label = `gui/${os.userInfo().uid}/${PROXY_LABEL}`;
  m.outside(() => {
    assert.deepEqual(installService({ cli: CLI, home: m.ownHome, machine: m.machine }), { type: 'launchd', path: plist });
    assert.match(fs.readFileSync(plist, 'utf8'), new RegExp(`<string>${m.ownHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
    assert.deepEqual(uninstallService({ home: m.ownHome, machine: m.machine }), [plist]);
  });
  assert.deepEqual(m.calls(), [
    `launchctl bootout ${label}`, `launchctl print ${label}`,                    // the old instance out, and gone
    `launchctl bootstrap gui/${os.userInfo().uid} ${plist}`,                      // the new one in
    `launchctl bootout ${label}`,                                                 // uninstall
  ]);
  assert.equal(fs.existsSync(plist), false);
});

test('the telemetry schedule: another home schedules nothing, removes nothing of the machine\'s, and asks no service manager', t => {
  const m = machineIn(t);
  const theirs = path.join(m.account, 'Library', 'LaunchAgents', 'com.thinker.telemetry.plist');
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, 'the machine\'s own job');
  m.outside(() => {
    assert.deepEqual(scheduleTelemetry({ home: m.strayHome, cliPath: CLI, machine: m.machine }), { type: 'invocation', reason: NOT_THE_MACHINE });
    assert.equal(isTelemetryScheduled(m.strayHome, { machine: m.machine }), false);
    assert.equal(unscheduleTelemetry({ home: m.strayHome, machine: m.machine }).unscheduled, false);
    // the door every command goes through (cli.js, mcp-server.js), a proxy launchd started for a test's home included
    assert.deepEqual(ensureTelemetryScheduled({ home: m.strayHome, rootDir: m.root, testMode: false, machine: m.machine }), { skipped: 'not the machine\'s own home' });
    assert.deepEqual(ensureTelemetryScheduled({ home: m.strayHome, rootDir: m.root, testMode: false, force: true, machine: m.machine }), { skipped: 'not the machine\'s own home' });
  });
  assert.deepEqual(m.calls(), [], 'no launchctl, no systemctl, no crontab');
  assert.equal(fs.readFileSync(theirs, 'utf8'), 'the machine\'s own job', 'the machine\'s job is as it was');
  assert.deepEqual(m.accountEntries(), ['com.thinker.telemetry.plist']);
  assert.equal(fs.existsSync(path.join(m.strayHome, 'state', 'telemetry-schedule.json')), false, 'and nothing is recorded as scheduled');
});

test('the telemetry schedule: the machine\'s own home writes the account\'s job and loads it', { skip: !darwin }, t => {
  const m = machineIn(t);
  const plist = path.join(m.account, 'Library', 'LaunchAgents', 'com.thinker.telemetry.plist');
  const uid = process.getuid();
  m.outside(() => {
    const r = ensureTelemetryScheduled({ home: m.ownHome, rootDir: m.root, testMode: false, machine: m.machine });
    assert.equal(r.type, 'launchd');
    assert.ok(fs.readFileSync(plist, 'utf8').includes(`THINKER_HOME='${m.ownHome}'`));
    assert.equal(unscheduleTelemetry({ home: m.ownHome, machine: m.machine }).unscheduled, true);
  });
  assert.deepEqual(m.calls(), [`launchctl unload ${plist}`, `launchctl bootstrap gui/${uid} ${plist}`, `launchctl bootout gui/${uid} ${plist}`]);
  assert.equal(fs.existsSync(plist), false);
});

test('the update schedule: another home schedules nothing, removes nothing of the machine\'s, and asks no service manager', t => {
  const m = machineIn(t);
  const theirs = path.join(m.account, 'Library', 'LaunchAgents', 'com.thinker.update.plist');
  fs.mkdirSync(path.dirname(theirs), { recursive: true });
  fs.writeFileSync(theirs, 'the machine\'s own job');
  const binPath = path.join(m.strayHome, 'bin', 'thinker');
  m.outside(() => {
    assert.deepEqual(scheduleDaily({ home: m.strayHome, binPath, machine: m.machine }), { type: 'invocation', reason: NOT_THE_MACHINE });
    assert.equal(isScheduled(m.strayHome, { machine: m.machine }), false);
    assert.deepEqual(ensureSchedule({ home: m.strayHome, binPath, machine: m.machine }), { type: 'invocation', reason: NOT_THE_MACHINE });
    // `thinker uninstall` from such a run: the person's schedule stays
    assert.equal(unscheduleDaily({ home: m.strayHome, machine: m.machine }).unscheduled, false);
  });
  assert.deepEqual(m.calls(), [], 'no launchctl, no crontab');
  assert.equal(fs.readFileSync(theirs, 'utf8'), 'the machine\'s own job', 'the machine\'s job is as it was');
  assert.deepEqual(m.accountEntries(), ['com.thinker.update.plist']);
});

test('the update schedule: the machine\'s own home writes the account\'s job and loads it', { skip: !darwin }, t => {
  const m = machineIn(t);
  const plist = path.join(m.account, 'Library', 'LaunchAgents', 'com.thinker.update.plist');
  const uid = process.getuid();
  const binPath = path.join(m.ownHome, 'bin', 'thinker');
  m.outside(() => {
    assert.deepEqual(scheduleDaily({ home: m.ownHome, binPath, machine: m.machine }), { type: 'launchd', path: plist });
    assert.ok(fs.readFileSync(plist, 'utf8').includes(binPath));
    assert.deepEqual(unscheduleDaily({ home: m.ownHome, machine: m.machine }), { unscheduled: true, type: 'launchd' });
  });
  assert.deepEqual(m.calls(), [`launchctl unload ${plist}`, `launchctl bootstrap gui/${uid} ${plist}`, `launchctl bootout gui/${uid} ${plist}`]);
  assert.equal(fs.existsSync(plist), false);
});

// --- a proxy that is not the machine's service goes when its home does ---

test('homeGoneWatcher: a proxy of another home stops listening and exits once that home is gone', async () => {
  let there = true, order = [];
  const stop = homeGoneWatcher({
    home: '/scratch/gone', machine: { account: '/account', env: {} }, every: 5, exists: () => there,
    close: () => { order.push('close'); }, exit: () => { order.push('exit'); },
  });
  assert.equal(typeof stop, 'function');
  await sleep(40);
  assert.deepEqual(order, [], 'a home that is there is no reason to go');
  there = false;
  await until(() => order.length >= 2);
  await sleep(30);
  assert.deepEqual(order, ['close', 'exit'], 'what is in flight is let finish, then it exits, once');
});

test('homeGoneWatcher: the machine\'s own service is never watched, and a home that was never there has not gone', async () => {
  let exits = 0;
  const machine = { account: '/account', env: {} };
  assert.equal(homeGoneWatcher({ home: path.join('/account', '.thinker'), machine, every: 5, exists: () => false, close: () => {}, exit: () => exits++ }), null,
    'no watcher at all for the machine\'s home: nothing here can end the service');
  const stop = homeGoneWatcher({ home: '/scratch/not-yet', machine, every: 5, exists: () => false, close: () => {}, exit: () => exits++ });
  await sleep(50);
  stop();
  assert.equal(exits, 0);
});

test('homeGoneWatcher: an answer that never finishes does not keep a homeless proxy alive past the grace', async () => {
  let there = true, exits = 0;
  let closing = 0;
  homeGoneWatcher({ home: '/scratch/gone', machine: { account: '/account', env: {} }, every: 5, grace: 150, exists: () => there, close: () => { closing = Date.now(); return new Promise(() => {}); }, exit: () => exits++ });
  there = false;
  assert.equal(await until(() => exits === 1), true, 'it exits all the same');
  assert.ok(Date.now() - closing >= 140, 'and not before the grace was up');
});

test('a proxy started for a temporary home exits by itself when that home is removed', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-owner-proxy-')));
  const home = path.join(root, 'thinker'), fakeHome = path.join(root, 'home');
  fs.mkdirSync(home); fs.mkdirSync(fakeHome);
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, 'proxy', '--port', String(port)], {
    cwd: root, stdio: 'ignore', env: { ...process.env, THINKER_TEST: '1', THINKER_HOME: home, HOME: fakeHome, THINKER_LOG: 'off' },
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(await waitListening(port, 15_000), true, 'the proxy came up');
  await sleep(HOME_GONE_CHECK_MS + 500);
  assert.equal(child.exitCode, null, 'and stays up while its home is there');
  fs.rmSync(home, { recursive: true, force: true });
  const end = await Promise.race([exited, sleep(HOME_GONE_CHECK_MS + 8000).then(() => null)]);
  assert.deepEqual(end, { code: 0, signal: null }, 'it left by itself, cleanly');
  assert.equal(await isListening(port), false);
});
