// The instruction files as a cost and a slim core for them (instructions.js, commands/instructions.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { instructionFiles, sessionStats, instructionCost, renderInstructionCost, slimInstructions, renderSlim, checkInstructions, watchInstructions, tokensOf, INSTRUCTIONS } from '../src/instructions.js';
import { maintenanceNotice } from '../src/maintain.js';

process.env.THINKER_TELEMETRY = 'off';
const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const AGENTS = ['# Repo', '', '## Commands', '', '- `npm test` runs the suite', '', '## Code Style', '', '- two spaces, no semicolons in prose', '', '## Commits and Pull Requests', '', '- squash, sign, link the issue', ...Array.from({ length: 80 }, (_, i) => `- rule ${i} about pull requests that an editing agent never uses`), '', '## CI', '', '- the workflow runs on every push', ''].join('\n');
function repo(t, { rules = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-instr-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), AGENTS);
  fs.symlinkSync('AGENTS.md', path.join(dir, 'CLAUDE.md'));
  if (rules) { fs.mkdirSync(path.join(dir, '.claude/rules'), { recursive: true }); fs.writeFileSync(path.join(dir, '.claude/rules/migrations.md'), '# Migrations\n\nNever edit a merged migration.\n'); fs.writeFileSync(path.join(dir, '.claude/rules/tests.md'), '# Tests\n\nOne assertion per behaviour.\n'); }
  fs.mkdirSync(path.join(dir, 'src/deep'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/deep/CLAUDE.md'), '# deep\n');
  return dir;
}
const logSession = (store, session, turns, inputTokens, t = new Date().toISOString()) => store.log({ op: 'session', session, turn: 1, client: 'claude', turns, inputTokens, t });

test('the files Claude Code loads into every turn: the root file once through its link, the rules, nested ones counted apart', t => {
  const dir = repo(t);
  const f = instructionFiles(dir);
  assert.deepEqual(f.files.map(x => [x.file, x.kind]), [['CLAUDE.md', 'core'], ['.claude/rules/migrations.md', 'rule'], ['.claude/rules/tests.md', 'rule']]);
  assert.equal(f.files[0].link, 'AGENTS.md', 'CLAUDE.md is a link to AGENTS.md, counted once');
  assert.equal(f.root, 'CLAUDE.md');
  assert.equal(f.tokens, f.files.reduce((a, x) => a + x.tokens, 0));
  assert.equal(f.nested, 1);
  assert.equal(instructionFiles(repo(t, { rules: false })).files.length, 1);
});

test('the cost: the files\' tokens times the median turns of the sessions logged here, as a share of their input', t => {
  const dir = repo(t); const store = new Store(dir).init();
  const empty = instructionCost(store);
  assert.equal(empty.sessions, 0); assert.equal(empty.share, null);
  assert.match(renderInstructionCost(empty), /No sessions logged here/);
  logSession(store, 'a', 10, 400_000); logSession(store, 'b', 14, 820_000); logSession(store, 'c', 20, 1_200_000);
  logSession(store, 'old', 90, 9_000_000, new Date(Date.now() - 40 * 86_400_000).toISOString());
  const s = sessionStats(store);
  assert.deepEqual([s.sessions, s.turns, s.input], [3, 14, 820_000], 'the median session, the old one outside the window');
  const c = instructionCost(store);
  assert.equal(c.share, Math.min(1, c.tokens * 14 / 820_000));
  const text = renderInstructionCost(c);
  assert.match(text, /re-read 14 times: about \d+% of the input tokens/);
  assert.match(text, /\.claude\/rules \(2 files\)/);
  assert.match(text, /1 nested CLAUDE\.md/);
  assert.match(text, /Budget for the core: 3\.0k tokens; CLAUDE\.md is [\d.]+k?, within it\./);
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ instructions: { budget: 200 } }));
  assert.match(renderInstructionCost(instructionCost(store)), /over|`thinker instructions slim` proposes a core/);
});

