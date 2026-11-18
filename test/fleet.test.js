// Fleet reporting (src/fleet.js): no key is no network; a report is increments, written before it is sent
// and sent again until acknowledged; at most one every five minutes; and only the closed list leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManaged } from '../src/managed.js';
import { readMachineConfig } from '../src/repo-switch.js';
import { FLEET, fleetKey, setFleetKey, unsetFleetKey, fleetTick, noteSession, sendFleetReport, fleetStatus, readFleetState, metricsOf, detailOf, repoName, machineId, redactKey } from '../src/fleet.js';

const KEY = 'thk_live_' + 'a'.repeat(43);
const T0 = Date.parse('2026-11-17T10:00:00.000Z');

// A home with a loopback fleet URL (a test may reach nowhere else) and a fleet that records what it is sent.
function machine(t, { key = KEY } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-fleet-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ fleet: { url: 'http://127.0.0.1:9/v1/' } }));
  const env = { THINKER_TEST: '1', ...(key ? { THINKER_API_KEY: key } : {}) };
  const calls = [], spawned = [];
  const fleet = { answer: () => ({ status: 200, body: { org_name: 'acme', applied: true } }) };
  const fetchFn = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    const { status, body, error } = fleet.answer(calls.at(-1));
    if (error) throw Object.assign(new Error(error), { name: error });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  const spawnFn = (...args) => { spawned.push(args); return { unref() {} }; };
  const event = (session, { prompts = 1, tokens = 1000, cleared = 0, cost = null, lastAt = '2026-11-17T09:59:00.000Z', decisions } = {}) => ({
    session, client: 'claude', model: 'claude-opus-5', firstAt: '2026-11-17T09:50:00.000Z', lastAt, prompts, tokens, cleared, decisions,
    cost: cost || { priced: true, saved: 0, net: 0, rewrite: 0, reread: 0, spend: tokens / 1e6 } });
  const note = (session, figures, now) => noteSession(null, { session, home, env, now, event: event(session, figures) });
  return { home, env, calls, spawned, fleet, fetchFn, spawnFn, note, opts: now => ({ home, env, now, fetchFn, spawnFn }) };
}

test('no key: no request, no state, no process; THINKER_FLEET=off is the same with a key set', async t => {
  const m = machine(t, { key: null });
  assert.equal(fleetKey({ env: m.env, home: m.home }), null);
  assert.deepEqual(await fleetTick(null, { session: 'ses_1', ...m.opts(T0) }), { mode: 'local' });
  assert.deepEqual(await sendFleetReport(m.opts(T0)), { mode: 'local' });
  assert.equal((await fleetStatus(m.opts(T0))).mode, 'local');
  const off = { ...m.env, THINKER_API_KEY: KEY, THINKER_FLEET: 'off' };
  assert.deepEqual(await fleetTick(null, { session: 'ses_1', ...m.opts(T0), env: off }), { mode: 'local' });
  assert.equal((await fleetStatus({ ...m.opts(T0), env: off })).reason, 'THINKER_FLEET=off');
  assert.equal(m.calls.length, 0);
  assert.equal(m.spawned.length, 0);
  assert.ok(!fs.existsSync(path.join(m.home, 'state', 'fleet.json')), 'local mode writes no fleet state');
});

test('the key: the environment wins, the file is 0600 and holds only a real key, and it never prints', t => {
  const m = machine(t, { key: null });
  assert.throws(() => setFleetKey('not-a-key', { home: m.home }), /thk_live_/);
  const other = 'thk_live_' + 'b'.repeat(43);
  setFleetKey(`  ${other}\n`, { home: m.home });
  const file = path.join(m.home, 'fleet-key');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fleetKey({ env: {}, home: m.home }), { key: other, from: 'file' });
  assert.deepEqual(fleetKey({ env: { THINKER_API_KEY: KEY }, home: m.home }), { key: KEY, from: 'env' });
  assert.ok(!fs.readFileSync(path.join(m.home, 'config.json'), 'utf8').includes('thk_'), 'never in config.json');
  assert.equal(unsetFleetKey({ home: m.home }), true);
  assert.equal(unsetFleetKey({ home: m.home }), false);
  assert.equal(fleetKey({ env: {}, home: m.home }), null);
  assert.equal(redactKey(`refused ${KEY}`), 'refused thk_<redacted>');
  assert.equal(machineId({ env: { THINKER_MACHINE_ID: 'ci-runner' }, home: m.home }), 'ci-runner');
  assert.match(machineId({ env: {}, home: m.home }), /^[0-9a-f-]{36}$/);
  assert.equal(machineId({ env: { THINKER_MACHINE_ID: 'has spaces' }, home: m.home }), machineId({ env: {}, home: m.home }));
});

