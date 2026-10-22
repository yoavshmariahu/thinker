// The first session in a repository: the hooks set it up, once, with what `thinker setup` would write for
// the repository (repo-onboard.js). No warm-up is offered: the cache grows from the sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, repoId } from '../src/store.js';
import { desktopApp } from '../src/repo-onboard.js';
import { createNote } from '../src/ops.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-onboard-home-'));
const env = { ...process.env, THINKER_HOME: HOME, THINKER_LOG: 'local', THINKER_HOLDOUT: 'off', THINKER_NO_BG_VERIFY: '1', THINKER_NO_LEARN: '1', THINKER_CE: 'off', THINKER_TELEMETRY: 'off', THINKER_OFFERS: 'on' };
const hook = (dir, kind, input, client = 'claude') => execFileSync('node', [CLI, 'hook', kind, '--client', client, '--repo', dir], { input: JSON.stringify(input), encoding: 'utf8', env });
const ops = dir => fs.readFileSync(path.join(dir, '.thinker/log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
function gitRepo(commits) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-onboard-')));
  const git = (...a) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows() {\n  return 1;\n}\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  for (let i = 1; i < commits; i++) { fs.writeFileSync(path.join(dir, 'src/a.js'), `export function fetchRows() {\n  return ${i + 1};\n}\n`); git('commit', '-qam', `bump ${i}`); }
  return dir;
}

// Cursor's always-applied rule (a copy of the workflow block) is no longer written, and a prompt takes out the one
// an older thinker wrote (2026-10-22)
const OLD_RULE = '---\ndescription: Use Thinker for repository exploration and learning\nalwaysApply: true\n---\nold\n';
test('Cursor gets no always-on rule, and a prompt takes out the one an older thinker wrote', t => {
  const dir = gitRepo(2);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  hook(dir, 'prompt', { conversation_id: 'c1', prompt: 'hello' }, 'cursor');
  assert.ok(!fs.existsSync(path.join(dir, '.cursor/rules/thinker.mdc')));
  assert.deepEqual(ops(dir).find(e => e.op === 'repo-setup').done, ['git hooks']);
  const old = gitRepo(2);
  t.after(() => fs.rmSync(old, { recursive: true, force: true }));
  fs.mkdirSync(path.join(old, '.cursor/rules'), { recursive: true }); fs.writeFileSync(path.join(old, '.cursor/rules/thinker.mdc'), OLD_RULE);
  hook(old, 'prompt', { conversation_id: 'c2', prompt: 'hello' }, 'cursor');
  assert.ok(!fs.existsSync(path.join(old, '.cursor/rules/thinker.mdc')));
});

test('the desktop app a session runs in: Claude Desktop by its env or its process, the Codex app and Cursor by their process; a terminal CLI is none', () => {
  const none = { env: {}, ancestry: ['claude', '-zsh', '/Applications/iTerm.app/Contents/MacOS/iTerm2'] };
  assert.equal(desktopApp('claude', { env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, ancestry: [] }), 'Claude Desktop');
  assert.equal(desktopApp('claude', { env: {}, ancestry: ['/Users/u/Library/Application Support/Claude/claude-code/2.1.299/x/claude.app/Contents/MacOS/claude', '/Applications/Claude.app/Contents/MacOS/Claude'] }), 'Claude Desktop');
  // Claude Code's own CLI bundle is not the desktop app
  assert.equal(desktopApp('claude', { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' }, ancestry: ['/Users/u/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude'] }), null);
  assert.equal(desktopApp('codex', { env: {}, ancestry: ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex', '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'] }), 'the Codex app');
  assert.equal(desktopApp('cursor', { env: {}, ancestry: ['Cursor Helper (Plugin)', '/Applications/Cursor.app/Contents/MacOS/Cursor'] }), 'Cursor');
  // Cursor's agent shell: its sandbox hides the process tree, the env says so (2026-10-16)
  assert.equal(desktopApp('cursor', { env: { CURSOR_AGENT: '1' }, ancestry: [] }), 'Cursor');
  for (const h of ['claude', 'codex', 'cursor']) assert.equal(desktopApp(h, none), null);
  assert.equal(desktopApp('gemini', { env: {}, ancestry: ['/Applications/Claude.app/Contents/MacOS/Claude'] }), null);
});
