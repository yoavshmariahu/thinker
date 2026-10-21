// The weekly coverage suggestion (coverage.js): directory access counted by the tool hook, a pick of the
// worked-in directories the cache covers little, the question put once, and the answers: build, none, never.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { COVERAGE, recordAccess, directoryActivity, pickSuggestions, scheduleSuggestion, coverageOffer, coveragePending, answerCoverage, readCoverageState, coverageNever } from '../src/coverage.js';
import { codeFiles, filesRead } from '../src/understand.js';
import { coverageMetrics } from '../src/telemetry.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const DAY = 86_400_000;
const T0 = Date.parse('2026-10-16T12:00:00Z');
function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-coverage-')));
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  for (const f of ['src/api/a.js', 'src/api/b.js', 'src/api/c.js', 'src/api/d.js', 'lib/util/x.js', 'lib/util/y.js', 'lib/util/z.js', 'docs/guide/readme.md', 'src/api/tests/a.test.js']) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), `export function ${path.basename(f).replace(/\W.*/, '')}() {\n  return 1;\n}\n`);
  }
  git('add', '.'); git('commit', '-q', '-m', 'init');
  return dir;
}
// sessions s1..sN, each on its own day, touching the given files
function activity(store, files, { sessions = 6, start = T0 - 6 * DAY } = {}) {
  for (let i = 0; i < sessions; i++) recordAccess(store, `s${i}`, files, { now: start + i * DAY });
}

test('the tool hook counts the directories a session works in, by day, and keeps four weeks', () => {
  const store = new Store(repo()).init();
  recordAccess(store, 'a', ['src/api/a.js', 'src/api/b.js', 'README.md', 'docs/guide/readme.md'], { now: T0 });
  recordAccess(store, 'a', ['src/api/c.js'], { now: T0 });
  recordAccess(store, 'b', ['lib/util/x.js'], { now: T0 });
  recordAccess(store, 'unknown', ['lib/util/x.js'], { now: T0 });
  const act = directoryActivity(store, { now: T0 });
  assert.deepEqual([act.sessions, act.days], [2, 1]);
  assert.deepEqual(act.dirs.map(d => [d.dir, d.sessions, d.touches]).sort(), [['lib/util', 1, 1], ['src/api', 1, 2]], 'code directories only; the session counted once');
  assert.doesNotMatch(fs.readFileSync(path.join(store.dir, 'state', 'access.json'), 'utf8'), /"a"|"b"/, 'sessions kept as hashes');
  recordAccess(store, 'c', ['lib/util/y.js'], { now: T0 + (COVERAGE.windowDays + 1) * DAY });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(store.dir, 'state', 'access.json'), 'utf8'))).length, 1, 'older days dropped');
});

test('suggestions wait for enough activity, then pick the worked-in directories the cache covers little', () => {
  const store = new Store(repo()).init();
  activity(store, ['src/api/a.js'], { sessions: 2 });
  assert.equal(pickSuggestions(store, { now: T0 }), null, 'two sessions are not enough');
  activity(store, ['src/api/a.js', 'lib/util/x.js'], { sessions: 6 });
  let picks = pickSuggestions(store, { now: T0 });
  assert.deepEqual(picks.map(p => p.dir).sort(), ['lib/util', 'src/api']);
  const api = picks.find(p => p.dir === 'src/api');
  assert.equal(api.files, 4, 'code files only: the test file is left out');
  assert.ok(api.tokens > 0, 'each with its build estimate');
  // notes on most of lib/util: covered, no longer suggested
  for (const f of ['x', 'y']) createNote(store, { title: `${f} in util`, kind: 'rule', answers: [`what does ${f} do`], body: `lib/util/${f}.js:${f} returns 1`, deps: [{ path: `lib/util/${f}.js`, symbol: f }] });
  picks = pickSuggestions(store, { now: T0 });
  assert.deepEqual(picks.map(p => p.dir), ['src/api']);
});

test('at most weekly: one question queued, said once, dropped when nobody answers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-coverage-home-'));
  const store = new Store(repo()).init();
  activity(store, ['src/api/a.js', 'lib/util/x.js']);
  assert.ok(scheduleSuggestion(store, { now: T0, home }));
  assert.equal(scheduleSuggestion(store, { now: T0 + DAY, home }), null, 'one waits already');
  assert.ok(coveragePending(store, { home }));
  const ask = coverageOffer(store, { client: 'claude', home, now: T0 + DAY });
  assert.match(ask, /<thinker-coverage-suggestion>/);
  assert.match(ask, /AskUserQuestion tool, not in prose/);
  assert.match(ask, /over two such questions/, 'four options at most per question');
  assert.match(ask, /"src\/api": about [\d.]+k? tokens; 0 of 4 code files covered; worked in by 6 sessions/);
  assert.match(ask, /`coverage` tool with choice set to the chosen directories/);
  assert.equal(coverageOffer(store, { client: 'claude', home, now: T0 + DAY }), '', 'once');
  // three days without an answer: dropped; the week has not passed, so nothing new
  assert.equal(scheduleSuggestion(store, { now: T0 + 5 * DAY, home }), null);
  assert.equal(readCoverageState(store).pending, undefined);
  assert.equal(scheduleSuggestion(store, { now: T0 + 6 * DAY, home }), null, 'within the week');
  activity(store, ['src/api/a.js', 'lib/util/x.js'], { start: T0 + 2 * DAY });
  assert.ok(scheduleSuggestion(store, { now: T0 + 8 * DAY, home }), 'a week later, asked again');
  const ops = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).map(e => e.op === 'coverage-answer' ? `answer:${e.choice}` : e.op).filter(o => /coverage|answer/.test(o));
  assert.deepEqual(ops, ['coverage-suggest', 'coverage-offer', 'answer:unanswered', 'coverage-suggest']);
});

