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
import { DEFAULT_DISTILL_MODEL } from '../src/llm.js';
import { buildModel } from '../src/setup/models.js';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('Bedrock opt-in flags belong to the shared CLI; page setup cannot enable them implicitly', () => {
  assert.match(read('cli.js'), /proxy on --bedrock --region region --model bedrock-model-id --token-file path/);
  assert.match(read('commands/proxy.js'), /tokenFile: flags\['token-file'\]/);
  assert.match(read('setup/steps.js'), /enableProxyService\(/);
  assert.doesNotMatch(read('setup/steps.js'), /bedrock:/);
  assert.doesNotMatch(read('ui/page.html'), /--bedrock/);
});

test('the footers, the ledger and the Report page price one thing the same way', async () => {
  // The footers say money, which the rest of the product deliberately does not (src/prices.js). The one
  // thing that keeps that honest is that every surface reads report-savings.js:weeklySavings, so a figure
  // under a prompt can never contradict the table in `thinker report`. savings-ledger.test.js checks the
  // arithmetic; this holds the wiring.
  assert.match(read('commands/hooks.js'), /savings-ledger\.js/);
  // and every door says it in the ledger's own words
  for (const [file, fn] of [['commands/savings.js', 'savingsLine'], ['commands/hooks.js', 'savingsLine']]) assert.match(read(file), new RegExp(fn));
  // OpenCode 2's terminal part is one more door: its footer calls savingsStatus, so the words under the
  // prompt are the status row's, and a figure there can never disagree with `thinker savings` either.
  // the command the hooks start in the background is the one a person can run by hand
  assert.match(read('cli.js'), /savings \[--json\] \[--refresh\]/, 'the flags are in help, which is what unknownFlags reads');
});

test('Codex proxy is wired by the default service and shares the existing thresholds', async () => {
  const { proxyConfig, PROXY_DEFAULTS } = await import('../src/proxy.js');
  const cfg = proxyConfig({ protocol: 'responses', upstream: 'https://api.openai.com/v1' }, {});
  for (const key of ['trigger', 'keep', 'keepMin', 'clearAtLeast']) assert.equal(cfg[key], PROXY_DEFAULTS[key]);
  assert.equal(proxyConfig({}, {}).protocol, 'anthropic');
  // the three clears are one default, wherever the service is started from, and the help names how to go back
  // inputs on; the thinking edit off since 2026-11-02 (proxy.js: its growing keep rewrote the cache)
  // results only since 2026-11-04: the call text and the thinking are never touched, by either door
  assert.equal(PROXY_DEFAULTS.clearInputs, undefined); assert.equal(PROXY_DEFAULTS.clearThinking, undefined);
  assert.match(read('cli.js'), /--protocol anthropic\|responses/);
  assert.match(read('commands/proxy.js'), /cfg\.protocol === 'responses'/);
  // The page has no separate proxy controls or implementation; setup uses the shared service.
  const { serviceArgs } = await import('../src/proxy-service.js');
  assert.ok(serviceArgs(tmp('thinker-proxy-sync-'), { port: 6901 }).includes('--codex'));
  assert.match(read('setup/steps.js'), /enableProxyService\(/);
  assert.match(read('cli.js'), /--codex/);
  assert.doesNotMatch(read('ui/page.html'), /--protocol responses/);
});

test('the CLI and page offer no test wrapper or automatic command rewrite', () => {
  assert.doesNotMatch(read('cli.js'), /test -- <command>|tests\.nudge|testingCommands/);
  assert.doesNotMatch(read('commands/hooks.js'), /wrappedCommand|test-nudge|preToolOutput/);
  assert.doesNotMatch(read('ui/page.html'), /thinker test --/);
});

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
function page(t, dir, opts = {}) {
  const home = tmp('thinker-sync-home-'), th = tmp('thinker-sync-th-');
  const claude = path.join(th, '.claude', 'projects', dir.replace(/[/.]/g, '-')); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 's1.jsonl'), JSON.stringify({ type: 'user', cwd: dir, message: 'hi' }) + '\n');
  const spawned = [];
  const spawnFn = (cmd, args, opts) => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); spawned.push({ args, opts, pid: c.pid }); return c; };
  const ui = createUiServer(new Store(dir), { home, transcriptsHome: th, cliPath: '/x/cli.js', spawnFn, ...opts });
  const call = (port, p, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: body ? 'POST' : 'GET', headers: { host: `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json' } : {}) } }, res => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  return {
    spawned, home,
    async start() {
      const { port } = await ui.listen(0);
      t.after(async () => { await ui.close(); for (const s of spawned) { try { process.kill(s.pid, 'SIGKILL'); } catch {} } });
      return {
        get: async p => { const r = await call(port, p); assert.equal(r.status, 200, r.body); return JSON.parse(r.body); },
        post: async (p, body) => { const r = await call(port, p, body); return { status: r.status, ...JSON.parse(r.body) }; },
        status: async p => (await call(port, p)).status,
      };
    },
  };
}

test('the command, the weekly question and the installer share one harness report, one switch and one tool reference; the page has no row for them', () => {
  assert.match(read('commands/harness.js'), /harnessUsage\(repo/);
  assert.match(read('ui/server.js'), /harnessView\(/);
  assert.match(read('cli.js'), /Claude Code, Codex and Cursor record loading/);
  // a switch is `thinker context --switch-off|--switch-on` and an approved change alike (context-suggest.js:approveChanges),
  // recorded for Recent activity's Revert; the page's own rows for it went with Find Savings (2026-11-21)
  assert.match(read('context-suggest.js'), /switchSources\(store, \{ keys: \[c\.sourceKey \|\| c\.name\], on: true \}\)/);
  // A tool's output compression is no door's choice (2026-11-04, the owner's call): the clearing compresses outputs and
  // is on by default, so neither the weekly question, the installer's picker nor `thinker context --approve`
  // offers one -- no row, no action, no ACTS entry. The diet stays as `thinker context --output-compression <tools>
  // [--level high]`, for an experiment arm.
  const page = read('ui/page.html');
  assert.doesNotMatch(page, /'No compression'|levelOpts/); assert.doesNotMatch(read('context-suggest.js'), /uncompress|c\.kind === 'output'/);
  // what a person decided before today is still theirs to take back: Revert on an old output decision puts the level back
  assert.match(read('context-suggest.js'), /u\.kind === 'output'/);
  assert.doesNotMatch(page, /view: 'outputs'/); assert.doesNotMatch(read('commands/context.js'), /Tool outputs: tokens per result/);
  assert.match(read('commands/context.js'), /\['high', 'moderate'\]\.includes\(flags\.level\)/);
  // a built-in tool gets a tool reference (2026-11-06, tool-stubs.js: not switched off; its definition in a file, a pointer in
  // every prompt, the tool still callable); no door may call it switched off (ACTS.ref everywhere)
  assert.match(read('part-explain.js'), /builtin: 'moving its full definition out of the prompt[^']*The agent can still use the tool/); assert.match(read('part-explain.js'), /p\.kind === 'tool' && p\.builtin \? ACTION_WORD\.builtin/);
  assert.doesNotMatch(page, /switched off across all repositories|cannot call it at all|loses the ability/);
  assert.match(read('context-suggest.js'), /ref: \{ act: 'off', text: 'Create tool reference' \}/);
  assert.match(read('context-machine.js'), /p\.group === 'builtin' \? ACTS\.ref/);
  assert.match(read('setup/context-ask.js'), /a built-in tool gets a tool reference for every repository and can still be used/);
  // Wasted is dollars (the owner's ask, 2026-11-09): the wasted tokens at the view's input rate (context-view.js:inputRate)
  assert.match(read('commands/context.js'), /formatDollars\(x\.wastedWindow \* vrate\)/);
  // the flag is one rule (the owner's rule, 2026-11-09): used under 10%, red from 5k tokens a call, yellow under, nothing under 500
  assert.match(read('context-view.js'), /const FLAG = \{ used: 0\.1, red: 5000, none: 500 \};/);
  assert.match(read('commands/context.js'), /\$\{mark\(s\)\}\$\{pad\(s\.tokens, 6\)\}/);
  // the words on what a part is are `thinker explain`'s (part-explain.js), one writer and one place they are kept
  assert.match(read('commands/explain.js'), /explainParts/);
  // the words are written once for the machine, never per repository, and never in the background
  assert.match(read('part-explain.js'), /export function partKey/);
  // `thinker context --cards` is the card view in the terminal, from the one list in the one order (part-explain.js:viewParts)
  assert.match(read('commands/context.js'), /if \(flags\.cards\)/);
  assert.match(read('commands/context.js'), /viewParts, readExplains/);
  assert.match(read('commands/context.js'), /thinker context --cards/);
  assert.match(read('cli.js'), /context \[--days n\] \[--cards\]/, 'the card view is in the help of `thinker context`');
  assert.match(read('cli.js'), /^  explain \[--days n\]/m, '`thinker explain`, the command behind the cards, is in the help');
  assert.match(read('commands/context.js'), /switchSources\(store, \{ keys: list\(flags\['switch-on'\]\), on: true \}\)/);
  // the installer's picker (setup/context-ask.js, `thinker context --machine --ask`) applies its picks through the same
  // approveChanges, in each change's repository (context-machine.js:applyMachinePicks), and install.sh runs that command
  assert.match(read('context-machine.js'), /approve = approveChanges/);
  assert.match(read('setup/context-ask.js'), /apply = applyMachinePicks/);
  assert.match(fs.readFileSync(path.join(SRC, '..', 'install.sh'), 'utf8'), /context --machine --ask/);
  assert.match(read('commands/hooks.js'), /harnessHere = \['claude', 'codex', 'cursor'\]\.includes\(client\)[\s\S]*harnessHere \? await harnessRecall/);
  assert.match(read('commands/hooks.js'), /snapshotCursorInventory\(/);
});

