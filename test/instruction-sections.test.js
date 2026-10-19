import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { frontmatterList, globRegex, deriveTriggers, sectionFires, sectionsForEvent, sectionCards } from '../src/instruction-sections.js';

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-sections-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'posthog/api'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'posthog/api/views.py'), 'def view(): pass\n');
  const store = new Store(repo); store.init();
  const dir = path.join(repo, '.thinker/agents-md'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'entrypoints.md'), '---\npaths:\n  - "posthog/api/**"\n  - "products/*/backend/api/**"\n---\n### Entrypoints\n\nKeep entrypoints thin.\n');
  fs.writeFileSync(path.join(dir, 'transactions.md'), '---\ncode:\n  - "transaction\\\\.atomic"\n---\n### Transactions\n\nWrap only the writes that must succeed together.\n');
  fs.writeFileSync(path.join(dir, 'commits.md'), '### Commits and pull requests\n\nUse conventional commits.\n');
  return { repo, store, config: v => fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ instructions: { sections: v } })) };
}

test('frontmatter lists and globs read as Claude Code reads rule paths', () => {
  assert.deepEqual(frontmatterList('---\npaths:\n  - "a/**"\n  - b/*.py\n---\nx', 'paths'), ['a/**', 'b/*.py']);
  assert.deepEqual(frontmatterList('---\ncommands: ["\\\\bgit commit\\\\b", "gh pr"]\n---\n', 'commands'), ['\\bgit commit\\b', 'gh pr'], 'quoted values unescape as JSON strings');
  assert.equal(frontmatterList('no frontmatter', 'paths'), null);
  assert.deepEqual(frontmatterList('---\ncode:\n  - "posthoganalytics\\\\.capture\\\\("\n---\n', 'code'), ['posthoganalytics\\.capture\\('], 'a double-quoted value is unescaped');
  const re = s => new RegExp(globRegex(s));
  assert.ok(re('products/*/backend/api/**').test('products/links/backend/api/views.py'));
  assert.ok(!re('products/*/backend/api/**').test('products/links/frontend/a.tsx'));
  assert.ok(re('**/test_*.py').test('posthog/api/test/test_x.py'));
  assert.ok(re('posthog/api/').test('posthog/api/views.py'));
});

test('a section about commits fires on the command; one naming nothing specific has no trigger', t => {
  const { repo } = fixture(t);
  const commits = deriveTriggers(repo, { title: 'Commits and pull requests', text: 'Use conventional commits.' });
  assert.equal(sectionFires({ triggers: commits }, { command: 'git commit -m "feat: x"' }), 'cmd');
  assert.equal(sectionFires({ triggers: commits }, { command: 'git status' }), null);
  const vague = deriveTriggers(repo, { title: 'Entrypoints and layering', text: 'Keep entrypoints thin; logic goes in a function.' });
  assert.deepEqual([vague.paths, vague.code, vague.cmd], [[], [], null]);
});

test('code fires only in what a source file printed, never in a document that quotes it', () => {
  const card = { triggers: { codeRe: ['transaction\\.atomic'] } };
  assert.equal(sectionFires(card, { output: 'with transaction.atomic():', read: ['posthog/models/team.py'] }), 'code');
  assert.equal(sectionFires(card, { output: 'with transaction.atomic():', read: ['AGENTS.md'] }), null);
  assert.equal(sectionFires(card, { output: 'with transaction.atomic():', read: ['.agents/skills/x/SKILL.md', 'a.py'] }), null);
  assert.equal(sectionFires({ triggers: { codeRe: ['capture('], paths: ['(['], cmd: '((' } }, { output: 'capture(', read: ['a.py'], files: ['x'], command: 'git' }), null, 'a pattern that does not compile matches nothing');
});

test('sections are off by default, served verbatim once a session, and logged', t => {
  const { store, config } = fixture(t);
  assert.equal(sectionsForEvent(store, { session: 's1', files: ['posthog/api/views.py'] }), '', 'off by default');
  config({ enabled: true });
  assert.equal(sectionCards(store).length, 3);
  const first = sectionsForEvent(store, { session: 's1', client: 'codex', files: ['posthog/api/views.py'] });
  assert.match(first, /^<thinker-instructions>\n/); assert.match(first, /Keep entrypoints thin\./); assert.doesNotMatch(first, /paths:/, 'frontmatter is not served');
  assert.equal(sectionsForEvent(store, { session: 's1', client: 'codex', files: ['posthog/api/views.py'] }), '', 'once a session');
  assert.match(sectionsForEvent(store, { session: 's1', client: 'codex', command: 'git commit -m x' }), /conventional commits/);
  assert.match(sectionsForEvent(store, { session: 's2', client: 'codex', files: ['posthog/api/views.py'] }), /entrypoints/i, 'a new session is served again');
  const log = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8');
  assert.match(log, /"op":"section".*"section":"entrypoints".*"how":"path"/);
});

test('the tool hook serves a section for a Codex shell read of a matching file', t => {
  const { repo, config } = fixture(t);
  config({ enabled: true });
  const cli = path.resolve('src/cli.js');
  const ev = { session_id: 'h1', cwd: repo, hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'cat posthog/api/views.py'] }, tool_response: 'def view(): pass' };
  const out = execFileSync(process.execPath, [cli, 'hook', 'tool', '--client', 'codex', '--repo', repo], { input: JSON.stringify(ev), encoding: 'utf8', env: { ...process.env, THINKER_TEST: '1', THINKER_LOG: 'local', THINKER_HOME: path.join(repo, '.home') } });
  assert.match(out, /Keep entrypoints thin/);
});