test('slim: the core the model writes is proposed beside the sections it left out, and --write puts it in the file with the original kept', async t => {
  const dir = repo(t); const store = new Store(dir).init();
  const core = '# Repo\n\n## Commands\n\n- `npm test` runs the suite\n\n## Code Style\n\n- two spaces, no semicolons in prose\n';
  const calls = [];
  const completeFn = async o => { calls.push(o); return { text: '```markdown\n' + core + '```', model: 'stub-sonnet', tokens: { inputTokens: 100, outputTokens: 50 } }; };
  const dry = await slimInstructions(store, { dry: true, completeFn });
  assert.equal(dry.dry, true); assert.equal(calls.length, 0); assert.match(renderSlim(dry), /would be written/);
  const r = await slimInstructions(store, { budget: 500, completeFn });
  assert.equal(calls.length, 1); assert.match(calls[0].prompt, /at most 500 tokens/); assert.equal(calls[0].accounting.purpose, 'instructions-slim');
  assert.equal(r.source, 'CLAUDE.md'); assert.equal(r.tokensAfter, tokensOf(core.trim())); assert.ok(r.tokensBefore > r.tokensAfter);
  assert.deepEqual(r.dropped, ['Commits and Pull Requests', 'CI'], 'the sections whose headings the core does not keep');
  assert.equal(fs.readFileSync(path.join(dir, r.slimPath), 'utf8'), core.trim() + '\n', 'the fence is taken off');
  assert.equal(fs.readFileSync(path.join(dir, r.fullPath), 'utf8'), AGENTS, 'the original is kept whole beside the core');
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), AGENTS, 'the person\'s file is untouched');
  assert.equal(r.written, false); assert.match(renderSlim(r), /Proposed in \.thinker\/instructions\/CLAUDE\.slim\.md/);
  assert.equal(store.list().length, 0, 'no note is written');
  const w = await slimInstructions(store, { budget: 500, write: true, completeFn });
  assert.equal(w.written, true);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), core.trim() + '\n', 'through the link, the file itself');
  assert.equal(fs.readFileSync(path.join(store.dir, 'instructions', 'CLAUDE.full.md'), 'utf8'), AGENTS);
  assert.match(renderSlim(w), /Written to CLAUDE\.md; the original is kept whole as \.thinker\/instructions\/CLAUDE\.full\.md/);
  const c = instructionCost(store);
  assert.match(renderInstructionCost(c), /Last slim: \d{4}-\d{2}-\d{2}, [\d.]+k? → \d+ tokens, written to the file\./);
  fs.appendFileSync(path.join(dir, 'AGENTS.md'), '\n## New section\n\n- grew\n');
  assert.match(renderInstructionCost(instructionCost(store)), /the file has changed since/);
  await assert.rejects(slimInstructions(store, { completeFn: async () => ({ text: '' }) }), /no core/);
});

test('check exits 1 over budget; the watch says so once per content through the maintenance notice, never below budget', t => {
  const dir = repo(t); const store = new Store(dir).init();
  assert.equal(checkInstructions(store).ok, true);
  const over = checkInstructions(store, { budget: 100 });
  assert.equal(over.ok, false); assert.match(over.line, /CLAUDE\.md: [\d.]+k? tokens, budget 100: over budget/);
  assert.deepEqual(watchInstructions(store), [], 'within the default budget: nothing');
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ instructions: { budget: 100 } }));
  const lines = watchInstructions(store);
  assert.equal(lines.length, 1); assert.match(lines[0], /CLAUDE\.md is [\d.]+k? tokens, over the 100-token budget.*thinker instructions slim/);
  assert.deepEqual(watchInstructions(store), [], 'once per content');
  fs.appendFileSync(path.join(dir, 'AGENTS.md'), '\n- more\n');
  assert.equal(watchInstructions(store).length, 1, 'changed content is reported again');
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ instructions: { budget: 100, watch: false } }));
  fs.appendFileSync(path.join(dir, 'AGENTS.md'), '\n- even more\n');
  assert.deepEqual(watchInstructions(store), [], 'watch: false');
  // the CLI: the report, the check's exit code, and the maintenance notice carrying the watch's line
  const env = { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'local', THINKER_NO_LEARN: '1', THINKER_TELEMETRY: 'off' };
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a, '--repo', dir], { encoding: 'utf8', env });
  assert.match(run('instructions').stdout, /Instruction files Claude Code loads into every turn/);
  assert.equal(run('instructions', 'check').status, 1);
  assert.equal(run('instructions', 'check', '--budget', '100000').status, 0);
  assert.equal(JSON.parse(run('instructions', '--json').stdout).root, 'CLAUDE.md');
});

test('maintenance carries the watch\'s line to the end of the next turn', async t => {
  const dir = repo(t); const store = new Store(dir).init();
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ instructions: { budget: 100 } }));
  const { maintain } = await import('../src/maintain.js');
  await maintain(store, dir, { fns: { instructions: () => watchInstructions(store) } });
  assert.match(maintenanceNotice(store), /CLAUDE\.md is [\d.]+k? tokens, over the 100-token budget/);
  assert.equal(maintenanceNotice(store), '', 'said once');
});
