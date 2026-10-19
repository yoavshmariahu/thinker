import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateInstructions } from '../src/agent-instructions.js';
import { agentWorkflow, cacheInstructions, cacheBundleIntro, disabledTools, INSTRUCTIONS_LIMIT } from '../src/cache-guidance.js';
import { installClient, refreshWiring, uninstallClients, uninstallWiring } from '../src/clients.js';
import { piExtension } from '../src/integrations/pi.js';
import { opencodePlugin } from '../src/integrations/opencode.js';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mcpEntry = { command: 'node', args: [fileURLToPath(new URL('../src/mcp.js', import.meta.url))] };
function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-guidance-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  return { repo, cli, mcpEntry, hooks: true, learn: true, mcp: true, late: false, shared: false };
}
const read = file => fs.readFileSync(file, 'utf8');
// orient is off by default and named for no client unless a repository turns it on
function checkWorkflow(text, cliOnly = false, orient = false) {
  assert.ok(text.includes('lookup'), 'lookup');
  // as a tool (`orient`) or a CLI command (cli.js' orient): the checkout's path may hold the word
  assert.equal(/`orient`|' orient\b|thinker orient\b/.test(text), orient, orient ? 'orient is named' : 'orient is off and must not be named');
  assert.doesNotMatch(text, /remember|feedback/, 'no instruction asks the agent to save or grade notes');
  // the code tools are off unless a repository turns them on, and a tool that is off is never named
  for (const name of ['find', 'drilldown']) assert.ok(!new RegExp(`\\b${name}\\b`).test(text), `${name} is off and must not be named`);
  // the four decisions, one line each; nothing about environment switches or whether .thinker/ exists,
  // which had a Codex agent spend its first turn checking them (the Click canary of 2026-10-07)
  assert.match(text, /Read an injected <thinker-cache> bundle first/);
  assert.match(text, orient ? /none bears on the task, .*orient.* once/ : /none bears on the task, work from the code/);
  assert.match(text, /file:symbol pointers say where the code is/);
  assert.match(text, /ordinary search and reads/);
  assert.match(text, /Then edit and test/);
  assert.doesNotMatch(text, /THINKER_|\.thinker\//);
  assert.ok(text.split('\n').filter(l => l.startsWith('- ')).length <= 4, 'four lines of decisions');
  if (cliOnly) assert.doesNotMatch(text, /call `remember`|Use the Thinker MCP/);
}

test('managed blocks are early, idempotent, replaceable and preserve user bytes on removal', t => {
  const { repo } = fixture(t), file = path.join(repo, 'AGENTS.md');
  const original = '# My rules\r\n\r\nPreserve these.  ';
  fs.writeFileSync(file, original);
  assert.equal(updateInstructions(file, 'old workflow'), true);
  assert.ok(read(file).startsWith('<!-- thinker:workflow:start -->'));
  const mtime = fs.statSync(file).mtimeMs;
  assert.equal(updateInstructions(file, 'old workflow'), false);
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  updateInstructions(file, 'new workflow');
  assert.doesNotMatch(read(file), /old workflow/);
  updateInstructions(file, null);
  assert.equal(read(file), original);
  const generated = path.join(repo, 'new.md');
  updateInstructions(generated, 'workflow'); updateInstructions(generated, null);
  assert.equal(fs.existsSync(generated), false);
});

test('malformed blocks and symlinked instructions are not overwritten', t => {
  const { repo } = fixture(t), file = path.join(repo, 'AGENTS.md');
  fs.writeFileSync(file, '<!-- thinker:workflow:start -->\nuser text');
  assert.throws(() => updateInstructions(file, 'new'), /Malformed/);
  assert.equal(read(file), '<!-- thinker:workflow:start -->\nuser text');
  const link = path.join(repo, 'link.md'); fs.symlinkSync(file, link);
  assert.throws(() => updateInstructions(link, 'new'), /symlink/);
  assert.equal(updateInstructions(link, null), false);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test('all eight adapters deliver the full workflow through native instructions or extension context', async t => {
  const config = fixture(t);
  const files = { claude: 'CLAUDE.local.md', codex: 'AGENTS.md', gemini: 'GEMINI.md', cursor: '.cursor/rules/thinker.mdc', windsurf: '.windsurf/rules/thinker.md', copilot: '.github/instructions/thinker.instructions.md', opencode: '.opencode/thinker.md' };
  for (const [client, file] of Object.entries(files)) {
    installClient(client, config);
    checkWorkflow(read(path.join(config.repo, file)), ['windsurf', 'copilot'].includes(client));
  }
  installClient('pi', config);
  const handlers = {};
  piExtension({ on: (event, fn) => { handlers[event] = fn; } }, { ...config, client: 'pi' }, async () => 'injected notes');
  const answer = await handlers.before_agent_start({ prompt: 'task' }, { sessionManager: { getSessionId: () => 's' } });
  checkWorkflow(answer.message.content, true);
  const oc = await opencodePlugin({ ...config, client: 'opencode' })();
  const c = { instructions: ['team.md'] }; await oc.config(c); await oc.config(c);
  assert.deepEqual(c.instructions, ['team.md', path.join(config.repo, '.opencode/thinker.md')]);
  uninstallClients(config.repo);
  for (const file of Object.values(files)) assert.equal(fs.existsSync(path.join(config.repo, file)), false, file);
});

test('user-scope installation, upgrade and uninstall preserve existing instructions and Codex overrides', t => {
  const config = fixture(t);
  const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  Object.assign(process.env, { HOME: config.repo, CODEX_HOME: path.join(config.repo, '.codex'), CLAUDE_CONFIG_DIR: path.join(config.repo, '.claude') });
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const files = { claude: '.claude/CLAUDE.md', codex: '.codex/AGENTS.override.md', gemini: '.gemini/GEMINI.md' };
  for (const [client, relative] of Object.entries(files)) {
    const file = path.join(config.repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'user rules\n');
    installClient(client, { ...config, scope: 'user', repo: undefined });
    checkWorkflow(read(file));
    assert.ok(read(file).endsWith('user rules\n'));
    // Simulate a pre-upgrade installation with wiring but no managed instructions.
    fs.writeFileSync(file, 'user rules\n');
    const args = { scope: 'user', clients: [client], cli, mcpEntry };
    assert.equal(refreshWiring(null, { ...args, dry: true }).changed.length, 1);
    assert.equal(read(file), 'user rules\n');
    assert.equal(refreshWiring(null, args).changed.length, 1);
    assert.deepEqual(refreshWiring(null, args).changed, []);
  }
  assert.equal(fs.existsSync(path.join(config.repo, '.codex/AGENTS.md')), false);
  uninstallWiring({ scope: 'user' });
  for (const file of Object.values(files)) assert.equal(read(path.join(config.repo, file)), 'user rules\n');
});

test('disabled integrations are respected, no instruction asks the agent to save or grade notes, and CLI instructions quote executable paths', async t => {
  const config = fixture(t);
  installClient('codex', { ...config, hooks: false, mcp: false });
  assert.equal(fs.existsSync(path.join(config.repo, 'AGENTS.md')), false);
  installClient('codex', { ...config, mcp: false, learn: false });
  const text = read(path.join(config.repo, 'AGENTS.md'));
  assert.doesNotMatch(text, /Use the Thinker MCP|remember|feedback|Learning is disabled/);
  installClient('codex', { ...config, mcp: true, learn: true });
  assert.doesNotMatch(read(path.join(config.repo, 'AGENTS.md')), /remember|feedback/, 'learning is the background distillation, never the agent (2026-10-08)');
  const oc = await opencodePlugin({ ...config, mcp: false })();
  const c = {}; await oc.config(c);
  assert.equal(c.mcp, undefined); assert.equal(c.instructions.length, 1);
  const quoted = agentWorkflow({ cli: "/tmp/a'b/cli.js", repo: '/tmp/$(touch danger)', mcp: false });
  assert.ok(quoted.includes("node '/tmp/a'\\''b/cli.js'"));
  assert.ok(quoted.includes("--repo '/tmp/$(touch danger)'"));
});

test('Cursor user wiring refreshes the project rule without installing project hooks', t => {
  const config = fixture(t), oldHome = process.env.HOME;
  process.env.HOME = config.repo;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  installClient('cursor', { ...config, scope: 'user', repo: undefined });
  const checkout = fixture(t).repo;
  new Store(checkout).init();
  const file = path.join(checkout, '.cursor/rules/thinker.mdc');
  const args = { cli, mcpEntry, clients: ['cursor'] };
  assert.deepEqual(refreshWiring(checkout, { ...args, dry: true }).changed, ['.cursor/rules/thinker.mdc']);
  assert.equal(fs.existsSync(file), false);
  refreshWiring(checkout, args);
  checkWorkflow(read(file));
  assert.equal(fs.existsSync(path.join(checkout, '.cursor/hooks.json')), false);
  assert.deepEqual(refreshWiring(checkout, args).changed, []);
});

test('CLI feedback corrects an existing note; invalid input does not write, and a fresh checkout gets an empty cache', t => {
  const { repo } = fixture(t);
  fs.writeFileSync(path.join(repo, 'module.js'), 'export const version = 1;\n');
  const store = new Store(repo).init();
  const { note } = createNote(store, { kind: 'rule', title: 'Version rule', answers: ['version'], body: 'Old claim.', deps: [{ path: 'module.js' }] });
  const run = input => spawnSync('node', [cli, 'feedback', '--repo', repo], { input: JSON.stringify(input), encoding: 'utf8', env: process.env });
  const corrected = run({ id: note.id, useful: false, correction: 'Corrected claim.' });
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(store.get(note.id).body, 'Corrected claim.');
  assert.ok(store.get(note.id).history.some(e => e.prevBody === 'Old claim.'));
  const before = JSON.stringify(store.get(note.id));
  assert.notEqual(run({ id: note.id, useful: 'false' }).status, 0);
  assert.equal(JSON.stringify(store.get(note.id)), before);
  assert.notEqual(run({ id: 'missing', useful: true }).status, 0);
  // a git checkout without a cache gets one on first use (every git repository has a cache); the bad input still writes no note
  const empty = fixture(t).repo;
  const r = spawnSync('node', [cli, 'feedback', '--repo', empty], { input: '{}', encoding: 'utf8', env: process.env });
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(empty, '.thinker', 'config.json')));
  assert.deepEqual(new Store(empty).list(), []);
});

// Claude Code cuts a server's instructions at INSTRUCTIONS_LIMIT and appends "… [truncated]", which
// silently dropped the tail of the guide before the text was composed under the cap.
test('MCP instructions fit the host cap whole, and the bundle header carries the two local decisions', () => {
  const deep = '/Users/x/' + 'deep/'.repeat(60) + 'repo';
  for (const repo of ['/r', '/Users/yoavshmariahu/src/thinker', deep]) {
    const text = cacheInstructions({ repo });
    assert.ok(text.length <= INSTRUCTIONS_LIMIT, `${repo}: ${text.length}`);
    assert.ok(text.includes(repo));
    assert.ok(text.includes('lookup') && !/\borient\b/.test(text), 'lookup, and orient off by default');
    assert.doesNotMatch(text, /remember|feedback/, 'no instruction asks the agent to save or grade notes (2026-10-08)');
    assert.doesNotMatch(text, /\bfind\b|\bdrilldown\b|before the first grep/, 'the code tools are off: not named');
    assert.match(text, /bears on the task/);
    // a repository that turned the code tools on is offered them beside its own search, never ahead of it, still under the cap
    const on = cacheInstructions({ repo, disabled: [] });
    assert.ok(on.length <= INSTRUCTIONS_LIMIT && /edit and verify/.test(on), `${repo}: ${on.length} with the code tools on`);
    for (const name of ['find', 'drilldown', 'mcp__thinker__find,mcp__thinker__drilldown']) assert.ok(on.includes(name), name);
    assert.match(on, /neither replaces one batched search or reading the file you will edit/);
    assert.doesNotMatch(on, /before the first grep|instead of grepping|fallback/, 'the tools are not put ahead of search');
    const one = cacheInstructions({ repo, disabled: ['find'] });
    assert.ok(one.includes('drilldown') && !/\bfind\b/.test(one), 'only the tool that is on is named');
  }
  // A cap below one section drops whole sections rather than handing the host half a sentence.
  const tight = cacheInstructions({ repo: '/r', limit: 600 });
  assert.ok(tight.length <= 600 && !/edit and verify/.test(tight));
  assert.match(cacheBundleIntro(), /match the working tree/);
  assert.match(cacheBundleIntro({ stale: true }), /STALE/);
  for (const t of [cacheBundleIntro(), cacheBundleIntro({ stale: true })]) {
    assert.doesNotMatch(t, /\borient\b/, 'orient is off by default');
    assert.doesNotMatch(t, /\bfind\b|\bdrilldown\b|before the first grep/);
  }
  assert.match(cacheBundleIntro({ disabled: [] }), /find locates code no note maps/);
  assert.doesNotMatch(cacheBundleIntro({ disabled: [] }), /before the first grep|drilldown/);
  assert.doesNotMatch(cacheBundleIntro({ disabled: ['find'] }), /\bfind\b/);
});

test('the workflow names the code tools only for a repository that turned them on', () => {
  const on = agentWorkflow({ disabled: [] });
  assert.match(on, /Beside them: `find` when you do not know where the code is; `drilldown` when you need a definition whole; neither replaces one batched search/);
  assert.match(agentWorkflow({ disabled: [], mcp: false }), /`thinker find "<code terms or identifier>"` when you do not know where the code is/);
  assert.ok(on.split('\n').filter(l => l.startsWith('- ')).length <= 4, 'four lines of decisions');
  assert.equal(agentWorkflow(), agentWorkflow({ disabled: disabledTools({}) }), 'off is the default');
  assert.deepEqual([...disabledTools({ disabledTools: [] })], ['orient'], 'the code tools on leave orient off');
  assert.deepEqual([...disabledTools({ disabledTools: ['find', 'lookup'] })].sort(), ['find', 'orient'], 'only orient and the code tools can be switched');
});

// orient is off by default, and every install turns it off: a disabledTools list from 0.1.65, which could switch it,
// does not keep it on; only enabledTools does (cache-guidance.js:disabledTools)
test('orient is off by default and on only where enabledTools names it; off, it is named nowhere the agent reads', () => {
  assert.ok(disabledTools({}).has('orient'));
  assert.ok(disabledTools({ disabledTools: [] }).has('orient'), 'a list written before this release does not keep it on');
  assert.ok(disabledTools({ disabledTools: ['find'] }).has('orient'));
  const on = disabledTools({ enabledTools: ['orient'] });
  assert.ok(!on.has('orient') && on.has('find') && on.has('drilldown'));
  for (const t of [agentWorkflow({ disabled: on }), cacheInstructions({ repo: '/r', disabled: on }), cacheBundleIntro({ disabled: on })]) assert.match(t, /\borient\b/);
  const off = disabledTools({});
  for (const t of [agentWorkflow(), agentWorkflow({ disabled: off, mcp: false }), cacheInstructions({ repo: '/r' }), cacheBundleIntro(), cacheBundleIntro({ stale: true })]) assert.doesNotMatch(t, /\borient\b/);
  assert.match(agentWorkflow(), /When none was injected, or none bears on the task, work from the code\./);
  assert.match(cacheInstructions({ repo: '/r' }), /ToolSearch `select:mcp__thinker__lookup`/);
});
