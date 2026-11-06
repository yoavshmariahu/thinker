// The ledger behind the footers (src/savings-ledger.js): the Report page's own two savings series over
// two windows, today and the whole log, kept in a file every surface can read for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { trackTurn } from '../src/ops.js';
import { computeSavings, dayKey, dayStart, readSavings, refreshSavings, refreshSavingsInBackground, savingsDetail, savingsFile, savingsLine, savingsStatus, writeSavings, REFRESH_MS } from '../src/savings-ledger.js';
import { reportView } from '../src/report.js';
import { formatDollars } from '../src/prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400_000;

// A machine with one repository, a serving the session acted on, and a clear the proxy recorded, each
// at a time the test chooses: the ledger's whole job is putting them in the right window.
function machine(t, { now = Date.now(), servedAt = [now], cleared = [] } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-savings-home-')));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-savings-repo-')));
  t.after(() => { for (const d of [home, repo]) fs.rmSync(d, { recursive: true, force: true }); });
  const before = { ...process.env };
  process.env.THINKER_HOME = home;
  process.env.THINKER_PROXY_LOG = path.join(home, 'state', 'proxy.jsonl');
  t.after(() => { for (const k of ['THINKER_HOME', 'THINKER_PROXY_LOG', 'THINKER_SAVINGS']) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'code.js'), 'x'.repeat(3600));
  const store = new Store(repo).init();
  // one serving per time given, each acted on: a confirmed hit with no transcript takes the one-read
  // fallback, whose saving is dated the serving itself, which is what makes the windows testable
  servedAt.forEach((at, i) => {
    const id = `n${i}`;
    store.log({ op: 'orient', t: new Date(at).toISOString(), session: 's', served: [id], tokens: 100, est: [[1, 1000]] });
    // the assessment names the model the session ran on, which is what prices the saving (usage.js)
    store.log({ op: 'attest', t: new Date(at).toISOString(), session: 's', model: 'claude-opus-5-5', applied: [{ id, verdict: 'confirmed' }] });
  });
  if (cleared.length) {
    // the clearing's own session must be one the machine's log knows, as the Report requires
    store.log({ op: 'session', t: new Date(now).toISOString(), session: 'p', model: 'claude-opus-5-5' });
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(process.env.THINKER_PROXY_LOG, cleared.map((c, i) => JSON.stringify({
      op: 'proxy', session: 'p', at: new Date(c.at).toISOString(), model: 'claude-opus-5-5',
      status: 200, cleared: c.tokens, clearedUses: i + 1,
    })).join('\n') + '\n');
  }
  return { store, home, repo };
}

test('the ledger splits what was saved today from the whole log, by series', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  // an hour into the person's own day, and one three days back: the windows are the point of the test
  const today = dayStart(now) + 3600_000;
  const earlier = now - 3 * DAY;
  const { store } = machine(t, { now, servedAt: [today, earlier], cleared: [{ at: today, tokens: 50_000 }, { at: earlier, tokens: 70_000 }] });
  const l = computeSavings(store, { now });

  assert.equal(l.day, dayKey(now));
  // one serving in each window's reach: 1000 estimated tokens of reading less the 100 the note cost
  assert.equal(l.today.cache.tokens, 900);
  assert.equal(l.lifetime.cache.tokens, 1800);
  assert.equal(l.today.cleared.tokens, 50_000);
  assert.equal(l.lifetime.cleared.tokens, 120_000);
  // the total is the two series added, and each window prices its own tokens
  assert.ok(Math.abs(l.today.cost - (l.today.cache.cost + l.today.cleared.cost)) < 1e-12);
  assert.ok(l.today.cost > 0 && l.lifetime.cost > l.today.cost);
  // cleared tokens are priced as prompt-cache reads, so they are worth a fraction of avoided reading
  assert.ok(l.lifetime.cleared.cost / l.lifetime.cleared.tokens < l.lifetime.cache.cost / l.lifetime.cache.tokens);
  assert.equal(l.from, new Date(earlier).toISOString());
});

test('the footers never disagree with the Report page: one window, the same two series', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const at = dayStart(now) + 3600_000;
  const { store } = machine(t, { now, servedAt: [at], cleared: [{ at, tokens: 50_000 }] });
  const l = computeSavings(store, { now });
  const v = reportView(store, { weeks: 6, now, includePrs: false });
  // the Report's week-by-week table, added up over its window, is the ledger's lifetime here
  for (const [key, cell] of [['cache', l.lifetime.cache], ['compression', l.lifetime.cleared]]) {
    const row = v.savings.find(s => s.key === key);
    const tokens = row.cells.reduce((a, c) => a + c.tokens, 0), cost = row.cells.reduce((a, c) => a + c.cost, 0);
    assert.equal(cell.tokens, tokens, `${key} tokens match the Report`);
    assert.ok(Math.abs(cell.cost - cost) < 1e-12, `${key} dollars match the Report`);
  }
});

