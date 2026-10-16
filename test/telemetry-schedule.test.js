import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureTelemetryScheduled, setTelemetryScheduleDisabled, telemetryScheduleState } from '../src/telemetry-schedule.js';
import { scheduleTelemetry, unscheduleTelemetry, isTelemetryScheduled } from '../src/telemetry.js';

const root = path.resolve(import.meta.dirname, '..');
// The scheduler is gated on telemetry being on (telemetry.js:isTelemetryEnabled reads the environment):
// these tests drive it with fake schedulers and must see it on whatever the shell says (the release
// script runs the suite with THINKER_TELEMETRY=off, and on 2026-10-13 two of them skipped and failed there).
for (const k of ['THINKER_TELEMETRY', 'THINKER_NO_TELEMETRY', 'THINKER_NO_LEARN']) delete process.env[k];
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-hourly-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function cron(initial = '') {
  let table = initial, writes = 0;
  return {
    get table() { return table; }, get writes() { return writes; },
    run(bin, args, opts) {
      assert.equal(bin, 'crontab');
      if (args[0] === '-l') return table;
      if (args[0] === '-') { table = opts.input; writes++; return ''; }
      if (args[0] === '-r') { table = ''; return ''; }
      assert.fail(args.join(' '));
    },
  };
}

test('Linux migration enables an hourly job once, uses final release path and preserves other cron jobs', t => {
  const home = temp(t), staged = path.join(home, 'unpacked-release');
  fs.mkdirSync(staged);
  const other = '15 3 * * * /usr/bin/backup\n';
  const c = cron(other + '0 * * * * /old/thinker telemetry --send --quiet\n');
  const schedule = opts => scheduleTelemetry({ ...opts, platform: 'linux', run: c.run });
  const opts = { home, rootDir: staged, schedule, testMode: false };
  assert.equal(ensureTelemetryScheduled(opts).type, 'cron');
  assert.ok(c.table.startsWith(other));
  assert.match(c.table, /0 \* \* \* \* /);
  assert.ok(c.table.includes(path.join(home, 'app/src/cli.js')));
  assert.ok(c.table.includes(process.execPath));
  assert.ok(c.table.includes(`THINKER_HOME='${home}'`));
  assert.ok(!c.table.includes(staged));
  assert.ok(!c.table.includes('/old/thinker'));
  ensureTelemetryScheduled(opts);
  ensureTelemetryScheduled({ ...opts, force: true });
  assert.equal(c.writes, 1);
  assert.equal(isTelemetryScheduled(home, { platform: 'linux', run: c.run }), true);
  setTelemetryScheduleDisabled(true, home);
  assert.equal(unscheduleTelemetry({ platform: 'linux', run: c.run, unitDir: home }).unscheduled, true);
  assert.equal(c.table, other);
  assert.equal(ensureTelemetryScheduled({ ...opts, force: true }).skipped, 'unscheduled');
  setTelemetryScheduleDisabled(false, home);
  assert.equal(ensureTelemetryScheduled(opts).type, 'cron');
});

test('automatic migration honors persistent and environment opt-outs and blocks real schedulers in tests', t => {
  const home = temp(t);
  let calls = 0;
  const opts = { home, rootDir: home, schedule: () => { calls++; return { type: 'cron' }; }, testMode: false };
  fs.writeFileSync(path.join(home, 'install.json'), '{"telemetry":false}');
  assert.equal(ensureTelemetryScheduled(opts).skipped, 'disabled');
  fs.writeFileSync(path.join(home, 'install.json'), '{}');
  const old = process.env.THINKER_TELEMETRY;
  try {
    process.env.THINKER_TELEMETRY = 'off';
    assert.equal(ensureTelemetryScheduled(opts).skipped, 'disabled');
  } finally {
    if (old === undefined) delete process.env.THINKER_TELEMETRY; else process.env.THINKER_TELEMETRY = old;
  }
  assert.equal(ensureTelemetryScheduled({ home, rootDir: home }).skipped, 'test');
  // Even explicitly bypassing the policy test flag cannot run a real scheduler.
  assert.equal(ensureTelemetryScheduled({ home, rootDir: home, testMode: false }).skipped, 'test');
  assert.equal(calls, 0);
});

