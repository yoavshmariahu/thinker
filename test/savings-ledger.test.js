// The ledger behind the footers (src/savings-ledger.js): the Report page's own savings series (the clearing) over
// two windows, today and the whole log, kept in a file every surface can read for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { computeSavings, dayKey, dayStart, readSavings, refreshSavings, refreshSavingsInBackground, savingsDetail, savingsFile, savingsLine, savingsStatus, writeSavings, REFRESH_MS } from '../src/savings-ledger.js';
import { reportView } from '../src/report.js';
import { formatDollars } from '../src/prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400_000;

// A machine with one repository and the clears the proxy recorded, each at a time the test chooses: the
// ledger's whole job is putting them in the right window.
function machine(t, { now = Date.now(), cleared = [], desktop = [] } = {}) {
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
  if (cleared.length) {
    // the clearing's own session must be one the machine's log knows, as the Report requires
    store.log({ op: 'session', t: new Date(now).toISOString(), session: 'p', model: 'claude-opus-5-5' });
    fs.mkdirSync(path.join(home, 'state'), { recursive: true });
    fs.writeFileSync(process.env.THINKER_PROXY_LOG, cleared.map((c, i) => JSON.stringify({
      op: 'proxy', session: 'p', at: new Date(c.at).toISOString(), model: 'claude-opus-5-5',
      status: 200, cleared: c.tokens, clearedUses: i + 1,
    })).join('\n') + '\n');
  }
  // a clear made inside a desktop session, which never reaches the proxy: the clearing mod's own record
  // (compression.js:noteCompression's shape, a number for its times), and the session in the machine's log
  for (const [i, d] of desktop.entries()) {
    const session = d.session || `d${i}`;
    store.log({ op: 'session', t: new Date(d.at).toISOString(), session, model: d.model === undefined ? 'claude-opus-5-5' : d.model });
    fs.mkdirSync(path.join(home, 'state', 'compression'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'compression', `${session}.json`), JSON.stringify({
      session, firstAt: d.at - 60_000, lastAt: d.at, requests: 5, saved: d.tokens, uses: 3, recent: [{ at: d.at - 60_000, cleared: d.tokens / 5, uses: 3 }],
      ...(d.recordModel ? { model: d.recordModel, cost: { rewrites: 1, write: 100_000 } } : {}),
    }));
  }
  return { store, home, repo };
}

test('the ledger splits what was saved today from the whole log', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  // an hour into the person's own day, and one three days back: the windows are the point of the test
  const today = dayStart(now) + 3600_000;
  const earlier = now - 3 * DAY;
  const { store } = machine(t, { now, cleared: [{ at: today, tokens: 50_000 }, { at: earlier, tokens: 70_000 }] });
  const l = computeSavings(store, { now });
  assert.equal(l.day, dayKey(now));
  assert.equal(l.today.cleared.tokens, 50_000);
  assert.equal(l.lifetime.cleared.tokens, 120_000);
  assert.equal(l.today.tokens, 50_000, 'the total is the one series');
  assert.ok(Math.abs(l.today.cost - l.today.cleared.cost) < 1e-12);
  assert.ok(l.today.cost > 0 && l.lifetime.cost > l.today.cost);
});

test('a clear made inside a desktop session counts, once, priced from the model its log rows name', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const at = dayStart(now) + 3600_000, earlier = now - 3 * DAY;
  // the proxy's session also has the record the proxy writes beside its rows: the log wins, the file is not added
  const { store, home } = machine(t, { now, cleared: [{ at, tokens: 50_000 }], desktop: [{ at, tokens: 80_000 }, { at: earlier, tokens: 20_000, model: null }] });
  fs.writeFileSync(path.join(home, 'state', 'compression', 'p.json'), JSON.stringify({ session: 'p', firstAt: new Date(at).toISOString(), lastAt: new Date(at).toISOString(), requests: 1, saved: 50_000, uses: 1, recent: [] }));
  const l = computeSavings(store, { now });
  assert.equal(l.today.cleared.tokens, 130_000, 'the proxy clear and the desktop clear, not the proxy one twice');
  assert.equal(l.lifetime.cleared.tokens, 150_000);
  // the desktop clear is priced as the proxy's is, at the cache-read rate of the model the session's log rows name
  const perToken = l.today.cleared.cost / l.today.cleared.tokens;
  assert.ok(perToken > 0);
  const { store: proxyOnly } = machine(t, { now, cleared: [{ at, tokens: 130_000 }] });
  assert.ok(Math.abs(computeSavings(proxyOnly, { now }).today.cleared.cost - l.today.cleared.cost) < 1e-9, 'the same tokens cost the same whichever door cleared them');
  // a session whose model nobody logged is counted in tokens and named as unpriced, never guessed a rate
  assert.equal(l.lifetime.unpricedTokens, 20_000);
  assert.ok(Math.abs(l.lifetime.cleared.cost - l.today.cleared.cost) < 1e-12);
});

