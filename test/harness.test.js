// What Claude Code loads into every session against what the sessions use (harness.js), read from
// the transcripts' own records of what was loaded, and the advice on what to switch off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionHarness, harnessUsage, harnessAdvice, skillCosts, serverKey } from '../src/harness.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const long = n => 'x'.repeat(n);
// a plugin's skill is listed as "- <plugin>:<file> (<plugin>:<name>): …"
const SKILLS = `- gtm:start-here (gtm:begin): ${long(800)}\n- gtm:pricing: ${long(800)}\n- mine: ${long(600)}\n- code-review: ${long(600)}\n`;
const loadedLines = () => [
  { type: 'attachment', cwd: '/r', attachment: { type: 'deferred_tools_delta', addedNames: ['Monitor', ...Array.from({ length: 60 }, (_, i) => `mcp__rea__tool_number_${i}`), 'mcp__artemis__get_experiment', 'mcp__claude_ai_Gmail__authenticate'], surfacedDefinitions: [{ name: 'mcp__claude_ai_Claude_Docs__batch', definition: { name: 'mcp__claude_ai_Claude_Docs__batch', description: long(800) } }] } },
  { type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: ['rea', 'artemis', 'claude.ai Claude Docs'], addedBlocks: [`## rea\n${long(1200)}`, `## artemis\n${long(1200)}`, `## docs\n${long(400)}`] } },
  { type: 'attachment', attachment: { type: 'skill_listing', content: SKILLS, names: ['gtm:start-here', 'gtm:pricing', 'mine', 'code-review'] } },
];
const call = (name, input = {}) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
function session(dir, id, extra = [], sub = []) {
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [...loadedLines(), ...extra].map(j => JSON.stringify(j)).join('\n') + '\n');
  if (sub.length) {
    fs.mkdirSync(path.join(dir, id, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'subagents', 'agent-a.jsonl'), sub.map(j => JSON.stringify(j)).join('\n') + '\n');
  }
  return { client: 'claude', file: path.join(dir, `${id}.jsonl`), session: id, mtime: Date.now() };
}
function home(t) {
  const h = tmp('thinker-harness-home-');
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ mcpServers: { rea: { command: 'rea', env: { KEY: 'secret-value' } }, artemis: { command: 'artemis' } } }));
  fs.mkdirSync(path.join(h, '.claude', 'skills', 'mine'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'gtm@market': true } }));
  return h;
}

test('a server is one key whether its tools or its instructions name it', () => {
  assert.equal(serverKey('claude_ai_Claude_Docs'), serverKey('claude.ai Claude Docs'));
  assert.equal(serverKey('claude-in-chrome'), 'claude_in_chrome');
});

test('each skill costs its own line of the listing', () => {
  const c = skillCosts(SKILLS, ['mine', 'gtm:start-here', 'absent']);
  assert.ok(c.get('gtm:start-here') > 200 && c.get('gtm:start-here') < 260, 'the first skill ends where the next begins');
  assert.equal(c.has('absent'), false);
});

test('a session records what it loaded, with tokens, and what it and its subagents called', t => {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = session(dir, 'a', [call('mcp__artemis__get_experiment'), { type: 'user', message: { content: '<command-name>/gtm:pricing</command-name>' } }], [call('Skill', { skill: 'mine' })]);
  const h = sessionHarness(s.file);
  assert.equal(h.cwd, '/r');
  assert.ok(h.loaded.get('mcp:rea') > 600, 'sixty tool names and the instructions');
  assert.ok(h.loaded.get('mcp:claude_ai_claude_docs') > 300, 'a surfaced definition counts whole, beside the instructions');
  assert.deepEqual([...h.used].sort(), ['mcp:artemis', 'skill:gtm:pricing', 'skill:mine']);
});

test('advice names what is loaded and never used, where it is switched on, and keeps what is used', t => {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = tmp('thinker-harness-repo-'); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const sessions = [0, 1, 2, 3].map(i => session(dir, `s${i}`, [call('mcp__artemis__get_experiment')]));
  const usage = harnessUsage(repo, { home: home(t), sessions });
  assert.equal(usage.sessions, 4);
  const by = Object.fromEntries(usage.sources.map(s => [s.name, s]));
  assert.equal(by.gtm.kind, 'plugin', 'a plugin\'s skills are one source');
  assert.equal(by.gtm.scope, 'user');
  assert.equal(by.artemis.used, 4);
  const advice = harnessAdvice(usage);
  const names = advice.map(a => a.name).sort();
  assert.deepEqual(names, ['Claude_Docs', 'gtm', 'mine', 'rea'].map(n => n === 'Claude_Docs' ? 'claude_docs' : n).sort());
  const rea = advice.find(a => a.name === 'rea');
  assert.match(rea.action, /claude mcp remove -s user rea/);
  assert.doesNotMatch(JSON.stringify(advice), /secret-value/, 'an entry\'s env is never printed');
  assert.match(advice.find(a => a.name === 'gtm').action, /"gtm@market": false/);
  assert.equal(advice.some(a => a.name === 'code-review'), false, 'a skill Claude Code builds in has no setting to change');
});

test('sessions written before Claude Code recorded what it loaded are not counted', t => {
  const dir = tmp('thinker-harness-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'old.jsonl'), JSON.stringify(call('Read', { file_path: 'a' })) + '\n');
  const usage = harnessUsage(dir, { home: home(t), sessions: [{ client: 'claude', file: path.join(dir, 'old.jsonl'), session: 'old', mtime: Date.now() }] });
  assert.equal(usage.sessions, 0);
  assert.deepEqual(harnessAdvice(usage), []);
});
