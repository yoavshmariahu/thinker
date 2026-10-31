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
  assert.deepEqual(context.map(m => m.completed), [0, 1, 2, 4, 5]);
  assert.ok(context.slice(1, -1).every(m => !m.done && m.view));
  assert.deepEqual(context.at(-1).view, contextView(store, { days: 7, sessions }));
  // Snapshot validity depends on the settings paths, which are isolated in the worker.
  const saved = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', 'context-view-7.json')));
  assert.deepEqual(saved.view, context.at(-1).view);
  const report = await run('report');
  assert.deepEqual(report.map(m => m.completed), [0, 1, 2, 4, 5]);
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