test('the first report goes at once and carries the closed list; later ones carry only what changed', async t => {
  const m = machine(t);
  m.note('ses_1', { prompts: 3, tokens: 1200 }, T0);
  const first = await fleetTick(null, m.opts(T0));
  assert.deepEqual({ sent: first.sent, sessions: first.sessions, orgName: first.orgName }, { sent: true, sessions: 1, orgName: 'acme' });
  const [call] = m.calls;
  assert.equal(call.url, 'http://127.0.0.1:9/v1/reports');
  assert.equal(call.auth, 'Bearer ' + KEY);
  assert.deepEqual(Object.keys(call.body).sort(), ['hostname', 'machine_id', 'os', 'report_id', 'sessions', 'thinker_version']);
  assert.deepEqual(Object.keys(call.body.sessions[0]).sort(), ['agent', 'last_at', 'metrics', 'model', 'repo', 'session_id', 'started_at']);
  assert.deepEqual(call.body.sessions[0], { session_id: 'ses_1', started_at: '2026-11-17T09:50:00.000Z', last_at: '2026-11-17T09:59:00.000Z', agent: 'claude', model: 'claude-opus-5', repo: null,
    metrics: { prompts: 3, tokens: 1200, spend_usd: 0.0012 } });
  assert.ok(!JSON.stringify(call.body).includes(m.home), 'no path');
  assert.ok(!fs.readFileSync(path.join(m.home, 'state', 'fleet.json'), 'utf8').includes('thk_'), 'the key is not in the state');

  // nothing moved: nothing is sent, even once five minutes have passed
  assert.equal((await sendFleetReport(m.opts(T0 + FLEET.everyMs))).reason, 'nothing-new');
  assert.equal(m.calls.length, 1);

  // the session grows and another starts: the increments, and the new one whole
  m.note('ses_1', { prompts: 5, tokens: 2000, cleared: 800, cost: { priced: true, saved: 0.4, net: 0.3, rewrite: 0.1, reread: 0, spend: 0.002 }, lastAt: '2026-11-17T10:06:00.000Z' }, T0 + 6 * 60e3);
  m.note('ses_2', { prompts: 1, tokens: 50, cost: { priced: false } }, T0 + 6 * 60e3);
  const second = await fleetTick(null, m.opts(T0 + 6 * 60e3));
  assert.equal(second.sessions, 2);
  const sessions = Object.fromEntries(m.calls[1].body.sessions.map(s => [s.session_id, s]));
  assert.deepEqual(sessions.ses_1.metrics, { prompts: 2, tokens: 800, cleared_tokens: 800, saved_usd: 0.4, net_usd: 0.3, rewrite_usd: 0.1, spend_usd: 0.0008 });
  assert.equal(sessions.ses_1.last_at, '2026-11-17T10:06:00.000Z');
  assert.deepEqual(sessions.ses_2.metrics, { prompts: 1, tokens: 50 }, 'no dollars for a session with no list price');
  assert.notEqual(m.calls[1].body.report_id, m.calls[0].body.report_id);
  assert.equal(m.calls[1].body.machine_id, m.calls[0].body.machine_id);

  // a saving that settles lower is a negative increment, and that is what is sent
  m.note('ses_1', { prompts: 5, tokens: 2000, cleared: 800, cost: { priced: true, saved: 0.4, net: 0.1, rewrite: 0.3, reread: 0, spend: 0.002 }, lastAt: '2026-11-17T10:06:00.000Z' }, T0 + 12 * 60e3);
  await fleetTick(null, m.opts(T0 + 12 * 60e3));
  assert.deepEqual(m.calls[2].body.sessions, [{ ...sessions.ses_1, metrics: { net_usd: -0.2, rewrite_usd: 0.2 } }]);
});

