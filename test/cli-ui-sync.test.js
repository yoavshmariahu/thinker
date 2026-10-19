// The command line and the local page are two doors to the same build (AGENTS.md, "stay in sync"):
// a default the warm-up page shows is the default `thinker setup --build --yes` takes, and a job the
// page queues runs the command line with the flags the person would have typed. The defaults live in
// one place each: DEFAULT_DISTILL_MODEL (llm.js), DEFAULT_DEPTH and DEFAULT_PRS (setup/estimate.js),
// activityAreas (areas.js). This file checks that both doors read them, on the wire where it can and
// in the source where the page's own script cannot run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { Store } from '../src/store.js';
import { createUiServer } from '../src/ui/server.js';
import { chooseProject } from '../src/setup/project.js';
import { activityAreas } from '../src/areas.js';
import { DEFAULT_DISTILL_MODEL } from '../src/llm.js';
import { DEFAULT_DEPTH, DEFAULT_PRS, DEPTHS } from '../src/setup/estimate.js';
import { buildModel } from '../src/setup/models.js';
import { areasConfig, refreshAreas } from '../src/areas.js';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A repository the test user committed to in src/api four times: their focus area is src/api.
function repo(t) {
  const dir = fs.realpathSync(tmp('thinker-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src', 'api'), { recursive: true }); fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs/x.md'), '# x\n'); fs.writeFileSync(path.join(dir, 'src/api/a.js'), 'export const a = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  for (let i = 0; i < 4; i++) { fs.writeFileSync(path.join(dir, 'src/api/a.js'), `export const a = ${i + 2};\n`); git('commit', '-qam', `fix: bump ${i}`); }
  return dir;
}

