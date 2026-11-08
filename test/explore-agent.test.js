// Exploration subagents on Sonnet (explore-agent.js): the user-scope Explore agent thinker writes, what
// switches it off, and that a person's own file is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPLORE_MODEL_DEFAULT, EXPLORE_MARK, exploreModel, exploreAgentFile, renderExploreAgent, installExploreAgent, removeExploreAgent, isThinkerExploreAgent } from '../src/explore-agent.js';
import { installClient, uninstallWiring } from '../src/clients.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const frontmatter = text => Object.fromEntries(text.split('\n---')[0].replace(/^---\n/, '').split('\n').filter(Boolean).map(l => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; }));

test('the agent is named Explore, read-only, without CLAUDE.md, on Sonnet by default, and marked as thinker\'s', () => {
  const text = renderExploreAgent();
  const fm = frontmatter(text);
  assert.equal(fm.name, 'Explore', 'the name is what overrides the built-in agent');
  assert.equal(fm.model, EXPLORE_MODEL_DEFAULT);
  assert.equal(EXPLORE_MODEL_DEFAULT, 'claude-sonnet-5-5', 'the replay of 2026-11-07 ran Sonnet 5.5; the sonnet alias resolved to Sonnet 5 live');
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent']) assert.match(fm.disallowedTools, new RegExp(`\\b${t}\\b`));
  assert.equal(fm.omitClaudeMd, 'true', 'as the built-in Explore, it starts without the instruction files');
  assert.ok(fm.description.length > 40);
  assert.ok(isThinkerExploreAgent(text) && text.includes(`<!-- ${EXPLORE_MARK}`));
  assert.equal(frontmatter(renderExploreAgent('haiku')).model, 'haiku');
});

test('the model comes from the environment, then the machine config, then the default; off is off', () => {
  const home = tmp('thinker-explore-home-');
  try {
    assert.equal(exploreModel({ env: {}, home }), null, 'off by default (the owner, 2026-11-08)');
    assert.equal(exploreModel({ env: { THINKER_EXPLORE_MODEL: 'on' }, home }), 'claude-sonnet-5-5');
    assert.equal(exploreModel({ env: { THINKER_EXPLORE_MODEL: 'off' }, home }), null);
    assert.equal(exploreModel({ env: { THINKER_EXPLORE_MODEL: 'claude-haiku-5-5' }, home }), 'claude-haiku-5-5');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ agents: { explore: false } }));
    assert.equal(exploreModel({ env: {}, home }), null, 'the config switches it off');
    assert.equal(exploreModel({ env: { THINKER_EXPLORE_MODEL: 'haiku' }, home }), 'haiku', 'the environment wins over the config');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ agents: { explore: 'opus' } }));
    assert.equal(exploreModel({ env: {}, home }), 'opus', 'the config names a model');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ agents: { explore: true } }));
    assert.equal(exploreModel({ env: {}, home }), 'claude-sonnet-5-5', 'true is the default model');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ agents: {} }));
    assert.equal(exploreModel({ env: {}, home }), null, 'an empty block is off');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('install writes once, rewrites on a model change, removes only its own file, and leaves a person\'s own alone', () => {
  const claudeDir = tmp('thinker-explore-claude-');
  try {
    const file = exploreAgentFile(claudeDir);
    assert.equal(installExploreAgent({ claudeDir, model: 'sonnet' }).action, 'written');
    assert.equal(fs.readFileSync(file, 'utf8'), renderExploreAgent('sonnet'));
    assert.equal(installExploreAgent({ claudeDir, model: 'sonnet' }).action, 'unchanged', 'the same bytes are not written again');
    assert.equal(installExploreAgent({ claudeDir, model: 'haiku' }).action, 'written');
    assert.equal(frontmatter(fs.readFileSync(file, 'utf8')).model, 'haiku');
    assert.equal(installExploreAgent({ claudeDir, model: null }).action, 'removed', 'off removes it');
    assert.ok(!fs.existsSync(file));
    assert.equal(installExploreAgent({ claudeDir, model: null }).action, 'absent');
    assert.ok(!fs.existsSync(file + `.${process.pid}.tmp`), 'no temp file left behind');
    // a person's own agent of the same name
    fs.writeFileSync(file, '---\nname: Explore\nmodel: opus\n---\nMy own explorer.\n');
    assert.equal(installExploreAgent({ claudeDir, model: 'sonnet' }).action, 'kept');
    assert.equal(removeExploreAgent({ claudeDir }).action, 'kept');
    assert.match(fs.readFileSync(file, 'utf8'), /My own explorer/, 'never overwritten, never removed');
  } finally { fs.rmSync(claudeDir, { recursive: true, force: true }); }
});

test('connect at user scope writes the Explore agent under the Claude config dir once opted in, and uninstall --user removes it', () => {
  const home = tmp('thinker-explore-connect-');
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, THINKER_EXPLORE_MODEL: process.env.THINKER_EXPLORE_MODEL };
  process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR; process.env.THINKER_EXPLORE_MODEL = 'on';
  try {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const done = installClient('claude', { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: [] }, hooks: true, late: true, learn: false, mcp: false });
    const file = path.join(home, '.claude', 'agents', 'Explore.md');
    assert.ok(fs.existsSync(file), 'Explore.md is written beside the settings');
    assert.equal(frontmatter(fs.readFileSync(file, 'utf8')).model, 'claude-sonnet-5-5');
    assert.ok(done.some(l => /exploration subagents run on claude-sonnet-5-5/.test(l)), `connect says so: ${done.join(' | ')}`);
    uninstallWiring({ scope: 'user' });
    assert.ok(!fs.existsSync(file), 'uninstall --user takes it out');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('by default connect writes nothing and removes a file thinker wrote while it was on', () => {
  const home = tmp('thinker-explore-off-');
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, THINKER_EXPLORE_MODEL: process.env.THINKER_EXPLORE_MODEL };
  process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR; delete process.env.THINKER_EXPLORE_MODEL;
  try {
    const file = path.join(home, '.claude', 'agents', 'Explore.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderExploreAgent('sonnet'));
    const done = installClient('claude', { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: [] }, hooks: true, late: true, learn: false, mcp: false });
    assert.ok(!fs.existsSync(file), 'the default removes the file thinker wrote');
    assert.ok(done.some(l => /removed .*Explore\.md/.test(l)), `connect says so: ${done.join(' | ')}`);
    const again = installClient('claude', { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: [] }, hooks: true, late: true, learn: false, mcp: false });
    assert.ok(!again.some(l => /Explore/.test(l)), 'and says nothing when there is nothing to remove');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