test('the answer: chosen directories are built whole through the signed-in agent; none waits a month; never stops', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-coverage-home-'));
  const store = new Store(repo()).init();
  activity(store, ['src/api/a.js', 'lib/util/x.js']);
  scheduleSuggestion(store, { now: T0, home }); coverageOffer(store, { client: 'claude', home, now: T0 });
  let ran;
  const said = await answerCoverage(store, '"src/api/", nope', { client: 'claude', home, now: T0, selectAgentFn: async () => ({ ok: true, agent: 'codex' }), spawnFn: (bin, args, o) => { ran = { args, o }; return { unref() {} }; } });
  assert.match(said, /Started in the background through codex: notes on how src\/api works/);
  assert.deepEqual(ran.args.slice(1, 5), ['understand', '--areas', 'src/api', '--whole']);
  assert.equal(ran.o.env.THINKER_LLM, 'codex'); assert.equal(ran.o.detached, true);
  const st = readCoverageState(store);
  assert.ok(st.built['src/api'] && st.declined['lib/util'] && !st.pending, 'the other one passed on');
  // within the month neither is suggested again
  activity(store, ['src/api/a.js', 'lib/util/x.js'], { start: T0 + DAY });
  assert.deepEqual(pickSuggestions(store, { now: T0 + 7 * DAY }), []);
  // no agent signed in: nothing starts, and the agent is told how to build later
  const s2 = new Store(repo()).init(); activity(s2, ['src/api/a.js']); scheduleSuggestion(s2, { now: T0, home });
  const refused = await answerCoverage(s2, 'src/api', { home, now: T0, selectAgentFn: async () => ({ ok: false, agent: 'claude', error: 'unauthenticated' }), spawnFn: () => { throw new Error('must not spawn'); } });
  assert.match(refused, /did not start: claude is not signed in/); assert.match(refused, /thinker understand --areas src\/api --whole/);
  // never: no suggestion on this machine again
  const s3 = new Store(repo()).init(); activity(s3, ['src/api/a.js']); scheduleSuggestion(s3, { now: T0, home });
  await answerCoverage(s3, 'never', { home, now: T0 });
  assert.ok(coverageNever(home));
  assert.equal(coverageOffer(s3, { client: 'claude', home }), '');
  const s4 = new Store(repo()).init(); activity(s4, ['src/api/a.js']);
  assert.equal(scheduleSuggestion(s4, { now: T0, home }), null);
  // the telemetry counts it all, no names
  const m = coverageMetrics(store, { all: false, now: T0 + DAY });
  assert.deepEqual([m.suggestions, m.offers, m.answeredBuild, m.directoriesChosen, m.buildsStarted], [1, 1, 1, 1, 1]);
  assert.doesNotMatch(JSON.stringify(m), /src\/api|lib\/util/);
});

test('Codex, with no question tool outside plan mode, is told to ask in chat and answer through the tool', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-coverage-home-'));
  const store = new Store(repo()).init();
  activity(store, ['src/api/a.js']);
  scheduleSuggestion(store, { now: T0, home });
  const ask = coverageOffer(store, { client: 'codex', home, now: T0 });
  assert.match(ask, /ask the user in chat which of these directories/);
  assert.match(ask, /asked "chat"/);
  assert.doesNotMatch(ask, /AskUserQuestion/);
});

test('a whole-directory build reads every code file of the directory, not only recent ones, and not what was read', () => {
  const store = new Store(repo()).init();
  assert.deepEqual(codeFiles(store.repo, ['src/api']), ['src/api/a.js', 'src/api/b.js', 'src/api/c.js', 'src/api/d.js']);
  createNote(store, { title: 'how a and b work', kind: 'map', answers: ['how does a work'], body: 'src/api/a.js:a and src/api/b.js:b', deps: [{ path: 'src/api/a.js', symbol: 'a' }] }, { source: { type: 'understanding', ref: 'src/api/a.js,src/api/b.js' } });
  assert.deepEqual([...filesRead(store)].sort(), ['src/api/a.js', 'src/api/b.js']);
  assert.deepEqual(codeFiles(store.repo, ['src/api'], { skip: filesRead(store) }), ['src/api/c.js', 'src/api/d.js']);
});

