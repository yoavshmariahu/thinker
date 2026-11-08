import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, logFile } from '../src/store.js';
import { summarize, renderUsage, readLog, knownRepos, sessionKey, normalizeClient, isoWeek, formatTokens, compressionNotice } from '../src/usage.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function withEnv(vars, fn) {
  const prev = {}; for (const k in vars) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k in prev) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}
const repo = () => new Store(tmp('thinker-usage-')).init();

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
