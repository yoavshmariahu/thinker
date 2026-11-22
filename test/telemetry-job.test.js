// The telemetry job's promises to the machine it runs on (2026-11-21): one an hour, one at a time, and never
// more time or memory than its limits, whatever the machine's history looks like. Found on a 16 GB machine that
// ran out of memory with eleven of these jobs alive at once, 3 GB between them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../src/store.js';
import {
  claimAttempt, recentTelemetry, holdTelemetryRun, sendTelemetry, maybeSendTelemetryInBackground,
  telemetryParts, assembleTelemetry, buildTelemetryPayload, CLAIMED, HOUR_MS, LOG_DAYS,
} from '../src/telemetry.js';
import { buildGuarded, BUILD_LIMITS } from '../src/telemetry-guard.js';
import { readErrors } from '../src/error-report.js';

process.env.THINKER_TEST = '1';
const TELEMETRY = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'telemetry.js')).href;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-telemetry-job-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const repo = path.join(dir, 'repo'), home = path.join(dir, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home);
  return { dir, home, store: new Store(repo).init() };
}
const attempts = home => { try { return fs.readdirSync(path.join(home, 'state', 'telemetry')).filter(f => f.startsWith('attempt.')); } catch { return []; } };
// the newest attempt, moved into the past
const age = (home, minutes) => { for (const f of attempts(home)) { const at = new Date(Date.now() - minutes * 60_000); fs.utimesSync(path.join(home, 'state', 'telemetry', f), at, at); } };
const accepted = sent => async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 202, json: async () => ({ status: 'accepted' }) }; };
// a report built at once, for the tests that are about when a job may run and not about what it builds
const core = { installId: 'install-under-test', event: 'hourly', version: '0.0.0', platform: 'test', timestamp: new Date().toISOString(), periodHours: 24 };
const quick = async () => ({ fragments: [core, { activity: { requestsTotal: 1, sessions: 1 } }], incomplete: null, stuck: false, ms: 1 });

// ---------------------------------------------------------------------------
// One an hour.

test('the hour is taken by exactly one of the processes that ask for it at the same instant', async t => {
  const { dir, home } = fixture(t);
  const script = path.join(dir, 'claim.mjs');
  fs.writeFileSync(script, `
    const { claimAttempt } = await import(${JSON.stringify(TELEMETRY)});
    const start = Number(process.argv[2]);
    while (Date.now() < start) {}            // every process reaches the claim in the same millisecond
    process.stdout.write(claimAttempt({ home: ${JSON.stringify(home)} }) ? '1' : '0');
  `);
  const round = async () => {
    const start = Date.now() + 2500;
    const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise((ok, no) => {
      const p = spawn(process.execPath, [script, String(start)], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = ''; p.stdout.on('data', d => { out += d; }); p.on('error', no); p.on('close', () => ok(out));
    })));
    return outs.filter(o => o === '1').length;
  };
  assert.equal(await round(), 1, 'eight asked, one got it');
  assert.equal(await round(), 0, 'and nobody gets it again inside the hour');
  for (let hour = 2; hour <= 4; hour++) {
    age(home, 61);
    assert.equal(await round(), 1, `hour ${hour} is again one`);
    assert.equal(attempts(home).length, 1, 'the attempt before it is not kept');
  }
});

// The interleaving the test above found once in a few hundred runs, made to happen every time: a rival takes the
// hour after this process has looked at the attempts and before it has made its own.
test('a rival that takes the hour between the look and the claim keeps it', t => {
  const { home } = fixture(t);
  const dir = path.join(home, 'state', 'telemetry');
  assert.equal(claimAttempt({ home }), true);
  age(home, 61);
  const [stale] = attempts(home), n = Number(stale.split('.')[1]);
  const readdir = fs.readdirSync; let looks = 0;
  t.mock.method(fs, 'readdirSync', (...a) => {
    const seen = readdir(...a);
    if (a[0] === dir && ++looks === 1) fs.writeFileSync(path.join(dir, `attempt.${n + 1}`), 'rival\n', { flag: 'wx' });
    return seen;
  });
  assert.equal(claimAttempt({ home }), false, 'it asked for the number the rival already has');
  assert.equal(fs.readFileSync(path.join(dir, `attempt.${n + 1}`), 'utf8'), 'rival\n');
  assert.equal(fs.existsSync(path.join(dir, `attempt.${n + 2}`)), false, 'and did not step over it');
});

