// The machine-wide page: the repositories the agents worked in (machine.js), what runs against a
// cache and how it is stopped (activity.js), and the warm-up builds the page queues (ui/server.js).
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
import { agentWorkDirs, discoverRepos, warmupCandidates, cacheStats } from '../src/machine.js';
import { createUiServer, machineRepos, jobProgress } from '../src/ui/server.js';

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

test('the agents\' transcripts name the repositories they worked in, with their estimates and top-level directories', t => {
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
  const [c] = warmupCandidates(store, { home });
  assert.ok(c.canMine, 'enough git history to read');
  assert.deepEqual(c.dirs, ['docs', 'src']);
  assert.ok(c.estimates.full.seconds > c.estimates.shallow.seconds);
  assert.ok(c.estimates.full.tokens > 0 && c.estimates.shallow.tokens > 0);
  assert.equal(cacheStats(dir), null, 'no cache, no stats');
  // an empty .thinker folder (every checkout an agent worked in has one) is no cache; notes are
  const st = new Store(dir).init();
  assert.equal(discoverRepos(store, { home })[0].hasCache, false, 'a folder without notes is not a cache');
  st.put({ id: 'n1', title: 'a note', kind: 'rule', answers: [], body: 'src/a.js:a is one', deps: [{ path: 'src/a.js', symbol: 'a' }], source: { type: 'session', ref: 's' }, confidence: 0.8, status: 'fresh' });
  const [again] = warmupCandidates(store, { home });
  assert.equal(again.hasCache, true); assert.equal(again.notes, 1); assert.equal(again.warmed, false, 'no pull requests read yet');
});

