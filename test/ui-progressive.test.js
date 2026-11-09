import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { uiScans, scanStatus } from '../src/ui/scans.js';
import { contextView } from '../src/context-view.js';
import { reportView } from '../src/report.js';
import { readSnapshot } from '../src/context-snapshot.js';
import { readReport } from '../src/report-snapshot.js';
import { createUiServer } from '../src/ui/server.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-progressive-')));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Project\n\n## Tests\n\nRun npm test.\n');
  const store = new Store(repo).init();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, repo, store };
}
class FakeWorker extends EventEmitter {
  requests = [];
  postMessage(data) { this.requests.push(data); }
  terminate() { this.emit('exit', 1); return Promise.resolve(); }
  answer(i, data) { this.emit('message', { id: this.requests[i].id, ...data }); }
}

test('scans share queued work, expose partial revisions, surface failures and allow retry', async t => {
  const { store } = fixture(t), worker = new FakeWorker();
  const scans = uiScans({ workerFactory: () => worker });
  t.after(() => scans.close());
  const first = scans.read('context', store, 7);
  assert.equal(first.view, undefined); assert.equal(first.refreshing, true);
  assert.equal(first.progress.total, null);
  scans.read('context', store, 7);
  assert.equal(worker.requests.length, 1);
  worker.answer(0, { completed: 1, total: 4, view: { sessions: 1 }, at: 100 });
  const partial = scans.read('context', store, 7);
  assert.equal(partial.view.sessions, 1); assert.notEqual(partial.revision, first.revision);
  // a count alone, from inside a batch: the stamp carries it and the revision stands, so the page fetches no table for it
  worker.answer(0, { completed: 2, total: 4 });
  const counted = scans.read('context', store, 7);
  assert.equal(counted.progress.completed, 2); assert.equal(counted.revision, partial.revision); assert.equal(counted.view.sessions, 1);
  assert.equal(readSnapshot(store, 7), null, 'partial data must never become the CLI snapshot');
  worker.answer(0, { error: 'Unreadable session', done: true });
  const failed = scans.read('context', store, 7);
  assert.equal(failed.refreshing, false); assert.equal(failed.progress.error, 'Unreadable session');
  assert.equal(failed.view.sessions, 1, 'keep partial results when a scan fails');
  scans.read('context', store, 7, { retry: true });
  assert.equal(worker.requests.length, 2);
  await scans.cancel();
  worker.answer(1, { view: { sessions: 999 }, done: true });
  assert.equal(scans.read('context', store, 7).view, undefined, 'cancelled work cannot return old figures');
});

test('All keeps completed counts while other repositories wait and reports failure explicitly', () => {
  const done = { progress: { completed: 4, total: 4, done: true }, revision: 'a' };
  const pending = { progress: { completed: 0, total: null }, refreshing: true, revision: 'b' };
  assert.deepEqual(scanStatus([done, pending]).progress, { completed: 4, total: null, error: null });
  const reading = { ...pending, progress: { completed: 2, total: 6 } };
  assert.equal(scanStatus([done, reading]).progress.total, 10);
  assert.equal(scanStatus([done, reading]).progress.completed, 6);
  assert.equal(scanStatus([done]).partial, false);
  assert.equal(scanStatus([done]).progress, null);
});

