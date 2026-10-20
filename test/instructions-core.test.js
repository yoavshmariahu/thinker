import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { buildCore, syncCore, setCore, MARK, OVERRIDE } from '../src/instructions-core.js';

const AGENTS = `# Guide

Intro line.

## Commands

Run \`hogli test\`.

## Commits and Pull Requests

Use conventional commits.

### Pushing to remote

Never push main.

## Code Style

### Python

Type everything.

### Comments

Few comments.
`;

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-core-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS);
  const store = new Store(repo); store.init();
  return { repo, store };
}

test('the core keeps the named sections verbatim, in order, with the outline heading of a kept subsection', () => {
  const r = buildCore(AGENTS, ['Commands', 'Python', 'Nope']);
  assert.ok(r.text.startsWith(MARK));
  assert.match(r.text, /# Guide\n\n## Commands\n\nRun `hogli test`\.\n\n## Code Style\n\n### Python\n\nType everything\.\n$/);
  assert.doesNotMatch(r.text, /conventional commits|Never push|Few comments|Intro line/);
  assert.deepEqual(r.kept, ['Commands', 'Python']);
  assert.deepEqual(r.missing, ['nope']);
  assert.ok(r.dropped.includes('Commits and Pull Requests') && r.dropped.includes('Comments'));
});

test('the override follows AGENTS.md, stays out of git, and goes when switched off', t => {
  const { repo, store } = fixture(t);
  assert.equal(syncCore(store).state, 'off');
  assert.equal(setCore(store, ['Commands']).state, 'written');
  const dst = path.join(repo, OVERRIDE);
  assert.match(fs.readFileSync(dst, 'utf8'), /hogli test/);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', OVERRIDE], { cwd: repo, encoding: 'utf8' }), '', 'excluded from git');
  assert.equal(syncCore(store).state, 'current');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS.replace('hogli test', 'hogli test --fast'));
  assert.equal(syncCore(store).state, 'written', 'AGENTS.md changed');
  assert.match(fs.readFileSync(dst, 'utf8'), /--fast/);
  assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8').includes('conventional commits'), true, 'the team file is untouched');
  assert.equal(setCore(store, null).state, 'removed');
  assert.equal(fs.existsSync(dst), false);
});

test("an AGENTS.override.md the team wrote is never touched", t => {
  const { repo, store } = fixture(t);
  fs.writeFileSync(path.join(repo, OVERRIDE), '# Theirs\n');
  assert.equal(setCore(store, ['Commands']).state, 'theirs');
  assert.equal(fs.readFileSync(path.join(repo, OVERRIDE), 'utf8'), '# Theirs\n');
  assert.equal(setCore(store, null).state, 'theirs');
  assert.equal(fs.readFileSync(path.join(repo, OVERRIDE), 'utf8'), '# Theirs\n');
});

test('the CLI lists the sections and writes the core', t => {
  const { repo } = fixture(t);
  const run = (...a) => execFileSync(process.execPath, [path.resolve('src/cli.js'), 'instructions', ...a, '--repo', repo], { encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'local', THINKER_HOME: path.join(repo, '.home') } });
  assert.match(run(), /Commits and Pull Requests: Pushing to remote|Pushing to remote/);
  assert.match(run('--core', 'Commands, Python'), /Wrote AGENTS\.override\.md .*2 sections/);
  assert.match(run('--off'), /Removed AGENTS\.override\.md/);
});

test('Claude Code reads the core from CLAUDE.local.md, CLAUDE.md skipped when it is AGENTS.md, other settings kept', t => {
  const { repo, store } = fixture(t);
  fs.symlinkSync('AGENTS.md', path.join(repo, 'CLAUDE.md'));
  const settings = path.join(repo, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true }); fs.writeFileSync(settings, JSON.stringify({ skillOverrides: { x: 'off' } }));
  const r = setCore(store, ['Commands']);
  assert.equal(r.claude, 'written');
  assert.match(fs.readFileSync(path.join(repo, 'CLAUDE.local.md'), 'utf8'), /hogli test/);
  const j = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.deepEqual(j.claudeMdExcludes, [path.join(repo, 'CLAUDE.md')]); assert.deepEqual(j.skillOverrides, { x: 'off' });
  assert.equal(execFileSync('git', ['status', '--porcelain', '--', 'CLAUDE.local.md', '.claude'], { cwd: repo, encoding: 'utf8' }), '', 'kept out of git');
  assert.equal(setCore(store, null).claude, 'removed');
  assert.equal(fs.existsSync(path.join(repo, 'CLAUDE.local.md')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { skillOverrides: { x: 'off' } });
});

test('Claude Code is left alone when CLAUDE.md has text of its own or CLAUDE.local.md is the person\'s', t => {
  const { repo, store } = fixture(t);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n\nAlso: never use tabs.\n');
  assert.equal(setCore(store, ['Commands']).claude, 'skipped');
  assert.equal(fs.existsSync(path.join(repo, 'CLAUDE.local.md')), false);
  assert.equal(fs.existsSync(path.join(repo, '.claude', 'settings.local.json')), false);
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '@AGENTS.md\n');
  fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), 'my notes\n');
  assert.equal(setCore(store, ['Commands']).claude, 'theirs');
  assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.local.md'), 'utf8'), 'my notes\n');
  setCore(store, null);
  assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.local.md'), 'utf8'), 'my notes\n');
});