test('a desktop record that names its own model is priced from it, with nothing in the log to name one', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const at = dayStart(now) + 3600_000;
  const { store } = machine(t, { now, desktop: [{ at, tokens: 80_000, model: null, recordModel: 'claude-opus-5-5' }] });
  const l = computeSavings(store, { now });
  assert.equal(l.today.cleared.tokens, 80_000);
  assert.equal(l.lifetime.unpricedTokens, 0, 'the record\'s model prices it');
  const { store: logged } = machine(t, { now, desktop: [{ at, tokens: 80_000 }] });
  assert.ok(Math.abs(computeSavings(logged, { now }).today.cleared.cost - l.today.cleared.cost) < 1e-12, 'the same price whichever named the model');
});

test('the footers never disagree with the Report page: one window, the same series', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const at = dayStart(now) + 3600_000;
  const { store } = machine(t, { now, cleared: [{ at, tokens: 50_000 }], desktop: [{ at, tokens: 80_000 }] });
  const l = computeSavings(store, { now });
  const v = reportView(store, { weeks: 6, now, includePrs: false });
  // the Report's week-by-week table, added up over its window, is the ledger's lifetime here
  for (const [key, cell] of [['compression', l.lifetime.cleared]]) {
    const row = v.savings.find(s => s.key === key);
    const tokens = row.cells.reduce((a, c) => a + c.tokens, 0), cost = row.cells.reduce((a, c) => a + c.cost, 0);
    assert.equal(cell.tokens, tokens, `${key} tokens match the Report`);
    assert.ok(Math.abs(cell.cost - cost) < 1e-12, `${key} dollars match the Report`);
  }
});

test('a figure stamped on another day says lifetime alone, and says it the same way everywhere', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const { store } = machine(t, { now, cleared: [{ at: now, tokens: 50_000 }] });
  const l = computeSavings(store, { now });
  const line = savingsLine(l, { now });
  assert.match(line, /^saved today \$[\d.]+ · lifetime \$[\d.]+$/);
  // the status row names the version that counted the figures, which is the one place thinker says it
  assert.equal(savingsStatus(l, { now }), `thinker v${l.version}: ${line}`);
  assert.equal(savingsStatus({ ...l, version: '9.9.9' }, { now }), `thinker v9.9.9: ${line}`);
  // tomorrow, the same file: today's figure belongs to a day that has passed, so it is not said
  const tomorrow = now + DAY;
  assert.equal(savingsLine(l, { now: tomorrow }), `lifetime ${formatDollars(l.lifetime.cost)}`);
  assert.equal(readSavings(store, { now: writeSavings(store, l) && tomorrow }).sameDay, false);
  // and a cache that has saved nothing says nothing at all, rather than ~$0.00
  assert.equal(savingsLine({ day: dayKey(now), today: { cost: 0, tokens: 0 }, lifetime: { cost: 0, tokens: 0, unpricedTokens: 0 } }, { now }), '');
  assert.equal(savingsLine(null), '');
  assert.match(savingsDetail(l.lifetime), /^context cleared \$[\d.]+ \(\d+k? tokens\)$/);
});