test('a figure stamped on another day says lifetime alone, and says it the same way everywhere', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const { store } = machine(t, { now, servedAt: [now] });
  const l = computeSavings(store, { now });
  const line = savingsLine(l, { now });
  assert.match(line, /^saved today ~\$[\d.]+ · lifetime ~\$[\d.]+$/);
  assert.equal(savingsStatus(l, { now }), `🧠 ${line}`);
  // tomorrow, the same file: today's figure belongs to a day that has passed, so it is not said
  const tomorrow = now + DAY;
  assert.equal(savingsLine(l, { now: tomorrow }), `lifetime ~${formatDollars(l.lifetime.cost)}`);
  assert.equal(readSavings(store, { now: writeSavings(store, l) && tomorrow }).sameDay, false);
  // and a cache that has saved nothing says nothing at all, rather than ~$0.00
  assert.equal(savingsLine({ day: dayKey(now), today: { cost: 0, tokens: 0 }, lifetime: { cost: 0, tokens: 0, unpricedTokens: 0 } }, { now }), '');
  assert.equal(savingsLine(null), '');
  assert.match(savingsDetail(l.lifetime), /cache hits ~\$[\d.]+ \(~\d+k? tokens\) · context cleared/);
});

test('the kept ledger is read back, goes stale with the clock, and one refresh runs at a time', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const { store, home } = machine(t, { now, servedAt: [now] });
  assert.equal(readSavings(store, { now }), null, 'nothing kept yet');
  const l = refreshSavings(store, { now, force: true });
  assert.equal(JSON.parse(fs.readFileSync(savingsFile(store), 'utf8')).day, dayKey(now));
  assert.equal(savingsFile(store), path.join(home, 'state', 'savings.json'), 'the ledger is the machine\'s, not a repository\'s');
  assert.equal(readSavings(store, { now }).current, true);
  assert.equal(readSavings(store, { now: now + REFRESH_MS + 1 }).current, false, 'due again');
  assert.equal(readSavings(store, { now: now + DAY }).current, false, 'a new day is due at once');
  // a refresh already running (its lock held) leaves the kept figure alone rather than doubling the work
  fs.writeFileSync(path.join(home, 'state', 'savings.lock'), 'held');
  const again = refreshSavings(store, { now: now + REFRESH_MS + 1 });
  assert.equal(again.at, l.at, 'the kept ledger is returned untouched');
  // a damaged file reads as no ledger, never as a throw in a hook
  fs.writeFileSync(savingsFile(store), '{ not json');
  assert.equal(readSavings(store, { now }), null);
});

test('the background refresh is a detached command the hooks start, and holds off in the suite', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const { store, home } = machine(t, { now, servedAt: [now] });
  // a test run never spawns it unless it is asked for by name: the suite must start no background work
  assert.equal(refreshSavingsInBackground(store, { cli: path.join(ROOT, 'src', 'cli.js'), now }), false);
  process.env.THINKER_SAVINGS = 'on';
  assert.equal(refreshSavingsInBackground(store, { cli: path.join(ROOT, 'src', 'cli.js'), now }), true);
  assert.ok(fs.existsSync(path.join(home, 'state', 'savings.lock')), 'the lock is taken before the child starts');
  assert.equal(refreshSavingsInBackground(store, { cli: path.join(ROOT, 'src', 'cli.js'), now }), false, 'one at a time');
});

test('`thinker savings` prints the split, the caveat and the same figures as --json', t => {
  const now = Date.now();
  const { store, repo, home } = machine(t, { now, servedAt: [now], cleared: [{ at: now, tokens: 50_000 }] });
  const env = { ...process.env, THINKER_TEST: '1', THINKER_HOME: home, THINKER_PROXY_LOG: process.env.THINKER_PROXY_LOG };
  const run = args => execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'savings', ...args, '--repo', repo], { env, encoding: 'utf8' });
  const text = run([]);
  assert.match(text, /^thinker savings · saved today ~\$[\d.]+ · lifetime ~\$[\d.]+$/m);
  assert.match(text, /Today .*cache hits ~\$[\d.]+ .*context cleared ~\$[\d.]+/);
  assert.match(text, /Lifetime /);
  assert.match(text, /not a bill/, 'the caveat travels with the figure');
  assert.match(text, /cache hits are an estimate of reading avoided/);
  assert.match(text, /context cleared is gross/);
  assert.match(text, /\+7\.3% of session cost/, 'and names the measurement that prices a clear end to end');
  assert.match(text, /thinker report/, 'and points at the table it comes from');
  const j = JSON.parse(run(['--json']));
  assert.equal(j.day, dayKey(now));
  assert.equal(j.today.cache.tokens, 900);
  assert.equal(j.today.cleared.tokens, 50_000);
  // --refresh is what the hooks start: it writes the ledger and, quiet, says nothing
  fs.rmSync(savingsFile(store), { force: true });
  assert.equal(run(['--refresh', '--quiet']), '');
  assert.equal(JSON.parse(fs.readFileSync(savingsFile(store), 'utf8')).today.cache.tokens, 900);
});

