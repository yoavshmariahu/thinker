// The Report kept for the page (report-snapshot.js): made once and read back, made again in the background when
// old or made by other code, one refresh at a time per checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { reportSnapshot, readReport, writeReport, refreshReport, dropReports, refreshing, keptRows, historyEffects, promptAverageHere, REFRESH_MS } from '../src/report-snapshot.js';

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-repsnap-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# R\n\n## Tests\n\nRun `npm test`.\n');
  const st = new Store(dir); st.init();
  return st;
}

test('the Report is made once and read back until it is old', t => {
  const st = repo(t), now = Date.now();
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  const a = reportSnapshot(st, 6, { now });
  assert.equal(a.stale, false);
  assert.equal(a.view.weeks, 6);
  assert.equal(a.view.columns.length, 6);
  // read back, not made again: the same time; older than REFRESH_MS it is served still, marked stale
  assert.equal(reportSnapshot(st, 6, { now: now + 1000 }).at, now);
  const old = reportSnapshot(st, 6, { now: now + REFRESH_MS + 1 });
  assert.equal(old.at, now); assert.equal(old.stale, true);
  // another window is its own report, in the same file
  assert.equal(readReport(st, 4), null);
  writeReport(st, 4, { weeks: 4 }, { now });
  assert.equal(readReport(st, 4, { now }).view.weeks, 4); assert.equal(readReport(st, 6, { now }).at, now);
  assert.equal(readReport(st, 6, { now }).current, true);
  assert.equal(readReport(st, 6, { now: now + REFRESH_MS + 1 }).current, false);
});

test('a report made by other code is served and marked for a refresh', t => {
  const st = repo(t), now = Date.now();
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  writeReport(st, 6, { weeks: 6, columns: [] }, { now });
  const f = path.join(st.dir, 'state', 'report.json'), kept = JSON.parse(fs.readFileSync(f, 'utf8'));
  kept.views['6'].code = 'other'; fs.writeFileSync(f, JSON.stringify(kept));
  const s = reportSnapshot(st, 6, { now });
  assert.equal(s.stale, true); assert.deepEqual(s.view, { weeks: 6, columns: [] });
  // its session rows are not lent to the decisions (another copy's rows lack what the effects need): nothing measured, stale
  assert.deepEqual(keptRows(st, { now }), { rows: [], stale: true });
  assert.equal(promptAverageHere(st, { now }), null);
  assert.equal(historyEffects(st, [{ kind: 'tool', key: 'claude:tool:Workflow', at: new Date(now - 1000).toISOString(), decision: 'approved' }], { now })[0].effect, null);
  // this code's report lends its rows, and is stale only once old
  writeReport(st, 6, { weeks: 6, columns: [], sessionRows: [{ t: now - 2000, input: 100, prompts: 2, sources: { 'claude:tool:Workflow': 50 } }, { t: now - 500, input: 100, prompts: 2, sources: {} }] }, { now });
  assert.deepEqual(keptRows(st, { now }).stale, false); assert.equal(keptRows(st, { now: now + REFRESH_MS + 1 }).stale, true);
  assert.deepEqual(promptAverageHere(st, { now }), { sessions: 2, prompts: 4, tokens: 200, perPrompt: 50 });
  assert.equal(historyEffects(st, [{ kind: 'tool', key: 'claude:tool:Workflow', at: new Date(now - 1000).toISOString(), decision: 'approved' }], { now })[0].effect.before.perPrompt, 25);
});

test('a refresh makes the report again, one run at a time, and a drop removes it', t => {
  const st = repo(t), now = Date.now();
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  assert.deepEqual(refreshReport(st, { weeks: 6, now }), { written: 6 });
  assert.equal(readReport(st, 6, { now }).at, now);
  assert.equal(refreshing(st), false);
  fs.writeFileSync(path.join(st.dir, 'state', 'report.lock'), '1');
  assert.equal(refreshing(st), true);
  assert.equal(refreshReport(st, { weeks: 6 }).skipped, 'locked');
  fs.rmSync(path.join(st.dir, 'state', 'report.lock'));
  dropReports(st);
  assert.equal(readReport(st, 6), null);
});

// `thinker report --refresh --all`, as the page starts it: every repository the page lists, from any directory
test('the command refreshes every listed repository in one run, from a directory that is no checkout', t => {
  const st = repo(t), home = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-repsnap-home-')), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-repsnap-nogit-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'machine-checkouts.json'), JSON.stringify({ at: Date.now(), transcripts: null, checkouts: [st.repo] }));
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
  const env = { ...process.env, THINKER_HOME: home, THINKER_LOG: 'local' }; delete env.THINKER_NOTES_DIR;
  const out = execFileSync(process.execPath, [cli, 'report', '--refresh', '--all'], { cwd, env, encoding: 'utf8' });
  assert.match(out, /Report kept for 1 of 1 repositories/);
  assert.ok(readReport(st, 6));
  // current already: not made again
  assert.match(execFileSync(process.execPath, [cli, 'report', '--refresh', '--all'], { cwd, env, encoding: 'utf8' }), /Report kept for 0 of 1 repositories/);
});