test('the real worker publishes increasing session subsets and finishes with the CLI figures', async t => {
  const { root, repo, store } = fixture(t);
  const env = { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'local', THINKER_HOME: path.join(root, 'thinker'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  const transcripts = path.join(env.CLAUDE_CONFIG_DIR, 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(transcripts, { recursive: true });
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const file = path.join(transcripts, `s${i}.jsonl`), timestamp = new Date().toISOString();
    fs.writeFileSync(file, [
      { type: 'user', cwd: repo, timestamp, message: { role: 'user', content: 'Read AGENTS.md and run the tests.' } },
      { type: 'assistant', timestamp, message: { id: `m${i}`, model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: (i + 1) * 1000, output_tokens: 50 } } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    sessions.push({ client: 'claude', file, session: `s${i}`, mtime: fs.statSync(file).mtimeMs });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  const worker = new Worker(new URL('../src/ui/scan-worker.js', import.meta.url), { env });
  t.after(() => worker.terminate());
  const run = kind => new Promise((resolve, reject) => {
    const messages = [];
    const onMessage = m => { messages.push(m); if (m.done) { worker.off('message', onMessage); m.error ? reject(new Error(m.error)) : resolve(messages); } };
    worker.on('message', onMessage); worker.once('error', reject);
    worker.postMessage({ id: kind, kind, repo, window: kind === 'context' ? 7 : 6 });
  });
  const context = await run('context');
  // the checkpoints double; between the 2 and the 4 the readers pass the two new sessions and the count says 3, with no view
  const checkpoints = ms => ms.filter(m => m.view || m.total === ms.at(-1).total && m.completed === 0).map(m => m.completed);
  assert.deepEqual(checkpoints(context), [0, 1, 2, 4, 5]);
  assert.deepEqual(context.filter(m => !m.view && m.completed > 0).map(m => m.completed), [3]);
  assert.ok(context.every((m, i) => i === 0 || m.completed >= context[i - 1].completed), 'the count never falls');
  assert.ok(context.slice(1, -1).every(m => !m.done));
  assert.deepEqual(context.at(-1).view, contextView(store, { days: 7, sessions }));
  // Snapshot validity depends on the settings paths, which are isolated in the worker.
  const saved = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', 'context-view-7.json')));
  assert.deepEqual(saved.view, context.at(-1).view);
  const report = await run('report');
  assert.deepEqual(checkpoints(report), [0, 1, 2, 4, 5]);
  assert.deepEqual(report.filter(m => !m.view && m.completed > 0).map(m => m.completed), [3]);
  const final = report.at(-1).view;
  const cli = reportView(store, { weeks: 6, now: final.to, sessions });
  for (const field of ['sessionTotals', 'columns', 'tokenTypes', 'parts', 'models', 'sessionRows']) assert.deepEqual(final[field], cli[field], field);
  assert.deepEqual(readReport(store, 6).view, final);
});

test('a cold progressive HTTP read returns immediately, then serves the finished snapshot', async t => {
  const { root, store } = fixture(t);
  const ui = createUiServer(store, { home: path.join(root, 'thinker'), transcriptsHome: path.join(root, 'transcripts'), refreshFn: () => {}, refreshReportFn: () => {} });
  t.after(() => ui.close());
  const { url } = await ui.listen(0);
  const get = async p => { const res = await fetch(url + p); assert.equal(res.status, 200); return res.json(); };
  await get('api/repos');
  const cold = await get('api/context?repo=all&days=7&progressive=1');
  assert.equal(cold.loading, true); assert.equal(cold.refreshing, true);
  assert.equal((await fetch(url)).status, 200, 'the page is still served while the worker runs');
  let last = cold;
  for (let i = 0; i < 100 && last.refreshing; i++) {
    await new Promise(r => setTimeout(r, 30));
    last = await get('api/context?repo=all&days=7&progressive=1');
  }
  assert.equal(last.refreshing, false); assert.equal(last.partial, false);
  assert.ok(last.totals); assert.ok(readSnapshot(store, 7));
});

test('the browser renders partial checkpoints, avoids duplicate tables, and ignores an abandoned request', async () => {
  const { default: vm } = await import('node:vm');
  const page = fs.readFileSync(new URL('../src/ui/page.html', import.meta.url), 'utf8');
  const code = page.slice(page.indexOf('async function progressiveView('), page.indexOf("$('#scan-retry').onclick"));
  const replies = [
    { loading: true, refreshing: true, revision: '0' },
    { refreshing: true, revision: '1' },
    { refreshing: true, partial: true, revision: '1', sessions: 1 },
    { refreshing: true, revision: '1' },
    { refreshing: false, revision: '2' },
    { refreshing: false, partial: false, revision: '2', sessions: 5 },
  ];
  const requests = [], drawn = [], progress = [];
  const context = vm.createContext({
    api: async url => { requests.push(url); assert.ok(replies.length); return replies.shift(); },
    scanProgress: v => progress.push(v), setTimeout: fn => fn(),
  });
  vm.runInContext(code, context);
  await context.progressiveView('/api/context?days=7', v => drawn.push(v), () => true);
  assert.deepEqual(drawn.map(v => v.sessions), [1, 5]);
  assert.equal(requests.filter(url => !url.includes('stamp=1')).length, 2);
  assert.equal(progress.at(-1).refreshing, false);
  let current = true;
  context.api = async () => { current = false; return { revision: 'late' }; };
  const before = progress.length;
  await context.progressiveView('/api/context?days=30', () => assert.fail('old window rendered'), () => current);
  assert.equal(progress.length, before, 'an abandoned request cannot update the new view’s bar');
});

test('the banner says the count, the share done and what is left, and goes when the read is over', async () => {
  const { default: vm } = await import('node:vm');
  const page = fs.readFileSync(new URL('../src/ui/page.html', import.meta.url), 'utf8');
  const code = page.slice(page.indexOf('function scanProgress('), page.indexOf('async function progressiveView('));
  const el = () => ({ hidden: false, textContent: '', classes: {}, classList: { toggle(c, on) { this.classes[c] = on; } }, removeAttribute(k) { delete this[k]; } });
  const els = {};
  for (const id of ['#scan-progress', '#scan-bar', '#scan-label', '#scan-pct', '#scan-note', '#scan-retry']) els[id] = el();
  els['#scan-progress'].classList = { toggle: (c, on) => { els['#scan-progress'].classes[c] = on; } };
  const context = vm.createContext({ $: id => els[id], fmt: n => n.toLocaleString('en-US'), navHeight: () => {} });
  vm.runInContext(code, context);
  context.scanProgress({ refreshing: true, progress: { completed: 412, total: 913 } });
  assert.equal(els['#scan-progress'].hidden, false);
  assert.equal(els['#scan-label'].textContent, 'Reading session data: 412 of 913 sessions');
  assert.equal(els['#scan-pct'].textContent, '45%');
  assert.match(els['#scan-note'].textContent, /^· 501 to go/);
  assert.equal(els['#scan-bar'].max, 913); assert.equal(els['#scan-bar'].value, 412); assert.equal(els['#scan-retry'].hidden, true);
  context.scanProgress({ refreshing: true, progress: { completed: 3, total: null } });
  assert.match(els['#scan-label'].textContent, /^Finding session data… 3 sessions read so far/);
  assert.equal(els['#scan-pct'].textContent, ''); assert.equal(els['#scan-bar'].value, undefined, 'no total: an indeterminate bar');
  context.scanProgress({ refreshing: false, progress: { completed: 2, total: 9, error: 'Unreadable session' } });
  assert.equal(els['#scan-progress'].hidden, false); assert.equal(els['#scan-retry'].hidden, false); assert.equal(els['#scan-progress'].classes.error, true);
  assert.match(els['#scan-label'].textContent, /Could not finish reading session data: Unreadable session/);
  context.scanProgress({ refreshing: false });
  assert.equal(els['#scan-progress'].hidden, true);
  context.scanProgress(null);
  assert.equal(els['#scan-progress'].hidden, true);
});

test('the browser handles an empty report and stops with an explicit cold-read error', async () => {
  const { default: vm } = await import('node:vm');
  const page = fs.readFileSync(new URL('../src/ui/page.html', import.meta.url), 'utf8');
  const code = page.slice(page.indexOf('async function progressiveView('), page.indexOf("$('#scan-retry').onclick"));
  const context = vm.createContext({ api: async () => ({ empty: true }), scanProgress: () => {}, setTimeout: fn => fn() });
  vm.runInContext(code, context);
  let result;
  await context.progressiveView('/api/report?repo=all', v => { result = v; }, () => true);
  assert.equal(result.empty, true);
  context.api = async () => ({ loading: true, refreshing: false, progress: { error: 'Disk unavailable' } });
  await assert.rejects(context.progressiveView('/api/report?repo=all', () => assert.fail('rendered no data'), () => true), /Disk unavailable/);
});

// All is paged 20 rows at a time and ranked by waste, so a row the weekly question numbered (or the installer's
// picker listed) could be checked on a page nobody had opened: the line above the Apply counted savings the person
// could not see. The checked rows come first on All, frozen when the door's list is resolved, so unchecking one does
// not move it (page.html:PRETOP, preselectRows, sortRows).
test('the rows a door checked come first on All, and stay where they are when one is unchecked', async () => {
  const { default: vm } = await import('node:vm');
  const page = fs.readFileSync(new URL('../src/ui/page.html', import.meta.url), 'utf8');
  const code = page.slice(page.indexOf('const PICKS = {'), page.indexOf('// a button says what it is doing while it works'));
  const context = vm.createContext({ pickKey: r => `${r.repo || ''}\t${r.key}` });
  const api = vm.runInContext(`${code}\n({ sortRows, preselectRows, PICKS, PRETOP })`, context);
  const row = (key, wastedWindow) => ({ key, name: key, view: 'all', wasted: 1, wastedWindow, window: wastedWindow, options: [['compress', 'Compress']] });
  const rows = [row('big', 900), row('mid', 500), row('small', 20)];
  // the rows come back from the vm's own Array, so the order is compared as text
  const keys = view => api.sortRows(rows, 'wasted', view).map(r => r.key).join(' ');
  assert.equal(keys('all'), 'big mid small', 'with nothing checked: most wasted first');
  api.preselectRows(rows, [{ kind: 'section', key: 'small', repo: null, act: 'compress' }]);
  assert.equal(keys('all'), 'small big mid', 'the checked row leads, the rest keep their order');
  assert.equal(keys('instructions'), 'big mid small', 'only All is preselected, so only All reorders');
  api.PICKS.all.delete('\tsmall');
  assert.equal(keys('all'), 'small big mid', 'unchecking does not move the row out from under the hand');
});

// A kept view this code made is brought up to date, not made again (2026-11-08): the worker is told when it was made
// and answers `unchanged` when no session and no log moved since; the view stands, the strip never shows, and the
// question is not asked again for REFRESH_MS. A changed session is read with the count over the changed ones alone.
test('a kept view is checked for changes, not read again; nothing changed means no read for REFRESH_MS', async t => {
  const { store } = fixture(t), worker = new FakeWorker();
  const scans = uiScans({ workerFactory: () => worker });
  t.after(() => scans.close());
  const { writeSnapshot } = await import('../src/context-snapshot.js');
  const madeAt = Date.now() - 3 * 600_000;
  writeSnapshot(store, 7, { sessions: 4 }, { now: madeAt });
  const first = scans.read('context', store, 7);
  assert.equal(first.view.sessions, 4, 'the kept view is served at once'); assert.equal(first.refreshing, true);
  assert.equal(worker.requests[0].since, madeAt, 'the worker is told when the view was made');
  worker.answer(0, { completed: 0, total: 0, done: true, unchanged: true, at: Date.now() });
  const same = scans.read('context', store, 7);
  assert.equal(same.view.sessions, 4); assert.equal(same.refreshing, false); assert.equal(same.at, madeAt, 'the figures are as old as they are');
  assert.equal(scanStatus([same]).progress, null, 'no strip for a check that found nothing');
  scans.read('context', store, 7); scans.read('context', store, 7);
  assert.equal(worker.requests.length, 1, 'not asked again within REFRESH_MS');
  // a view another copy of thinker made is read in full
  const f = path.join(store.dir, 'state', 'context-view-7.json'), kept = JSON.parse(fs.readFileSync(f, 'utf8'));
  kept.code = 'other'; fs.writeFileSync(f, JSON.stringify(kept));
  await scans.cancel();
  const scans2 = uiScans({ workerFactory: () => worker }); t.after(() => scans2.close());
  scans2.read('context', store, 7);
  assert.equal(worker.requests[1].since, null);
  // the count over the changed sessions is said to be so
  worker.answer(1, { completed: 1, total: 3, delta: true });
  const s = scanStatus([scans2.read('context', store, 7)]);
  assert.equal(s.progress.delta, true); assert.equal(s.progress.total, 3);
});

test('the real worker answers unchanged when nothing moved since the kept view, and reads one changed session on its own count', async t => {
  const { root, repo, store } = fixture(t);
  const env = { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'local', THINKER_HOME: path.join(root, 'thinker'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
  const transcripts = path.join(env.CLAUDE_CONFIG_DIR, 'projects', repo.replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(transcripts, { recursive: true });
  const files = [];
  for (let i = 0; i < 3; i++) {
    const file = path.join(transcripts, `s${i}.jsonl`), timestamp = new Date().toISOString();
    fs.writeFileSync(file, [
      { type: 'user', cwd: repo, timestamp, message: { role: 'user', content: 'Read AGENTS.md and run the tests.' } },
      { type: 'assistant', timestamp, message: { id: `m${i}`, model: 'claude-sonnet-4-20250514', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: (i + 1) * 1000, output_tokens: 50 } } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    files.push(file);
  }
  const worker = new Worker(new URL('../src/ui/scan-worker.js', import.meta.url), { env });
  t.after(() => worker.terminate());
  let n = 0;
  const run = (kind, since) => new Promise((resolve, reject) => {
    const messages = [], id = `${kind}${++n}`;
    const onMessage = m => { if (m.id !== id) return; messages.push(m); if (m.done) { worker.off('message', onMessage); m.error ? reject(new Error(m.error)) : resolve(messages); } };
    worker.on('message', onMessage); worker.once('error', reject);
    worker.postMessage({ id, kind, repo, window: kind === 'context' ? 7 : 6, since });
  });
  const cold = await run('context');
  const madeAt = cold.at(-1).at;
  // nothing moved: one message, no view, the kept one stands
  const same = await run('context', madeAt);
  assert.equal(same.length, 1); assert.equal(same[0].unchanged, true); assert.equal(same[0].view, undefined);
  // one session written since: the count is over that one, the view is the whole window's
  await new Promise(r => setTimeout(r, 5));
  const later = new Date(); // after `madeAt`, never in the future: the report's check below must not see it as changed again
  fs.appendFileSync(files[1], JSON.stringify({ type: 'user', cwd: repo, timestamp: later.toISOString(), message: { role: 'user', content: 'again' } }) + '\n');
  fs.utimesSync(files[1], later, later);
  const delta = await run('context', madeAt);
  assert.deepEqual(delta[0], { id: delta[0].id, completed: 0, total: 1, delta: true });
  assert.equal(delta.at(-1).total, 1); assert.equal(delta.at(-1).completed, 1); assert.equal(delta.at(-1).delta, true);
  const sessions = files.map(file => ({ client: 'claude', file, session: path.basename(file, '.jsonl'), mtime: fs.statSync(file).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  assert.deepEqual(delta.at(-1).view, contextView(store, { days: 7, sessions }), 'the same view as a full read');
  // the Report is also read again when the log moved, with no session changed
  const rep = await run('report');
  const repAt = rep.at(-1).at;
  assert.equal((await run('report', repAt))[0].unchanged, true);
  await new Promise(r => setTimeout(r, 5));
  fs.appendFileSync(path.join(store.dir, 'log.jsonl'), JSON.stringify({ t: new Date().toISOString(), op: 'request', repo, session: 'x' }) + '\n');
  const logged = await run('report', repAt);
  assert.deepEqual(logged[0], { id: logged[0].id, completed: 0, total: 0, delta: true });
  assert.equal(logged.at(-1).done, true); assert.ok(logged.at(-1).view);
});