test('at most one report every five minutes: inside the window one process is left to send at the mark', async t => {
  const m = machine(t);
  m.note('ses_1', {}, T0);
  await fleetTick(null, m.opts(T0));
  m.note('ses_1', { prompts: 2, tokens: 3000 }, T0 + 60e3);
  const held = await fleetTick(null, m.opts(T0 + 60e3));
  assert.deepEqual(held, { mode: 'fleet', sent: false, reason: 'scheduled', at: T0 + FLEET.everyMs });
  assert.equal((await fleetTick(null, m.opts(T0 + 120e3))).reason, 'scheduled');
  assert.equal(m.calls.length, 1, 'nothing more was sent');
  assert.equal(m.spawned.length, 1, 'and one process waits, not one per turn');
  const [, args, options] = m.spawned[0];
  assert.deepEqual(args.slice(1), ['fleet-report', '--background', '--at', String(T0 + FLEET.everyMs)]);
  assert.equal(options.detached, true);
  assert.equal(options.env.THINKER_HOME, m.home);
  // what that process does at the mark
  const sent = await sendFleetReport(m.opts(T0 + FLEET.everyMs));
  assert.equal(sent.sent, true);
  assert.deepEqual(m.calls[1].body.sessions[0].metrics, { prompts: 1, tokens: 2000, spend_usd: 0.002 });
  // and the next window starts from that send
  m.note('ses_1', { prompts: 3, tokens: 4000 }, T0 + FLEET.everyMs + 60e3);
  assert.equal((await fleetTick(null, m.opts(T0 + FLEET.everyMs + 60e3))).at, T0 + 2 * FLEET.everyMs);
  assert.equal(m.spawned.length, 2);
});

test('a report whose answer is lost is sent again as it was, and what moved meanwhile waits for the next', async t => {
  const m = machine(t);
  m.note('ses_1', { prompts: 3, tokens: 1200 }, T0);
  m.fleet.answer = () => ({ error: 'TimeoutError' });
  const lost = await fleetTick(null, m.opts(T0));
  assert.deepEqual({ sent: lost.sent, reason: lost.reason }, { sent: false, reason: 'unreachable' });
  assert.ok(readFleetState(m.home).pending, 'the report is on disk');
  m.note('ses_1', { prompts: 9, tokens: 5000 }, T0 + 60e3);
  m.fleet.answer = () => ({ status: 503, body: {} });
  assert.equal((await fleetTick(null, m.opts(T0 + 60e3))).reason, 'unreachable');
  m.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: false } });
  assert.equal((await fleetTick(null, m.opts(T0 + 120e3))).sent, true);
  assert.equal(m.calls.length, 3);
  assert.deepEqual(m.calls[1].body, m.calls[0].body, 'the same report, the same id');
  assert.deepEqual(m.calls[2].body, m.calls[0].body);
  assert.deepEqual(m.calls[0].body.sessions[0].metrics, { prompts: 3, tokens: 1200, spend_usd: 0.0012 });
  // only now what moved since: the difference from what was acknowledged, not from zero
  await sendFleetReport(m.opts(T0 + 10 * 60e3));
  assert.deepEqual(m.calls[3].body.sessions[0].metrics, { prompts: 6, tokens: 3800, spend_usd: 0.0038 });
  assert.equal(readFleetState(m.home).pending, null);
});

test('a refused key and a refused report: the first waits, the second is dropped and its increments go again', async t => {
  const m = machine(t);
  m.note('ses_1', { prompts: 3, tokens: 1200 }, T0);
  m.fleet.answer = () => ({ status: 401, body: { error: { code: 'invalid_api_key' } } });
  assert.equal((await fleetTick(null, m.opts(T0))).reason, 'invalid-key');
  const status = await fleetStatus(m.opts(T0 + 1000));
  assert.deepEqual({ mode: status.mode, reachable: status.reachable, reason: status.reason, keyFrom: status.keyFrom }, { mode: 'fleet', reachable: false, reason: 'invalid-key', keyFrom: 'env' });
  m.fleet.answer = () => ({ status: 400, body: { error: { code: 'invalid_request' } } });
  assert.equal((await sendFleetReport(m.opts(T0 + 2000))).reason, 'refused');
  assert.equal(readFleetState(m.home).pending, null, 'a malformed report is not held');
  m.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: true } });
  const ok = await fleetStatus(m.opts(T0 + 3000));
  assert.deepEqual({ reachable: ok.reachable, orgName: ok.orgName }, { reachable: true, orgName: 'acme' });
  assert.notEqual(m.calls.at(-1).body.report_id, m.calls[0].body.report_id);
  assert.deepEqual(m.calls.at(-1).body.sessions[0].metrics, { prompts: 3, tokens: 1200, spend_usd: 0.0012 });
  // status with nothing new still asks: an empty report is a machine saying it is there
  await fleetStatus(m.opts(T0 + 4000));
  assert.deepEqual(m.calls.at(-1).body.sessions, []);
});