test('a warm-up build reports where it is: the stage, the fraction done and the seconds left', async t => {
  const { dir } = repo(t);
  const store = new Store(dir).init();
  const now = Date.now();
  const job = { checkout: dir, started: new Date(now - 60_000).toISOString(), estimateSeconds: 400 };
  // before the mining batch: the design documents, with the whole build ahead
  let p = jobProgress(job, { now });
  assert.match(p.stage, /design documents/); assert.ok(p.fraction > 0 && p.fraction < 0.1, String(p.fraction)); assert.ok(p.etaSeconds > 400 && p.etaSeconds < 520, String(p.etaSeconds));
  // the mining batch at its pace: 2 of 10 in 40s is 160s more, plus the last stage
  const file = path.join(store.dir, 'state', `pr-mining-${now - 40_000}-${process.pid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const rec = r => JSON.stringify({ time: new Date(now).toISOString(), ...r }) + '\n';
  fs.writeFileSync(file, rec({ event: 'batch', name: 'PR mining', total: 10 }) + rec({ event: 'start', item: 'PR #1' }) + rec({ event: 'complete', item: 'PR #1', notes: ['a'] }) + rec({ event: 'start', item: 'PR #2' }) + rec({ event: 'complete', item: 'PR #2', notes: [] }) + rec({ event: 'start', item: 'PR #3' }));
  const b = latestBatch(store.dir, 'pr-mining', now - 60_000);
  assert.equal(b.completed, 2); assert.equal(b.current, 'PR #3'); assert.equal(b.done, false); assert.equal(b.startedMs, now - 40_000);
  assert.equal(batchEta(b, b.startedMs, now), 160);
  assert.equal(latestBatch(store.dir, 'pr-mining', now), null, 'none started since then');
  p = jobProgress(job, { now });
  assert.equal(p.stage, 'mining 2/10 PRs'); assert.equal(p.current, 'PR #3'); assert.equal(p.saved, 1);
  assert.ok(p.fraction > 0.1 && p.fraction < 0.4, String(p.fraction)); assert.equal(p.etaSeconds, 160 + 75);
  assert.equal(activity(store.dir).etaSeconds, 160, 'the live batch carries the same ETA');
  // the batch finished a minute ago: the last stage, nearly over
  fs.appendFileSync(file, rec({ event: 'finish', completed: 10, saved: 7 }).replace(new Date(now).toISOString(), new Date(now - 60_000).toISOString()));
  p = jobProgress(job, { now });
  assert.match(p.stage, /phrasings/); assert.ok(p.fraction > 0.9 && p.fraction < 1, String(p.fraction)); assert.equal(p.etaSeconds, 15); assert.equal(p.saved, 1, 'notes counted from the items completed');
  assert.equal(batchEta({ total: 4, completed: 0 }, now, now), null); assert.equal(batchEta({ total: 4, completed: 4 }, now, now), 0);
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

test('the page lists caches with their stats, queues warm-up builds one at a time, and stops one', async t => {
  const { dir } = repo(t);
  const other = repo(t, 'thinker-machine-b-');
  const store = new Store(dir).init();
  store.put({ id: 'n1', title: 'a note', kind: 'rule', answers: [], body: 'src/a.js:a is one', deps: [{ path: 'src/a.js', symbol: 'a' }], source: { type: 'pr', ref: 'o/r#1' }, confidence: 0.8, status: 'fresh', uses: 3 });
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  const home = tmp('thinker-ui-home-'), th = tmp('thinker-ui-th-');
  const claude = path.join(th, '.claude', 'projects', 'x'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 's.jsonl'), JSON.stringify({ cwd: other.dir }) + '\n');
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); spawned.push({ args, opts, pid: c.pid }); return c; };
  const ui = createUiServer(store, { token: 'a'.repeat(32), home, transcriptsHome: th, cliPath: '/x/cli.js', spawnFn });
  const { port } = await ui.listen(0);
  t.after(async () => { await ui.close(); for (const s of spawned) { try { process.kill(s.pid, 'SIGKILL'); } catch {} } });
  const get = async p => { const r = await call(port, p, { token: 'a'.repeat(32) }); assert.equal(r.status, 200, r.body); return JSON.parse(r.body); };
  const post = (p, body) => call(port, p, { token: 'a'.repeat(32), body });

  const repos = await get('/api/repos');
  assert.equal(repos.repos.length, 1, 'only the checkout with a cache');
  assert.equal(repos.repos[0].stats.notes, 1); assert.equal(repos.repos[0].stats.hits, 3); assert.equal(repos.repos[0].stats.activity, null);
  assert.deepEqual(machineRepos(store, { home: th }).map(r => r.checkout), [dir]);
  const machine = await get('/api/machine');
  assert.deepEqual(machine.repos.map(r => r.checkout).sort(), [dir, other.dir].sort(), 'both checkouts, with or without a cache');
  assert.ok(Array.isArray(machine.tiers));
  const agents = await get('/api/agents');
  assert.ok(Array.isArray(agents.agents) && agents.agents.every(a => a.models.length === 3));

  // two builds queued: the first starts at once, the second waits for it
  assert.equal((await post('/api/warmup', { repos: [{ checkout: '/nope', depth: 'full' }] })).status, 400, 'only a listed repository');
  const started = await post('/api/warmup', { repos: [{ checkout: other.dir, depth: 'shallow', directories: ['src', 'nope'] }, { checkout: dir, depth: 'full' }], agent: 'claude', tier: 'haiku' });
  assert.equal(started.status, 200, started.body);
  const jobs = JSON.parse(started.body).jobs;
  assert.equal(jobs.length, 2);
  assert.equal(spawned.length, 1, 'one at a time');
  assert.deepEqual(spawned[0].args.slice(0, 8), ['/x/cli.js', 'setup', '--build', '--yes', '--no-ui', '--no-benchmark', '--depth', 'shallow']);
  assert.ok(spawned[0].args.includes('--directories') && spawned[0].args.includes('src') && !spawned[0].args.join(' ').includes('nope'));
  assert.ok(spawned[0].args.includes('--model') && spawned[0].args.includes('haiku'));
  assert.equal(spawned[0].opts.env.THINKER_LLM, 'claude');
  assert.equal(spawned[0].opts.cwd, other.dir);
  const act = await get('/api/activity');
  assert.equal(act.jobs.filter(j => j.status === 'running').length, 1);
  assert.equal(act.jobs.filter(j => j.status === 'queued').length, 1);
  const running = act.jobs.find(j => j.status === 'running');
  assert.ok(running.estimateSeconds > 0, 'the estimate the page showed travels with the job');
  assert.ok(running.progress.fraction >= 0 && running.progress.fraction < 1 && running.progress.etaSeconds > 0, JSON.stringify(running.progress));
  assert.equal(act.jobs.find(j => j.status === 'queued').progress, undefined);
  assert.equal(ui.idleMs(), 0, 'a queued build keeps the server up');
  assert.ok(fs.existsSync(path.join(home, 'state', 'warmup.json')));
  // the first is stopped: the second starts
  const stop = await post('/api/warmup/cancel', { id: act.jobs.find(j => j.status === 'running').id });
  assert.equal(stop.status, 200, stop.body);
  await new Promise(r => setTimeout(r, 300));
  const after = await get('/api/activity');
  assert.equal(after.jobs.find(j => j.checkout === other.dir).status, 'cancelled');
  assert.equal(after.jobs.find(j => j.checkout === dir).status, 'running');
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[1].args.slice(6, 8), ['--depth', 'full']);
  assert.ok(spawned[1].args.includes('--full-repo'));
  // a mining batch of that build is the repository's activity, and stopping it from the card stops the build
  const file = path.join(store.dir, 'state', `pr-mining-${Date.now()}-${spawned[1].pid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [JSON.stringify({ event: 'batch', name: 'PR mining', total: 10 }), JSON.stringify({ event: 'start', item: 'PR #3' })].join('\n') + '\n');
  const live = await get('/api/activity');
  assert.equal(live.repos[repos.repos[0].id].status, 'mining 0/10 PRs');
  const stopped = await post('/api/activity/cancel', { repo: repos.repos[0].id, pid: spawned[1].pid });
  assert.equal(stopped.status, 200, stopped.body);
  await new Promise(r => setTimeout(r, 300));
  const end = await get('/api/activity');
  assert.equal(end.repos[repos.repos[0].id], null);
  assert.equal(end.jobs.find(j => j.checkout === dir).status, 'cancelled');
  assert.ok(end.jobs.every(j => j.status === 'cancelled'));
  assert.ok(ui.idleMs() >= 0 && !ui.jobs.active());
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

test('the switch flips a repository off and on without rebuilding the page\'s lists, and the warm-up sees the change', async t => {
  const { dir } = repo(t);
  const th = tmp('thinker-sw-th-');
  const claude = path.join(th, '.claude', 'projects', dir.replace(/[/.]/g, '-')); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 's1.jsonl'), JSON.stringify({ type: 'user', cwd: dir, message: 'hi' }) + '\n');
  const home = tmp('thinker-sw-home-');
  const ui = createUiServer(new Store(dir), { token: 'a'.repeat(32), home, transcriptsHome: th, cliPath: '/x/cli.js', spawnFn: () => { throw new Error('no build expected'); } });
  const { port } = await ui.listen(0);
  t.after(() => ui.close());
  const get = async p => { const r = await call(port, p, { token: 'a'.repeat(32) }); assert.equal(r.status, 200, r.body); return JSON.parse(r.body); };
  const post = async (p, body) => { const r = await call(port, p, { token: 'a'.repeat(32), body }); return { status: r.status, ...JSON.parse(r.body) }; };
  assert.equal((await get('/api/machine')).repos.find(r => r.checkout === dir).disabled, false);
  // off: the page's lists are kept and the flag is flipped in place, so the next call answers at once
  const offAt = Date.now();
  assert.equal((await post('/api/repos/switch', { checkout: dir, disabled: true })).disabled, true);
  const on = await post('/api/repos/switch', { checkout: dir, disabled: false });
  const onMs = Date.now() - offAt;
  assert.equal(on.disabled, false);
  assert.ok(onMs < 1000, `two switches in a row took ${onMs}ms: the warm-up list was rebuilt`);
  assert.equal((await get('/api/machine')).repos.find(r => r.checkout === dir).disabled, false);
  // while off, a warm-up of it is refused, and on again it is accepted by the kept list
  await post('/api/repos/switch', { checkout: dir, disabled: true });
  assert.equal((await post('/api/warmup', { repos: [{ checkout: dir }] })).status, 400);
  await post('/api/repos/switch', { checkout: dir, disabled: false });
  assert.equal((await get('/api/repos')).repos.length, 0, 'no cache yet, so the cache list is empty either way');
});
