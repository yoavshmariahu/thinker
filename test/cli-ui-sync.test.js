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
  const ui = createUiServer(new Store(dir), { home, transcriptsHome: th, cliPath: '/x/cli.js', spawnFn });
  const call = (port, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
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
  // one level of compression from the page (moderate): its rows offer Compress or No compression, never High, which only
  // `thinker context --output-compression <tools> --level high` sets, for an experiment arm (the owner's call, 2026-10-22)
  const page = read('ui/page.html');
  assert.doesNotMatch(page, /\['high', 'High compression'\]/); assert.doesNotMatch(read('context-suggest.js'), /text: 'High compression'/);
  assert.match(page, /const levelOpts = s => s\.compression \? \[\['uncompress', 'No compression'\]\] : \[\['compress', 'Compress'\]\]/);
  assert.match(read('commands/context.js'), /\['high', 'moderate'\]\.includes\(flags\.level\)/);
  // a built-in tool is switched off from its row through the same route, after the page's confirmation names what goes,
  // where it is written (harness.js: permissions.deny of .claude/settings.local.json) and how it comes back
  assert.match(page, /bold: s\.kind === 'tool'/);
  assert.match(page, /confirmDialog\(\{\s*title: `Switch off \$\{builtins\.length/);
  assert.match(page, /permissions\.deny<\/code> of <code>\.claude\/settings\.local\.json<\/code> in this repository/);
  assert.match(page, /<b>Revert<\/b> under History, <b>Turn back on<\/b> in the tool's row, or <code>thinker harness --undo<\/code>/);
  // every view opens with its Potential savings card
  assert.match(page, /const savingsCard = /);
  for (const k of ['all', 'instructions', 'custom', 'builtin', 'outputs']) assert.match(page, new RegExp(`savings: sav\\.${k}`), k);
  assert.match(read('ui/page.html'), /cursor: 'Cursor'/);
  assert.match(read('commands/context.js'), /switchSources\(store, \{ keys: list\(flags\['switch-on'\]\), on: true \}\)/);
  // the installer's picker (setup/context-ask.js, `thinker context --machine --ask`) applies its picks through the same
  // approveChanges, in each change's repository (context-machine.js:applyMachinePicks), and install.sh runs that command
  assert.match(read('context-machine.js'), /approve = approveChanges/);
  assert.match(read('setup/context-ask.js'), /apply = applyMachinePicks/);
  assert.match(fs.readFileSync(path.join(SRC, '..', 'install.sh'), 'utf8'), /context --machine --ask/);
  assert.match(read('commands/hooks.js'), /harnessHere = \['claude', 'codex', 'cursor'\]\.includes\(client\)[\s\S]*harnessHere \? await harnessRecall/);
  assert.match(read('commands/hooks.js'), /snapshotCursorInventory\(/);
});

test('the Save tab and `thinker context` show one report, and its controls are the commands', async t => {
  assert.match(read('commands/context.js'), /contextView\(store/);
  // the page reads the report kept by `thinker context --refresh`, which it starts in the background (context-snapshot.js)
  assert.match(read('ui/server.js'), /snapshotView\(st, d\)/);
  assert.match(read('ui/server.js'), /child\(\['context', '--refresh'/);
  // and the Report kept by `thinker report --refresh` (report-snapshot.js), every repository's in one run
  assert.match(read('ui/server.js'), /child\(\['report', '--refresh', '--all'/);
  assert.match(read('commands/report.js'), /refreshReport\(st, \{ weeks \}\)/);
  assert.match(read('context-snapshot.js'), /contextView\(store, \{ days: d \}\)/);
  assert.match(read('commands/context.js'), /refreshSnapshots\(store\)/);
  // the installer's report (context-machine.js) is the page's All repositories: one merge, and the reports it
  // keeps are the snapshots the page reads; the browser choice of the installer's question opens the page on it
  // (`thinker ui --tab save --all`, setup/context-ask.js:openContextPage)
  const machine = read('context-machine.js'), install = fs.readFileSync(path.join(SRC, '..', 'install.sh'), 'utf8');
  assert.match(install, /"\$thinker" context --machine/);
  assert.match(read('setup/context-ask.js'), /'ui', '--from-setup', '--tab', 'save', \.\.\.\(all \? \['--all'\]/);
  // and that page opens with the terminal picker's suggestions checked: the same rows and actions, from one function
  // (context-machine.js:suggestedPicks, sent with the report as `suggested`; page.html:preselectRows on from=setup)
  assert.match(machine, /export function suggestedPicks\(view/); assert.match(machine, /const act = suggestedAct\(x\), key = suggestedKey\(x\)/);
  assert.match(read('ui/server.js'), /suggested: suggestedPicks\(view\)/);
  assert.match(read('ui/page.html'), /const FROM_SETUP = H\(\)\.get\('from'\) === 'setup'/);
  assert.match(read('ui/page.html'), /preselectRows\(all, v\.suggested \|\| \[\]\)/);
  assert.match(read('setup/context-ask.js'), /suggested savings already checked/);
  assert.match(read('commands/context.js'), /machineContext\(store, \{ days, limit/);
  assert.match(machine, /mergeViews\(views\)/); assert.match(read('ui/server.js'), /mergeViews\(xs\.map/);
  assert.match(machine, /writeSnapshot\(st, d, v/); assert.match(machine, /refreshCheckouts\(store/);
  assert.match(read('commands/cache.js'), /flags\.all \? 'repo=all'/);
  assert.match(read('ui/page.html'), /H\(\)\.get\('repo'\) === 'all' \? 'all'/);
  // setup asks the same question over the same report for its one repository (setup/context-ask.js)
  assert.match(read('setup.js'), /askMachineReport\(\{ r, recs: recommendations\(view\)/);
  assert.match(read('setup/context-ask.js'), /renderMachineReport\(r, recs\)/);
  // a switch is `thinker harness --off`; judging more sessions is `thinker context --judge n` alone (the page's button
  // went on 2026-10-24: a 25% sample is judged as sessions end); the trimmed copy (`--core`, /api/context/core) went
  // the same day, from both doors
  assert.doesNotMatch(read('commands/instructions.js'), /setCore/);
  assert.doesNotMatch(read('ui/server.js'), /api\/context\/core/);
  assert.doesNotMatch(read('ui/page.html'), /trimmed copy|context\/core/);
  assert.match(read('commands/context.js'), /judgeRecent\(store/);
  assert.doesNotMatch(read('ui/server.js'), /api\/context\/judge/);
  assert.match(read('commands/harness.js'), /switchOffNow\(store, String\(flags.off\), \{ via: 'cli', any: true \}\)/);
  assert.match(read('ui/server.js'), /switchOffNow\(st, b.labels.join\(','\), \{ via: 'ui', any: true \}\)/);
  const dir = repo(t); new Store(dir).init();
  const p = await page(t, dir).start();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# R\n\n## Tests\n\nRun `npm test`.\n\n## Style\n\nShort lines.\n');
  const id = (await p.get('/api/repos')).repos[0].id;
  const v = await p.get(`/api/context?repo=${encodeURIComponent(id)}&days=7`);
  assert.deepEqual(v.instructions.sections.map(s => s.title), ['Tests', 'Style']);
  assert.ok(v.instructions.sections.every(s => s.kept === undefined && !s.off), 'no trimmed copy to be kept out of');
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
  assert.match(read('ui/page.html'), /\/api\/changes\?repo=\$\{encodeURIComponent\(CREPO\)\}&days=7/);
  assert.match(read('context-suggest.js'), /days: 7,/);
  assert.match(read('context-suggest.js'), /tab=save&view=all/);
  // the page's rows carry the keys allChanges gives, so the server finds the part a row's Apply names
  for (const k of ['`section:${s.file}:${s.id}`', '`${s.client}:${s.key}`', '`output:${s.name}`']) assert.ok(read('ui/page.html').includes(k), k);
});

test('the Report tab and `thinker report` show one report: the same weeks, parts, prices and trend rule', () => {
  // both doors read report.js:reportView; the page's All repositories is mergeReports, as the command has no All
  assert.match(read('commands/report.js'), /reportView\(store, \{ weeks \}\)/);
  // the page reads the report kept in each checkout (report-snapshot.js), made by the same function
  assert.match(read('report-snapshot.js'), /reportView\(store, \{ weeks, now \}\)/);
  assert.match(read('ui/server.js'), /reportSnapshot\(st, weeks\)/);
  assert.match(read('ui/server.js'), /mergeReports\(xs\.map/);
  // six weeks; the command's ▲ ▼ mark a 5% change against the first week;
  // the page's Share toggle is the command's --share (every row but the whole-session total as its share of it), on both doors
  assert.match(read('ui/page.html'), /<div class="seg" id="r-view"><button data-view="values" class="on">Values<\/button><button data-view="share">Share<\/button><\/div>/);
  assert.match(read('commands/report.js'), /share: Boolean\(flags\.share\)/); assert.match(read('cli.js'), /report \[--weeks n\] \[--cost\] \[--total\] \[--share\]/);
  assert.match(read('report.js'), /share = false \} = \{\}\) \{/);
  assert.equal((read('ui/page.html').match(/\{ cls: 'rep-total', total: true \}/g) || []).length, 3, 'the three whole-session rows keep their values under Share');
  // the page's Total toggle is the command's --total
  assert.match(read('commands/report.js'), /total: Boolean\(flags\.total\)/);
  assert.match(read('ui/page.html'), /data-mode="sum">Total</);
  assert.match(read('report.js'), /export const REPORT_WEEKS = 6;/);
  assert.match(read('ui/page.html'), /\/api\/report\?repo=\$\{encodeURIComponent\(REPO\)\}&weeks=6/);
  assert.match(read('report.js'), /export const TREND_MIN = 0\.05;/);
  // the page shades a cell by its value against its own row's weeks (the highest red, the lowest green; by row since
  // 2026-10-24, by table before); the command marks the change against the first week
  assert.match(read('ui/page.html'), /const SHADE_MIN = 0\.1;/);
  assert.match(read('ui/page.html'), /const sh = shade\(a, rowValues\(cells, b\)\);/); assert.doesNotMatch(read('ui/page.html'), /mscale|valuesOf\(/);
  assert.match(read('report.js'), /change\(val\(cells, 0, base\), val\(cells, w, base\)\)/);
  // the decisions table is one function on both pages, the Report's over its window alone
  assert.match(read('ui/page.html'), /historyFigure\(hs, \{ many, caption: 'Decisions'/);
  // one Sort control in the header, the view's orderings (CSORTS), instead of one in every table's caption
  assert.match(read('ui/page.html'), /id="c-sort" aria-label="Sort"/);
  assert.doesNotMatch(read('ui/page.html'), /data-vsort/);
  // every table on the page shows 20 rows a page
  assert.match(read('ui/page.html'), /const TABLE_PAGE = 20, VPAGE = \{\};/);
  assert.match(read('ui/page.html'), /rows\.slice\(from, from \+ TABLE_PAGE\)/);
  assert.match(read('ui/page.html'), /historyFigure\(acts, \{ many: Boolean\(v\.all\), caption: 'Actions in the window'/);
  // the cost view is the command's --cost: list prices from prices.js, an unpriced model marked on both (the command in its
  // row's name, the page in the row's kind: the Report's tables carry no prose under them since 2026-10-24, the owner's ask)
  assert.match(read('commands/report.js'), /cost: Boolean\(flags\.cost\)/);
  assert.match(read('report.js'), /listPrice\(r\.model, \{ config \}\)/);
  assert.match(read('report.js'), /\(unpriced\)/); assert.match(read('ui/page.html'), /sub: m\.priced \? '' : 'no list price'/);
  assert.doesNotMatch(read('ui/page.html'), /class="lede">What a session costs here/); assert.doesNotMatch(read('ui/page.html'), /A model's row is its share/);
  // three tables under both doors, each ending on the whole session: the token types (report.js:TOKEN_TYPES, the page reads the
  // rows from the view, so the names live in one place), the parts with the rest of the input and the output under them
  // (report.js:OTHERS), the models, the token types last (2026-10-24)
  assert.match(read('report.js'), /export const TOKEN_TYPES = \[\['fresh', 'Input, fresh'\], \['cacheWrite', 'Input, written to cache'\], \['cacheRead', 'Input, read from cache'\], \['output', 'Model output'\]\];/);
  assert.match(read('report.js'), /export const OTHERS = \[\['otherInput', 'Other input'\], \['output', 'Model output'\]\];/);
  assert.match(read('report.js'), /'By token type \(as the model reported them/); assert.match(read('ui/page.html'), /<b>By token type<\/b>/);
  assert.match(read('ui/page.html'), /el\.innerHTML = parts \+ models \+ tokenTypes \+ actions \+ cards;/);
  assert.doesNotMatch(read('ui/page.html'), /Total of these/); assert.doesNotMatch(read('report.js'), /'Total of these'/);
  assert.equal((read('report.js').match(/line\('Total \(the whole session\)', v\.sessionTotals, true\)/g) || []).length, 3);
  assert.equal((read('ui/page.html').match(/row\('Total \(the whole session\)', v\.sessionTotals, \{ cls: 'rep-total', total: true \}\)/g) || []).length, 3);
  assert.match(read('ui/page.html'), /\.\.\.others\.map\(p => row\(esc\(p\.name\), p\.cells/); assert.match(read('report.js'), /for \(const p of v\.others \|\| \[\]\) L\.push\(line\(p\.name, p\.cells, false, base\)\);/);
  // the same four numbers under both, the dollars first (report.js:cacheMetrics), and the actions from context-suggest.js
  for (const f of ['report.js', 'ui/page.html']) { assert.match(read(f), /\$ saved/); assert.match(read(f), /Tokens saved|tokens saved/); }
  assert.match(read('report.js'), /changeHistory\(store\)\.filter\(e => Date\.parse\(e\.at\) >= from\)/);
  // the page's tabs: Save (was Context, the chart gone) and Report (was Cache); the old names still open them
  assert.match(read('ui/page.html'), /data-tab="save">Find Savings</);
  assert.match(read('ui/page.html'), /data-tab="report">View Report</);
  assert.match(read('ui/page.html'), /if \(tab === 'cache'\) tab = 'report';/);
  assert.doesNotMatch(read('ui/page.html'), /renderTrend|tr-stack|api\/cache|api\/behaviors|api\/usage/);
  assert.match(read('cli.js'), /ui \[--port n\] \[--no-open\] \[--tab save\|report\]/);
});