test('the kept ledger is read back, goes stale with the clock, and one refresh runs at a time', t => {
  const now = Date.parse('2026-11-05T15:00:00Z');
  const { store, home } = machine(t, { now, cleared: [{ at: now, tokens: 50_000 }] });
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
  const { store, home } = machine(t, { now, cleared: [{ at: now, tokens: 50_000 }] });
  // a test run never spawns it unless it is asked for by name: the suite must start no background work
  assert.equal(refreshSavingsInBackground(store, { cli: path.join(ROOT, 'src', 'cli.js'), now }), false);
  process.env.THINKER_SAVINGS = 'on';
  assert.equal(refreshSavingsInBackground(store, { cli: path.join(ROOT, 'src', 'cli.js'), now }), true);
  assert.ok(fs.existsSync(path.join(home, 'state', 'savings.lock')), 'the lock is taken before the child starts');
  assert.equal(refreshSavingsInBackground(store, { cli: path.join(ROOT, 'src', 'cli.js'), now }), false, 'one at a time');
});

test('`thinker savings` prints the figure, the caveat and the same figures as --json', t => {
  const now = Date.now();
  const { store, repo, home } = machine(t, { now, cleared: [{ at: now, tokens: 50_000 }] });
  const env = { ...process.env, THINKER_TEST: '1', THINKER_HOME: home, THINKER_PROXY_LOG: process.env.THINKER_PROXY_LOG };
  const run = args => execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'savings', ...args, '--repo', repo], { env, encoding: 'utf8' });
  const text = run([]);
  assert.match(text, /^thinker savings · saved today \$[\d.]+ · lifetime \$[\d.]+$/m);
  assert.match(text, /Today .*context cleared \$[\d.]+/);
  assert.match(text, /Lifetime /);
  assert.match(text, /not a bill/, 'the caveat travels with the figure');
  assert.match(text, /context cleared is gross/);
  assert.match(text, /\+7\.3% of session cost/, 'and names the measurement that prices a clear end to end');
  assert.match(text, /thinker report/, 'and points at the table it comes from');
  const j = JSON.parse(run(['--json']));
  assert.equal(j.day, dayKey(now));
  assert.equal(j.today.cleared.tokens, 50_000);
  // --refresh is what the hooks start: it writes the ledger and, quiet, says nothing
  fs.rmSync(savingsFile(store), { force: true });
  assert.equal(run(['--refresh', '--quiet']), '');
  assert.equal(JSON.parse(fs.readFileSync(savingsFile(store), 'utf8')).today.cleared.tokens, 50_000);
});

test('through the Stop hook: the line carries the money in Codex, the card mod carries it in Claude Code', t => {
  const now = Date.now();
  const { store, repo, home } = machine(t, { now, cleared: [{ at: now, tokens: 50_000 }] });
  // no floors: this test is about what the hook says when a summary comes due, not about the cadence
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ notice: { everyPrompts: 0, everyHours: 0 } }));
  refreshSavings(store, { now, force: true });
  const env = { ...process.env, THINKER_HOME: home, THINKER_PROXY_LOG: process.env.THINKER_PROXY_LOG, THINKER_NO_BG_VERIFY: '1' };
  const stop = (client, session, extra = {}) => execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'hook', 'stop', '--client', client, '--no-distill', '--repo', repo],
    { input: JSON.stringify({ session_id: session, cwd: repo }), encoding: 'utf8', env: { ...env, ...extra } }).trim();

  // Codex CLI and a Claude Code without the mod: the summary line is the money. The first summary a
  // machine is given carries the update note above it, once (update-note.js); the money is the line under it.
  const first = JSON.parse(stop('codex', 'c1')).systemMessage;
  assert.match(first, /^🧠 thinker v[\d.]+ · What changed\n/, first);
  const line = first.split('\n').pop();
  assert.match(line, /^🧠 thinker: saved today \$[\d.]+ · lifetime \$[\d.]+$/, line);
  // and it is said once: the next summary is the money alone
  fs.rmSync(path.join(home, 'state', 'notice.json'), { force: true });
  assert.equal(JSON.parse(stop('codex', 'c1')).systemMessage, line);

  // Claude Code with the card mod running: the statusline has it, so the line does not say it twice
  fs.mkdirSync(path.join(home, 'state', 'claude-card'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'claude-card', 'c2'), '');
  fs.rmSync(path.join(home, 'state', 'notice.json'), { force: true });
  const carded = stop('claude', 'c2');
  assert.doesNotMatch(carded, /lifetime \$/, carded);

  // and switched-off notices leave every door quiet, the money with them
  fs.rmSync(path.join(home, 'state', 'notice.json'), { force: true });
  assert.equal(stop('codex', 'c3', { THINKER_NOTICE: 'off' }), '');
});