test('one sender at a time, and a session noted while a report is on the wire is not lost', async t => {
  const m = machine(t);
  m.note('ses_1', { prompts: 1, tokens: 100 }, T0);
  let inner;
  m.fleet.answer = () => {
    m.note('ses_2', { prompts: 4, tokens: 400 }, T0 + 500);                 // a hook, mid-request
    inner = sendFleetReport(m.opts(T0 + 500));                              // and a second sender
    return { status: 200, body: { org_name: 'acme', applied: true } };
  };
  assert.equal((await sendFleetReport(m.opts(T0))).sent, true);
  assert.deepEqual(await inner, { mode: 'fleet', sent: false, reason: 'busy' });
  m.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: true } });
  await sendFleetReport(m.opts(T0 + FLEET.everyMs));
  assert.deepEqual(m.calls.at(-1).body.sessions.map(s => [s.session_id, s.metrics.tokens]), [['ses_2', 400]]);
  // a lock left by a process that died is taken over
  fs.writeFileSync(path.join(m.home, 'state', 'fleet.lock'), '1');
  fs.utimesSync(path.join(m.home, 'state', 'fleet.lock'), new Date(T0), new Date(T0));
  m.note('ses_2', { prompts: 5, tokens: 500 }, T0 + 2 * FLEET.everyMs);
  assert.equal((await sendFleetReport(m.opts(Date.now()))).sent, true);
});

test('a repository is its name and never a path; a test may reach only loopback', async t => {
  const m = machine(t);
  const checkout = (name, origin) => {
    const repo = path.join(m.home, name);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    if (origin) fs.writeFileSync(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
    return repo;
  };
  assert.equal(repoName(checkout('bare')), null, 'no origin: nothing, not the path');
  assert.equal(repoName(checkout('ssh', 'git@github.com:acme/widgets.git')), 'acme/widgets');
  assert.equal(repoName(checkout('https', 'https://someone:token@github.com/acme/widgets.git')), 'acme/widgets', 'and nothing of the URL');
  assert.equal(repoName(null), null);
  assert.deepEqual(metricsOf({ prompts: 2, tokens: null, cleared: 5, cost: { priced: true, saved: 1, net: 1, rewrite: 0, reread: 0, spend: null } }),
    { prompts: 2, tokens: 0, cleared_tokens: 5, calls: 0, cuts: 0, saved_usd: 1, net_usd: 1, rewrite_usd: 0, reread_usd: 0 });
  // the default URL is production, and a test never reaches it
  fs.writeFileSync(path.join(m.home, 'config.json'), '{}');
  m.note('ses_1', {}, T0);
  assert.deepEqual(await sendFleetReport(m.opts(T0)), { mode: 'fleet', sent: false, reason: 'test' });
  assert.equal(m.calls.length, 0);
});

test('from a real store: the session as the one pricing door measured it reaches the report, twice only its change', async t => {
  const { Store } = await import('../src/store.js');
  const m = machine(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-fleet-repo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir).init();
  const ago = ms => new Date(Date.now() - ms).toISOString();
  const row = (turns, tokens) => store.log({ op: 'session', t: ago(60_000), session: 's1', client: 'opencode', model: 'claude-opus-5', turns, totalTokens: tokens,
    tokenCoverage: 'complete', inputTokens: tokens - 20_000, outputTokens: 20_000, cacheReadTokens: 200_000, cacheWriteTokens: 40_000 });
  row(12, 300_000);
  const state = path.join(m.home, 'state', 'compression');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 's1.json'), JSON.stringify({ session: 's1', saved: 120_000, requests: 4, firstAt: ago(7200_000), lastAt: ago(60_000) }));

  const now = Date.now();
  assert.equal((await fleetTick(store, { session: 's1', ...m.opts(now) })).sent, true);
  const [sent] = m.calls[0].body.sessions;
  assert.equal(sent.session_id, 's1');
  assert.equal(sent.agent, 'opencode');
  assert.equal(sent.repo, null, 'a checkout with no origin has no name to send');
  assert.equal(sent.metrics.prompts, 12);
  assert.equal(sent.metrics.tokens, 300_000);
  assert.equal(sent.metrics.cleared_tokens, 120_000);
  assert.ok(sent.metrics.spend_usd > 0 && sent.metrics.saved_usd > 0, 'priced by the session\'s own model');
  assert.ok(Object.values(sent.metrics).every(Number.isFinite), 'numbers only');
  assert.ok(!JSON.stringify(m.calls[0].body).includes(dir), 'nothing of where the repository is');
  assert.equal((await fleetTick(store, { session: 'unknown', ...m.opts(now + FLEET.everyMs) })).reason, 'nothing-new');
});