test('through the Stop hook: the line carries the money in Codex, the card mod carries it in Claude Code', t => {
  const now = Date.now();
  const { store, repo, home } = machine(t, { now, servedAt: [now] });
  // no floors: this test is about what the hook says when a summary comes due, not about the cadence
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ minNotes: 1, notice: { everyPrompts: 0, everyHours: 0 } }));
  const note = { id: 'n0', title: 'A fact about this repository', body: 'A constraint.', deps: [{ path: 'code.js' }] };
  fs.mkdirSync(path.join(store.dir, 'local', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'local', 'notes', 'n0.json'), JSON.stringify(note));
  refreshSavings(store, { now, force: true });
  const env = { ...process.env, THINKER_HOME: home, THINKER_PROXY_LOG: process.env.THINKER_PROXY_LOG, THINKER_NO_BG_VERIFY: '1' };
  // the turn served that note, which is what brings a summary due at all
  const stop = (client, session) => {
    trackTurn(store, session, [note.id]);
    return execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'hook', 'stop', '--client', client, '--no-distill', '--repo', repo],
      { input: JSON.stringify({ session_id: session, cwd: repo }), encoding: 'utf8', env }).trim();
  };

  // Codex CLI and a Claude Code without the mod: the summary line, with the figures on the end
  const line = JSON.parse(stop('codex', 'c1')).systemMessage;
  assert.match(line, / · saved today ~\$[\d.]+ · lifetime ~\$[\d.]+$/, line);

  // Claude Code with the card mod running: the statusline has it, so the line does not say it twice
  fs.mkdirSync(path.join(home, 'state', 'claude-card'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'claude-card', 'c2'), '');
  fs.rmSync(path.join(home, 'state', 'notice.json'), { force: true });
  const carded = stop('claude', 'c2');
  assert.doesNotMatch(carded, /lifetime ~\$/, carded);

  // and switched-off notices leave every door quiet, the money with them
  fs.rmSync(path.join(home, 'state', 'notice.json'), { force: true });
  trackTurn(store, 'c3', [note.id]);
  const off = execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'hook', 'stop', '--client', 'codex', '--no-distill', '--repo', repo],
    { input: JSON.stringify({ session_id: 'c3', cwd: repo }), encoding: 'utf8', env: { ...env, THINKER_NOTICE: 'off' } }).trim();
  assert.equal(off, '');
});

test('today counts what was served, lifetime only what was confirmed', t => {
  // a fixed clock, as the windows tests use: an hour past midnight is in the future for a suite run
  // in the small hours, and the estimate counts nothing dated after `now`
  const now = Date.parse('2026-11-05T15:00:00Z');
  const at = dayStart(now) + 3600_000;
  // one serving today that nothing has assessed yet, and one the session said it did not use
  const { store, home } = machine(t, { now, servedAt: [] });
  for (const [id, verdict] of [['open', null], ['unused', 'unused']]) {
    store.log({ op: 'orient', t: new Date(at).toISOString(), session: `s-${id}`, served: [id], tokens: 100, est: [[1, 1000]] });
    if (verdict) store.log({ op: 'attest', t: new Date(at).toISOString(), session: `s-${id}`, model: 'claude-opus-5-5', applied: [{ id, verdict }] });
  }
  const l = computeSavings(store, { now });
  // the unassessed serving counts today; the one assessed unused counts nowhere
  assert.equal(l.today.cache.tokens, 900);
  assert.equal(l.lifetime.cache.tokens, 0, 'nothing is confirmed yet, so the Report\'s estimate is still nothing');
  // nothing names the model of a session nothing has assessed and whose agent keeps no transcript
  // here, so those tokens are counted and named unpriced rather than guessed at another model's rate
  assert.equal(l.today.cache.cost, 0);
  assert.equal(l.today.unpricedTokens, 900);

  // once the session is assessed, the same serving is in both windows, and counted once in each
  store.log({ op: 'attest', t: new Date(now).toISOString(), session: 's-open', model: 'claude-opus-5-5', applied: [{ id: 'open', verdict: 'confirmed' }] });
  const after = computeSavings(store, { now });
  assert.equal(after.today.cache.tokens, 900, 'confirming it does not count it twice');
  assert.equal(after.lifetime.cache.tokens, 900);
});

test('a session still running is priced from the transcript its agent keeps', t => {
  // The ordinary Claude Code case, and the whole value of a daily figure rests on it: nothing has
  // assessed the session, so no log line names its model, and the transcript is what does.
  const now = Date.parse('2026-11-05T15:00:00Z');
  const at = dayStart(now) + 3600_000;
  const { store, home } = machine(t, { now, servedAt: [] });
  const claude = path.join(home, 'claude');
  const before = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = claude;
  t.after(() => { if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before; });
  const file = path.join(claude, 'projects', store.repo.replace(/[^A-Za-z0-9]/g, '-'), 's-live.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000 } } }) + '\n');
  store.log({ op: 'orient', t: new Date(at).toISOString(), session: 's-live', served: ['live'], tokens: 100, est: [[1, 1000]] });
  const l = computeSavings(store, { now });
  assert.equal(l.today.cache.tokens, 900);
  assert.ok(l.today.cache.cost > 0, 'priced at the model the transcript names');
  assert.equal(l.today.unpricedTokens, 0);
  // and the Report's own window still shows nothing: it counts confirmed servings only
  assert.equal(l.lifetime.cache.tokens, 0);
});