test('a prompt starts one job an hour, whether or not a report is ever sent', t => {
  const { home, store } = fixture(t);
  const started = [];
  const spawnFn = (bin, args, opts) => { started.push({ args, env: opts.env }); return { unref() {} }; };
  const prompt = (more = {}) => maybeSendTelemetryInBackground({ home, cliPath: '/thinker/cli.js', store, spawnFn, env: {}, testMode: false, ...more });

  assert.equal(prompt(), true);
  assert.deepEqual(started[0].args.slice(0, 4), ['/thinker/cli.js', 'telemetry', '--background', '--quiet']);
  assert.equal(started[0].env.THINKER_BACKGROUND_TELEMETRY, CLAIMED, 'the job is told the hour is already its own');
  // The job is still building, or it failed, or the endpoint is down: nothing has been sent, and nothing says so.
  assert.equal(fs.existsSync(path.join(home, 'state', 'telemetry.last')), false);
  for (let i = 0; i < 20; i++) assert.equal(prompt(), false);
  assert.equal(started.length, 1, 'twenty more prompts in the same hour start nothing');

  age(home, 61);
  assert.equal(prompt(), true);
  assert.equal(started.length, 2);

  assert.equal(prompt({ force: true, event: 'install' }), true, 'an install reports whatever the hour');
  assert.ok(started[2].args.includes('--force'));
  assert.notEqual(started[2].env.THINKER_BACKGROUND_TELEMETRY, CLAIMED, 'a forced job was promised nothing');

  assert.equal(maybeSendTelemetryInBackground({ home, store, spawnFn, env: { THINKER_BACKGROUND_TELEMETRY: '1' }, testMode: false, force: true }), false, 'a job never starts a job');
  assert.equal(maybeSendTelemetryInBackground({ home, store, spawnFn, env: {}, testMode: true, force: true }), false, 'and a test run starts none');
});

test('a home whose state cannot be written starts no job, rather than one per prompt', t => {
  const { home, store } = fixture(t);
  fs.writeFileSync(path.join(home, 'state'), 'not a directory');
  const started = [];
  for (let i = 0; i < 3; i++) maybeSendTelemetryInBackground({ home, cliPath: '/thinker/cli.js', store, spawnFn: () => { started.push(1); return { unref() {} }; }, env: {}, testMode: false });
  assert.equal(started.length, 0);
  assert.equal(claimAttempt({ home }), false);
});

test('a report that could not be sent does not give the hour back', async t => {
  const { home, store } = fixture(t);
  let calls = 0;
  const down = async () => { calls++; throw new Error('Network offline'); };
  const first = await sendTelemetry({ home, store, fetchFn: down, build: quick });
  assert.equal(first.sent, false); assert.equal(first.error, 'Network offline');
  const second = await sendTelemetry({ home, store, fetchFn: down, build: quick });
  assert.equal(second.reason, 'already_sent_recently');
  assert.ok(Number.isFinite(Date.parse(second.lastSent)), 'it says when the attempt was');
  assert.equal(calls, 1, 'the endpoint was asked once');
  assert.equal(maybeSendTelemetryInBackground({ home, store, spawnFn: () => { throw new Error('must not start'); }, env: {}, testMode: false }), false);
  assert.ok(recentTelemetry({ home }), 'the attempt is what counts as recent');

  // a refusal is the same: the stamp of a sent report is never written, and the hour is still taken
  const { home: other } = fixture(t);
  const refused = await sendTelemetry({ home: other, store, fetchFn: async () => ({ ok: false, status: 413 }), build: quick });
  assert.equal(refused.error, 'HTTP 413');
  assert.equal(fs.existsSync(path.join(other, 'state', 'telemetry.last')), false);
  assert.equal(claimAttempt({ home: other }), false);
});

