import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { updateInstructions } from '../src/agent-instructions.js';
import { cacheBundleIntro, cacheUsageGuide, disabledTools } from '../src/cache-guidance.js';
import { installClient, refreshWiring, uninstallClients } from '../src/clients.js';
import { piExtension } from '../src/integrations/pi.js';
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
// the block as installs before 2026-10-22 wrote it
const OLD_BLOCK = '<!-- thinker:workflow:start -->\n## Using Thinker while working\n\nUse the Thinker MCP tools as a map to the code.\n<!-- thinker:workflow:end -->\n\n';
const OLD_RULE = '---\ndescription: Use Thinker for repository exploration and learning\nalwaysApply: true\n---\n## Using Thinker while working\n';

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

// The workflow block thinker wrote into the agents' instruction files, and the rules that copied it, were taken out
// on 2026-10-22 with the agent's MCP tools: install writes none, and install or rewire (run by every update) takes
// an old one out, leaving the person's own text as it was.
test('no adapter writes the workflow; installing over an old one takes it out and keeps the user text', async t => {
  const config = fixture(t);
  const blocks = { claude: 'CLAUDE.local.md', codex: 'AGENTS.md', gemini: 'GEMINI.md', opencode: '.opencode/thinker.md' };
  for (const [client, file] of Object.entries(blocks)) {
    const f = path.join(config.repo, file);
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, OLD_BLOCK + 'user rules\n');
    installClient(client, config);
    assert.equal(read(f), 'user rules\n', file);
  }
  const rules = { cursor: '.cursor/rules/thinker.mdc', windsurf: '.windsurf/rules/thinker.md', copilot: '.github/instructions/thinker.instructions.md' };
  for (const [client, file] of Object.entries(rules)) {
    const f = path.join(config.repo, file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, client === 'cursor' ? OLD_RULE : '---\ntrigger: always_on\n---\n<!-- thinker -->\nold guidance\n');
    installClient(client, config);
    assert.equal(fs.existsSync(f), false, file);
  }
  // Pi is handed the notes alone, and nothing where there are none
  installClient('pi', config);
  const handlers = {};
  piExtension({ on: (event, fn) => { handlers[event] = fn; } }, { ...config, client: 'pi' }, async () => 'injected notes');
  const answer = await handlers.before_agent_start({ prompt: 'task' }, { sessionManager: { getSessionId: () => 's' } });
  assert.equal(answer.message.content, 'injected notes');
  const quiet = {};
  piExtension({ on: (event, fn) => { quiet[event] = fn; } }, { ...config, client: 'pi' }, async () => '');
  assert.equal(await quiet.before_agent_start({ prompt: 'task' }, { sessionManager: { getSessionId: () => 's' } }), undefined);
  uninstallClients(config.repo);
});

test('a person\'s own Cursor rule named thinker.mdc is left alone', t => {
  const config = fixture(t);
  const f = path.join(config.repo, '.cursor/rules/thinker.mdc');
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '---\ndescription: my notes on thinking\n---\nmine\n');
  installClient('cursor', config);
  assert.equal(read(f), '---\ndescription: my notes on thinking\n---\nmine\n');
});

test('an update takes the old workflow out of the user\'s instruction files, once, and keeps their rules', t => {
  const config = fixture(t);
  const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  Object.assign(process.env, { HOME: config.repo, CODEX_HOME: path.join(config.repo, '.codex'), CLAUDE_CONFIG_DIR: path.join(config.repo, '.claude') });
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const files = { claude: '.claude/CLAUDE.md', codex: '.codex/AGENTS.md', gemini: '.gemini/GEMINI.md' };
  for (const [client, relative] of Object.entries(files)) {
    installClient(client, { ...config, scope: 'user', repo: undefined });
    const file = path.join(config.repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, OLD_BLOCK + 'user rules\n');
    const args = { scope: 'user', clients: [client], cli, mcpEntry };
    assert.equal(refreshWiring(null, { ...args, dry: true }).changed.length, 1, `${client}: the dry run names it`);
    assert.equal(read(file), OLD_BLOCK + 'user rules\n', 'and writes nothing');
    assert.equal(refreshWiring(null, args).changed.length, 1);
    assert.equal(read(file), 'user rules\n');
    assert.deepEqual(refreshWiring(null, args).changed, []);
  }
  // a file holding nothing but the block goes
  const only = path.join(config.repo, '.claude/CLAUDE.md'); fs.writeFileSync(only, OLD_BLOCK);
  refreshWiring(null, { scope: 'user', clients: ['claude'], cli, mcpEntry });
  assert.equal(fs.existsSync(only), false);
});

// Since the wiring went machine-wide a checkout is rarely wired itself, so the block an older setup wrote into its files
// is taken out whether or not an agent is wired there, as are the user's files of an agent wired nowhere.
test('rewire takes the old workflow and rules out of a checkout and home no agent is wired in', t => {
  const config = fixture(t), repo = config.repo;
  const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const home = fixture(t).repo;
  Object.assign(process.env, { HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
  t.after(() => { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const kept = ['CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md'].map(f => path.join(repo, f));
  for (const f of kept) put(f, OLD_BLOCK + 'team rules\n');
  const gone = [path.join(repo, '.opencode/thinker.md'), path.join(repo, '.cursor/rules/thinker.mdc'), path.join(repo, '.windsurf/rules/thinker.md')];
  put(gone[0], OLD_BLOCK); put(gone[1], OLD_RULE); put(gone[2], '---\ntrigger: always_on\n---\n<!-- thinker -->\nold\n');
  const user = [path.join(home, '.claude/CLAUDE.md'), path.join(home, '.codex/AGENTS.md')];
  for (const f of user) put(f, OLD_BLOCK + 'mine\n');
  const args = { cli, mcpEntry };
  const dry = refreshWiring(repo, { ...args, dry: true });
  assert.ok(dry.changed.includes('AGENTS.md') && dry.changed.includes('.cursor/rules/thinker.mdc'), dry.changed.join(', '));
  assert.equal(read(kept[1]), OLD_BLOCK + 'team rules\n', 'a dry run writes nothing');
  assert.ok(fs.existsSync(gone[1]));
  refreshWiring(repo, args);
  for (const f of kept) assert.equal(read(f), 'team rules\n', f);
  for (const f of gone) assert.equal(fs.existsSync(f), false, f);
  refreshWiring(null, { ...args, scope: 'user' });
  for (const f of user) assert.equal(read(f), 'mine\n', f);
  assert.deepEqual(refreshWiring(repo, args).changed, []);
});

test('the bundle header is one line naming no tool, and the guide names none either', () => {
  const header = cacheBundleIntro();
  assert.equal(header.split('\n').length, 1);
  assert.match(header, /map, not a plan/);
  for (const t of [header, cacheUsageGuide()]) assert.doesNotMatch(t, /\b(orient|lookup|find|drilldown|remember|feedback)\b|mcp__|ToolSearch/);
  assert.match(cacheUsageGuide(), /<thinker-cache>/);
});

// the code tools stay switchable for the prompt hook's code (ops.js:codeForRequest)
test('only orient and the code tools can be switched, orient on only where enabledTools names it', () => {
  assert.deepEqual([...disabledTools({ disabledTools: [] })], ['orient']);
  assert.deepEqual([...disabledTools({ disabledTools: ['find', 'lookup'] })].sort(), ['find', 'orient']);
  assert.ok(!disabledTools({ enabledTools: ['orient'] }).has('orient'));
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

