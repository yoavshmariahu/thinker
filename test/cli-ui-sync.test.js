// The command line and the local page are two doors to the same commands (AGENTS.md, "stay in sync"):
// what the page shows and does is what the command shows and does. This file checks that both doors read
// the same functions, on the wire where it can and in the source where the page's own script cannot run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { Store } from '../src/store.js';
import { createUiServer } from '../src/ui/server.js';
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

test('CLI and page expose the shared Claude Code, Codex and Cursor harness report and qualified undo controls', () => {
  assert.match(read('commands/harness.js'), /harnessUsage\(repo/);
  assert.match(read('ui/server.js'), /harnessView\(/);
  assert.match(read('cli.js'), /Claude Code, Codex and Cursor record loading/);
  // the page switches tools off and back on, and sets an output's compression, from a row's dropdown and Apply: through
  // /api/changes/approve and context-suggest.js:approveChanges, which calls the same functions as `thinker context
  // --switch-off|--switch-on|--output-compression`, and records the decision for History's Revert
  assert.match(read('ui/page.html'), /api\('\/api\/changes\/approve', \{ repo, \.\.\.g, days: cdays \}\)/);
  assert.match(read('context-suggest.js'), /switchSources\(store, \{ keys: \[c\.sourceKey \|\| c\.name\], on: true \}\)/);
  assert.match(read('context-suggest.js'), /setOutputCompression\(store, \[c\.name\], level\)/);
  assert.match(read('ui/page.html'), /cursor: 'Cursor'/);
  assert.match(read('commands/context.js'), /switchSources\(store, \{ keys: list\(flags\['switch-on'\]\), on: true \}\)/);
  assert.match(read('commands/hooks.js'), /harnessHere = \['claude', 'codex', 'cursor'\]\.includes\(client\)[\s\S]*harnessHere \? await harnessRecall/);
  assert.match(read('commands/hooks.js'), /snapshotCursorInventory\(/);
});

test('the Context tab and `thinker context` show one report, and its controls are the commands', async t => {
  assert.match(read('commands/context.js'), /contextView\(store/);
  // the page reads the report kept by `thinker context --refresh`, which it starts in the background (context-snapshot.js)
  assert.match(read('ui/server.js'), /snapshotView\(st, d\)/);
  assert.match(read('ui/server.js'), /\[cliPath, 'context', '--refresh'/);
  assert.match(read('context-snapshot.js'), /contextView\(store, \{ days: d \}\)/);
  assert.match(read('commands/context.js'), /refreshSnapshots\(store\)/);
  // the installer's report (context-machine.js) is the page's All repositories: one merge, and the reports it
  // keeps are the snapshots the page reads; the page opens on it (`thinker ui --tab context --all`)
  const machine = read('context-machine.js'), install = fs.readFileSync(path.join(SRC, '..', 'install.sh'), 'utf8');
  assert.match(install, /"\$thinker" context --machine/);
  assert.match(install, /ui --from-setup --tab context --all/);
  assert.match(read('commands/context.js'), /machineContext\(store, \{ days, limit/);
  assert.match(machine, /mergeViews\(views\)/); assert.match(read('ui/server.js'), /mergeViews\(xs\.map/);
  assert.match(machine, /writeSnapshot\(st, d, v/); assert.match(machine, /refreshCheckouts\(store/);
  assert.match(read('commands/cache.js'), /flags\.all \? '&repo=all'/);
  assert.match(read('ui/page.html'), /H\(\)\.get\('repo'\) === 'all' \? 'all'/);
  // setup prints the same report for its one repository
  assert.match(read('setup.js'), /renderMachineReport\(\{ days: 30/);
  // keeping sections is `thinker instructions --core`; judging is `thinker context --judge n`; a switch is `thinker harness --off`
  assert.match(read('commands/instructions.js'), /setCore\(store, keep/);
  assert.match(read('ui/server.js'), /\/api\/context\/core'\) \{[^\n]*setCore\(st/);
  assert.match(read('commands/context.js'), /judgeRecent\(store/);
  assert.match(read('ui/server.js'), /\/api\/context\/judge'\) \{[^\n]*judgeRecent\(st/);
  assert.match(read('commands/harness.js'), /switchOffNow\(store, String\(flags.off\), \{ via: 'cli', any: true \}\)/);
  assert.match(read('ui/server.js'), /switchOffNow\(st, b.labels.join\(','\), \{ via: 'ui', any: true \}\)/);
  const dir = repo(t); new Store(dir).init();
  const p = await page(t, dir).start();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# R\n\n## Tests\n\nRun `npm test`.\n\n## Style\n\nShort lines.\n');
  const id = (await p.get('/api/repos')).repos[0].id;
  const v = await p.get(`/api/context?repo=${encodeURIComponent(id)}&days=7`);
  assert.deepEqual(v.instructions.sections.map(s => s.title), ['Tests', 'Style']);
  const r = await p.post('/api/context/core', { repo: id, keep: ['Tests'] });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(new Store(dir).config().instructions.core.keep, ['Tests']);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.override.md'), 'utf8'), /## Tests/);
  assert.equal((await p.get(`/api/context?repo=${encodeURIComponent(id)}&days=7`)).instructions.sections.find(s => s.title === 'Tests').kept, true);
  await p.post('/api/context/core', { repo: id, keep: null });
  assert.equal(fs.existsSync(path.join(dir, 'AGENTS.override.md')), false);
});

test('All and History on the Context tab are `thinker context --approve|--dismiss|--revert|--history`', () => {
  // the command picks from the top five less the decisions (context-suggest.js:currentChanges), the page's rows from every
  // part (allChanges); both act through the same functions, and the page's section Apply records its undo (applyReviewed)
  assert.match(read('ui/server.js'), /pickChanges\(allChanges\(changesView\(st, /);
  assert.match(read('ui/server.js'), /\bapplyReviewed\(st, picked, /);
  assert.match(read('ui/page.html'), /\/api\/changes\/apply', \{ repo, keys: rows\.map\(r => r\.key\), edit: p\.key, files/);
  for (const [f, st] of [['commands/context.js', 'store'], ['ui/server.js', 'st']]) {
    assert.match(read(f), new RegExp(`currentChanges\\(${st}, `));
    assert.match(read(f), /\bapproveChanges\b/);
    assert.match(read(f), /\bdismissChanges\b/);
    assert.match(read(f), /\brevertDecision\b/);
    assert.match(read(f), /\bchangeHistory\b/);
  }
  assert.match(read('ui/server.js'), /\/api\/changes\/approve/);
  assert.match(read('ui/server.js'), /\/api\/changes\/revert/);
  // the page's 7-day window is the command's suggested one (SUGGEST.days) and the session's summary links to that tab
  assert.match(read('ui/page.html'), /\/api\/changes\?repo=\$\{encodeURIComponent\(want\)\}&days=7/);
  assert.match(read('context-suggest.js'), /days: 7,/);
  assert.match(read('context-suggest.js'), /tab=context&view=all/);
  // the page's rows carry the keys allChanges gives, so the server finds the part a row's Apply names
  for (const k of ['`section:${s.file}:${s.id}`', '`${s.client}:${s.key}`', '`output:${s.name}`']) assert.ok(read('ui/page.html').includes(k), k);
});