test('the Context report is one computation: `thinker context`, the installer and setup read it, and the page has no tab for it', async t => {
  assert.match(read('commands/context.js'), /contextView\(store/);
  // the kept report (context-snapshot.js) is made again by `thinker context --refresh`; the page starts that after a decision is taken back
  assert.match(read('ui/server.js'), /child\(\['context', '--refresh'/);
  // and the Report kept by `thinker report --refresh` (report-snapshot.js), every repository's in one run
  assert.match(read('ui/server.js'), /child\(\['report', '--refresh', '--all'/);
  assert.match(read('commands/report.js'), /refreshReport\(st, \{ weeks \}\)/);
  // the refresh passes the window's sessions it gathered for the stamp (view-sources.js); nothing else changes
  assert.match(read('commands/context.js'), /refreshSnapshots\(store\)/);
  // the installer's report (context-machine.js) is one merge over the most active repositories, and the reports it keeps
  // are the snapshots `thinker context` and thinker's own check read
  const machine = read('context-machine.js'), install = fs.readFileSync(path.join(SRC, '..', 'install.sh'), 'utf8');
  assert.match(install, /"\$thinker" context --machine/);
  // the suggestions and their actions come from one function (context-machine.js:suggestedPicks)
  assert.match(machine, /export function suggestedPicks\(view/); assert.match(machine, /const act = suggestedAct\(x\), key = suggestedKey\(x\)/);
  // and the terminal picker comes with them checked (2026-10-29)
  assert.match(read('setup/context-ask.js'), /value: p, picked: true/);
  // no door links to a page of rows any more (2026-11-21): the installer's browser answer and the weekly question's link went with Find Savings
  assert.doesNotMatch(read('setup/context-ask.js'), /suggestionsUrl|openContextPage|In the browser/);
  assert.doesNotMatch(read('context-suggest.js'), /tab=save|export const suggestionsUrl|export function offeredPicks/);
  assert.match(read('commands/context.js'), /machineContext\(store, \{ days, limit/);
  assert.match(machine, /mergeViews\(views\)/);
  assert.match(machine, /writeSnapshot\(st, d, v/); assert.match(machine, /refreshCheckouts\(store/);
  // `thinker ui` opens over every repository, on every tab, and `--here` on this checkout alone (2026-10-25):
  // one default, the command's hash and the page's own reading of it
  assert.match(read('commands/cache.js'), /flags\.here && !flags\.all \? 'repo=here' : 'repo=all'/);
  assert.match(read('ui/page.html'), /const hashRepo = \(\) => \{ const r = H\(\)\.get\('repo'\); return r === 'here' \? '' : r \|\| 'all'; \}/);
  for (const d of [/REPO = hashTab\(\) === 'factory' \? hashRepo\(\)/, /AREPO = hashTab\(\) === 'activity' \? hashRepo\(\)/, /HREPO = hashTab\(\) === 'chat' \? hashRepo\(\)/]) assert.match(read('ui/page.html'), d);
  assert.match(read('cli.js'), /ui \[--port n\] \[--no-open\] \[--tab chat\|factory\|activity\] \[--here\]/);
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
});

test('Recent activity is `thinker context --history|--revert|--retry`, a decision is `thinker context --approve|--dismiss`, and a section\'s change is `thinker instructions --compress|--remove <ids> --pr` in the background', () => {
  // the command picks from the top five less the decisions (context-suggest.js:currentChanges) and makes them; the page
  // makes none (2026-11-21: Find Savings went, thinker decides itself) and keeps the two that take one back or run it again
  assert.match(read('commands/context.js'), /currentChanges\(store, /);
  for (const fn of ['approveChanges', 'dismissChanges', 'revertDecision', 'retryJob', 'changeHistory']) assert.match(read('commands/context.js'), new RegExp(`\\b${fn}\\b`), fn);
  for (const fn of ['revertDecision', 'retryJob', 'changeHistory']) assert.match(read('ui/server.js'), new RegExp(`\\b${fn}\\b`), fn);
  assert.doesNotMatch(read('ui/server.js').replace(/^\s*\/\/.*$/gm, ''), /approveChanges|dismissChanges|startSectionJob|\/api\/changes\/(approve|dismiss|start)/);
  assert.match(read('ui/server.js'), /\/api\/changes\/revert/);
  assert.match(read('ui/server.js'), /\/api\/changes\/retry/);
  // a section's change is a job (context-suggest.js:startSectionJob): the decision recorded at once, and the command the person
  // would have typed started detached, `thinker instructions --compress|--remove <ids> --pr --job <group>` (--apply where no pull
  // request can be opened: instruction-pr.js:prAvailable), which finishes the recorded decision (runSectionJob); nothing to wait
  // at (the owner's ask, 2026-10-24): Recent activity follows it
  const cs = read('context-suggest.js');
  // every door records which one a decision came through (context-suggest.js:VIA), so a change thinker made by
  // itself can be told from one a person typed
  assert.match(read('commands/context.js'), /fn\(store, picked, \{ via \}\)/);
  assert.match(read('upkeep.js'), /approveChanges\(store, picked, \{ via: VIA\.thinker, now, pr: true, batch: id, made/);
  // the weekly question that put these changes to the person in their session is retired (2026-11-21): nothing
  // schedules it, the prompt hook does not offer it, and no MCP tool answers it
  assert.doesNotMatch(read('maintain.js'), /scheduleContextSuggestion/);
  assert.doesNotMatch(read('commands/hooks.js'), /contextSuggestOffer/);
  assert.doesNotMatch(read('mcp-server.js'), /registerTool\('context'/);
  // Every question thinker still has an agent ask is built with askThrough (or askInChat where there is no such
  // tool), so it carries thinker's name in the question and in the header and no offer can hand-write one that does
  // not (2026-10-29, the owner's ask). A new question goes through the same helper.
  for (const f of ['proxy-offer.js', 'error-report.js', 'containers-offer.js']) {
    const src = read(f);
    assert.match(src, /askThrough\(tool, /, `${f} asks through the labelled clause`);
    assert.match(src, /askInChat\(/, `${f} labels its chat fallback too`);
    assert.doesNotMatch(src, /\(header "(?!\$\{QUESTION_HEADER\})/, `${f} writes no header of its own`);
  }
  // The container question is the owner's own wording (2026-11-05) and the only place it is written: the
  // offer passes it to askThrough, which tells the agent to put it unchanged. A change here is deliberate.
  // one question a turn: the container offer takes its place in the hook's single chain, never beside another
  assert.match(read('commands/hooks.js'), /proxyOffer\(store, \{ client \}\) \|\| containersOffer\(store, \{ client \}\) \|\|/);
  // the command a job is: each list by its action, so a batch of thinker's own that shortens some sections and
  // removes others is one run and one pull request
  assert.match(cs, /const jobArgs = \(cliPath, ids, pr, group\) => \[cliPath, 'instructions', \.\.\.SECTION_ACTS\.flatMap\(a => \(ids\[a\]\?\.length \? \[`--\$\{a\}`, ids\[a\]\.join\(','\)\] : \[\]\)\), pr \? '--pr' : '--apply', '--job', group\];/);
  // and so does every other door, since 2026-10-29: thinker's own batch, `thinker context --approve` and the
  // installer's picks all approve through approveChanges, which sends a
  // section to the same job rather than compressing it inline, so no door holds a person's session through the model
  // call or writes the file without a pull request. Only a switch-off or a compression level is made where it is asked.
  assert.match(cs, /const secs = changes\.filter\(c => act\(c\)\);/);
  assert.match(cs, /const j = startSectionJob\(store, xs, action, \{ pr: open, now, spawnFn, cliPath, via, batch \}\);/);
  assert.match(cs, /const open = pr \?\? prAvailable\(store\.repo\)\.ok;/);
  assert.doesNotMatch(cs.split('export async function approveChanges')[1].split('\n}')[0], /previewEdit|applyEdit/);
  assert.match(read('commands/instructions.js'), /runSectionJob\(store, \{ group: flags\.job, ids: given\.flatMap\(idsOf\), action: given\.length > 1 \? 'each' : given\[0\], pr: Boolean\(flags\.pr\) \}\)/);
  assert.match(read('cli.js'), /instructions \[--remove <id> \| --compress <id> \[--pr \| --apply\] \[--job <id>\]\]/);
  const page = read('ui/page.html');
  assert.doesNotMatch(page, /edit-overlay|openEditModal|previewSections|api\/context\/edit|api\/context\/apply/);
  assert.doesNotMatch(read('ui/server.js'), /api\/context\/edit|api\/context\/apply|api\/changes\/apply/);
  // Recent activity is its own page, the tab at the right of the nav with a badge counting what is not complete (a job running or
  // failed, a pull request to merge: context-suggest.js:changeHistory `attention`); Retry there is `thinker context --retry <n>`
  assert.match(page, /data-tab="activity"[^>]*>Recent activity<span class="badge" id="act-badge"/);
  assert.match(page, /api\(`\/api\/activity\?repo=\$\{encodeURIComponent\(AREPO\)\}&progressive=1`\)/);
  assert.match(page, /api\('\/api\/changes\/retry', \{ repo: e\.repo, id: e\.id \}\)/);
  assert.match(read('ui/server.js'), /attention: history\.filter\(h => h\.attention\)\.length/);
  assert.match(cs, /attention: running \? 'running' : failed && !e\.revertedAt \? 'failed' : pending \? 'pr' : null/);
  // a merged pull request this checkout has not pulled (`unpulled`, with the branch to pull): Recent activity says to pull
  // that branch and tints the decision, and `thinker context --history` says the same
  assert.match(cs, /unpulled\.has\(e\) \? \{ unpulled: true, pullFrom: e\.pr\.base \|\| pullFrom \}/);
  assert.match(page, /once you pull <code>\$\{esc\(br\)\}<\/code> \(<code>git pull origin \$\{esc\(br\)\}<\/code>\)/);
  assert.match(page, /e\.unpulled \? \['wait', 'Merged · pull to apply'\]/);
  assert.match(read('commands/context.js'), /once you pull \$\{br\} \(git pull origin \$\{br\}\)/);
  assert.match(read('commands/context.js'), /merged\$\{e\.revertPr \? `, revert #\$\{e\.revertPr\.number\}` : e\.unpulled \? ', pull to apply' : ''\}/);
  // Revert on a merged pull request opens one that reverts it (instruction-pr.js:revertPr), on the page and by --revert
  assert.match(page, /e\.revertPr \? \['off', 'Revert PR opened'\]/);
  assert.match(cs, /kind: 'revert-pr'/);
  // reverted decisions are hidden by default (2026-10-26): the page's caption toggle shows them, as --reverted lists them
  assert.match(page, /hs = SHOW_REVERTED \? all : all\.filter\(e => !e\.revertedAt\)/);
  assert.match(page, /data-toggle-reverted/);
  assert.match(read('commands/context.js'), /filter\(\(\[e\]\) => flags\.reverted \|\| !e\.revertedAt\)/);
  assert.match(read('commands/context.js'), /--reverted lists/);
  assert.match(read('commands/context.js'), /if \(flags\.retry !== undefined\)/);
  assert.doesNotMatch(page, /\['history', 'History'\]/);
  assert.match(read('context-suggest.js'), /days: 7,/);
  assert.doesNotMatch(page, /'compression' : 'removal'\} failed/);
  // a section changed inside the window is measured over the sessions since, and the command says so (instruction-value.js `recent`)
  assert.match(read('commands/context.js'), /s\.recent \? ` \(changed \$\{s\.changedAt\.slice\(0, 10\)\}: \$\{s\.sessions\} session/);
});

test('over the wire: a section change started by another door is counted by Recent activity until its job finishes; Revert and Retry are the page\'s', async t => {
  const dir = repo(t); const st = new Store(dir).init();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# R\n\n## Tests\n\nRun `npm test`.\n\n## Style\n\nShort lines.\n');
  const pg = page(t, dir), p = await pg.start();
  const id = (await p.get('/api/repos')).repos[0].id;
  assert.deepEqual(await p.get(`/api/activity?repo=${encodeURIComponent(id)}`), { history: [], promptAvg: null, measuring: true, scan: null, attention: 0, running: 0 }, 'no report kept yet: measuring, and the refresh started (no progressive read, so no scan to report)');
  // two sections, one compressed and one removed, as `thinker context --approve` and thinker's own check start them
  // (startSectionJob): one job each, the command started detached in the checkout. The page starts none itself.
  const { startSectionJob, runSectionJob, allChanges, pickChanges } = await import('../src/context-suggest.js');
  const { snapshotView } = await import('../src/context-snapshot.js');
  const picked = pickChanges(allChanges(snapshotView(st, 7).view), ['section:AGENTS.md:tests', 'section:AGENTS.md:style'], { 'section:AGENTS.md:tests': 'compress', 'section:AGENTS.md:style': 'remove' });
  const spawned = [], spawnFn = (cmd, args, opts) => { spawned.push({ args, opts }); return { pid: process.pid, on() {}, unref() {} }; };
  const said = ['compress', 'remove'].map(action => startSectionJob(st, picked.filter(c => (c.chosen || c.default?.act) === action), action, { pr: false, spawnFn, cliPath: '/x/cli.js', via: 'command' }).said);
  assert.match(said.join(' '), /^Compressing 1 section in the background: the file in your working tree is rewritten when the model is done\. Follow it under Recent activity\. Removing 1 section: written to your working tree in a moment\. Follow it under Recent activity\.$/);
  assert.equal(spawned.length, 2);
  assert.deepEqual(spawned[0].args.slice(0, 5), ['/x/cli.js', 'instructions', '--compress', 'tests', '--apply']); assert.equal(spawned[0].args[5], '--job');
  assert.deepEqual(spawned[1].args.slice(0, 5), ['/x/cli.js', 'instructions', '--remove', 'style', '--apply']);
  assert.equal(spawned[0].opts.cwd, dir); assert.equal(spawned[0].opts.detached, true);
  // Recent activity: both running, both counted for the badge, nothing to revert yet
  let a = await p.get('/api/activity?repo=all');
  assert.equal(a.attention, 2); assert.equal(a.running, 2);
  assert.deepEqual(a.history.map(e => [e.key, e.attention, e.revertible, e.job.action, e.repo]).sort(), [['section:AGENTS.md:style', 'running', false, 'remove', id], ['section:AGENTS.md:tests', 'running', false, 'compress', id]]);
  // the command's side finishes the compress job: the row is complete, the removal still running
  const group = spawned[0].args[6];
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

// 2026-11-21, the owner's direction: "drop the 'find savings' page and 'view report' page. Thinker should be responsible to
// finding and making those decisions". The two tabs, their routes and the doors that linked to them are gone; the commands
// (`thinker context`, `thinker report`) and the computations behind them stay, since thinker acts on them.
test('Find Savings and View Report are no tabs of the page: no button, no section, no route, and an old link opens the chat', async t => {
  const html = read('ui/page.html');
  assert.deepEqual([...html.matchAll(/class="nav-link" data-tab="([a-z]+)"/g)].map(m => m[1]), ['chat', 'factory', 'activity'], 'the nav is the chat, the Factory and Recent activity');
  assert.deepEqual([...html.matchAll(/<section id="tab-([a-z]+)"/g)].map(m => m[1]), ['chat', 'factory', 'activity']);
  assert.doesNotMatch(html, /Find Savings<\/button>|View Report<\/button>|id="tab-save"|id="tab-report"|id="context-body"|id="report-body"/);
  assert.doesNotMatch(html, /function loadContext|function loadReport|function renderContext|function renderReport|function applyRows|\/api\/context|\/api\/explain|\/api\/changes\/(approve|dismiss|start)/);
  // an old link (tab=save, report, changes, cache) and a tab the page does not know open the chat; Save's old History view
  // is Recent activity, as since 2026-10-24. The page's own two functions, run as the browser runs them.
  const { default: vm } = await import('node:vm');
  const hashTab = html.match(/^const hashTab = .*$/m)[0], show = html.slice(html.indexOf('function show(tab) {'), html.indexOf('function segOn('));
  const opened = hash => {
    const shown = {}, loaded = [];
    const context = vm.createContext({
      H: () => new URLSearchParams(hash), $: sel => ({ set hidden(v) { shown[sel] = !v; } }),
      document: { querySelectorAll: () => [] }, history: { replaceState: (a, b, to) => { shown.hash = to; } }, scanProgress: () => {},
      loadHome: () => loaded.push('chat'), loadFactory: () => loaded.push('factory'), loadActivity: () => loaded.push('activity'),
    });
    vm.runInContext(`${hashTab}\nlet TAB;\n${show}\nshow(H().get('tab') || 'chat');`, context);
    return [vm.runInContext('hashTab()', context), vm.runInContext('TAB', context), loaded.join(), shown.hash, Object.keys(shown).filter(k => shown[k] === true).join()];
  };
  for (const hash of ['tab=save', 'tab=report', 'tab=changes', 'tab=cache', 'tab=context', 'tab=save&view=all&repo=r1&from=suggestion', '']) assert.deepEqual(opened(hash), ['chat', 'chat', 'chat', '#tab=chat', '#tab-chat'], hash || 'no tab');
  assert.deepEqual(opened('tab=save&view=history'), ['activity', 'activity', 'activity', '#tab=activity', '#tab-activity']);
  assert.deepEqual(opened('tab=factory'), ['factory', 'factory', 'factory', '#tab=factory', '#tab-factory']);
  // the command names the three tabs, and says where the two pages' figures are
  assert.match(read('cli.js'), /ui \[--port n\] \[--no-open\] \[--tab chat\|factory\|activity\] \[--here\] \[--refresh\]/);
  assert.match(read('cli.js'), /Find Savings and View Report are no longer tabs of it:\s+thinker makes those decisions itself, and their figures are \\`thinker context\\` and \\`thinker report\\`/);
  assert.doesNotMatch(read('commands/cache.js'), /Find Savings \(where your agents' context goes\)/);
  // over the wire: the routes that served the two tabs answer as any unknown route does; the ones the page still reads answer
  const dir = repo(t); new Store(dir).init();
  const p = await page(t, dir).start();
  const id = (await p.get('/api/repos')).repos[0].id;
  for (const route of ['/api/changes/approve', '/api/changes/dismiss', '/api/changes/start', '/api/context/switch', '/api/context/compression', '/api/explain']) assert.equal((await p.post(route, { repo: id, keys: ['section:AGENTS.md:tests'] })).status, 404, route);
  for (const route of ['/api/context', '/api/explain']) assert.equal(await p.status(`${route}?repo=${encodeURIComponent(id)}&days=7`), 405, `${route}: no GET route answers there, so it is "method not allowed" as for any unknown one`);
  assert.equal(await p.status('/api/nothing-here'), 405);
  for (const route of [`/api/report?repo=${encodeURIComponent(id)}`, `/api/activity?repo=${encodeURIComponent(id)}`, '/api/upkeep?repo=&look=0', '/api/chat']) assert.equal(await p.status(route), 200, route);
});

test('the Report is `thinker report`: the weeks, parts, prices and trend rule, kept for the page\'s Factory and Recent activity', () => {
  assert.match(read('report.js'), /prs, prWeekly: weeklyPrStats\(prs, columns, now\)/);
  assert.match(read('report.js'), /for \(const w of v\.prWeekly\)/);
  // one computation, report.js:reportView; the page's All repositories is mergeReports, as the command has no All
  assert.match(read('commands/report.js'), /reportView\(store, \{ weeks, sessions \}\)/);
  // the page reads the report kept in each checkout (report-snapshot.js), made by the same function
  assert.match(read('report-snapshot.js'), /reportView\(store, \{ weeks, now, sessions \}\)/);
  assert.match(read('ui/server.js'), /reportSnapshot\(st, weeks\)/);
  assert.match(read('ui/server.js'), /mergeReports\(ready\.map/);
  // six weeks; --share is every row but the whole-session total as its share of it
  assert.match(read('commands/report.js'), /share: Boolean\(flags\.share\)/); assert.match(read('cli.js'), /report \[--weeks n\] \[--total\] \[--share\]/);
  assert.match(read('report.js'), /share = false \} = \{\}\) \{/);
  // the rest of the input by kind (report.js:OTHERS, the breakdown's rows), the prompt-cache rewrites by cause and the sessions
  // whose agent reports no usage, on both doors (2026-10-25), from the one view (reportView: rewrites, rewriteTotals, estimated, calibration)
  // the rewrites by cause and the estimated sessions are in the view and on neither door (the owner's call, 2026-10-25)
  for (const re of [/Prompt cache rewrites/, /Sessions whose agent reported no usage/]) assert.doesNotMatch(read('report.js').replace(/\/\/[^\n]*/g, ''), re);
  // the rest of the input is one row (reportView `otherInput`), its kinds under it
  assert.match(read('report.js'), /line\('Other input', v\.otherInput, false, base, \{ key: 'otherInput', thresholds: true \}\)/); assert.match(read('report.js'), /line\(`  \$\{p\.name\}`, p\.cells/);
  assert.match(read('report.js'), /export const CALIBRATION = \{ Anthropic: 1\.44 \}/, 'one calibration constant, read by the command and sent to the page in the view');
  assert.match(read('report.js'), /export const OTHERS = \[\.\.\.REST_INPUT, 'output'\]/, 'the rows under the four parts are the breakdown\'s kinds');
  // --total is the week's sum; the unit is a prompt, one call to the model (2026-10-24): the average is the week's sum over its prompts
  assert.match(read('commands/report.js'), /total: Boolean\(flags\.total\)/);
  assert.match(read('report.js'), /col\.pricedPrompts \? c\.cost \/ col\.pricedPrompts : null/);
  assert.match(read('report.js'), /per prompt \(one call to the model\)/);
  assert.match(read('report.js'), /export const REPORT_WEEKS = 6;/);
  // the Factory and Recent activity's pull requests read the same six weeks off /api/report
  assert.match(read('ui/page.html'), /\/api\/report\?repo=\$\{encodeURIComponent\(REPO\)\}&weeks=6/); assert.match(read('ui/page.html'), /\/api\/report\?repo=\$\{encodeURIComponent\(AREPO\)\}&weeks=6/);
  // every row of the parts table has bounds in dollars a priced prompt: report.js:COST_THRESHOLDS, carried in the view
  // (`costThresholds`), which the command marks (2026-10-26)
  assert.match(read('report.js'), /costThresholds: COST_THRESHOLDS,/); assert.doesNotMatch(read('report.js'), /thresholds: THRESHOLDS/); assert.match(read('report.js'), /verdict\(key, cells\[w\]\.cost \/ col\.pricedPrompts\)/);
  // Dollars and nothing else (the owner, 2026-11-08: "only costs"): no --tokens in the help, renderReport takes no unit;
  // the tokens stay in the view and --json
  assert.doesNotMatch(read('cli.js'), /--tokens/);
  assert.match(read('report.js'), /renderReport\(v, \{ total = false, share = false \} = \{\}\)/); assert.doesNotMatch(read('commands/report.js'), /cost: !flags\.tokens/);
  assert.match(read('commands/report.js'), /renderReport\(v, \{ total: Boolean\(flags\.total\), share: Boolean\(flags\.share\) \}\)/);
  assert.match(read('report.js'), /thresholds \? thr\(key\)/);
  for (const k of ['otherInput', 'output']) assert.match(read('report.js'), new RegExp(`key: '${k}', thresholds: true`));
  assert.doesNotMatch(read('report.js'), /TREND_MIN|TREND_BIG|▲/);
  // the decisions table is Recent activity's (historyFigure)
  // What the hooks wrote down and the agent never sent is in no cell of the parts table (transcripts.js:noteTokens):
  // the sentence under it is made once, in report.js, and carried on the view as `line`, so a later door prints the
  // words the command prints rather than writing its own (2026-11-21; the Report page went with #901, so the command
  // is the only door that says it today).
  assert.match(read('report.js'), /export const notesUnsentLine = u =>/);
  assert.match(read('report.js'), /line: notesUnsentLine\(u\)/);
  assert.match(read('report.js'), /v\.notesUnsent\) L\.push\(`  \$\{v\.notesUnsent\.line\}`\)/);
  assert.match(read('ui/page.html'), /historyFigure\(hs, \{ many, caption: 'Decisions'/);
  // the decisions tables show 20 rows a page
  assert.match(read('ui/page.html'), /const TABLE_PAGE = 20;/);
  // the decisions are not on the Report (2026-10-24, the owner's call): Recent activity and `thinker context --history` show
  // every decision with before, after and saved a prompt, attributed to the thing it changed alone (report.js:actionEffect
  // over the kept report, report-snapshot.js:historyEffects), under a cell over Saved with what a prompt costs on average
  // here (promptAverageHere), the size the savings are read against; no text under the table
  assert.doesNotMatch(read('report.js'), /Recent improvements|reportTop/);
  assert.doesNotMatch(read('ui/page.html'), /Recent improvements|Saved with thinker|compact: true/);
  assert.match(read('ui/server.js'), /historyEffects\(st, entries\.filter/);
  assert.match(read('ui/server.js'), /promptAvg: mergePromptAverages\(avgs\)/);
  assert.match(read('commands/context.js'), /historyEffects\(store, changeHistory\(store\)\)/);
  assert.match(read('commands/context.js'), /A prompt here costs \$\{formatTokens\(avg\.perPrompt\)\} tokens on average/);
  assert.match(read('ui/page.html'), /promptAvg: d\.promptAvg \|\| null/);
  // a kept report none of this code's is not read for the savings; the activity API starts the refresh and the page checks back
  assert.match(read('report-snapshot.js'), /export function keptRows/);
  assert.match(read('ui/server.js'), /if \(kept\.stale && url\.searchParams\.get\('measure'\) !== '0'\) \{ measuring = true; if \(progressive\) readings\.push\(scans\.read\('report', st, REPORT_WEEKS\)\); else if \(!reportRefreshing\(st\)\) refreshReportFn\(st\.repo\); \}/);
  assert.match(read('ui/page.html'), /function activityCheckBack/);
  // the page's script parses (2026-10-24: a second `let APOLL` left the whole page blank, which no test caught)
  for (const [, src] of read('ui/page.html').matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(src));
  assert.match(read('commands/context.js'), /thinker report --refresh` makes the report they are read from/);
  assert.match(read('ui/page.html'), /<span class="ctx-avg-label">Average prompt<\/span><b>\$\{fmt\(promptAvg\.perPrompt\)\}<\/b> tokens/);
  assert.match(read('ui/page.html'), /<tr class="ctx-caprow"><th colspan="4" class="ctx-cap">\$\{capText\}<\/th><th class="num ctx-avgcell">\$\{avgStat\}<\/th>/, 'the caption is the first header row, the average prompt in the cell over Saved');
  assert.match(read('ui/page.html'), /<th class="num"[^>]*>Before<\/th><th class="num"[^>]*>After<\/th><th class="num"[^>]*>Saved per prompt<\/th><th>Pull request<\/th>/);
  assert.doesNotMatch(read('ui/page.html'), /A section's change runs in the background and <b>o/);
  // list prices from prices.js, an unpriced model marked in its row's name
  assert.match(read('report.js'), /listPrice\(r\.model, \{ config \}\)/);
  assert.match(read('report.js'), /\(unpriced\)/);
  assert.doesNotMatch(read('ui/page.html'), /class="lede">What a session costs here/); assert.doesNotMatch(read('ui/page.html'), /A model's row is its share/);
  // three tables, each ending on the whole session: the token types (report.js:TOKEN_TYPES), the parts with the rest of the
  // input and the output under them (report.js:OTHERS), the models, the token types last (2026-10-24)
  assert.match(read('report.js'), /export const TOKEN_TYPES = \[\['fresh', 'Input, fresh'\], \['cacheWrite', 'Input, written to cache'\], \['cacheRead', 'Input, read from cache'\], \['output', 'Model output'\]\];/);
  assert.match(read('report.js'), /export const OTHERS = \[\.\.\.REST_INPUT, 'output'\]\.map\(k => BREAKDOWN\.find/, 'the rest of the input by kind, then the output (2026-10-25)');
  assert.match(read('report.js'), /'By token type \(as the model reported them/);
  // every tab is rebuilt in place once on screen (2026-10-25): the renders go through swapBody, which keeps the scroll, and
  // a load of what is already shown does not wipe the body to the spinner
  assert.match(read('ui/page.html'), /function swapBody\(el, html\)/); assert.match(read('ui/page.html'), /swapBody\(el, card \+ pullCard \+ historyFigure\(/);
  assert.match(read('ui/page.html'), /inPlace = prs \? Boolean\(APR\) && APR_FOR === AREPO : Boolean\(ACT\) && ACT_FOR === AREPO/); assert.match(read('ui/page.html'), /inPlace = Boolean\(FX\) && FX_FOR === REPO/);
  assert.doesNotMatch(read('ui/page.html'), /Total of these/); assert.doesNotMatch(read('report.js'), /'Total of these'/);
  assert.equal((read('report.js').match(/line\('Total \(the whole session\)', v\.sessionTotals, true(, null, \{ key: 'total', thresholds: true \})?\)/g) || []).length, 3);
  assert.match(read('report.js'), /for \(const p of rest\) L\.push\(line\(`  \$\{p\.name\}`, p\.cells, false, base, \{ key: p\.key, thresholds: true \}\)\);/, 'the kinds under Other input, indented');
  // the weekly savings series is the Report's
  assert.match(read('report.js'), /Compression effectiveness/);
  assert.match(read('report.js'), /changeHistory\(store\)\.filter\(e => Date\.parse\(e\.at\) >= from\)/);
  assert.doesNotMatch(read('ui/page.html'), /renderTrend|tr-stack|api\/cache|api\/behaviors|api\/usage/);
});

test('Recent activity rows and `thinker context --history` say what the part is (a built-in tool apart from a custom one) and does, with no See more (2026-10-24)', () => {
  const page = read('ui/page.html'), hist = page.slice(page.indexOf('function historyFigure'), page.indexOf('function wireHistory'));
  assert.doesNotMatch(hist, /ctx-more|data-more|data-detail|detail\(e\)/, 'no detail row and no button to open one; the hovers tell');
  assert.match(hist, /title="\$\{esc\(hintOf\(e\)\)\}"/); assert.match(hist, /title="\$\{esc\(decidedHint\(e\)\)\}"/);
  assert.match(hist, /e\.what \|\| CH_KIND\[e\.kind\]/); assert.match(hist, /<span class="ctx-about">\$\{esc\(e\.about\)\}<\/span>/);
  assert.doesNotMatch(read('ui/page.html').slice(page.indexOf('function wireHistory')), /\[data-more\]/);
  // the command prints the same two, after the title
  assert.match(read('commands/context.js'), /\$\{e\.title\}\$\{e\.what \? `  \[\$\{e\.what\}\$\{e\.about \? `: \$\{e\.about\}` : ''\}\]` : ''\}/);
  // both read them from the entry, which changeHistory describes (part-describe.js) for entries written before they were kept
  assert.match(read('context-suggest.js'), /\.\.\.describeEntry\(e\)/);
  for (const kind of ['section', 'skill', 'tool']) assert.match(read('context-suggest.js'), new RegExp(`describePart\\(\\{ kind: '${kind}'`));
});

test('what a change is worth is said in money, from one rate, by the command and by thinker itself', async () => {
  // the dollars an input token cost here, off the kept report (report.js:inputRate): `thinker context`'s Top changes,
  // and what a line of the activity says an action saves a day
  assert.match(read('report.js'), /export const inputRate = view => view\?\.inputRate \?\? null;/);
  assert.match(read('report.js'), /inputRate: pricedInput > 0 && pricedInputCost > 0 \? pricedInputCost \/ pricedInput : null,/, 'measured over the priced sessions alone');
  assert.match(read('report-snapshot.js'), /export function inputRateHere\(store/);
  for (const f of ['upkeep.js', 'commands/context.js']) assert.match(read(f), /inputRateHere\(store/, f);
  for (const f of ['upkeep.js', 'commands/context.js']) assert.match(read(f), /formatDollars\(/, f);
});

test('`thinker prs` is one door, and its help says what the figures are (2026-10-29)', async () => {
  const { WINDOW_DAYS } = await import('../src/delivery.js');
  const { DEFAULTS } = await import('../src/maintain.js');
  const cli = read('cli.js'), cmd = read('commands/prs.js');
  // The command's window default is the module's, so help, report and telemetry cover the same days.
  assert.match(cmd, /flags\.days === undefined \? WINDOW_DAYS/);
  assert.equal(WINDOW_DAYS, 30);
  // There is no page tab for it yet, so the help carries the whole explanation, and says the saving is measured.
  assert.match(cli, /prs \[--days n\] \[--pr n\] \[--detail\] \[--json\]/);
  assert.match(cli, /prs sync \[--days n\] \[--pr n\]/);
  assert.match(cli, /prs link --session id --pr n/);
  assert.match(cli, /prs comment --pr n \[--days n\] \[--dry\] \[--json\]/);
  assert.match(cli, /prs auto \[--dry\] \[--json\]/);
  assert.match(cmd, /commentOnPr\(store, \{ pr, days, dry: !!flags\.dry \}\)/);
  assert.match(cli, /\(measured\)/);
  // The page's second door is the Report tab's band, which reads the figures off the report view that
  // report.js already computed (prSavings). There is no endpoint of its own, and nothing on the page
  // recomputes them on a visit.
  assert.match(read('ui/page.html'), /pr = v\.prs;/);
  assert.doesNotMatch(read('ui/page.html'), /api\/prs/);
  // Maintenance keeps it current by itself; the switch named in the docs is the one the code reads.
  assert.equal(DEFAULTS.prSync, true);
  assert.equal(DEFAULTS.prs, undefined, 'maintain.prs is the mining switch; the sync has its own');
  assert.match(fs.readFileSync(path.join(SRC, '..', 'docs', 'usage.md'), 'utf8'), /\{ prSync: false \}/);
});

// The dollars are one computation in delivery.js, read by both doors; a door that priced a token itself is how the
// band came to show a gross saving for a fortnight with nothing beside it. The netted figure (2026-11-04) is thinker
// prs's and the posted comment's. The Report shows the saving gross and the cost beside it (the owner, 2026-11-08:
// "saved per PR doesn't need to be negative"): the cost already holds the cache writes after a clear, so netting
// them out of the saving too would count them against the pull request twice. Where the gross figure is shown, the
// writes are named as part of the cost.
test('the dollars are one computation, shown by both doors', () => {
  // The command's summary line and its table column.
  assert.match(read('report.js'), /saved on them\s+\$\{formatDollars\(pr\.cost\?\.saved[^\n]*includes \$\{formatDollars\(pr\.cost\?\.rewrite/);
  assert.match(read('report.js'), /'saved'\.padStart/);
  assert.doesNotMatch(read('report.js'), /formatDollars\(pr\.cost\?\.net|r\.net == null \? '–' : formatDollars/, 'the Report shows the gross saving, not the netted one');
  // The page's own column reads the same fields off the row the report sends; it computes no dollars.
  const page = read('ui/page.html');
  assert.match(page, /<th class="num" title="[^"]*">Saved<\/th>/, 'the page column explains itself in a hover');
  assert.match(page, /money\(r\.savedUsd\)/);
  assert.doesNotMatch(page, /money\(r\.net\)/);
  assert.match(page, /its cost includes \$\{money\(r\.rewriteUsd\)\} of cache writes after a clear/, 'the writes are named as part of the cost');
  // thinker prs and the comment keep the netted figure
  assert.doesNotMatch(page, /cacheWrite1h|cacheRead \*/, 'the page never prices a token itself');
  // One place the rewrite cost is worked out, and the deduction is named wherever the figure is shown.
  for (const f of ['report.js', 'delivery.js', 'delivery-comment.js']) {
    assert.match(read(f), /after a clear/, `${f} says what was deducted`);
  }
  // A loss is never posted on someone's pull request by the automatic pass.
});

test('automatic PR comments reuse the update cadence and expose their defaults and opt-out', async () => {
  const { AUTO_PR_COMMENTS, PR_COMMENT_IDLE_MS, PR_COMMENT_LIMIT } = await import('../src/delivery-auto.js');
  const { UPDATE_EVERY_MS } = await import('../src/update.js');
  assert.equal(AUTO_PR_COMMENTS, true);
  assert.equal(PR_COMMENT_IDLE_MS, 20 * 60_000);
  assert.equal(PR_COMMENT_LIMIT, 10);
  assert.equal(UPDATE_EVERY_MS, 4 * 3600_000);
  assert.match(read('cli.js'), /false in the machine or repository config/);
  assert.match(read('commands/prs.js'), /runAutomaticPrComments\(store, \{ dry: !!flags\.dry \}\)/);
});

test('Recent activity\'s PR savings and `thinker report` share the report data, in dollars (2026-10-30, dollars since 2026-11-08)', async () => {
  const page = read('ui/page.html'), rep = read('report.js');
  // one source for both doors: the band is computed in report.js and carried on the view, never recomputed on a page
  assert.match(rep, /const prs = includePrs \? prSavings\(store, \{ days, now \}\) : null/);
  assert.match(page, /pr = v\.prs;/);
  assert.doesNotMatch(page, /const cards =|const prBand =/);
  for (const phrase of ['merged with work here', 'spent on them', 'saved on them', 'on the average one']) assert.ok(rep.includes(phrase), `command line: ${phrase}`);
  // the same columns, in the same order (the reading-avoided and saved columns went with the knowledge notes, 2026-11-08)
  // in dollars on both doors since 2026-11-08 (the owner's call: tokens add reads, writes and output as one thing)
  for (const c of ['Sessions', 'Its cost', 'Saved', 'Share']) assert.ok(page.includes(`>${c}</th>`), `page column: ${c}`);
  const head = rep.slice(rep.indexOf("'Merged, newest first'"), rep.indexOf("'Merged, newest first'") + 400);
  for (const c of ['sessions', 'its cost', 'saved', 'share']) assert.ok(head.includes(`'${c}'`), `command column: ${c}`);
  assert.doesNotMatch(page, /Tokens saved per PR|Total tokens per PR|>Cleared<\/th>/, 'no token figure on a pull request');
  for (const key of ['savedUsdPerPr', 'spendPerPr']) assert.ok(rep.includes(`w.${key}`), `command column ${key}`);
  // Both doors describe the PR figures in dollars, and the page prices no token itself: it reads the row's dollars
  assert.doesNotMatch(page, /Tokens spent and saved on merged pull requests|Of the work shipped here/);
  assert.ok(rep.includes('what merged work cost and what the clearing saved on it, in dollars'));
  const prRows = page.slice(page.indexOf('function renderActivityPrs('), page.indexOf('function renderActivityPrs(') + 2500);
  assert.match(prRows, /money\(r\.spend\)/); assert.match(prRows, /money\(r\.savedUsd\)/); assert.doesNotMatch(prRows, /fmt\(r\.agent\)|fmt\(r\.cleared\)/, 'no token figure on a PR row');
  // a kept report made before the band must be remade, so report-snapshot hashes what the band is computed from
  for (const f of ['delivery.js', 'compression.js']) assert.ok(read('report-snapshot.js').includes(`'${f}'`), `${f} is in the report's code key`);
});

// Every element the page's script reaches for is in its own markup. #537 took the sort control out and left the tab's
// loader hiding it, on a line above the try, so the tab threw on `$('#c-sort-wrap').hidden` before it fetched anything
// and sat on its spinner for good -- a page that renders nothing, with nothing in the catch to say so. One dead
// selector in a load path costs the whole page, and nothing but a browser was looking.
test('the page reaches for no element it does not define', () => {
  const page = read('ui/page.html');
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const reached = new Set([
    ...[...page.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
    ...[...page.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
    ...[...page.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
  ]);
  // an id built from a variable (`#c-${k}`) ends at the brace and is the tabs' own sections (`#tab-${k}`)
  const dangling = [...reached].filter(k => !ids.has(k) && !k.endsWith('-'));
  assert.deepEqual(dangling, [], `page.html reaches for ${dangling.join(', ')}, which its markup does not define`);
});


test('Recent activity defaults to Action savings; PR savings uses the report data independently', () => {
  const page = read('ui/page.html');
  assert.match(page, /let AVIEW = 'actions'/);
  assert.match(page, /data-view="actions" class="on" aria-selected="true"/);
  assert.match(page, /data-view="prs" aria-selected="false"/);
  assert.match(page, /function renderActivityPrs\(v\)/);
  assert.match(page, /await progressiveView\(`\/api\/report\?repo=\$\{encodeURIComponent\(AREPO\)\}/);
  assert.match(read('context-suggest.js'), /global: c\.kind === 'tool'/, 'approving a tool switches it machine-wide, one decision and not one a repository');
});

// Devin shares the CLI's client selection/default delivery; the page has no second installer.
test('Devin is selectable through connect and is named consistently', async () => {
  const { parseClients, CLIENTS, USER_SCOPE_CLIENTS } = await import('../src/clients.js');
  assert.deepEqual(parseClients('devin'), ['devin']);
  assert.ok(CLIENTS.includes('devin') && USER_SCOPE_CLIENTS.includes('devin'));
  assert.match(read('cli.js'), /opencode, devin and more/);
  // the compaction policy is off by default and documented under the key Devin reads (devin-compaction.js)
  const compaction = await import('../src/devin-compaction.js');
  const { PROXY_DEFAULTS } = await import('../src/proxy.js');
  assert.equal(compaction.DEVIN_COMPACT_AT, PROXY_DEFAULTS.trigger, 'Devin compacts where the proxy clears');
  assert.equal(compaction.devinCompactAt(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-nopolicy-')), {}), compaction.DEVIN_COMPACT_AT, 'on by default (owner, 2026-11-01)');
  assert.match(fs.readFileSync(path.join(SRC, '..', 'docs', 'agent-integrations.md'), 'utf8'), new RegExp(`devin: \\{ compactAt[^\\n]*|agent\\.${compaction.DEVIN_COMPACT_KEY}`));
  assert.match(read('setup/steps.js'), /devin: \{ name: 'Devin' \}/);
});

test('the end-of-turn notices have one cadence, and the hooks read it from the module', async () => {
  const { NOTICE_PROMPTS, NOTICE_HOURS, noticeCadence } = await import('../src/notice-cadence.js');
  assert.deepEqual([NOTICE_PROMPTS, NOTICE_HOURS], [20, 24], 'one summary every 20 prompts and at most one a day');
  assert.deepEqual(noticeCadence({ config: () => ({}) }), { prompts: NOTICE_PROMPTS, hours: NOTICE_HOURS });
  const hooks = read('commands/hooks.js');
  for (const fn of ['noticeDue', 'noticeShown', 'countPrompt', 'holdNotice']) assert.match(hooks, new RegExp(fn));
  assert.doesNotMatch(hooks, /everyPrompts|everyHours|NOTICE_PROMPTS|NOTICE_HOURS/, 'the floors are the module\'s, never a second copy at a door');
});

// Experiment-only validation has no UI control; normal page reports retain their shape.
test('proxy accounting verification is an explicit CLI flag', () => {
  assert.match(read('cli.js'), /--verify-usage/);
  assert.match(read('commands/proxy.js'), /flags\['verify-usage'\]/);
});

// `thinker containers` is machine-wide and CLI-only, like `proxy` and `errors`: it changes a container on
// this machine, not a repository's context, so it has no row on Find Savings and no Report figure. The sync
// rule it must keep is the other one -- the command is the only door, and it answers in a repository thinker
// is switched off for, because a container is the machine's, not the checkout's.
test('thinker containers is machine-wide and CLI-only, and installs from this build rather than the network', async () => {
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.match(cli, /'containers'/, 'containers answers where a repository is switched off, as proxy and errors do');
  assert.match(cli, /containers \[--install id\|name\|all\] \[--devcontainer\] \[--json\]/, 'the command is in the help');
  const page = fs.readFileSync(new URL('../src/ui/page.html', import.meta.url), 'utf8');
  assert.ok(!/containers/.test(page), 'no page control may offer to change a container');
  const mod = await import('../src/containers.js');
  // what goes into a container is this build, so the two copies cannot drift to different versions
  assert.ok(mod.COPY_EXCLUDES.includes('node_modules/onnxruntime-node'), 'the host\'s native modules are the wrong architecture inside');
  assert.match(mod.containerSnippet(), /npx -y thinkersh --no-build/, 'the permanent form installs by version, not by copy');
});

// The Report carries the session profile's own measure on both doors (2026-11-08, the owner's ask), from one
// computation (profile-metric.js); the verdict wording is the page's copy of report.js's. The notes' cache-hits row
// went with the notes (report-savings.js, 2026-11-08) and may not come back as a row of zeros.
test('the Report prints the profile metric, and no row of the removed notes', async () => {
  const report = read('report.js');
  assert.match(report, /profileMetric\(store/); assert.match(report, /mergeProfileMetrics\(/, 'All repositories pools the arms');
  assert.match(report, /profileLines\(v\.profile/);
  assert.match(read('commands/profile.js'), /holdoutFromLog\(/, 'thinker profile holdout reads the same computation');
  const { PROFILE_VERDICTS } = await import('../src/report.js');
  assert.ok(PROFILE_VERDICTS['too-early'] && PROFILE_VERDICTS.fewer && PROFILE_VERDICTS.cheaper, 'a verdict in words for each outcome');
  assert.doesNotMatch(report, /Cache hits|notes served|savings-counts/);
  assert.match(read('report-snapshot.js'), /'profile-metric\.js'/, 'a kept report from before the figure is remade');
});

test('the Factory tab and `thinker factory` read one computation, kept with the Report', () => {
  // factory.js builds the view once (factoryView); the Report keeps it (`factory` on reportView, merged for All
  // repositories by mergeFactory), the page reads it off /api/report, and the command prints the kept one
  assert.match(read('report.js'), /const factory = \(\(\) => \{ try \{ return factoryView\(/);
  assert.match(read('report.js'), /factory: mergeFactory\(list\)/);
  assert.match(read('report-snapshot.js'), /'factory\.js'/, 'a kept report from before the factory is remade, not served without it');
  assert.match(read('commands/factory.js'), /reportSnapshot\(store, weeks\)\.view\?\.factory/);
  assert.match(read('ui/page.html'), /renderFactory\(v\)/);
  assert.match(read('ui/page.html'), /data-tab="factory"/);
  assert.match(read('cli.js'), /factory \[--weeks n\] \[--diff profile\|compression\] \[--json\] \[--refresh\]/, 'the flags are in help, which is what unknownFlags reads');
  // the weekly trend the page opens on a stage or a loop is the command's weekly table, off the same `weekly` on the view
  assert.match(read('ui/page.html'), /wk\.stages\[id\]/); assert.match(read('ui/page.html'), /wk\.loops\[id\]/);
  // "See diff by": the page's two features and sides are factory.js:ARMS, and the command has the same split as --diff
  for (const f of ['profile', 'compression']) { assert.match(read('ui/page.html'), new RegExp(`${f}: \\{ name: '`)); assert.match(read('factory.js'), new RegExp(`${f}: \\{ name: '`)); }
  assert.match(read('cli.js'), /--diff profile\|compression/);
  // the two doors say the attribution rule in the same words
  for (const f of ['factory.js', 'ui/page.html']) assert.match(read(f), /A call's tokens go to the stage of the tool it called; the first call after a prompt is Prompts; a call with no tool is Think\./);
});

test('the page opens on the chat with Recent activity beside it: `thinker chat` and `thinker activity` are the same function and view, and nothing on either is for the person to do', async t => {
  // 2026-11-21, the owner's calls: the chat is the page, Recent activity runs down its left side as a line an action
  // with what it came to, under a toggle to the chat history, and there is "no more manual action": thinker does its
  // work itself
  const html = read('ui/page.html');
  assert.match(html, /show\(H\(\)\.get\('tab'\) \|\| 'chat'\);/, 'no tab named: the chat');
  assert.match(html, /<button class="nav-link" data-tab="chat"/); assert.match(html, /<section id="tab-chat" hidden>/);
  assert.match(html, /<aside class="home-side" aria-label="Recent activity and chat history">/);
  assert.match(html, /esc\(f\.impactSaid\)/, 'the page prints the impact the server worded, as the command does');
  assert.match(read('upkeep.js'), /\$\{f\.impactSaid \? ` {2}\$\{f\.impactSaid\}` : ''\}/);
  // a pull request may be in review for days: its line carries its link through both doors
  assert.match(html, /<a href="\$\{esc\(f\.url\)\}" target="_blank" rel="noopener">PR #\$1<\/a>/); assert.match(read('upkeep.js'), /\$\{f\.url \? ` {2}\$\{f\.url\}` : ''\}/);
  // thinker's own housekeeping is not activity: neither door has a line for a session read or a state file cleared
  for (const f of ['upkeep.js', 'ui/page.html']) assert.doesNotMatch(read(f), /stale state file|Read \$\{plural\(g\.n, 'session'\)/);
  // one computation (upkeep.js:upkeepView): the command prints it, the page reads it merged over the repositories
  assert.match(read('commands/activity.js'), /const v = upkeepView\(store\);/);
  assert.match(read('ui/server.js'), /mergeUpkeepViews\(pairs\)/);
  // no manual action through either door: no route and no button to do, leave, undo or look, and no verb for them
  assert.doesNotMatch(read('ui/server.js'), /\/api\/upkeep\/|upkeepDo\(|upkeepDismiss\(|upkeepUndo\(|upkeepCheck\(/);
  assert.doesNotMatch(html, /\/api\/upkeep\/|data-do|data-leave|data-undo|Leave it|Look again/);
  assert.doesNotMatch(read('commands/activity.js'), /upkeepDo|upkeepDismiss|upkeepUndo|setBehavior/);
  assert.match(read('cli.js'), /activity \[run \[--look\]\] \[--all\] \[--json\]/, 'the flags are in help');
  assert.match(read('cli.js'), /chat \[message\] \[--new\] \[--chat id\] \[--history\] \[--json\]/);
  // the chat history is one list (chat.js:chatList, through chatView): the page's side draws it, the command prints it,
  // and both open on the conversation last spoken in where none is named and start another on the same word, `new`
  assert.match(read('ui/server.js'), /chatView\(\{ home, chat: url\.searchParams\.get\('chat'\) \|\| null \}\)/); assert.match(read('commands/chat.js'), /const open = chatView\(\{ chat \}\);/);
  assert.match(html, /CHATS = r\.chats \|\| \[\]/); assert.match(read('commands/chat.js'), /renderChats\(open\.chats, \{ open: open\.chat \}\)/);
  assert.match(html, /chat: into \|\| 'new'/); assert.match(read('commands/chat.js'), /const chat = flags\.new \? 'new' : /);
  // doing, leaving and taking back a thing, and how thinker behaves, are said to it: the chat is the one door to them
  for (const fn of ['setBehavior(', 'steerBehavior(', 'upkeepDo(', 'upkeepDismiss(', 'upkeepUndo(']) assert.ok(read('chat.js').includes(fn), `the chat calls ${fn}`);
  // "Chat about this" on a line of the side: the line goes into the prompt box as a card and with the message as `about`;
  // the card is only that -- no button on it says or sends anything ("users can just chat about it, no fixed buttons")
  assert.match(html, /<button class="side-about" type="button" data-about="a:\$\{i\}">Chat about this<\/button>/); assert.match(html, /data-about="s:\$\{i\}">Chat about this/);
  assert.match(html, /<div class="chat-box"><div class="chat-attach" id="chat-attach"><\/div><textarea id="chat-input"/, 'the card sits inside the prompt box, over the words');
  assert.match(html, /\.\.\.\(ref \? \{ about: ref \} : \{\}\)/); assert.match(read('ui/server.js'), /ref: b\.about && typeof b\.about === 'object' \? b\.about : null/);
  assert.doesNotMatch(html, /More like this|Less like this|data-ref-say/);
  // the card names its line (`id`), so the chat can be given what thinker knows behind it and answer about the thing
  assert.match(html, /CHAT_REF = \{ kind, id: x\.id \|\| '', text: x\.text,/); assert.match(read('chat.js'), /known = upkeepDetail\(whose\.store, card\.id, \{ now, home \}\)/);
  // the Factory's own "Chat about this", to the right of a clicked stage's trend: the stage goes into the same prompt box
  // as the same kind of card, named by its key, and the chat is given what the Factory holds on it from the kept report
  assert.match(html, /chat\.className = 'fx-chat'; chat\.textContent = 'Chat about this'; chat\.onclick = \(\) => \{ fxPopClose\(\); chatAboutStage\(stage, dollars\); \};/);
  assert.match(html, /CHAT_REF = \{ kind: 'stage', id: s\.key, text: /); assert.match(read('chat.js'), /lines: stageDetail\(v, card\.id, /); assert.match(read('chat.js'), /readReport\(r\.store\)\?\.view/, 'from the kept report, never made for a message');
  // per session, what was handed to cheaper agents and what that saved: the Report's delegation figure, one rule, both doors
  assert.match(read('upkeep.js'), /delegationBySession\(\{ events, compression: rows, config,/); assert.match(read('report-savings.js'), /for \(const r of delegationSavings\(\{ events, compression, config \}\)\) \{\n    const g = of\(r\.session\);/);
  assert.match(html, /Delegated to cheaper agents<\/div><div class="side-total">\$\{esc\(g\.said\)\}/); assert.match(read('upkeep.js'), /`Delegated to cheaper agents · \$\{delegatedTotalSaid\(v\.delegated\)\}`/);
  assert.match(read('commands/chat.js'), /chatSend\(text, /); assert.match(read('ui/server.js'), /chatSend\(String\(b\.message/);
  // A visit to the page never has thinker act: the page's own check only looks. Acting is maintenance's clock.
  assert.match(read('ui/server.js'), /child\(\['activity', 'run', '--look', '--quiet', '--repo', checkout\], checkout\)/);
  assert.match(read('commands/activity.js'), /upkeepCheck\(store, \{ act: !flags\.look \}\)/);
  const { behaviorOf, upkeepView, upkeepCheck, BEHAVIOR } = await import('../src/upkeep.js');
  // by itself, only what clearly pays, in batches: the defaults both doors describe (the owner's answers, 2026-11-21)
  assert.deepEqual([BEHAVIOR.level, BEHAVIOR.prs, BEHAVIOR.remove, BEHAVIOR.sweep, BEHAVIOR.tools, BEHAVIOR.skills, BEHAVIOR.minPerDay, BEHAVIOR.batchPerDay, BEHAVIOR.batchEveryDays], ['auto', true, true, true, true, false, 1, 5, 7]);
  assert.match(read('cli.js'), /worth \$1 a day or more, together in one batch once they come to \$5 a day, at most one\s+batch a repository a week/);

  // on the wire, over a home of its own: a pull request in review is a line with its link and what it is expected to
  // save, exactly as the command prints it; what thinker holds back is not on the page at all
  const dir = repo(t), st = new Store(dir).init();
  const at = new Date(Date.now() - 3600_000).toISOString();
  fs.mkdirSync(path.join(st.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(st.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [
    { id: 'p1', at, key: 'section:AGENTS.md:releases', kind: 'section', title: 'AGENTS.md · Releases', saving: 1200, act: 'compress', decision: 'pull request', via: 'thinker', pr: { number: 12, state: 'open', url: 'https://github.com/o/r/pull/12', at } },
  ] }));
  const p = page(t, dir, { chatFn: async () => ({ json: { reply: "I'll wait for your word from now on.", actions: [{ type: 'set', key: 'level', value: 'ask' }] }, model: 'fake' }) });
  const ui = await p.start();
  await upkeepCheck(st, { act: false, home: p.home, fns: { view: () => null, findMess: () => ({ worktrees: [], branches: [], kept: [] }) } });
  const now = Date.now(), shown = await ui.get('/api/upkeep?repo=&look=0'), printed = upkeepView(st, { now, home: p.home });
  const lines = v => v.feed.filter(f => f.kind === 'pr').map(f => [f.text, f.impactSaid, f.url, f.pr]);
  assert.deepEqual(lines(shown), [['PR #12 in review: shortens AGENTS.md · Releases', 'about −1.2k tokens per prompt once merged', 'https://github.com/o/r/pull/12', { number: 12, state: 'open' }]]);
  assert.deepEqual(lines(shown), lines(printed));
  assert.deepEqual([shown.summary, shown.lastCheck, shown.behaviorSaid, shown.level, shown.later, shown.held], [printed.summary, printed.lastCheck, printed.behaviorSaid, 'auto', 0, 0]);
  assert.deepEqual([shown.pending, shown.notes, shown.items], [undefined, undefined, undefined], 'nothing listed for the person to work through');
  for (const route of ['do', 'leave', 'undo', 'look']) assert.equal((await ui.post(`/api/upkeep/${route}`, { repo: '', id: 'sweep' })).status, 404);
  // the chat: the message is answered, what it changed is said by the server, and the side says the same
  assert.deepEqual(await ui.get('/api/chat'), { chat: null, messages: [], chats: [] });
  const said = await ui.post('/api/chat', { message: 'ask me before you do anything', repo: '' });
  assert.deepEqual(said.messages.map(m => [m.role, m.text]), [['you', 'ask me before you do anything'], ['thinker', "I'll wait for your word from now on."]]);
  assert.deepEqual(said.messages[1].did, [{ type: 'set', ok: true, text: 'level is now ask on this machine' }]);
  assert.equal(behaviorOf(st, { home: p.home }).level, 'ask');
  assert.equal((await ui.get('/api/upkeep?repo=&look=0')).behaviorSaid, 'Thinker does nothing here until you tell it to.');
  assert.equal((await ui.get('/api/chat')).messages.length, 2);
  assert.equal((await ui.post('/api/chat', { message: '  ', repo: '' })).status, 400);
  // a message sent with a card keeps it, cut to what a line is
  const withCard = await ui.post('/api/chat', { message: 'what is this for?', repo: '', about: { kind: 'action', text: 'PR #12 in review: shortens AGENTS.md · Releases', url: 'https://github.com/o/r/pull/12', at, extra: 'dropped' } });
  assert.deepEqual(withCard.messages.at(-2).ref, { kind: 'action', text: 'PR #12 in review: shortens AGENTS.md · Releases', at, url: 'https://github.com/o/r/pull/12' });
  // the chat history: a message with no conversation named went on in the one open, New chat starts another, and the
  // rows the page lists are the rows `thinker chat --history` prints (chatList), newest first
  assert.equal(withCard.chat, said.chat); assert.equal(withCard.messages.length, 4);
  const fresh = await ui.post('/api/chat', { message: 'what did you do today?', repo: '', chat: 'new' });
  assert.notEqual(fresh.chat, said.chat); assert.deepEqual(fresh.messages.map(m => m.text), ['what did you do today?', "I'll wait for your word from now on."]);
  const { chatView } = await import('../src/chat.js');
  assert.deepEqual(fresh.chats, chatView({ home: p.home }).chats);
  assert.deepEqual(fresh.chats.map(c => [c.id, c.title, c.messages]), [[fresh.chat, 'what did you do today?', 2], [said.chat, 'ask me before you do anything', 4]]);
  assert.equal((await ui.get('/api/chat')).chat, fresh.chat, 'no conversation named: the one last spoken in');
  assert.equal((await ui.get(`/api/chat?chat=${said.chat}`)).messages.length, 4);
  assert.deepEqual([(await ui.get('/api/chat?chat=new')).chat, (await ui.get('/api/chat?chat=new')).messages.length, (await ui.get('/api/chat?chat=new')).chats.length], [null, 0, 2]);
  assert.deepEqual(shown.delegated, { days: 14, total: { sessions: 0, reads: 0, runs: 0, handed: 0, saved: 0, unpriced: 0 }, sessions: [], said: '' });
});

test('models from other providers are the command line\'s alone: the page has no door to a key, and every flag is in help', () => {
  // the registry and its key files are the machine's (providers.js); the page never asks for a credential
  assert.doesNotMatch(read('ui/page.html'), /thinker models|--key-env|providers\.json/);
  for (const f of ['--key-env NAME|--key-file path|--key value|--no-key', '--format messages|chat', '--template reader|worker', '--input n --output n', 'models profile [--days n] [--here] [--json] [--refresh]']) assert.ok(read('cli.js').includes(f), f);
  // prices stay one door: the registry's prices reach the Report through prices.js, and nowhere else prices a token
});
