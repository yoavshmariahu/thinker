import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-tools-')));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows() {\n  return 1;\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const env = { ...process.env, THINKER_LOG: 'local', THINKER_HOLDOUT: 'off', THINKER_NO_BG_VERIFY: '1', THINKER_NO_LEARN: '1', THINKER_CE: 'off' };
const hook = (dir, kind, input, ...flags) => execFileSync('node', [CLI, 'hook', kind, '--repo', dir, ...flags], { input: JSON.stringify(input), encoding: 'utf8', env });
const logOps = dir => fs.readFileSync(path.join(dir, '.thinker/log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).op);

// In two weeks of real sessions `find` was called 3 times over MCP: agents grepped instead. Claude Code
// defers MCP tools until they are searched for, so the first prompt of a session names the tools and
// the search, once. It does not tell the agent to run a review: that is done when asked for.
test('the first prompt of a session introduces find and drilldown, with the ToolSearch that loads them in Claude Code; once', () => {
  const dir = gitRepo(); new Store(dir).init();
  // an empty cache: nothing to orient on, the tools still work
  const first = hook(dir, 'prompt', { session_id: 's1', prompt: 'where does fetchRows read the rows from' });
  assert.match(first, /<thinker-tools>/);
  assert.match(first, /find \(the definitions carrying the words the code would use/);
  assert.match(first, /ToolSearch `select:mcp__thinker__find,mcp__thinker__drilldown`/);
  assert.ok(!/review/i.test(first), 'review is not named: it is run when asked for');
  const second = hook(dir, 'prompt', { session_id: 's1', prompt: 'now change saveRows as well' });
  assert.equal(second.trim(), '', 'said once per session');
  const other = hook(dir, 'prompt', { session_id: 's2', prompt: 'where does fetchRows read the rows from' });
  assert.match(other, /<thinker-tools>/);
  // Codex is not told to search for its tools
  const codex = hook(dir, 'prompt', { session_id: 's3', prompt: 'where does fetchRows read the rows from' }, '--client', 'codex');
  assert.match(codex, /<thinker-tools>/);
  assert.ok(!codex.includes('ToolSearch'), 'Codex offers its MCP tools directly');
  assert.equal(logOps(dir).filter(op => op === 'intro').length, 3);
});

test('with notes served, the intro comes with the bundle; an edit brings late notes and no review nudge', () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'rule', answers: ['how are rows fetched', 'where does fetchRows read the rows from'], body: 'src/a.js:fetchRows reads the rows table; nothing else may', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  const prompt = hook(dir, 'prompt', { session_id: 'e1', prompt: 'where does fetchRows read the rows from' });
  assert.match(prompt, /<thinker-tools>[\s\S]*<thinker-cache>/);
  assert.match(prompt, /fetchRows reads the rows table/);
  const read = hook(dir, 'tool', { session_id: 'e1', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  assert.ok(!read.includes('<thinker-review>'), 'reading is not editing');
  const edit = hook(dir, 'tool', { session_id: 'e1', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'src/a.js') } });
  assert.ok(!edit.includes('<thinker-review>'), 'no review nudge: a review runs when asked for');
  assert.equal(logOps(dir).filter(op => op === 'review-nudge').length, 0);
});
