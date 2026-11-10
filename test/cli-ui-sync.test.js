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
  assert.match(read('savings-ledger.js'), /weeklySavings/);
  assert.match(read('savings-ledger.js'), /SAVINGS_SERIES/, 'the Report\'s own series');
  assert.match(read('commands/hooks.js'), /savings-ledger\.js/);
  // and every door says it in the ledger's own words
  for (const [file, fn] of [['commands/savings.js', 'savingsLine'], ['commands/hooks.js', 'savingsLine']]) assert.match(read(file), new RegExp(fn));
  // OpenCode 2's terminal part is one more door: its footer calls savingsStatus, so the words under the
  // prompt are the status row's, and a figure there can never disagree with `thinker savings` either.
  assert.match(read('integrations/opencode-tui.js'), /savingsStatus/);
  assert.match(read('integrations/opencode-tui.js'), /LEDGER_POLL_MS = 5_000/, 'the Claude mod polls the ledger every 5 s; the terminal part follows the file, not the turn');
  // the command the hooks start in the background is the one a person can run by hand
  assert.match(read('savings-ledger.js'), /'savings', '--refresh', '--quiet'/);
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
  assert.match(read('proxy-service.js'), /agents = \['claude', 'pi', 'opencode', 'codex'\]/);
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
  // the page switches tools off and back on from a row's dropdown and Apply: through /api/changes/approve and
  // context-suggest.js:approveChanges, which calls the same function as `thinker context --switch-off|--switch-on`,
  // and records the decision for History's Revert
  assert.match(read('ui/page.html'), /api\('\/api\/changes\/approve', \{ repo, \.\.\.g, days: cdays \}\)/);
  assert.match(read('context-suggest.js'), /switchSources\(store, \{ keys: \[c\.sourceKey \|\| c\.name\], on: true \}\)/);
  // A tool's output compression is no door's choice (2026-11-04, the owner's call): the clearing compresses outputs and
  // is on by default, so neither the page, the weekly question, the installer's picker nor `thinker context --approve`
  // offers one -- no row, no action, no ACTS entry. The diet stays as `thinker context --output-compression <tools>
  // [--level high]`, for an experiment arm.
  const page = read('ui/page.html');
  assert.doesNotMatch(page, /'No compression'|levelOpts/); assert.doesNotMatch(read('context-suggest.js'), /uncompress|c\.kind === 'output'/);
  // what a person decided before today is still theirs to take back: Revert on an old output decision puts the level back
  assert.match(read('context-suggest.js'), /u\.kind === 'output'/);
  assert.doesNotMatch(page, /view: 'outputs'/); assert.doesNotMatch(read('commands/context.js'), /Tool outputs: tokens per result/);
  assert.match(read('commands/context.js'), /\['high', 'moderate'\]\.includes\(flags\.level\)/);
  // a built-in tool gets a tool reference from its row through the same route (2026-11-06, tool-stubs.js: not switched off; its
  // definition in a file, a pointer in every prompt, the tool still callable). Every Apply is read back first (2026-10-29):
  // one entry a change, naming the part, what the action does to it, and what the agent did with it. A built-in tool's
  // entry says where the definition goes and how it comes back, and the review's own paragraph says the tool stays
  // callable; nothing on the page may call it switched off, nor may the command or the installer (ACTS.ref everywhere).
  assert.match(page, /bold: s\.kind === 'tool'/);
  assert.match(page, /title: `Apply \$\{items\.length === 1 \? 'this change' : `these \$\{items\.length\} changes`\}\?`/);
  assert.match(page, /'builtin:off': \['still usable', "The tool can still be used:/);
  assert.match(read('part-explain.js'), /builtin: 'moving its full definition out of the prompt[^']*The agent can still use the tool/); assert.match(read('part-explain.js'), /p\.kind === 'tool' && p\.builtin \? ACTION_WORD\.builtin/);
  assert.doesNotMatch(page, /switched off across all repositories|cannot call it at all|loses the ability/);
  assert.match(page, /'builtin:off': \['still usable', "[^"]*in new sessions across all repositories\."\]/, 'one sentence, and it says the tool can still be used');
  assert.match(page, /rev-warn[\s\S]{0,260}a tool reference is created and the tool can still be used/);
  assert.match(page, /s\.group === 'builtin' \? 'Create tool reference' : 'Switch off'/);
  assert.match(read('context-suggest.js'), /ref: \{ act: 'off', text: 'Create tool reference' \}/);
  assert.match(read('context-machine.js'), /p\.group === 'builtin' \? ACTS\.ref/);
  assert.match(read('setup/context-ask.js'), /a built-in tool gets a tool reference for every repository and can still be used/);
  // what every action does, in the row and in the review: one entry a change, keyed by the kind and the action
  for (const k of ['section:compress', 'section:remove', 'skill:off', 'tool:off', 'builtin:off']) assert.match(page, new RegExp(`'${k}': \\[`), k);
  assert.match(page, /const effectOf = /);
  // and what each part is, in one line, from the same place Recent activity takes it (part-describe.js)
  assert.match(read('ui/server.js'), /describePart\(\{ kind: 'section'/);
  assert.match(page, /class="ctx-about"/);
  // Find Savings is one table, a part a row (2026-11-09, the owner's ask): title, type, per call, used, wasted, action.
  // No view tabs, no Potential savings card, no cards view, no checking rows and no Apply over the table: the action is a
  // dropdown and an Apply in the row, and the > beside the title opens the one-line description and the part's text.
  assert.doesNotMatch(page, /CMODE|cardOf\(|data-apply-picked|data-pick=|class="vtabs" id="c-view"|savingsCard|flaggedSavings|id="c-mode"/);
  // Wasted is dollars (the owner's ask, 2026-11-09): the wasted tokens at the view's input rate (context-view.js:inputRate), on both doors
  assert.match(page, /money\(wasteUsd\(r, rate\)\)/); assert.match(read('context-view.js'), /export function inputRate\(store, sessions\)/);
  assert.match(read('commands/context.js'), /formatDollars\(x\.wastedWindow \* vrate\)/);
  // the row colour is one rule on both doors (the owner's rule, 2026-11-09): used under 10%, red from 5k tokens a call, yellow under, nothing under 500
  const flagRe = /const FLAG = \{ used: 0\.1, red: 5000, none: 500 \};/; assert.match(page, flagRe); assert.match(read('context-view.js'), flagRe);
  assert.match(page, /const flagOf = r => r\.off \|\| r\.acted == null \|\| r\.acted >= FLAG\.used \|\| !\(r\.tokens >= FLAG\.none\) \? null : r\.tokens >= FLAG\.red \? 'red' : 'yellow';/);
  assert.match(read('context-view.js'), /export const flagOf = r => r\.off \|\| r\.usedShare == null \|\| r\.usedShare >= FLAG\.used \|\| !\(r\.tokens >= FLAG\.none\) \? null : r\.tokens >= FLAG\.red \? 'red' : 'yellow';/);
  assert.match(read('commands/context.js'), /\$\{mark\(s\)\}\$\{pad\(s\.tokens, 6\)\}/);
  assert.match(page, /\['Part', ''\], \['Type', ''\]/); for (const h of ['Per call', 'Used', 'Wasted', 'Action']) assert.match(page, new RegExp(`\\['${h}', `), h);
  assert.match(page, /<button class="ctx-x" data-more="\$\{i\}" data-dk="\$\{dk\}" aria-expanded="false"/);
  assert.match(page, /<select class="sel" data-act="\$\{i\}" data-dk="\$\{dk\}" aria-label="Action">/); assert.match(page, /<button class="btn" data-go="\$\{i\}"/);
  assert.match(page, /applyRows\(\[\{ r: sorted\[i\], act: root\.querySelector/);
  assert.doesNotMatch(page, /class="lede">Your agent re-reads/);
  // the words on what a part is are `thinker explain`'s (part-explain.js), one writer and one place they are kept; the
  // page asks for them when a row is opened (never for the hundreds nobody opens) and patches them into the open row
  assert.match(read('ui/server.js'), /url\.pathname === '\/api\/explain'/);
  assert.match(read('ui/server.js'), /'--keys', keys\.join\(','\), \.\.\.\(want === 'all' \? \['--all'\] : \[\]\)\]/);
  assert.match(page, /function explainRow\(r\)/);
  assert.match(page, /if \(open\) explainRow\(sorted\[Number\(b\.dataset\.more\)\]\)/);
  assert.match(page, /\{ keys: \[r\.explainKey\] \}/);
  // and the words arrive on their own, by key, patched into the rows where they stand: the page must never poll the
  // whole report for them (1.3 MB and five tables redrawn every four seconds, to 2026-10-29)
  assert.match(read('ui/server.js'), /if \(keys\.length\) return json\(res, 200, \{ explains:/);
  assert.match(page, /\/api\/explain\?repo=\$\{encodeURIComponent\(CREPO\)\}&days=\$\{cdays\}&keys=/);
  assert.match(page, /function putExplains\(got\)/);
  assert.match(page, /class="ctx-ex" data-ek=/);
  assert.doesNotMatch(page, /EXPLAIN_TIMER = setTimeout\([\s\S]{0,400}api\(`\/api\/context\?repo=\$\{encodeURIComponent\(CREPO\)\}&days=\$\{cdays\}`\)/);
  assert.doesNotMatch(page, /pc-offer|explainOffer|No explanation has been written/);
  // and the paragraph over each table went with it: the opened row says what a part is, the Apply's hover what an action does
  assert.doesNotMatch(page, /ctx-apply|note: `/);
  assert.match(read('ui/server.js'), /attachExplains\(describeParts\(shown\), have\)/);
  // the ranked changes and the timeline are the kept report's, for the command and the weekly suggestion: the page
  // reads neither, so neither is sent (411 KB of the 1.3 MB this machine answered with, to 2026-10-29)
  assert.match(read('ui/server.js'), /const \{ suggestions, timeline, \.\.\.shown \} = view;/);
  // and waiting for a newer report asks for the stamp alone, not the report
  assert.match(read('ui/server.js'), /if \(stamp\) return json\(res, 200, \{ asOf:/);
  assert.match(page, /&stamp=1`\)/);
  assert.match(read('commands/explain.js'), /explainParts/);
  // the words are written once for the machine, never per repository, and never in the background
  assert.match(read('part-explain.js'), /export function partKey/);
  assert.doesNotMatch(read('maintain.js'), /explainParts|part-explain/);
  // and both doors show them: `thinker context --cards` is the card view in the terminal, from the same list in the
  // same order as the page (part-explain.js:viewParts), so a terminal-only machine is told what a part is too
  assert.match(read('commands/context.js'), /if \(flags\.cards\)/);
  assert.match(read('commands/context.js'), /viewParts, readExplains/);
  assert.match(read('commands/context.js'), /thinker context --cards/);
  assert.match(read('cli.js'), /context \[--days n\] \[--cards\]/, 'the card view is in the help of `thinker context`');
  assert.match(read('cli.js'), /^  explain \[--days n\]/m, '`thinker explain`, the command behind the cards, is in the help');
  // a card someone asked for in a desktop app is answered by the session's own model, so the queued job must survive
  // the next update: rewire dropped it before (retire-background.js), which left that door dead
  assert.match(read('retire-background.js'), /KEPT_JOBS = new Set\(\['distill', 'learn', 'maintain', 'explain'\]\)/);
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
  // (`thinker ui --tab save`, over every repository by default, setup/context-ask.js:openContextPage)
  const machine = read('context-machine.js'), install = fs.readFileSync(path.join(SRC, '..', 'install.sh'), 'utf8');
  assert.match(install, /"\$thinker" context --machine/);
  assert.match(read('setup/context-ask.js'), /'ui', '--from-setup', '--tab', 'save', \.\.\.\(all \? \[\] : \['--here'\]\)/);
  // and that page opens with the terminal picker's suggestions first, each on its action: the same rows and actions, from one function
  // (context-machine.js:suggestedPicks, sent with the report as `suggested`; page.html:preselectRows on from=setup)
  assert.match(machine, /export function suggestedPicks\(view/); assert.match(machine, /const act = suggestedAct\(x\), key = suggestedKey\(x\)/);
  assert.match(read('ui/server.js'), /suggested: suggestedPicks\(view\)/);
  assert.match(read('ui/page.html'), /const FROM_SETUP = FROM === 'setup'/);
  assert.match(read('ui/page.html'), /preselectRows\(all, \(FROM === 'suggestion' && v\.offered\?\.length \? v\.offered : v\.suggested\) \|\| \[\]\)/);
  assert.match(read('setup/context-ask.js'), /suggested savings first, each on its suggested action/);
  // and the terminal picker comes checked as that page does, so both answers to the installer's question start from
  // the same suggestions (2026-10-29)
  assert.match(read('setup/context-ask.js'), /value: p, picked: true/);
  assert.match(read('setup/context-ask.js'), /suggestionsUrl\(url, null, \{ from: 'setup' \}\)/);
  // The link in the weekly question opens the page on the lines that question numbered, checked, with the action it
  // suggested for each (context-suggest.js:offeredPicks, sent with the report as `offered`): one door's suggestion,
  // not the page's own ranking, which is recomputed on arrival.
  const suggest = read('context-suggest.js');
  assert.match(suggest, /export const suggestionsUrl = \(url, repoId, \{ from \} = \{\}\)/);
  assert.match(suggest, /suggestionsUrl\(url, repoId, \{ from: 'suggestion' \}\)/);
  assert.match(suggest, /export function offeredPicks\(store/);
  assert.match(read('ui/server.js'), /offered = offeredPicks\(one\)/);
  assert.match(read('ui/server.js'), /suggested: suggestedPicks\(view\), offered,/);
  assert.match(read('commands/context.js'), /machineContext\(store, \{ days, limit/);
  assert.match(machine, /mergeViews\(views\)/); assert.match(read('ui/server.js'), /mergeViews\(xs\.filter\(x => x\.s\.view\)\.map/);
  assert.match(machine, /writeSnapshot\(st, d, v/); assert.match(machine, /refreshCheckouts\(store/);
  // `thinker ui` opens over every repository, on every tab, and `--here` on this checkout alone (2026-10-25):
  // one default, the command's hash and the page's own reading of it
  assert.match(read('commands/cache.js'), /flags\.here && !flags\.all \? 'repo=here' : 'repo=all'/);
  assert.match(read('ui/page.html'), /const hashRepo = \(\) => \{ const r = H\(\)\.get\('repo'\); return r === 'here' \? '' : r \|\| 'all'; \}/);
  for (const d of [/REPO = \['report', 'factory'\]\.includes\(hashTab\(\)\) \? hashRepo\(\)/, /CREPO = hashTab\(\) === 'save' \? hashRepo\(\)/, /AREPO = hashTab\(\) === 'activity' \? hashRepo\(\)/]) assert.match(read('ui/page.html'), d);
  assert.match(read('cli.js'), /ui \[--port n\] \[--no-open\] \[--tab save\|report\|activity\] \[--here\]/);
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
  assert.match(read('ui/server.js'), /startSectionJob\(st, xs, action, \{ pr, spawnFn, cliPath, via: VIA\.page \}\)/);
  // both doors record which one a decision came through (context-suggest.js:VIA), so the funnel can tell a change
  // accepted on the page from one accepted in the session after the weekly suggestion
  assert.match(read('ui/server.js'), /approveChanges\(st, picked, \{ via: VIA\.page \}\)/);
  assert.match(read('ui/server.js'), /dismissChanges\(st, picked, \{ via: VIA\.page \}\)/);
  assert.match(read('commands/context.js'), /fn\(store, picked, \{ via \}\)/);
  assert.match(read('context-suggest.js'), /const cmd = `thinker context --days \$\{p\.days\} --via session`/);
  assert.match(read('context-suggest.js'), /\$\{cmd\} --approve/);
  // the answer comes back through thinker's own MCP tool where the client speaks MCP, the command being the fallback
  assert.match(read('context-suggest.js'), /tool with choice set to the numbers they chose/);
  assert.match(read('mcp-server.js'), /answerContextSuggestion\(store, String\(choice\)/);
  // the weekly suggestion is a question the agent puts to the person with its own tool, and a no is recorded too.
  // Every question thinker has an agent ask is built with askThrough (or askInChat where there is no such tool), so
  // it carries thinker's name in the question and in the header and no offer can hand-write one that does not
  // (2026-10-29, the owner's ask). A new question goes through the same helper.
  assert.match(read('repo-onboard.js'), /export const QUESTION_HEADER = 'thinker';/);
  for (const f of ['context-suggest.js', 'proxy-offer.js', 'error-report.js', 'containers-offer.js']) {
    const src = read(f);
    assert.match(src, /askThrough\(tool, /, `${f} asks through the labelled clause`);
    assert.match(src, /askInChat\(/, `${f} labels its chat fallback too`);
    assert.doesNotMatch(src, /\(header "(?!\$\{QUESTION_HEADER\})/, `${f} writes no header of its own`);
  }
  // The container question is the owner's own wording (2026-11-05) and the only place it is written: the
  // offer passes it to askThrough, which tells the agent to put it unchanged. A change here is deliberate.
  assert.match(read('containers-offer.js'), /export const QUESTION = 'thinker is installed on your machine but not in the container\. Install it here to get token cost savings on your sessions\?';/);
  assert.match(read('containers-offer.js'), /askThrough\(tool, QUESTION\)/);
  assert.match(read('containers-offer.js'), /export const OPTIONS = '"Yes" \/ "No" \/ "Never ask again"';/);
  assert.match(read('mcp-server.js'), /answerContainersOffer\(String\(choice\)/);
  // one question a turn: the container offer takes its place in the hook's single chain, never beside another
  assert.match(read('commands/hooks.js'), /proxyOffer\(store, \{ client \}\) \|\| containersOffer\(store, \{ client \}\) \|\|/);
  assert.match(read('context-suggest.js'), /\$\{cmd\} --dismiss all/);
  assert.match(read('ui/server.js'), /const said = \[\], pr = prAvailable\(st\.repo\)\.ok;/);
  assert.match(cs, /\[cliPath, 'instructions', `--\$\{action\}`, ids\.join\(','\), pr \? '--pr' : '--apply', '--job', group\]/);
  // and so does every other door, since 2026-10-29: the weekly suggestion answered in the session (the MCP `context`
  // tool), `thinker context --approve` and the installer's picks all approve through approveChanges, which sends a
  // section to the same job rather than compressing it inline, so no door holds a person's session through the model
  // call or writes the file without a pull request. Only a switch-off or a compression level is made where it is asked.
  assert.match(cs, /const secs = changes\.filter\(c => act\(c\)\);/);
  assert.match(cs, /const j = startSectionJob\(store, xs, action, \{ pr: open, now, spawnFn, cliPath, via \}\);/);
  assert.match(cs, /const open = pr \?\? prAvailable\(store\.repo\)\.ok;/);
  assert.doesNotMatch(cs.split('export async function approveChanges')[1].split('\n}')[0], /previewEdit|applyEdit/);
  assert.match(read('commands/instructions.js'), /runSectionJob\(store, \{ group: flags\.job, ids, action, pr: Boolean\(flags\.pr\) \}\)/);
  assert.match(read('cli.js'), /instructions \[--remove <id> \| --compress <id> \[--pr \| --apply\] \[--job <id>\]\]/);
  const page = read('ui/page.html');
  assert.match(page, /api\('\/api\/changes\/start', \{ repo, \.\.\.g, days: cdays \}\)/);
  assert.doesNotMatch(page, /edit-overlay|openEditModal|previewSections|api\/context\/edit|api\/context\/apply/);
  assert.doesNotMatch(read('ui/server.js'), /api\/context\/edit|api\/context\/apply|api\/changes\/apply/);
  // Recent activity is its own page, the tab at the right of the nav with a badge counting what is not complete (a job running or
  // failed, a pull request to merge: context-suggest.js:changeHistory `attention`); Retry there is `thinker context --retry <n>`
  assert.match(page, /data-tab="activity"[^>]*>Recent activity<span class="badge" id="act-badge"/);
  assert.match(page, /api\(`\/api\/activity\?repo=\$\{encodeURIComponent\(AREPO\)\}&progressive=1`\)/);
  assert.match(page, /api\('\/api\/changes\/retry', \{ repo: e\.repo, id: e\.id \}\)/);
  assert.match(read('ui/server.js'), /attention: history\.filter\(h => h\.attention\)\.length/);
  assert.match(cs, /attention: running \? 'running' : failed && !e\.revertedAt \? 'failed' : pending \? 'pr' : null/);
  // a merged pull request this checkout has not pulled (`unpulled`, with the branch to pull): the section has no row on the
  // page, Recent activity says to pull that branch and tints the decision, and `thinker context --history` says the same
  assert.match(cs, /unpulled\.has\(e\) \? \{ unpulled: true, pullFrom: e\.pr\.base \|\| pullFrom \}/);
  assert.match(page, /e\.failed \|\| e\.unpulled\) &&/);
  assert.match(page, /if \(d\.unpulled\) r\.hidden = true;/);
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
  // the page's rows read the same decisions, for the pill on a section under way, failed or pending on a pull request
  assert.match(page, /api\(`\/api\/activity\?repo=\$\{encodeURIComponent\(CREPO\)\}&progressive=1&measure=0`\)/);
  assert.match(read('context-suggest.js'), /days: 7,/);
  assert.match(read('context-suggest.js'), /tab=save&view=all/);
  // a failed change leaves the section its waste pill on Find Savings (the failure is Recent activity's to say)
  assert.match(page, /else if \(d\.failed\) continue;/);
  assert.doesNotMatch(page, /'compression' : 'removal'\} failed/);
  // a section changed inside the window is measured over the sessions since, said so by both doors (instruction-value.js `recent`)
  assert.match(page, /sessions: s\.sessionsSince \?\? iv\.sessions \?\? 0/);
  // the date left the type cell on 2026-11-09 (the owner's ask); it stays in the used-share hover
  assert.match(page, /s\.recent \? `too few sessions since it changed on \$\{dayOf\(s\.changedAt\)\}/); assert.doesNotMatch(page, /`changed \$\{dayOf\(s\.changedAt\)\}`/);
  assert.match(read('commands/context.js'), /s\.recent \? ` \(changed \$\{s\.changedAt\.slice\(0, 10\)\}: \$\{s\.sessions\} session/);
  // the page's rows carry the keys allChanges gives, so the server finds the part a row's Apply names
  for (const k of ['`section:${s.file}:${s.id}`', '`${s.client}:${s.key}`']) assert.ok(read('ui/page.html').includes(k), k);
});

test('over the wire: a section\'s Apply records the decision running and starts the command; Recent activity counts it until the job finishes', async t => {
  const dir = repo(t); new Store(dir).init();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# R\n\n## Tests\n\nRun `npm test`.\n\n## Style\n\nShort lines.\n');
  const pg = page(t, dir), p = await pg.start();
  const id = (await p.get('/api/repos')).repos[0].id;
  await p.get(`/api/context?repo=${encodeURIComponent(id)}&days=7`); // the report the server resolves the rows in
  // The link in the weekly question opens on the rows that question numbered, checked (page.html:preselectRows on
  // `from=suggestion`): the server hands them over with the report as `offered`, by the same keys the rows carry.
  const { scheduleContextSuggestion, contextSuggestOffer } = await import('../src/context-suggest.js');
  const sec = { id: 'tests', file: 'AGENTS.md', title: 'Tests', tokens: 2000, wasted: 9000, waste: 'high', usedShare: 0.1, prompts: 100 };
  await scheduleContextSuggestion(new Store(dir), { view: { days: 7, sessions: 40, instructions: { sessions: 40, sections: [sec] }, skills: [], tools: [], outputs: { tools: [] } }, force: true });
  contextSuggestOffer(new Store(dir), { env: {}, ui: () => null, client: 'claude' });
  assert.deepEqual((await p.get(`/api/context?repo=${encodeURIComponent(id)}&days=7`)).offered, [{ kind: 'section', key: 'section:AGENTS.md:tests', repo: null, act: 'compress' }]);
  assert.deepEqual(await p.get(`/api/activity?repo=${encodeURIComponent(id)}`), { history: [], promptAvg: null, measuring: true, scan: null, attention: 0, running: 0 }, 'no report kept yet: measuring, and the refresh started (no progressive read, so no scan to report)');
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

test('the page touches no element it no longer renders', () => {
  // Find Savings hid a Sort control that went with the one ordering (2026-10-29) and kept setting `hidden` on it:
  // the first load of the tab threw before it ever asked for the report, and the page sat on "Reading the
  // transcripts..." for good. A reference to an id the page never writes is that bug, whatever the id.
  const html = read('ui/page.html');
  const ids = new Set([...html.matchAll(/id="([a-zA-Z0-9_-]+)"/g)].map(m => m[1]));
  const missing = [...new Set([...html.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map(m => m[1]))].filter(id => !ids.has(id));
  assert.deepEqual(missing, [], `the page sets properties on ids it never renders: ${missing.join(', ')}`);
});

test('the Report tab and `thinker report` show one report: the same weeks, parts, prices and trend rule', () => {
  assert.match(read('report.js'), /prs, prWeekly: weeklyPrStats\(prs, columns, now\)/);
  assert.match(read('report.js'), /for \(const w of v\.prWeekly\)/);
  assert.match(read('ui/page.html'), /const weeks = v\.prWeekly;/);
  assert.doesNotMatch(read('ui/page.html'), /prStatsChart|pr-charts|pr-chart/);
  const prTable = read('ui/page.html').split('function prStatsTable(v) {')[1].split('function renderReport(v)')[0];
  assert.match(prTable, /<table class="ctx-table rep-table savings-table"/);
  assert.doesNotMatch(prTable, /<svg/);
  assert.match(read('ui/page.html'), /swapBody\(el, prStatsTable\(v\) \+ parts \+ effectiveness \+ profileFigure\(v\) \+ `<button/, 'PR table leads the Report and stays outside collapsed metrics');
  // both doors read report.js:reportView; the page's All repositories is mergeReports, as the command has no All
  assert.match(read('commands/report.js'), /reportView\(store, \{ weeks \}\)/);
  // the page reads the report kept in each checkout (report-snapshot.js), made by the same function
  assert.match(read('report-snapshot.js'), /reportView\(store, \{ weeks, now \}\)/);
  assert.match(read('ui/server.js'), /reportSnapshot\(st, weeks\)/);
  assert.match(read('ui/server.js'), /mergeReports\(ready\.map/);
  // six weeks; the page's Share toggle is the command's --share (every row but the whole-session total as its share of it), on both doors
  assert.match(read('ui/page.html'), /<div class="seg" id="r-view"><button data-view="values" class="on">Values<\/button><button data-view="share">Share<\/button><\/div>/);
  assert.match(read('commands/report.js'), /share: Boolean\(flags\.share\)/); assert.match(read('cli.js'), /report \[--weeks n\] \[--total\] \[--share\]/);
  assert.match(read('report.js'), /share = false \} = \{\}\) \{/);
  assert.equal((read('ui/page.html').match(/\{ cls: 'rep-total', total: true(, key: 'total', thresholds: true)? \}/g) || []).length, 3, 'the three whole-session rows keep their values under Share');
  // the rest of the input by kind (report.js:OTHERS, the breakdown's rows), the prompt-cache rewrites by cause and the sessions
  // whose agent reports no usage, on both doors (2026-10-25), from the one view (reportView: rewrites, rewriteTotals, estimated, calibration)
  // the rewrites by cause and the estimated sessions are in the view and on neither door (the owner's call, 2026-10-25)
  for (const re of [/Prompt cache rewrites/, /Sessions whose agent reported no usage/]) { assert.doesNotMatch(read('ui/page.html'), re); assert.doesNotMatch(read('report.js').replace(/\/\/[^\n]*/g, ''), re); }
  assert.match(read('ui/page.html'), /swapBody\(el, prStatsTable\(v\) \+ parts \+ effectiveness \+/); assert.match(read('ui/page.html'), /v\.calibration/);
  // the rest of the input is one row on both doors (reportView `otherInput`), folded by default on the page, its kinds under it
  assert.match(read('ui/page.html'), /RFOLD = new Set\(\['other-input'\]\)/); assert.match(read('ui/page.html'), /data-fold="other-input"/); assert.match(read('ui/page.html'), /v\.otherInput \|\| \[\]/);
  assert.match(read('report.js'), /line\('Other input', v\.otherInput, false, base, \{ key: 'otherInput', thresholds: true \}\)/); assert.match(read('report.js'), /line\(`  \$\{p\.name\}`, p\.cells/);
  assert.match(read('report.js'), /export const CALIBRATION = \{ Anthropic: 1\.44 \}/, 'one calibration constant, read by the command and sent to the page in the view');
  assert.match(read('report.js'), /export const OTHERS = \[\.\.\.REST_INPUT, 'output'\]/, 'the rows under the four parts are the breakdown\'s kinds');
  // the page's Total toggle is the command's --total
  assert.match(read('commands/report.js'), /total: Boolean\(flags\.total\)/);
  assert.match(read('ui/page.html'), /data-mode="sum" class="on">Total</);
  // the unit is a prompt, one call to the model, on both doors (2026-10-24): the average is the week's sum over its prompts
  assert.match(read('ui/page.html'), /data-mode="sum" class="on">Total</);
  assert.match(read('ui/page.html'), /col\.pricedPrompts \? c\.cost \/ col\.pricedPrompts : null/);
  assert.match(read('report.js'), /col\.pricedPrompts \? c\.cost \/ col\.pricedPrompts : null/);
  assert.match(read('report.js'), /per prompt \(one call to the model\)/);
  assert.match(read('report.js'), /export const REPORT_WEEKS = 6;/);
  assert.match(read('ui/page.html'), /\/api\/report\?repo=\$\{encodeURIComponent\(REPO\)\}&weeks=6/);
  // a row's cell is green, yellow or red (flat, the owner's ask of 2026-10-24) and its bounds sit beside it in Good and Bad
  // columns on both doors; the model and token-type tables take no colour or mark
  assert.match(read('ui/page.html'), /x <= t\.good \? 'rep-good' : x >= t\.bad \? 'rep-bad' : 'rep-mid'/);
  assert.match(read('ui/page.html'), /\$\{head\('Part', true\)\}/); assert.match(read('ui/page.html'), /\$\{head\('Provider · model'\)\}/); assert.match(read('ui/page.html'), /\$\{head\('Token type'\)\}/);
  assert.match(read('ui/page.html'), /row\(esc\(p\.name\), p\.cells, \{ key: p\.key, thresholds: true \}\)/);
  // every row of the parts table has bounds in dollars a priced prompt: report.js:COST_THRESHOLDS, carried in the view
  // (`costThresholds`) to the page, which colours by the same cost a priced prompt the command marks (2026-10-26).
  assert.match(read('report.js'), /costThresholds: COST_THRESHOLDS,/); assert.doesNotMatch(read('report.js'), /thresholds: THRESHOLDS/); assert.match(read('report.js'), /verdict\(key, cells\[w\]\.cost \/ col\.pricedPrompts\)/);
  assert.match(read('ui/page.html'), /const thr = v\.costThresholds \|\| \{\}/);
  // Dollars and nothing else on both doors (the owner, 2026-11-08: "only costs"): no Cost/Tokens toggle on the page, no
  // --tokens in the help, renderReport takes no unit; the tokens stay in the view and --json
  assert.doesNotMatch(read('ui/page.html'), /r-measure|RMEASURE|data-m="tokens"|>Tokens<\/button>/); assert.doesNotMatch(read('cli.js'), /--tokens/);
  assert.match(read('report.js'), /renderReport\(v, \{ total = false, share = false \} = \{\}\)/); assert.doesNotMatch(read('commands/report.js'), /cost: !flags\.tokens/);
  assert.match(read('commands/report.js'), /renderReport\(v, \{ total: Boolean\(flags\.total\), share: Boolean\(flags\.share\) \}\)/);
  // the table does not move on a toggle: fixed layout, set column widths (2026-10-26)
  assert.match(read('ui/page.html'), /\.rep-table \{ table-layout: fixed;/); assert.match(read('ui/page.html'), /\$\{colgroup\(thresholds\)\}<thead>/); assert.match(read('report.js'), /thresholds \? thr\(key\)/); assert.match(read('ui/page.html'), /col\.pricedPrompts \? cells\[w\]\.cost \/ col\.pricedPrompts : 0/);
  for (const k of ['otherInput', 'output']) { assert.match(read('ui/page.html'), new RegExp(`key: '${k}', thresholds: true`)); assert.match(read('report.js'), new RegExp(`key: '${k}', thresholds: true`)); }
  assert.match(read('ui/page.html'), /cls: 'rep-subrow', key: p\.key, thresholds: true/);
  assert.doesNotMatch(read('ui/page.html'), /SHADE_MIN|rep-up|rep-down/); assert.doesNotMatch(read('report.js'), /TREND_MIN|TREND_BIG|▲/);
  // the decisions table is one function on both pages, the Report's over its window alone
  assert.match(read('ui/page.html'), /historyFigure\(hs, \{ many, caption: 'Decisions'/);
  // One ordering, most wasted first (the owner's call, 2026-10-29), so the Sort control went; a door's suggested rows
  // lead it (2026-11-05)
  assert.doesNotMatch(read('ui/page.html'), /id="c-sort"|CSORTS|VSORT/);
  assert.match(read('ui/page.html'), /const cmpRows = \(a, b\) => windowWaste\(b\) - windowWaste\(a\) \|\| windowCost\(b\) - windowCost\(a\);/);
  assert.doesNotMatch(read('ui/page.html'), /data-vsort/);
  // the Find Savings table shows 50 rows a page, the decisions tables 20
  assert.match(read('ui/page.html'), /const ROWS_PAGE = 50, TABLE_PAGE = 20;/);
  assert.match(read('ui/page.html'), /rows\.slice\(from, from \+ ROWS_PAGE\)/);
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
  // the cost view, the default on both doors: list prices from prices.js, an unpriced model marked on both (the command in its
  // row's name, the page in the row's kind: the Report's tables carry no prose under them since 2026-10-24, the owner's ask)
  assert.match(read('report.js'), /listPrice\(r\.model, \{ config \}\)/);
  assert.match(read('report.js'), /\(unpriced\)/); assert.match(read('ui/page.html'), /sub: m\.priced \? '' : 'no list price'/);
  assert.doesNotMatch(read('ui/page.html'), /class="lede">What a session costs here/); assert.doesNotMatch(read('ui/page.html'), /A model's row is its share/);
  // three tables under both doors, each ending on the whole session: the token types (report.js:TOKEN_TYPES, the page reads the
  // rows from the view, so the names live in one place), the parts with the rest of the input and the output under them
  // (report.js:OTHERS), the models, the token types last (2026-10-24)
  assert.match(read('report.js'), /export const TOKEN_TYPES = \[\['fresh', 'Input, fresh'\], \['cacheWrite', 'Input, written to cache'\], \['cacheRead', 'Input, read from cache'\], \['output', 'Model output'\]\];/);
  assert.match(read('report.js'), /export const OTHERS = \[\.\.\.REST_INPUT, 'output'\]\.map\(k => BREAKDOWN\.find/, 'the rest of the input by kind, then the output (2026-10-25)');
  assert.match(read('report.js'), /'By token type \(as the model reported them/); assert.match(read('ui/page.html'), /<b>By token type<\/b>/);
  assert.match(read('ui/page.html'), /swapBody\(el, prStatsTable\(v\) \+ parts \+ effectiveness \+/, 'the token types last, no decisions on the Report');
  // every page is rebuilt in place once on screen (2026-10-25): the three renders go through swapBody, which keeps the scroll and
  // the open rows, and a load of what is already shown does not wipe the body to the spinner
  assert.match(read('ui/page.html'), /function swapBody\(el, html\)/); assert.match(read('ui/page.html'), /swapBody\(el, renderRows\(all, \{ caption, rate \}\)\);/); assert.match(read('ui/page.html'), /swapBody\(el, card \+ pullCard \+ historyFigure\(/);
  assert.match(read('ui/page.html'), /inPlace = Boolean\(CTX\) && CTX_FOR === `\$\{CREPO\}\|\$\{cdays\}`/); assert.match(read('ui/page.html'), /inPlace = prs \? Boolean\(APR\) && APR_FOR === AREPO : Boolean\(ACT\) && ACT_FOR === AREPO/); assert.match(read('ui/page.html'), /inPlace = Boolean\(RPT\) && RPT_FOR === REPO/);
  assert.doesNotMatch(read('ui/page.html'), /Total of these/); assert.doesNotMatch(read('report.js'), /'Total of these'/);
  assert.equal((read('report.js').match(/line\('Total \(the whole session\)', v\.sessionTotals, true(, null, \{ key: 'total', thresholds: true \})?\)/g) || []).length, 3);
  assert.equal((read('ui/page.html').match(/row\('Total \(the whole session\)', v\.sessionTotals, \{ cls: 'rep-total', total: true(, key: 'total', thresholds: true)? \}\)/g) || []).length, 3);
  assert.match(read('ui/page.html'), /\.\.\.otherRows\]\.join/); assert.match(read('report.js'), /for \(const p of rest\) L\.push\(line\(`  \$\{p\.name\}`, p\.cells, false, base, \{ key: p\.key, thresholds: true \}\)\);/, 'the kinds under Other input, indented');
  // Both doors show the weekly savings series from the shared report.
  for (const f of ['report.js', 'ui/page.html']) assert.match(read(f), /Compression effectiveness/);
  assert.match(read('report.js'), /changeHistory\(store\)\.filter\(e => Date\.parse\(e\.at\) >= from\)/);
  // the page's tabs: Save (was Context, the chart gone) and Report (was Cache); the old names still open them
  assert.match(read('ui/page.html'), /data-tab="save">Find Savings</);
  assert.match(read('ui/page.html'), /data-tab="report">View Report</);
  assert.match(read('ui/page.html'), /if \(tab === 'cache'\) tab = 'report';/);
  assert.doesNotMatch(read('ui/page.html'), /renderTrend|tr-stack|api\/cache|api\/behaviors|api\/usage/);
  assert.match(read('cli.js'), /ui \[--port n\] \[--no-open\] \[--tab save\|report\|activity\]/);
  assert.match(read('ui/page.html'), /if \(tab === 'save' && H\(\)\.get\('view'\) === 'history'\) tab = 'activity';/);
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

test('the weekly question interrupts only when it is worth it, and both doors price a saving the same way (2026-11-04)', async () => {
  const { SUGGEST } = await import('../src/context-suggest.js');
  // a thin list is a line and the page's address, never a picker: two changes and 1k input tokens a prompt together
  // before thinker stops anyone in the middle of their own work
  assert.deepEqual([SUGGEST.minAsk, SUGGEST.askSaving], [2, 1000]);
  const suggest = read('context-suggest.js');
  assert.match(suggest, /const thin = asked\.length < SUGGEST\.minAsk \|\| asked\.reduce\(\(a, c\) => a \+ \(c\.saving \|\| 0\), 0\) < SUGGEST\.askSaving/);
  assert.match(suggest, /if \(thin\) return `<thinker-context-suggestions>/);
  // and what a change is worth is said in money, from one rate: the dollars an input token cost here, off the kept
  // report (report.js:inputRate), in the session's question and in `thinker context`'s Top changes alike
  assert.match(read('report.js'), /export const inputRate = view => view\?\.inputRate \?\? null;/);
  assert.match(read('report.js'), /inputRate: pricedInput > 0 && pricedInputCost > 0 \? pricedInputCost \/ pricedInput : null,/, 'measured over the priced sessions alone');
  assert.match(read('report-snapshot.js'), /export function inputRateHere\(store/);
  for (const f of ['context-suggest.js', 'commands/context.js']) assert.match(read(f), /inputRateHere\(store\)|inputRateHere\(store\)\)/, f);
  for (const f of ['context-suggest.js', 'commands/context.js']) assert.match(read(f), /formatDollars\(/, f);
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
  assert.match(read('maintain.js'), /cfg\.prSync !== false/);
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
  assert.match(read('delivery.js'), /net\s+\$\{formatDollars\(p\.cost\.net\)\} = /);
  assert.doesNotMatch(page, /cacheWrite1h|cacheRead \*/, 'the page never prices a token itself');
  // One place the rewrite cost is worked out, and the deduction is named wherever the figure is shown.
  assert.match(read('delivery.js'), /clearingCostBySession/);
  assert.match(read('compression.js'), /export function clearingCostBySession/);
  for (const f of ['report.js', 'delivery.js', 'delivery-comment.js']) {
    assert.match(read(f), /after a clear/, `${f} says what was deducted`);
  }
  // A loss is never posted on someone's pull request by the automatic pass.
  assert.match(read('delivery-auto.js'), /p\.cost\?\.priced \|\| p\.cost\.net > 0/);
});

test('automatic PR comments reuse the update cadence and expose their defaults and opt-out', async () => {
  const { AUTO_PR_COMMENTS, PR_COMMENT_IDLE_MS, PR_COMMENT_LIMIT } = await import('../src/delivery-auto.js');
  const { UPDATE_EVERY_MS } = await import('../src/update.js');
  assert.equal(AUTO_PR_COMMENTS, true);
  assert.equal(PR_COMMENT_IDLE_MS, 20 * 60_000);
  assert.equal(PR_COMMENT_LIMIT, 10);
  assert.equal(UPDATE_EVERY_MS, 4 * 3600_000);
  assert.match(read('delivery-auto.js'), /< UPDATE_EVERY_MS/);
  assert.match(read('cli.js'), /false in the machine or repository config/);
  assert.match(read('commands/prs.js'), /runAutomaticPrComments\(store, \{ dry: !!flags\.dry \}\)/);
});

test('Report summaries and Recent activity PR savings share the CLI report data, in dollars under either toggle (2026-10-30, dollars since 2026-11-08)', async () => {
  const page = read('ui/page.html'), rep = read('report.js');
  // one source for both doors: the band is computed in report.js and carried on the view, never recomputed on a page
  assert.match(rep, /const prs = includePrs \? prSavings\(store, \{ days, now \}\) : null/);
  assert.match(page, /pr = v\.prs;/);
  // PR details live in Recent activity; the report now charts weekly savings.
  assert.doesNotMatch(page, /const cards =|const prBand =/);
  assert.match(page, /v\.savings \|\| \[\]/);
  assert.match(page, /See more metrics/);
  assert.match(page, /RMORE = false/);
  for (const phrase of ['merged with work here', 'spent on them', 'saved on them', 'on the average one']) assert.ok(rep.includes(phrase), `command line: ${phrase}`);
  // the same columns, in the same order (the reading-avoided and saved columns went with the knowledge notes, 2026-11-08)
  // in dollars on both doors since 2026-11-08 (the owner's call: tokens add reads, writes and output as one thing)
  for (const c of ['Sessions', 'Its cost', 'Saved', 'Share']) assert.ok(page.includes(`>${c}</th>`), `page column: ${c}`);
  const head = rep.slice(rep.indexOf("'Merged, newest first'"), rep.indexOf("'Merged, newest first'") + 400);
  for (const c of ['sessions', 'its cost', 'saved', 'share']) assert.ok(head.includes(`'${c}'`), `command column: ${c}`);
  assert.doesNotMatch(page, /Tokens saved per PR|Total tokens per PR|>Cleared<\/th>/, 'no token figure on a pull request');
  for (const key of ['savedUsdPerPr', 'spendPerPr']) { assert.ok(page.includes(`'${key}'`), `page row ${key}`); assert.ok(rep.includes(`w.${key}`), `command column ${key}`); }
  // Both doors describe the PR figures in dollars, and the page prices no token itself: it reads the row's dollars
  assert.doesNotMatch(page, /Tokens spent and saved on merged pull requests|Of the work shipped here/);
  assert.ok(rep.includes('what merged work cost and what the clearing saved on it, in dollars'));
  const prRows = page.slice(page.indexOf('function renderActivityPrs('), page.indexOf('function renderActivityPrs(') + 2500);
  assert.match(prRows, /money\(r\.spend\)/); assert.match(prRows, /money\(r\.savedUsd\)/); assert.doesNotMatch(prRows, /fmt\(r\.agent\)|fmt\(r\.cleared\)/, 'no token figure on a PR row');
  // a kept report made before the band must be remade, so report-snapshot hashes what the band is computed from
  for (const f of ['delivery.js', 'compression.js']) assert.ok(read('report-snapshot.js').includes(`'${f}'`), `${f} is in the report's code key`);
});

// Every element the page's script reaches for is in its own markup. #537 took the sort control out and left
// `loadContext` hiding it, on a line above the try, so Find Savings threw on `$('#c-sort-wrap').hidden` before it
// fetched anything and sat on its spinner for good -- a page that renders nothing, with nothing in the catch to say
// so. One dead selector in a load path costs the whole page, and nothing but a browser was looking.
test('the page reaches for no element it does not define', () => {
  const page = read('ui/page.html');
  const ids = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const reached = new Set([
    ...[...page.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
    ...[...page.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
    ...[...page.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]),
  ]);
  // an id built from a variable (`#c-${k}`) ends at the brace and is the view divs', which renderContext writes
  const dangling = [...reached].filter(k => !ids.has(k) && !k.endsWith('-'));
  assert.deepEqual(dangling, [], `page.html reaches for ${dangling.join(', ')}, which its markup does not define`);
});


test('Recent activity defaults to Action savings; PR savings uses the report data independently', () => {
  const page = read('ui/page.html');
  assert.match(page, /let AVIEW = 'actions'/);
  assert.match(page, /data-view="actions" class="on" aria-selected="true"/);
  assert.match(page, /data-view="prs" aria-selected="false"/);
  const report = page.slice(page.indexOf('function renderReport('));
  assert.doesNotMatch(report, /prTable|prRows|metric-label|c\.tokenDescription|c\.dollarsDescription/);
  assert.match(page, /function renderActivityPrs\(v\)/);
  assert.match(page, /await progressiveView\(`\/api\/report\?repo=\$\{encodeURIComponent\(AREPO\)\}/);
  assert.match(page, /r\.kind === 'tool' \? \[r\.repo \|\| r\.repoIds\?\.\[0\]/, 'one request per tool, not per repository');
  assert.match(read('context-suggest.js'), /global: c\.kind === 'tool'/, 'CLI approvals use the same machine-wide tool scope');
});


test('Report defaults to weekly totals and shows savings as a table without a graph', () => {
  const page = read('ui/page.html');
  assert.match(page, /RMODE = 'sum'/);
  assert.match(page, /data-mode="sum" class="on">Total</);
  assert.match(page, /class="ctx-table rep-table savings-table"/);
  assert.doesNotMatch(page, /savings-chart|savings-legend/);
  assert.match(read('commands/report.js'), /total: Boolean\(flags\.total\)/, 'the page default uses the CLI --total view');
});

// Devin shares the CLI's client selection/default delivery; the page has no second installer.
test('Devin is selectable through connect and is named consistently on the page', async () => {
  const { parseClients, CLIENTS, USER_SCOPE_CLIENTS } = await import('../src/clients.js');
  assert.deepEqual(parseClients('devin'), ['devin']);
  assert.ok(CLIENTS.includes('devin') && USER_SCOPE_CLIENTS.includes('devin'));
  assert.match(read('cli.js'), /opencode, devin and more/);
  assert.match(read('ui/page.html'), /devin: 'Devin'/);
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
test('the Report shows the profile metric on the page as the command prints it, and no row of the removed notes', async () => {
  const report = read('report.js'), page = read('ui/page.html');
  assert.match(report, /profileMetric\(store/); assert.match(report, /mergeProfileMetrics\(/, 'All repositories pools the arms');
  assert.match(report, /profileLines\(v\.profile/); assert.match(page, /profileFigure\(v\)/);
  assert.match(read('commands/profile.js'), /holdoutFromLog\(/, 'thinker profile holdout reads the same computation');
  const { PROFILE_VERDICTS } = await import('../src/report.js');
  for (const text of Object.values(PROFILE_VERDICTS)) assert.ok(page.includes(text), `the page says "${text}"`);
  // the two sentences and the odds are the same code on both doors
  for (const fn of ['const share = r =>', 'const bandShare = (l, band) =>', 'Lines rarely used', 'Lines sometimes used', 'Lines frequently used', 'function profileWhen(p) {', 'function profileLinesSentence(p) {']) assert.ok(page.includes(fn), fn);
  const body = name => src => src.split(name)[1].split('\n}\n')[0];
  for (const name of ['function profileWhen(p) {', 'function profileLinesSentence(p) {']) assert.equal(body(name)(page), body(name)(report.replace('export function', 'function').replaceAll('export function', 'function')), `${name} is one body on both doors`);
  assert.doesNotMatch(page, /Cache hits|notes served|savings-counts/);
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
  assert.match(read('factory.js'), /v\.weekly\.stages\[key\]/); assert.match(read('factory.js'), /v\.weekly\.loops\[L\.key\]/);
  // "See diff by": the page's two features and sides are factory.js:ARMS, and the command has the same split as --diff
  for (const f of ['profile', 'compression']) { assert.match(read('ui/page.html'), new RegExp(`${f}: \\{ name: '`)); assert.match(read('factory.js'), new RegExp(`${f}: \\{ name: '`)); }
  assert.match(read('cli.js'), /--diff profile\|compression/);
  // the two doors say the attribution rule in the same words
  for (const f of ['factory.js', 'ui/page.html']) assert.match(read(f), /A call's tokens go to the stage of the tool it called; the first call after a prompt is Prompts; a call with no tool is Think\./);
});
