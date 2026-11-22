import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, logFile } from '../src/store.js';
import { summarize, renderUsage, readLog, knownRepos, knownCheckouts, onlyLogSince, sessionKey, normalizeClient, isoWeek, formatTokens, compressionNotice } from '../src/usage.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function withEnv(vars, fn) {
  const prev = {}; for (const k in vars) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k in prev) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}
const repo = () => new Store(tmp('thinker-usage-')).init();

// 2026-11-21. A telemetry report was built against a copy of a machine's logs, THINKER_HOME on the copy. The copy
// named the person's home directory as a checkout, so the machine's real log was taken for that checkout's local
// log and moved into the copy; the next run did the same to the log the hooks had started in its place, and wrote
// it over the first. Ten weeks of usage, read back out of a running page server's memory.
test('a read moves no log, the machine\'s log is never a local log, and a moved log is never written over', () => {
  const home = tmp('thinker-home-'), account = tmp('thinker-account-');
  const row = (session, t) => JSON.stringify({ t, op: 'request', session, task: 'q' }) + '\n';
  withEnv({ THINKER_HOME: home, THINKER_LOG: undefined, HOME: account }, () => {
    const one = repo(), local = path.join(one.dir, 'log.jsonl'), moved = n => path.join(one.dir, 'state', `log-before-shared${n ? `.${n}` : ''}.jsonl`);
    fs.writeFileSync(local, row('old-1', '2026-01-01T00:00:00.000Z'));

    // looking at a checkout from somewhere else -- what usage and telemetry do to every checkout on the machine
    readLog(new Store(one.repo, { readonly: true }), { all: true });
    assert.equal(fs.readFileSync(local, 'utf8'), row('old-1', '2026-01-01T00:00:00.000Z'), 'a store opened to read left the log where it was');
    assert.equal(fs.existsSync(moved()), false);

    // the checkout itself still brings its old log into the machine's, once
    assert.deepEqual(readLog(one).map(e => e.session), ['old-1']);
    assert.equal(fs.existsSync(local), false); assert.ok(fs.existsSync(moved()));

    // and if it ever has one again, what was moved the first time is still there afterwards
    fs.writeFileSync(local, row('old-2', '2026-01-02T00:00:00.000Z'));
    assert.deepEqual(readLog(one).map(e => e.session), ['old-1', 'old-2']);
    assert.match(fs.readFileSync(moved(), 'utf8'), /old-1/, 'the first moved log was not written over');
    assert.match(fs.readFileSync(moved(2), 'utf8'), /old-2/);

    // The person's home directory as a checkout: sessions run there, so a log names it. Its `.thinker` is the
    // machine's own home and the `log.jsonl` in it is the machine's log, even while THINKER_HOME points elsewhere.
    const machine = path.join(account, '.thinker', 'log.jsonl');
    fs.mkdirSync(path.dirname(machine), { recursive: true });
    fs.writeFileSync(machine, row('real-1', '2026-02-01T00:00:00.000Z') + row('real-2', '2026-02-02T00:00:00.000Z'));
    const before = fs.statSync(machine);
    readLog(new Store(account), { all: true });
    const after = fs.statSync(machine);
    assert.equal(after.ino, before.ino, 'the machine\'s log is the same file');
    assert.equal(fs.readFileSync(machine, 'utf8').split('\n').filter(Boolean).length, 2, 'with every row it had');
    assert.equal(fs.existsSync(path.join(account, '.thinker', 'state', 'log-before-shared.jsonl')), false);
    assert.ok(!fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').includes('real-1'), 'and none of it was copied into the other home');
  });
});

test('usage is kept in one log for the machine and summarized across repositories', () => {
  const home = tmp('thinker-home-');
  withEnv({ THINKER_HOME: home, THINKER_LOG: undefined }, () => {
    const one = repo(), two = repo();
    assert.equal(logFile(one), path.join(home, 'log.jsonl'));
    assert.match(renderUsage(summarize(one, { all: true })), /No usage recorded on this machine/);
    // what this repository logged locally before the log was shared is moved into the machine's log
    fs.writeFileSync(path.join(one.dir, 'log.jsonl'), JSON.stringify({ t: '2026-01-01T00:00:00.000Z', op: 'orient', session: 'old', task: 'q', served: [] }) + '\n');
    one.log({ op: 'request', session: 's1', client: 'claude', task: 't' });
    one.log({ op: 'request', session: 's1', client: 'claude', task: 't2' });
    one.log({ op: 'request', client: 'codex', task: 'no session' });
    one.log({ op: 'session', session: 's1', client: 'claude', turns: 2, inputTokens: 10 });
    one.log({ op: 'session', session: 's2', client: 'codex', turns: 1 });
    one.log({ op: 'model', phase: 'learning', purpose: 'profile-extract', provider: 'claude', model: 'claude-opus-5-5', tokens: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    one.log({ op: 'profile', session: 's1', observations: 4 });
    one.log({ op: 'profile-compile', observations: 4 });
    two.log({ op: 'request', session: 's1', client: 'cursor', task: 'elsewhere' });
    const u = summarize(one, { all: true });
    assert.equal(u.requests, 5, 'every prompt the hooks saw, the old orient rows included');
    assert.equal(u.sessions, 4, 'the same session id in another repository is another session');
    assert.deepEqual(u.clients.active, { claude: 2, codex: 1, cursor: 1, gemini: 0, mcp: 0, cli: 0, other: 1 });
    assert.equal(u.spending.totalTokens, 1200); assert.equal(u.spending.byPurpose['profile-extract'].calls, 1);
    assert.deepEqual(u.learned, { sessions: 1, observations: 4, compiles: 1 });
    assert.equal(u.repos.length, 2);
    const here = summarize(one);
    assert.equal(here.requests, 4); assert.equal(here.scope, one.repo);
    const text = renderUsage(u);
    assert.match(text, /requests\s+5, in 4 sessions/); assert.match(text, /sessions read\s+1 into the profile: 4 observations, 1 compiles/); assert.match(text, /By repository/);
    assert.equal(readLog(one).length, 9, 'the adopted local row and the eight logged'); assert.equal(readLog(one, { all: true }).length, 10);
    assert.equal(knownRepos(one, { all: true }).length, 2);
  });
});

test('THINKER_LOG moves or silences the log', () => {
  withEnv({ THINKER_HOME: undefined, THINKER_LOG: 'local' }, () => { const s = repo(); assert.equal(logFile(s), path.join(s.dir, 'log.jsonl')); });
  withEnv({ THINKER_LOG: 'off' }, () => { const s = repo(); assert.equal(logFile(s), null); s.log({ op: 'request' }); assert.equal(readLog(s).length, 0); });
  const f = path.join(tmp('thinker-log-'), 'my.jsonl');
  withEnv({ THINKER_LOG: f }, () => { const s = repo(); assert.equal(logFile(s), f); });
});

test('session keys, clients and weeks', () => {
  assert.equal(sessionKey('trace-abc.jsonl'), 'abc');
  assert.equal(sessionKey('rollout-2026-10-01T10-00-00-0192abcd-1234-1234-1234-123456789abc'), '0192abcd-1234-1234-1234-123456789abc');
  assert.equal(normalizeClient('Claude Code'), 'claude'); assert.equal(normalizeClient(null, 'rollout-x'), 'codex'); assert.equal(normalizeClient('agy'), 'gemini'); assert.equal(normalizeClient('x'), 'other');
  assert.equal(isoWeek(new Date(2026, 9, 14)), '2026-W42');
  assert.equal(formatTokens(1_500_000), '1.5M');
  assert.equal(compressionNotice(null), '');
});

// 2026-11-21. The log has no end, and a process that reads it held all of it: 25 MB of rows for ten weeks. The
// hourly telemetry job looks back thirty days and has a ceiling on its memory, so it says how far back it looks.
test('a process that only looks at recent days holds recent rows, whole sessions, and still knows every checkout', t => {
  const home = tmp('thinker-home-');
  t.after(() => onlyLogSince(''));
  withEnv({ THINKER_HOME: home, THINKER_LOG: undefined }, () => {
    const one = repo(), two = repo(), gone = repo();
    const day = n => new Date(Date.now() - n * 86400_000).toISOString();
    // a repository nothing has touched for two months, a session that ended long ago, a machine-wide row of then
    gone.log({ op: 'request', t: day(60), session: 'long-gone', task: 'q' });
    one.log({ op: 'session', t: day(50), session: 'ended', turns: 3, delegated: { tokens: 900 } });
    one.log({ op: 'upkeep', t: day(45) });
    // a session that began before the window and is still going: what it saved is cumulative on its rows
    one.log({ op: 'session', t: day(40), session: 'spanning', turns: 5, delegated: { tokens: 1000 } });
    one.log({ op: 'delegate', t: day(40), session: 'spanning', tokens: 1000 });
    one.log({ op: 'session', t: day(2), session: 'spanning', turns: 9, delegated: { tokens: 5000 } });
    two.log({ op: 'request', t: day(1), session: 'new', task: 'q' });
    const key = e => `${e.t}|${e.op}|${e.session || ''}`;

    const every = readLog(one, { all: true }).map(key);
    const repos = knownRepos(one, { all: true }), mine = knownRepos(one), checkouts = knownCheckouts(one);
    assert.equal(every.length, 7); assert.equal(repos.length, 3); assert.deepEqual(checkouts, [gone.repo, one.repo, two.repo]);

    onlyLogSince(day(31));
    const recent = readLog(one, { all: true }).map(key);
    assert.deepEqual(recent, every.filter(k => /\|spanning$|\|new$/.test(k)), 'the window\'s rows, and every row of a session that reaches into it');
    assert.equal(recent.filter(k => k.endsWith('|spanning')).length, 3, 'the spanning session is whole: its first row is what its last is measured from');
    assert.deepEqual(readLog(one).map(key), recent.filter(k => k.endsWith('|spanning')), 'one repository\'s rows the same way');
    // what is asked of the whole log is still answered for the whole log, in the same order
    assert.deepEqual(knownRepos(one, { all: true }), repos);
    assert.deepEqual(knownRepos(one), mine);
    assert.deepEqual(knownCheckouts(one), checkouts, 'the repository only old rows name is still a checkout of this machine');

    // a row written afterwards is read, and a session that comes back brings its old rows with it
    one.log({ op: 'request', t: day(0), session: 'ended', task: 'again' });
    assert.equal(readLog(one, { all: true }).filter(e => e.session === 'ended').length, 2);

    onlyLogSince('');
    assert.equal(readLog(one, { all: true }).length, 8, 'and a process that takes it back holds every row again');
  });
});

test('a log with rows that name no repository is held whole, whatever the process says', t => {
  const home = tmp('thinker-home-');
  t.after(() => onlyLogSince(''));
  withEnv({ THINKER_HOME: home, THINKER_LOG: undefined }, () => {
    const one = repo();
    const old = new Date(Date.now() - 60 * 86400_000).toISOString();
    fs.writeFileSync(logFile(one), [{ t: old, op: 'orient', session: 'old' }, { t: old, op: 'request', session: 'old2', repo: one.repo }].map(e => JSON.stringify(e)).join('\n') + '\n');
    const every = readLog(one, { all: true }).length;
    onlyLogSince(new Date(Date.now() - 31 * 86400_000).toISOString());
    assert.equal(readLog(one, { all: true }).length, every);
    assert.deepEqual(knownCheckouts(one), [one.repo]);
  });
});