// The page's server over a transcripts home that names the repository, with the build spawn captured.
function page(t, dir) {
  const home = tmp('thinker-sync-home-'), th = tmp('thinker-sync-th-');
  const claude = path.join(th, '.claude', 'projects', dir.replace(/[/.]/g, '-')); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 's1.jsonl'), JSON.stringify({ type: 'user', cwd: dir, message: 'hi' }) + '\n');
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); spawned.push({ args, opts, pid: c.pid }); return c; };
  const token = 'a'.repeat(32);
  const ui = createUiServer(new Store(dir), { token, home, transcriptsHome: th, cliPath: '/x/cli.js', spawnFn });
  const call = (port, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${port}`, 'x-thinker-token': token, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  return {
    spawned,
    async start() {
      const { port } = await ui.listen(0);
      t.after(async () => { await ui.close(); for (const s of spawned) { try { process.kill(s.pid, 'SIGKILL'); } catch {} } });
      return {
        get: async p => { const r = await call(port, p); assert.equal(r.status, 200, r.body); return JSON.parse(r.body); },
        post: async (p, body) => { const r = await call(port, p, body); return { status: r.status, ...JSON.parse(r.body) }; },
      };
    },
  };
}

test('the model the warm-up page offers by default is the one the command line mines with', async t => {
  const dir = repo(t);
  const { get } = await page(t, dir).start();
  const machine = await get('/api/machine');
  assert.equal(machine.defaultTier, DEFAULT_DISTILL_MODEL, 'the warm-up page');
  assert.equal(machine.tiers, undefined, 'no model options are offered');
  const agents = await get('/api/agents');
  assert.equal(agents.defaultTier, DEFAULT_DISTILL_MODEL, 'the agent picker');
  for (const agent of agents.agents) {
    assert.deepEqual(agent.model, buildModel(agent.agent), 'terminal and page share the automatic model');
    assert.equal(agent.models, undefined, 'the page offers only a harness choice');
  }
  assert.ok(!read('ui/page.html').includes('w-tier'), 'the model dropdown is removed');
  // the command line: mine-prs, the session distill and the skill reader fall back to the same constant, and
  // nowhere does a literal name a different default
  for (const f of ['commands/learn.js', 'skills.js']) {
    const src = read(f);
    assert.ok(src.includes("distillModel || DEFAULT_DISTILL_MODEL"), `${f} falls back to DEFAULT_DISTILL_MODEL`);
    assert.ok(!/distillModel \|\| '[a-z]+'/.test(src), `${f} names no literal default model`);
  }
  assert.ok(!/defaultTier: '/.test(read('ui/server.js')), 'the page server names no literal default model');
});

test('a repository the page lists starts on the areas the command line would build, and a queued job runs that command', async t => {
  const dir = repo(t);
  // the command line, answered with --yes: the person's areas, from their own commits
  const lines = [];
  const project = await chooseProject({ repo: dir, store: null, flags: { yes: true }, interactive: false, out: s => lines.push(s) });
  assert.deepEqual(project?.directories, ['src/api'], lines.join('\n'));
  // the page lists the same areas for the same checkout (what its default pick and a hand pick start from)
  const p = page(t, dir);
  const { get, post } = await p.start();
  const machine = await get('/api/machine');
  const row = machine.repos.find(r => r.checkout === dir);
  assert.ok(row, 'the repository is on the page');
  assert.deepEqual(row.areas, project.directories, 'the page shows the areas the command line picks');
  assert.deepEqual(row.areas, activityAreas(dir, { noGitHub: true }).directories);
  // a warm-up queued as the page sends it: the areas as directories, no depth named
  const queued = await post('/api/warmup', { repos: [{ checkout: dir, directories: row.areas, automatic: true }] });
  assert.equal(queued.status, 200, JSON.stringify(queued));
  assert.equal(queued.jobs[0].depth, DEFAULT_DEPTH, 'the depth the page falls back to is the command line default');
  assert.deepEqual(queued.jobs[0].directories, ['src/api']);
  assert.equal(p.spawned.length, 1);
  const args = p.spawned[0].args;
  assert.deepEqual(args.slice(0, 6), ['/x/cli.js', 'setup', '--build', '--yes', '--no-ui', '--no-benchmark'], 'the job is the setup command, answered yes');
  assert.deepEqual(args.slice(args.indexOf('--depth'), args.indexOf('--depth') + 2), ['--depth', DEFAULT_DEPTH]);
  assert.equal(queued.jobs[0].automatic, true);
  assert.ok(!args.includes('--directories'), 'automatic areas use the command default, not a manual scope');
  assert.ok(!args.includes('--full-repo'), 'not the whole repository');
  assert.ok(!args.includes('--prs'), 'the pull-request count is the command line default (DEFAULT_PRS), not a second number');
  assert.equal(DEFAULT_PRS, 60); assert.equal(DEFAULT_DEPTH, DEPTHS[0]);
  // Execute the scope selection the queued command uses, then check maintenance follows activity.
  const store = new Store(dir).init();
  await chooseProject({ repo: dir, store, flags: { yes: true }, interactive: false, out: () => {} });
  assert.equal(areasConfig(store).source, 'activity');
  refreshAreas(store, dir, { now: Date.now() + 2 * 86400_000, find: () => ({ source: 'activity', directories: ['src/db'] }) });
  assert.deepEqual(areasConfig(store).directories, ['src/db']);
});

test('a manual page selection stays manual even when it equals the suggested areas; Clear means the whole repo', async t => {
  for (const directories of [['src/api'], []]) {
    const dir = repo(t), p = page(t, dir);
    const { post } = await p.start();
    const result = await post('/api/warmup', { repos: [{ checkout: dir, directories, automatic: false }] });
    assert.equal(result.status, 200);
    const args = p.spawned[0].args;
    const flags = directories.length ? { directories: args[args.indexOf('--directories') + 1] } : { 'full-repo': args.includes('--full-repo') };
    const store = new Store(dir).init();
    await chooseProject({ repo: dir, store, flags: { yes: true, ...flags }, interactive: false, out: () => {} });
    assert.equal(areasConfig(store).source, directories.length ? 'manual' : 'all');
    assert.equal(refreshAreas(store, dir, { now: Date.now() + 2 * 86400_000, find: () => ({ source: 'activity', directories: ['src/db'] }) }), null);
  }
});

test('the page chooses the default model for the harness, ignoring obsolete model selections', async t => {
  const dir = repo(t);
  const p = page(t, dir);
  const { post } = await p.start();
  const custom = await post('/api/warmup', { repos: [{ checkout: dir }], agent: 'codex', tier: 'gpt-6-sol' });
  assert.equal(custom.status, 200);
  assert.equal(custom.jobs.at(-1).model, DEFAULT_DISTILL_MODEL);
  assert.equal(p.spawned[0].args[p.spawned[0].args.indexOf('--model') + 1], DEFAULT_DISTILL_MODEL);
  assert.equal(p.spawned[0].opts.env.THINKER_LLM, 'codex');
});

test('the page script builds a pick from the areas, and names the depth the command line takes', () => {
  const html = read('ui/page.html');
  // every selection the page creates on its own starts from r.areas; only the picker's Clear empties it
  assert.equal((html.match(/directories: \[\]/g) || []).length, 0, 'no selection starts as the whole repository');
  assert.ok((html.match(/directories: \[\.\.\.\((W\.repos\.find\([^)]*\)\?|r)\.areas \|\| \[\]\)\], automatic: true/g) || []).length >= 2, 'the default pick and a hand pick both start from automatic areas');
  assert.ok(html.includes("sel.directories = []"), 'Clear is the one way to the whole repository');
  assert.equal((html.match(/sel\.automatic = false/g) || []).length, 2, 'Clear and directory edits both opt out of automatic areas');
  assert.ok(html.includes('automatic: s.automatic'), 'the page sends the scope choice to the command queue');
  assert.ok(html.includes(`depth: '${DEFAULT_DEPTH}'`), 'a pick starts at the command line depth');
  // the command line answered yes takes the same depth
  assert.ok(read('setup.js').includes('yes ? (depth || DEFAULT_DEPTH)'), 'setup --yes takes DEFAULT_DEPTH');
  assert.ok(read('commands/setup.js').includes('num(flags.prs, DEFAULT_PRS)'), 'setup reads DEFAULT_PRS');
  assert.ok(read('machine.js').includes('prs: DEFAULT_PRS'), 'the page estimates with DEFAULT_PRS');
});

test('CLI and page expose the shared Codex harness report and qualified undo controls', () => {
  assert.match(read('commands/harness.js'), /harnessUsage\(repo/);
  assert.match(read('ui/server.js'), /harnessView\(/);
  assert.match(read('cli.js'), /Claude Code and Codex record loading/);
  assert.match(read('ui/page.html'), /Recorded in Claude Code and Codex transcripts/);
  assert.match(read('ui/page.html'), /data-hundo="\$\{esc\(s.key \|\| s.name\)\}"/);
  assert.match(read('commands/hooks.js'), /\['claude', 'codex'\]\.includes\(client\).*harnessRecall/);
});