test('a look takes nothing: a dry run and a recent report leave the hour as it was', async t => {
  const { home, store } = fixture(t);
  const dry = await sendTelemetry({ home, store, dryRun: true, build: quick });
  assert.equal(dry.dryRun, true); assert.equal(dry.payload.installId, core.installId);
  assert.equal(attempts(home).length, 0, 'a dry run is not an attempt');
  assert.equal(claimAttempt({ home }), true);
  // a clock set back leaves a stamp from the future; it is old, not a reason never to report again
  const ahead = new Date(Date.now() + 5 * HOUR_MS);
  fs.utimesSync(path.join(home, 'state', 'telemetry', attempts(home)[0]), ahead, ahead);
  assert.equal(recentTelemetry({ home }), null);
  assert.equal(claimAttempt({ home }), true);
});

// ---------------------------------------------------------------------------
// One at a time.

test('one report is built at a time: a second job leaves, a forced one waits its turn', async t => {
  const { home, store } = fixture(t);
  const sent = [];
  const release = await holdTelemetryRun({ home });
  assert.equal(typeof release, 'function');
  assert.equal(await holdTelemetryRun({ home }), null, 'held');
  const second = await sendTelemetry({ home, store, fetchFn: accepted(sent), build: quick, force: true, waitMs: 0 });
  assert.equal(second.reason, 'already_running'); assert.equal(sent.length, 0);

  setTimeout(release, 300);
  const waited = await sendTelemetry({ home, store, fetchFn: accepted(sent), build: quick, force: true, event: 'install', waitMs: 10_000 });
  assert.equal(waited.sent, true, 'an install waits for the hourly report in front of it');
  assert.equal(sent.length, 1);
  assert.equal(fs.existsSync(path.join(home, 'state', 'telemetry', 'run.lock')), false, 'and gives the run back');

  // the run is given back when the send fails, too
  await sendTelemetry({ home, store, fetchFn: async () => { throw new Error('down'); }, build: quick, force: true });
  assert.equal(fs.existsSync(path.join(home, 'state', 'telemetry', 'run.lock')), false);
});

