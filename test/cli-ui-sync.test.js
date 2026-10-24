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
  assert.match(page, /<b>Revert<\/b> under Recent activity, <b>Turn back on<\/b> in the tool's row, or <code>thinker harness --undo<\/code>/);
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

test('All on Find Savings and Recent activity are `thinker context --approve|--dismiss|--revert|--retry|--history`, and a section\'s Apply is `thinker instructions --compress|--remove <ids> --pr` in the background', () => {
  // the command picks from the top five less the decisions (context-suggest.js:currentChanges), the page's rows from every
  // part (allChanges); both act through the same functions
  assert.match(read('ui/server.js'), /pickChanges\(allChanges\(changesView\(st, /);
  assert.match(read('commands/context.js'), /currentChanges\(store, /);
  for (const f of ['commands/context.js', 'ui/server.js']) {
    assert.match(read(f), /\bapproveChanges\b/);
    assert.match(read(f), /\bdismissChanges\b/);
    assert.match(read(f), /\brevertDecision\b/);
    assert.match(read(f), /\bretryJob\b/);
    assert.match(read(f), /\bchangeHistory\b/);
  }
  assert.match(read('ui/server.js'), /\/api\/changes\/approve/);
  assert.match(read('ui/server.js'), /\/api\/changes\/revert/);
  assert.match(read('ui/server.js'), /\/api\/changes\/retry/);
  // a section's Apply starts a job (context-suggest.js:startSectionJob): the decision recorded at once, and the command the person
  // would have typed started detached, `thinker instructions --compress|--remove <ids> --pr --job <group>` (--apply where no pull
  // request can be opened: instruction-pr.js:prAvailable), which finishes the recorded decision (runSectionJob); no modal, no
  // spinner to wait at (the owner's ask, 2026-10-24): the page says once that it started and Recent activity follows it
  const cs = read('context-suggest.js');
  assert.match(read('ui/server.js'), /startSectionJob\(st, xs, action, \{ pr, spawnFn, cliPath \}\)/);
  assert.match(read('ui/server.js'), /const said = \[\], pr = prAvailable\(st\.repo\)\.ok;/);
  assert.match(cs, /\[cliPath, 'instructions', `--\$\{action\}`, ids\.join\(','\), pr \? '--pr' : '--apply', '--job', group\]/);
  assert.match(read('commands/instructions.js'), /runSectionJob\(store, \{ group: flags\.job, ids, action, pr: Boolean\(flags\.pr\) \}\)/);
  assert.match(read('cli.js'), /instructions \[--remove <id> \| --compress <id> \[--pr \| --apply\] \[--job <id>\]\]/);
  const page = read('ui/page.html');
  assert.match(page, /api\('\/api\/changes\/start', \{ repo, \.\.\.g, days: cdays \}\)/);
  assert.doesNotMatch(page, /edit-overlay|openEditModal|previewSections|api\/context\/edit|api\/context\/apply/);
  assert.doesNotMatch(read('ui/server.js'), /api\/context\/edit|api\/context\/apply|api\/changes\/apply/);
  // Recent activity is its own page, the tab at the right of the nav with a badge counting what is not complete (a job running or
  // failed, a pull request to merge: context-suggest.js:changeHistory `attention`); Retry there is `thinker context --retry <n>`
  assert.match(page, /data-tab="activity"[^>]*>Recent activity<span class="badge" id="act-badge"/);
  assert.match(page, /api\(`\/api\/activity\?repo=\$\{encodeURIComponent\(AREPO\)\}`\)/);
  assert.match(page, /api\('\/api\/changes\/retry', \{ repo: e\.repo, id: e\.id \}\)/);
  assert.match(read('ui/server.js'), /attention: history\.filter\(h => h\.attention\)\.length/);
  assert.match(cs, /attention: running \? 'running' : failed && !e\.revertedAt \? 'failed' : pending \? 'pr' : null/);
  assert.match(read('commands/context.js'), /if \(flags\.retry !== undefined\)/);
  assert.doesNotMatch(page, /\['history', 'History'\]/);
  // the page's rows read the same decisions, for the pill on a section under way, failed or pending on a pull request
  assert.match(page, /api\(`\/api\/activity\?repo=\$\{encodeURIComponent\(CREPO\)\}`\)/);
  assert.match(read('context-suggest.js'), /days: 7,/);
  assert.match(read('context-suggest.js'), /tab=save&view=all/);
  // the page's rows carry the keys allChanges gives, so the server finds the part a row's Apply names
  for (const k of ['`section:${s.file}:${s.id}`', '`${s.client}:${s.key}`', '`output:${s.name}`']) assert.ok(read('ui/page.html').includes(k), k);
});

test('over the wire: a section\'s Apply records the decision running and starts the command; Recent activity counts it until the job finishes', async t => {
  const dir = repo(t); new Store(dir).init();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# R\n\n## Tests\n\nRun `npm test`.\n\n## Style\n\nShort lines.\n');
  const pg = page(t, dir), p = await pg.start();
  const id = (await p.get('/api/repos')).repos[0].id;
  await p.get(`/api/context?repo=${encodeURIComponent(id)}&days=7`); // the report the server resolves the rows in
  assert.deepEqual(await p.get(`/api/activity?repo=${encodeURIComponent(id)}`), { history: [], attention: 0, running: 0 });
  // Apply on two rows, one compressed and one removed: one job each, the command started detached in the checkout
  const r = await p.post('/api/changes/start', { repo: id, keys: ['section:AGENTS.md:tests', 'section:AGENTS.md:style'], acts: { 'section:AGENTS.md:tests': 'compress', 'section:AGENTS.md:style': 'remove' }, days: 7 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.match(r.said, /^Compressing 1 section in the background: the file in your working tree is rewritten when the model is done\. Follow it under Recent activity\. Removing 1 section: written to your working tree in a moment\. Follow it under Recent activity\.$/);
  const jobs = pg.spawned.filter(x => x.args[1] === 'instructions');
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0].args.slice(0, 5), ['/x/cli.js', 'instructions', '--compress', 'tests', '--apply']); assert.equal(jobs[0].args[5], '--job');
  assert.deepEqual(jobs[1].args.slice(0, 5), ['/x/cli.js', 'instructions', '--remove', 'style', '--apply']);
  assert.equal(jobs[0].opts.cwd, dir); assert.equal(jobs[0].opts.detached, true);
  // Recent activity: both running, both counted for the badge, nothing to revert yet; the Save rows read the same
  let a = await p.get('/api/activity?repo=all');
  assert.equal(a.attention, 2); assert.equal(a.running, 2);
  assert.deepEqual(a.history.map(e => [e.key, e.attention, e.revertible, e.job.action, e.repo]).sort(), [['section:AGENTS.md:style', 'running', false, 'remove', id], ['section:AGENTS.md:tests', 'running', false, 'compress', id]]);
  // a part that is no section is not started this way; a row no longer in the report is refused
  assert.equal((await p.post('/api/changes/start', { repo: id, keys: ['output:Read'], days: 7 })).status, 400);
  assert.equal((await p.post('/api/changes/start', { repo: id, keys: ['section:AGENTS.md:nope'], days: 7 })).status, 400);
  // the command's side finishes the compress job: the row is complete, the removal still running
  const { runSectionJob } = await import('../src/context-suggest.js');
  const group = jobs[0].args[6], st = new Store(dir);
  const edit = { previewEdit: async () => ({ key: 'tests', files: ['AGENTS.md'], file: 'AGENTS.md', modelTokens: 500 }), applyEdit: () => { fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# R\n\n## Tests\n\n`npm test`.\n\n## Style\n\nShort lines.\n'); return { said: 'Compressed it in AGENTS.md' }; } };
  assert.equal((await runSectionJob(st, { group, ids: ['tests'], action: 'compress', pr: false }, { edit })).said, 'Compressed it in AGENTS.md');
  a = await p.get(`/api/activity?repo=${encodeURIComponent(id)}`);
  assert.equal(a.attention, 1); assert.equal(a.running, 1);
  const done = a.history.find(e => e.key === 'section:AGENTS.md:tests');
  assert.equal(done.attention, null); assert.equal(done.revertible, true); assert.equal(done.job.state, 'done'); assert.equal(done.result, 'Compressed it in AGENTS.md');
  // Revert from the page writes the file back; Retry on a running job is refused
  assert.equal((await p.post('/api/changes/retry', { repo: id, id: a.history.find(e => e.running).id })).status, 400);
  const rv = await p.post('/api/changes/revert', { repo: id, id: done.id });
  assert.equal(rv.status, 200); assert.match(rv.said, /written back as it was$/);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# R\n\n## Tests\n\nRun `npm test`.\n\n## Style\n\nShort lines.\n');
});

test('the Report tab and `thinker report` show one report: the same weeks, parts, prices and trend rule', () => {
  // both doors read report.js:reportView; the page's All repositories is mergeReports, as the command has no All
  assert.match(read('commands/report.js'), /reportView\(store, \{ weeks \}\)/);
  // the page reads the report kept in each checkout (report-snapshot.js), made by the same function
  assert.match(read('report-snapshot.js'), /reportView\(store, \{ weeks, now \}\)/);
  assert.match(read('ui/server.js'), /reportSnapshot\(st, weeks\)/);
  assert.match(read('ui/server.js'), /mergeReports\(xs\.map/);
  // six weeks; the command's ▲ ▼ mark a 5% change against the first week;
  // the page's Total toggle is the command's --total
  assert.match(read('commands/report.js'), /total: Boolean\(flags\.total\)/);
  assert.match(read('ui/page.html'), /data-mode="sum">Total</);
  assert.match(read('report.js'), /export const REPORT_WEEKS = 6;/);
  assert.match(read('ui/page.html'), /\/api\/report\?repo=\$\{encodeURIComponent\(REPO\)\}&weeks=6/);
  assert.match(read('report.js'), /export const TREND_MIN = 0\.05;/);
  // the page shades a cell by its value against every cell of its table (the highest red, the lowest green), a total row
  // against its own weeks; the command marks the change against the first week
  assert.match(read('ui/page.html'), /const SHADE_MIN = 0\.1;/);
  assert.match(read('ui/page.html'), /valuesOf\(v\.parts\.map\(p => p\.cells\)\)/);
  assert.match(read('report.js'), /change\(avg\(cells\[0\], 0\), avg\(cells\[w\], w\)\)/);
  // the decisions table is one function on both pages, the Report's over its window alone
  assert.match(read('ui/page.html'), /historyFigure\(hs, \{ many, caption: 'Decisions'/);
  // one Sort control in the header, the view's orderings (CSORTS), instead of one in every table's caption
  assert.match(read('ui/page.html'), /id="c-sort" aria-label="Sort"/);
  assert.doesNotMatch(read('ui/page.html'), /data-vsort/);
  // every table on the page shows 20 rows a page
  assert.match(read('ui/page.html'), /const TABLE_PAGE = 20, VPAGE = \{\};/);
  assert.match(read('ui/page.html'), /rows\.slice\(from, from \+ TABLE_PAGE\)/);
  assert.match(read('ui/page.html'), /historyFigure\(acts, \{ many: Boolean\(v\.all\), caption: 'Actions in the window'/);
  // what was saved with thinker leads the actions on both doors: a session's input tokens before the first action in effect
  // against since (report.js:savingsSummary, over the view's sessionRows), the server reading it live over the kept report,
  // and each action with the same comparison for the part it touched (actionEffect)
  assert.match(read('report.js'), /savings: savingsSummary\(actions, sessionRows\)/);
  assert.match(read('report.js'), /L\.push\('', 'Saved with thinker'\)/);
  assert.match(read('ui/server.js'), /savings: savingsSummary\(actions, s\.view\.sessionRows \|\| \[\]\)/);
  assert.match(read('ui/server.js'), /view\.savings = mergeSavings\(/);
  assert.match(read('ui/page.html'), /<div class="kicker">Saved with thinker<\/div>/);
  assert.match(read('ui/page.html'), /effectTable\(e\.effect\)/);
  assert.match(read('report.js'), /effect: actionEffect\(e, sessionRows, now\)/);
  // the cost view is the command's --cost: list prices from prices.js, the unpriced models named on both
  assert.match(read('commands/report.js'), /cost: Boolean\(flags\.cost\)/);
  assert.match(read('report.js'), /listPrice\(r\.model, \{ config \}\)/);
  assert.match(read('ui/page.html'), /v\.unpriced\.map\(esc\)/);
  // the same four numbers under both, the dollars first (report.js:cacheMetrics), and the actions from context-suggest.js
  for (const f of ['report.js', 'ui/page.html']) { assert.match(read(f), /\$ saved/); assert.match(read(f), /Tokens saved|tokens saved/); }
  assert.match(read('report.js'), /changeHistory\(store\)\.filter\(e => Date\.parse\(e\.at\) >= from\)/);
  // the page's tabs: Save (was Context, the chart gone) and Report (was Cache); the old names still open them
  assert.match(read('ui/page.html'), /data-tab="save">Find Savings</);
  assert.match(read('ui/page.html'), /data-tab="report">View Report</);
  assert.match(read('ui/page.html'), /if \(tab === 'cache'\) tab = 'report';/);
  assert.doesNotMatch(read('ui/page.html'), /renderTrend|tr-stack|api\/cache|api\/behaviors|api\/usage/);
  assert.match(read('cli.js'), /ui \[--port n\] \[--no-open\] \[--tab save\|report\|activity\]/);
  assert.match(read('ui/page.html'), /if \(tab === 'save' && H\(\)\.get\('view'\) === 'history'\) tab = 'activity';/);
});
