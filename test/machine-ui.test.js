// The machine-wide page: the repositories the agents worked in (machine.js), what runs against a
// cache and how it is stopped (activity.js), and the page's server (ui/server.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { Store } from '../src/store.js';
import { batchProgress } from '../src/progress.js';
import { activity, cancelActivity, latestBatch, batchEta } from '../src/activity.js';
import { agentWorkDirs, discoverRepos, cacheStats } from '../src/machine.js';
import { createUiServer, machineRepos } from '../src/ui/server.js';

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
function repo(t, name = 'thinker-machine-') {
  const dir = fs.realpathSync(tmp(name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export const a = 1;\n'); fs.writeFileSync(path.join(dir, 'docs/x.md'), '# x\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  for (let i = 0; i < 6; i++) { fs.writeFileSync(path.join(dir, 'src/a.js'), `export const a = ${i + 2};\n`); git('commit', '-qam', `fix: bump ${i}`); }
  return { dir, git };
}
const call = (port, p, { token, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${port}`, 'x-thinker-token': token, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
    let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, body: s }));
  });
  req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
});

test('the agents\' transcripts name the repositories they worked in', t => {
  const { dir } = repo(t);
  const home = tmp('thinker-th-');
  // a Claude Code transcript names its cwd; a Codex session likewise, by date; a Cursor project its workspace
  const claude = path.join(home, '.claude', 'projects', dir.replace(/[/.]/g, '-')); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 's1.jsonl'), JSON.stringify({ type: 'user', cwd: path.join(dir, 'src'), message: 'hi' }) + '\n');
  const d = new Date(), codex = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')); fs.mkdirSync(codex, { recursive: true });
  fs.writeFileSync(path.join(codex, 'rollout-1.jsonl'), JSON.stringify({ payload: { cwd: dir } }) + '\n');
  const cursor = path.join(home, '.cursor', 'projects', 'p1'); fs.mkdirSync(path.join(cursor, 'agent-transcripts', 'c1'), { recursive: true });
  fs.writeFileSync(path.join(cursor, '.workspace-trusted'), JSON.stringify({ workspacePath: dir })); fs.writeFileSync(path.join(cursor, 'agent-transcripts', 'c1', 'c1.jsonl'), '{}\n');
  // the home directory itself, and a directory that is no checkout, are not repositories
  const stray = path.join(home, '.claude', 'projects', 'other'); fs.mkdirSync(stray); fs.writeFileSync(path.join(stray, 's.jsonl'), JSON.stringify({ cwd: home }) + '\n');
  const saved = process.env.CODEX_HOME; process.env.CODEX_HOME = path.join(home, '.codex'); t.after(() => { if (saved === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved; });
  const dirs = agentWorkDirs({ home });
  assert.equal(dirs.filter(x => x.dir === dir || x.dir === path.join(dir, 'src')).length, 3);
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  const store = new Store(tmp('thinker-cwd-'));
  const found = discoverRepos(store, { home });
  assert.deepEqual(found.map(r => r.checkout), [dir], 'one checkout, the home directory left out');
  assert.deepEqual(found[0].checkouts, [dir]);
  assert.equal(found[0].sessions, 3);
  assert.equal(found[0].hasCache, false);
  assert.equal(cacheStats(dir), null, 'no cache, no stats');
  // an empty .thinker folder (every checkout an agent worked in has one) is no cache; notes are
  const st = new Store(dir).init();
  assert.equal(discoverRepos(store, { home })[0].hasCache, false, 'a folder without notes is not a cache');
  st.put({ id: 'n1', title: 'a note', kind: 'rule', answers: [], body: 'src/a.js:a is one', deps: [{ path: 'src/a.js', symbol: 'a' }], source: { type: 'session', ref: 's' }, confidence: 0.8, status: 'fresh' });
  assert.equal(discoverRepos(store, { home })[0].hasCache, true, 'a folder with a note is');
});

test('a running batch is the cache\'s activity, with its count, and stopping it closes the file', async t => {
  const { dir } = repo(t);
  const store = new Store(dir).init();
  assert.equal(activity(store.dir), null);
  // a batch of this process: live while it runs, gone once finished
  const p = batchProgress({ dir: store.dir, name: 'PR mining', total: 4, out: () => {}, silent: true });
  p.start('PR #1'); p.complete({ item: 'PR #1', notes: ['n1', 'n2'] }); p.start('PR #2');
  const a = activity(store.dir);
  assert.equal(a.kind, 'mining'); assert.equal(a.total, 4); assert.equal(a.completed, 1); assert.equal(a.saved, 2); assert.equal(a.current, 'PR #2');
  assert.equal(a.status, 'mining 1/4 PRs'); assert.equal(a.pid, process.pid);
  p.finish();
  assert.equal(activity(store.dir), null, 'finished');
  // a batch of a process that is gone is not activity
  fs.writeFileSync(path.join(store.dir, 'state', `distilling-sessions-${Date.now()}-999999.jsonl`), JSON.stringify({ event: 'batch', name: 'Distilling sessions', total: 3 }) + '\n');
  assert.equal(activity(store.dir), null);
  // one of another live process: it is stopped, and reads as stopped at once
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref();
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
  const file = path.join(store.dir, 'state', `distilling-sessions-${Date.now()}-${child.pid}.jsonl`);
  fs.writeFileSync(file, [JSON.stringify({ event: 'batch', name: 'Distilling sessions', total: 3 }), JSON.stringify({ event: 'start', item: 'claude s1' }), JSON.stringify({ event: 'complete', item: 'claude s1', notes: [] }), JSON.stringify({ event: 'start', item: 'codex s2' })].join('\n') + '\n');
  const b = activity(store.dir);
  assert.equal(b.status, 'distilling 1/3 sessions');
  assert.deepEqual(cancelActivity(store.dir, 12345), { error: 'nothing is running with that pid' });
  const r = cancelActivity(store.dir, child.pid);
  assert.equal(r.ok, true); assert.equal(r.kind, 'distilling');
  assert.equal(activity(store.dir), null);
  assert.match(fs.readFileSync(file, 'utf8'), /"event":"cancelled"/);
  await new Promise(res => child.on('exit', res));
});

test('usage for all repositories works from a directory that is no checkout', async t => {
  const cwd = tmp('thinker-ui-nogit-');
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  const ui = createUiServer(new Store(cwd), { token: 'a'.repeat(32), home: tmp('thinker-ui-home-'), transcriptsHome: tmp('thinker-ui-th-') });
  const { port } = await ui.listen(0);
  t.after(() => ui.close());
  const r = await call(port, '/api/usage?repo=all', { token: 'a'.repeat(32) });
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).notesInCache, 0);
  assert.equal((await call(port, '/api/repos', { token: 'a'.repeat(32) })).status, 200);
  assert.ok(!fs.existsSync(path.join(cwd, '.thinker')), 'nothing created outside a checkout');
});