test('a session in depth goes with its report when it changes, and only its numbers and closed names', async t => {
  const m = machine(t);
  const decisions = { calls: 2, cuts: 1,
    series: [{ c: 1, at: '2026-11-17T09:51:00.000Z', carried: 40_000, fresh: 2000, read: 30_000, write: 8000, out: 500, cost: 0.12, turn: 1 },
      { c: 2, at: '2026-11-17T09:52:00.000Z', carried: 150_000, fresh: 1000, read: 140_000, write: 9000, out: 700, cost: null, turn: 1, cut: 60_000, cold: true }],
    actions: [{ at: '2026-11-17T09:52:00.000Z', kind: 'cut', turn: 1, tokens: 60_000, policy: 'r3-t140k-f8k-p25-deep', cold: true, results: 9 },
      { at: '2026-11-17T09:53:00.000Z', kind: 'delegate', of: 'read', tool: 'Read', files: ['/home/ada/secret.py'], tokens: 9000, held: false, cached: false, error: 'ENOENT /home/ada/x', model: 'claude-sonnet-5-5', usd: 0.2 },
      { at: '2026-11-17T09:54:00.000Z', kind: 'dropped', results: 9, tools: [{ name: 'Read', calls: 5, tokens: 40_000, args: 'x' }] }],
    byType: { fresh: 0.012345678, read: 0.2, write: 0.5, out: 0.3 } };
  m.note('ses_1', { prompts: 3, tokens: 1200, decisions }, T0);
  await fleetTick(null, m.opts(T0));
  const [sent] = m.calls[0].body.sessions;
  assert.deepEqual([sent.metrics.calls, sent.metrics.cuts], [2, 1]);
  assert.deepEqual(sent.detail.series[1], { c: 2, at: '2026-11-17T09:52:00.000Z', carried: 150_000, out: 700, turn: 1, cut: 60_000, cold: true, fresh: 1000, read: 140_000, write: 9000 }, 'an unpriced call carries no cost');
  assert.deepEqual(sent.detail.actions[1], { kind: 'delegate', at: '2026-11-17T09:53:00.000Z', tokens: 9000, usd: 0.2, of: 'read', model: 'claude-sonnet-5-5' });
  assert.deepEqual(sent.detail.actions[2].tools, [{ name: 'Read', calls: 5, tokens: 40_000 }]);
  assert.deepEqual(sent.detail.by_type, { fresh: 0.0123, read: 0.2, write: 0.5, out: 0.3 });
  for (const leak of ['/home/ada', 'ENOENT', 'secret.py', '"args"']) assert.ok(!JSON.stringify(m.calls[0].body).includes(leak), leak);
  // the figures move and the depth does not: it is not sent again
  m.note('ses_1', { prompts: 4, tokens: 1500, decisions }, T0 + FLEET.everyMs);
  await fleetTick(null, m.opts(T0 + FLEET.everyMs));
  assert.equal('detail' in m.calls[1].body.sessions[0], false);
  // a call is added: the depth alone is a reason to report, and it goes whole
  const more = { ...decisions, calls: 3, series: [...decisions.series, { c: 3, carried: 95_000, out: 100, cost: 0.1, reason: 'below-trigger' }] };
  m.note('ses_1', { prompts: 4, tokens: 1500, decisions: more }, T0 + 2 * FLEET.everyMs);
  await fleetTick(null, m.opts(T0 + 2 * FLEET.everyMs));
  assert.equal(m.calls[2].body.sessions[0].detail.series.length, 3);
  assert.deepEqual(m.calls[2].body.sessions[0].metrics, { calls: 1 });
  assert.equal(detailOf({}), null);
  assert.equal(detailOf({ decisions: { series: [], actions: [] } }), null);
});