test('the tool hook records access for the weekly suggestion', () => {
  const dir = repo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-coverage-home-'));
  const env = { ...process.env, THINKER_HOME: home, THINKER_LOG: 'local', THINKER_HOLDOUT: 'off', THINKER_NO_BG_VERIFY: '1', THINKER_NO_LEARN: '1', THINKER_CE: 'off', THINKER_TELEMETRY: 'off', THINKER_OFFERS: 'on' };
  new Store(dir).init();
  execFileSync('node', [CLI, 'hook', 'tool', '--client', 'claude', '--repo', dir], { input: JSON.stringify({ session_id: 'h1', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/api/a.js') } }), encoding: 'utf8', env });
  const act = directoryActivity(new Store(dir), { now: Date.now() });
  assert.deepEqual(act.dirs.map(d => d.dir), ['src/api']);
});

test('inside a desktop app, or with no agent CLI signed in, the build reads through the session, capped to one subagent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-coverage-home-'));
  const queued = async (client, opts) => {
    const store = new Store(repo()).init(); activity(store, ['src/api/a.js']); scheduleSuggestion(store, { now: T0, home });
    let ran = null;
    const said = await answerCoverage(store, 'src/api', { client, home, now: T0, spawnFn: (bin, args, o) => { ran = { args, o }; return { pid: 999999, unref() {} }; }, ...opts });
    return { store, said, ran };
  };
  // in Claude Desktop: the app's session, even with a CLI signed in (its login is not even checked)
  let checked = false;
  const app = await queued('claude-code', { appFn: h => h === 'claude' ? 'Claude Desktop' : null, selectAgentFn: async () => { checked = true; return { ok: true, agent: 'claude' }; } });
  assert.equal(checked, false);
  assert.match(app.said, /runs in Claude Desktop, so the build reads through it/);
  assert.match(app.said, /run_in_background/, 'the agent is told to start a background subagent');
  assert.match(app.said, /warmup_next/, 'and given the prompt that works the queue');
  const a = app.ran.args;
  assert.deepEqual(a.slice(1, 5), ['understand', '--areas', 'src/api', '--whole']);
  assert.equal(a[a.indexOf('--max-code') + 1], String(COVERAGE.sessionCode));
  assert.equal(a[a.indexOf('--batch') + 1], String(COVERAGE.sessionBatch));
  assert.equal(app.ran.o.env.THINKER_LLM, 'session');
  assert.equal(app.ran.o.env.THINKER_SESSION_QUEUE, path.join(app.store.dir, 'state', 'session-llm'));
  // no CLI signed in, in a client that starts subagents: the session too
  const nologin = await queued('codex-mcp-client', { appFn: () => null, selectAgentFn: async () => ({ ok: false, agent: 'codex', error: 'unauthenticated' }) });
  assert.match(nologin.said, /No agent CLI is signed in on this machine, so the build reads through this session/);
  assert.match(nologin.said, /spawn_agent/);
  assert.equal(nologin.ran.o.env.THINKER_LLM, 'session');
  // a session build already running (a warm-up): nothing more is queued over it
  const busy = new Store(repo()).init(); activity(busy, ['src/api/a.js']); scheduleSuggestion(busy, { now: T0, home });
  fs.mkdirSync(path.join(busy.dir, 'state', 'session-llm'), { recursive: true });
  fs.writeFileSync(path.join(busy.dir, 'state', 'session-llm', 'build.json'), JSON.stringify({ pid: process.pid }));
  const refused = await answerCoverage(busy, 'src/api', { client: 'claude-code', home, now: T0, appFn: () => 'Claude Desktop', spawnFn: () => { throw new Error('must not spawn'); } });
  assert.match(refused, /another build already reads through this session/);
});

test('coverage suggestions are off until a repository turns them on (a new strategy waits for its experiment)', async () => {
  const { maintainConfig, maintain } = await import('../src/maintain.js');
  const store = new Store(repo()).init();
  assert.equal(maintainConfig(store).coverage, false);
  let asked = 0;
  await maintain(store, store.repo, { fns: { coverage: () => { asked++; return null; } } });
  assert.equal(asked, 0, 'off by default');
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), maintain: { coverage: true } }));
  fs.rmSync(path.join(store.dir, 'state', 'maintain.json'), { force: true });
  await maintain(store, store.repo, { fns: { coverage: () => { asked++; return null; } } });
  assert.equal(asked, 1, 'on when the config says so');
});

test('a capped build reads the first batches in rank order and reports only what it read', async () => {
  const { understand } = await import('../src/understand.js');
  const store = new Store(repo()).init();
  const all = await understand(store, { areas: ['src/api'], whole: true, dry: true, batch: 1 });
  const capped = await understand(store, { areas: ['src/api'], whole: true, dry: true, batch: 1, maxCode: 1 });
  assert.equal(all.files.length, 4);
  assert.deepEqual(capped.files, [all.files[0]], 'at least one batch, then the cap');
  assert.equal(capped.calls, 1);
});