test('failed scheduling remains visible and is retried, never marked successful', t => {
  const home = temp(t);
  let calls = 0;
  const opts = { home, rootDir: home, testMode: false, now: 1000,
    schedule: () => { calls++; throw new Error('cron denied'); } };
  assert.equal(ensureTelemetryScheduled(opts).error, 'cron denied');
  assert.equal(telemetryScheduleState(home).error, 'cron denied');
  ensureTelemetryScheduled(opts);
  assert.equal(calls, 1);
  ensureTelemetryScheduled({ ...opts, now: 3601_001 });
  assert.equal(calls, 2);
  assert.equal(ensureTelemetryScheduled({ ...opts, force: true, schedule: () => ({ type: 'cron' }) }).type, 'cron');
  assert.equal(telemetryScheduleState(home).error, undefined);
});

test('scheduled command handles shell characters and retains the correct Thinker home', t => {
  const dir = temp(t), home = path.join(dir, "space '& $value % home");
  fs.mkdirSync(home);
  const cliPath = path.join(home, 'cli.cjs');
  fs.writeFileSync(cliPath, 'console.log(JSON.stringify({ home: process.env.THINKER_HOME, args: process.argv.slice(2), test: process.env.THINKER_TEST }));');
  const c = cron();
  const { line } = scheduleTelemetry({ home, cliPath, platform: 'linux', run: c.run });
  const command = line.slice('0 * * * * '.length).replaceAll('\\%', '%');
  const output = JSON.parse(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' }));
  assert.deepEqual(output, { home, args: ['telemetry', '--send', '--quiet'], test: '1' });
  const plistPath = path.join(dir, 'job.plist');
  scheduleTelemetry({ home, cliPath, platform: 'darwin', plistPath, skipLaunchctl: true });
  assert.ok(fs.readFileSync(plistPath, 'utf8').includes('&amp;'));
});

test('Linux without cron uses a systemd user timer and removes it on unschedule', t => {
  const home = temp(t), calls = [];
  const run = (bin, args) => {
    calls.push([bin, args]);
    if (bin === 'crontab') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    assert.equal(bin, 'systemctl');
    return '';
  };
  const opts = { home, cliPath: path.join(home, 'app/src/cli.js'), platform: 'linux', run, unitDir: home };
  assert.equal(scheduleTelemetry(opts).type, 'systemd');
  assert.match(fs.readFileSync(path.join(home, 'thinker-telemetry.timer'), 'utf8'), /OnCalendar=hourly\nPersistent=true/);
  assert.match(fs.readFileSync(path.join(home, 'thinker-telemetry.service'), 'utf8'), /THINKER_HOME=.*telemetry --send --quiet/);
  assert.ok(calls.some(([, args]) => args.join(' ') === '--user enable --now thinker-telemetry.timer'));
  assert.equal(isTelemetryScheduled(home, opts), true);
  assert.equal(unscheduleTelemetry(opts).unscheduled, true);
  assert.equal(fs.existsSync(path.join(home, 'thinker-telemetry.timer')), false);
  assert.ok(calls.some(([, args]) => args.join(' ') === '--user disable --now thinker-telemetry.timer'));
});

test('Linux reports unavailable schedulers and preserves cron on write errors', t => {
  const home = temp(t);
  assert.throws(() => scheduleTelemetry({ home, platform: 'linux', unitDir: home,
    run: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), /crontab is not installed and a systemd user manager is unavailable/);
  assert.throws(() => scheduleTelemetry({ home, platform: 'linux', run: (_, args) => {
    if (args[0] === '-l') return '15 3 * * * backup\n';
    throw new Error('permission denied');
  } }), /permission denied/);
});

// The old updater is still executing when it unpacks a release. This entrypoint
// existed before the migration; relying only on the new update command would miss
// the very first upgrade. Keep all launch paths connected to the same migration.
test('old updater launch, new installation and MCP startup reach the migration', () => {
  const cli = fs.readFileSync(path.join(root, 'src/cli.js'), 'utf8');
  assert.match(cli, /async function main\(\) \{[\s\S]*?ensureTelemetryScheduled/);
  assert.ok(!cli.slice(cli.indexOf('async function main()'), cli.indexOf('// every git repository')).includes("'ranker'"));
  assert.match(fs.readFileSync(path.join(root, 'src/mcp-server.js'), 'utf8'), /ensureTelemetryScheduled\(\{ rootDir:/);
  const update = fs.readFileSync(path.join(root, 'src/update.js'), 'utf8');
  assert.match(update, /fetchRankerModel\(sourceDir\)/);
  assert.match(update, /scheduleTelemetryAfterUpdate\(path.join\(appDir, 'src', 'cli.js'\), home\)/);
});