test('more sessions than a report holds go in a few reports back to back, each acknowledged before the next', async t => {
  const m = machine(t);
  for (let i = 0; i < 23; i++) m.note('ses_' + String(i).padStart(2, '0'), { prompts: 1, tokens: 100 + i }, T0 + i);
  const result = await fleetTick(null, m.opts(T0 + 100));
  assert.deepEqual({ sent: result.sent, sessions: result.sessions }, { sent: true, sessions: 23 });
  assert.deepEqual(m.calls.map(c => c.body.sessions.length), [FLEET.sessionsMax, FLEET.sessionsMax, 3]);
  assert.equal(new Set(m.calls.flatMap(c => c.body.sessions.map(s => s.session_id))).size, 23, 'every session once');
  assert.equal(new Set(m.calls.map(c => c.body.report_id)).size, 3);
  // a failure part-way leaves the rest for the next report, and nothing already acknowledged goes twice
  for (let i = 0; i < 23; i++) m.note('ses_' + String(i).padStart(2, '0'), { prompts: 2, tokens: 200 + i }, T0 + 1000 + i);
  let n = 0;
  m.fleet.answer = () => (++n === 2 ? { status: 503, body: {} } : { status: 200, body: { org_name: 'acme', applied: true } });
  const partial = await sendFleetReport(m.opts(T0 + FLEET.everyMs));
  assert.deepEqual({ sent: partial.sent, sessions: partial.sessions }, { sent: true, sessions: FLEET.sessionsMax }, 'what got through is what it reports');
  assert.ok(readFleetState(m.home).pending, 'and the report that failed waits on disk');
  m.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: true } });
  await sendFleetReport(m.opts(T0 + 2 * FLEET.everyMs));
  const second = m.calls.slice(3).flatMap(c => c.body.sessions.map(s => s.session_id));
  assert.equal(new Set(second).size, 23);
  assert.equal(second.length, 23 + FLEET.sessionsMax, 'the report that failed is the one sent again, whole');
});

test('the org\'s settings come back on a report\'s answer: the newest is taken, and a machine may refuse them', async t => {
  const m = machine(t);
  const managed = { at: '2026-11-17T09:00:00.000Z', config: { proxy: { trigger: 90_000, upstream: 'https://elsewhere.example' }, delegate: { enabled: false } } };
  m.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: true, managed } });
  m.note('ses_1', { prompts: 1 }, T0);
  assert.equal((await fleetTick(null, m.opts(T0))).sent, true);
  assert.deepEqual(readManaged(m.home).config, { proxy: { trigger: 90_000 }, delegate: { enabled: false } }, 'only what a fleet may set');
  assert.equal(readManaged(m.home).from, 'fleet');
  assert.equal(readMachineConfig(m.home).proxy.trigger, 90_000, 'and it is what the machine runs');
  // an answer with nothing set, or with settings older than the ones held, changes nothing
  m.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: true } });
  await sendFleetReport({ ...m.opts(T0 + 1), force: true });
  m.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: true, managed: { at: '2026-11-16T09:00:00.000Z', config: {} } } });
  await sendFleetReport({ ...m.opts(T0 + 2), force: true });
  assert.equal(readManaged(m.home).at, managed.at);
  // everything handed back, later: the machine's own file stands again
  m.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: true, managed: { at: '2026-11-17T09:30:00.000Z', config: {} } } });
  await sendFleetReport({ ...m.opts(T0 + 3), force: true });
  assert.deepEqual(readManaged(m.home).config, {});

  const off = machine(t);
  off.env.THINKER_MANAGED = 'off';
  off.fleet.answer = () => ({ status: 200, body: { org_name: 'acme', applied: true, managed } });
  off.note('ses_1', { prompts: 1 }, T0);
  assert.equal((await fleetTick(null, off.opts(T0))).sent, true);
  assert.equal(readManaged(off.home), null, 'the figures still go; the settings are refused');
});