test('a run left behind by a job that was killed is taken over', async t => {
  const { home } = fixture(t);
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const lock = path.join(home, 'state', 'telemetry', 'run.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: dead, at: Date.now() }));
  const release = await holdTelemetryRun({ home });
  assert.equal(typeof release, 'function', 'its process is gone');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  release();

  // a job that is alive but older than any job may live is not waited for either
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.equal(await holdTelemetryRun({ home, holdMs: 60_000 }), null, 'alive and young: held');
  const old = new Date(Date.now() - 5 * 60_000); fs.utimesSync(lock, old, old);
  assert.equal(typeof await holdTelemetryRun({ home, holdMs: 60_000 }), 'function');
});

// ---------------------------------------------------------------------------
// Never more than its limits.

// A report whose third part misbehaves the way `mode` says.
function reportModule(t, dir) {
  const file = path.join(dir, 'parts.mjs');
  fs.writeFileSync(file, `
    export function telemetryParts(store, options) {
      return [
        ['core', () => (${JSON.stringify(core)})],
        ['activity', () => ({ activity: { requestsTotal: 3, sessions: 2 } })],
        ['heavy', () => {
          if (options.mode === 'hang') for (;;) {}
          if (options.mode === 'grow') { const kept = []; for (;;) kept.push(new Array(100_000).fill(Math.random())); }
          if (options.mode === 'buffers') { const kept = []; for (;;) kept.push(Buffer.alloc(8 * 1024 * 1024, 1)); }
          if (options.mode === 'throw') throw new Error('ENOENT: /Users/somebody/private-repository/.thinker/state/report.json');
          return { prs: { merged: 1 } };
        }],
        ['after', () => ({ sessions: { all: { sessions: 2 } } })],
      ];
    }
  `);
  return pathToFileURL(file).href;
}

test('a report that never finishes is stopped at its deadline, and what was built is the report', async t => {
  const { dir, home, store } = fixture(t);
  const module = reportModule(t, dir);
  const t0 = Date.now();
  const built = await buildGuarded({ module, options: { mode: 'hang' }, limits: { deadlineMs: 500 } });
  assert.ok(Date.now() - t0 < 5000, 'a loop that never ends was ended from outside it');
  assert.equal(built.incomplete.reason, 'deadline');
  assert.deepEqual(built.incomplete.missing, ['heavy', 'after']);
  assert.equal(built.fragments.length, 2); assert.equal(built.stuck, false);

  const sent = [];
  const res = await sendTelemetry({ home, store, fetchFn: accepted(sent), build: o => buildGuarded({ ...o, module, options: { ...o.options, mode: 'hang' }, limits: { deadlineMs: 500 } }) });
  assert.equal(res.sent, true, 'the machine still reports');
  const [body] = sent;
  assert.equal(body.installId, core.installId); assert.deepEqual(body.activity, { requestsTotal: 3, sessions: 2 });
  assert.equal(body.incomplete.reason, 'deadline'); assert.deepEqual(body.incomplete.missing, ['heavy', 'after']);
  assert.ok(!('prs' in body) && !('sessions' in body), 'a part that was not built is absent, never zero');
  assert.ok(fs.existsSync(path.join(home, 'state', 'telemetry.last')));
});

test('a report that outgrows its memory is stopped, on the heap or outside it, and this process lives', async t => {
  const { dir } = fixture(t);
  const module = reportModule(t, dir);
  const heap = await buildGuarded({ module, options: { mode: 'grow' }, limits: { heapMb: 24, youngMb: 4, deadlineMs: 30_000 } });
  assert.equal(heap.incomplete.reason, 'memory');
  assert.deepEqual(heap.incomplete.missing, ['heavy', 'after']); assert.equal(heap.fragments.length, 2);
  // buffers are not on V8's heap, so its limit never sees them: the process's own size is the limit there
  const outside = await buildGuarded({ module, options: { mode: 'buffers' }, limits: { growthMb: 96, deadlineMs: 30_000 } });
  assert.equal(outside.incomplete.reason, 'memory');
  assert.deepEqual(outside.incomplete.missing, ['heavy', 'after']);
});

test('one part failing is that part missing; the reason stays on the machine', async t => {
  const { dir, home, store } = fixture(t);
  process.env.THINKER_ERRORS_TEST = '1'; t.after(() => { delete process.env.THINKER_ERRORS_TEST; });
  const module = reportModule(t, dir);
  const sent = [];
  const res = await sendTelemetry({ home, store, fetchFn: accepted(sent), build: o => buildGuarded({ ...o, module, options: { ...o.options, mode: 'throw' } }) });
  assert.equal(res.sent, true);
  const [body] = sent;
  assert.equal(body.incomplete.reason, 'error'); assert.deepEqual(body.incomplete.missing, ['heavy']);
  assert.deepEqual(body.sessions, { all: { sessions: 2 } }, 'the part after it was still built');
  assert.ok(!/somebody|private-repository|ENOENT/.test(JSON.stringify(body)), 'no path leaves in a report');

  // on the machine it is an error record like any other (error-report.js), scrubbed, sent only with consent
  let kept = [];
  for (let i = 0; i < 40 && !kept.length; i++) { await new Promise(ok => setTimeout(ok, 50)); kept = readErrors(home); }
  assert.equal(kept.length, 1); assert.equal(kept[0].op, 'telemetry.build');
  assert.match(kept[0].message, /incomplete \(error\).*missing: heavy/);
  assert.ok(!kept[0].message.includes('/Users/somebody'), 'scrubbed there too');

  const failed = await buildGuarded({ module, options: { mode: 'throw' } });
  assert.match(failed.detail, /private-repository/, 'what went wrong is kept for the machine\'s own error record');
  assert.ok(!('detail' in failed.incomplete), 'and is no part of what the report says');

  const whole = await buildGuarded({ module, options: { mode: 'fine' } });
  assert.equal(whole.incomplete, null); assert.equal(whole.fragments.length, 4);
});

test('a report that cannot be built at all still says who it is and that the rest is missing', async t => {
  const { home, store } = fixture(t);
  const sent = [];
  const res = await sendTelemetry({ home, store, fetchFn: accepted(sent), build: o => buildGuarded({ ...o, module: 'file:///nowhere/at/all.mjs' }) });
  assert.equal(res.sent, true);
  assert.match(sent[0].installId, /^[0-9a-f-]{36}$/);
  assert.equal(sent[0].incomplete.reason, 'error');
  assert.deepEqual(sent[0].incomplete.missing, telemetryParts(store, { home }).slice(1).map(([name]) => name));
  assert.ok(!('prs' in sent[0]));
});

// ---------------------------------------------------------------------------
// The same report.

test('the report built a part at a time, in the worker, is the report built whole', async t => {
  const { home, store } = fixture(t);
  store.log({ op: 'request', t: new Date().toISOString(), session: 's1', client: 'claude' });
  // The worker holds only the rows its parts can look back to (usage.js:onlyLogSince); this process holds all of
  // them. A session that began before that and is still going is where the two would part: what it saved is
  // cumulative on its rows, so a day's saving is measured from the row before -- which is ten days older than
  // the window here. And a checkout only old rows name is still one of the machine's.
  const day = n => new Date(Date.now() - n * 86400_000).toISOString();
  assert.ok(LOG_DAYS > 30 && LOG_DAYS < 40);
  store.log({ op: 'request', t: day(60), repo: path.join(path.dirname(store.repo), 'long-gone'), session: 'old', client: 'claude' });
  store.log({ op: 'session', t: day(40), session: 'spanning', client: 'claude', model: 'claude-opus-5-5', turns: 5, totalTokens: 1000, delegated: { tokens: 1000 } });
  store.log({ op: 'delegate', t: day(40), session: 'spanning', kind: 'read', tokens: 1000 });
  store.log({ op: 'session', t: day(2), session: 'spanning', client: 'claude', model: 'claude-opus-5-5', turns: 9, totalTokens: 9000, delegated: { tokens: 5000 } });
  store.log({ op: 'delegate', t: day(2), session: 'spanning', kind: 'read', tokens: 4000 });
  const strip = p => { const { timestamp, ...rest } = p; return rest; };
  const whole = buildTelemetryPayload(store, { home });
  const parts = telemetryParts(store, { home });
  assert.equal(parts[0][0], 'core', 'who the machine is comes first');
  assert.deepEqual(parts.slice(-2).map(([name]) => name), ['spend', 'delivery'], 'the walks over every repository come last');
  assert.deepEqual(strip(assembleTelemetry(parts.map(([, make]) => make()))), strip(whole));
  assert.equal(assembleTelemetry([{ activity: {} }]), null, 'no identity, no report');

  const built = await buildGuarded({ repo: store.repo, options: { home, days: 1, all: true, event: 'hourly' } });
  assert.equal(built.incomplete, null);
  assert.deepEqual(built.names, parts.map(([name]) => name));
  const fromWorker = assembleTelemetry(built.fragments);
  assert.deepEqual(Object.keys(fromWorker), Object.keys(whole), 'the same keys in the same order');
  assert.deepEqual(strip(fromWorker), strip(whole));
  assert.ok(!('incomplete' in fromWorker));
  const saved = Object.values(whole.delegate.byDay).reduce((n, d) => n + d.savedTokens, 0);
  assert.ok(saved > 0 && saved < 5000, `the spanning session's saving inside the window is the difference from its older row (${saved})`);
});

test('the limits are small, and are constants', () => {
  assert.ok(BUILD_LIMITS.deadlineMs <= 60_000);
  assert.ok(BUILD_LIMITS.heapMb <= 192 && BUILD_LIMITS.growthMb <= 512);
});
