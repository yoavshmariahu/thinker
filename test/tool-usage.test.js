import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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

// find and drilldown are off unless the repository turned them on (cache-guidance.js:disabledTools).
const enableCodeTools = store => fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), disabledTools: [] }));

test('with the code tools off, as shipped, the bundle comes without an intro and names neither tool', () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'rule', answers: ['how are rows fetched', 'where does fetchRows read the rows from'], body: 'src/a.js:fetchRows reads the rows table; nothing else may', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  const first = hook(dir, 'prompt', { session_id: 'off1', prompt: 'where does fetchRows read the rows from' });
  assert.ok(first.startsWith('<thinker-cache>'), 'no tool intro');
  assert.match(first, /fetchRows reads the rows table/);
  assert.doesNotMatch(first, /<thinker-tools>|\bfind\b|\bdrilldown\b/);
  assert.equal(logOps(dir).filter(op => op === 'intro').length, 0);
  // one tool on: it alone is introduced
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), disabledTools: ['find'] }));
  const one = hook(dir, 'prompt', { session_id: 'off2', prompt: 'where does fetchRows read the rows from' });
  assert.match(one, /<thinker-tools>[\s\S]*drilldown \(a definition whole/);
  assert.doesNotMatch(one, /\bfind\b/);
  assert.match(one, /ToolSearch `select:mcp__thinker__drilldown`/);
});

// In two weeks of real sessions `find` was called 3 times over MCP: agents grepped instead. Claude Code
// defers MCP tools until they are searched for, so the first bundle of a session names the tools and
// the search, once. A session the cache serves nothing gets no intro either (the Click canary of
// 2026-10-07: the intro and the workflow text were the whole cost of a session the notes did not help).
// It does not tell the agent to run a review: that is done when asked for.
test('the first served bundle of a session introduces find and drilldown, with the ToolSearch that loads them in Claude Code; once; never alone', () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  enableCodeTools(store);
  // an empty cache: nothing to orient on, nothing is said
  const empty = hook(dir, 'prompt', { session_id: 's0', prompt: 'where does fetchRows read the rows from' });
  assert.equal(empty.trim(), '', 'an empty cache injects nothing, not even the intro');
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'rule', answers: ['how are rows fetched', 'where does fetchRows read the rows from'], body: 'src/a.js:fetchRows reads the rows table; nothing else may', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  // a note for the request: the intro opens the bundle
  const first = hook(dir, 'prompt', { session_id: 's1', prompt: 'where does fetchRows read the rows from' });
  assert.match(first, /<thinker-tools>[\s\S]*<thinker-cache>/);
  assert.match(first, /find \(the definitions carrying the words the code would use/);
  assert.match(first, /ToolSearch `select:mcp__thinker__find,mcp__thinker__drilldown`/);
  assert.ok(!/review/i.test(first), 'review is not named: it is run when asked for');
  // nothing for the follow-up: nothing is said, the intro included
  const second = hook(dir, 'prompt', { session_id: 's1', prompt: 'now change saveRows as well' });
  assert.equal(second.trim(), '', 'said once per session, and never without a note');
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
  enableCodeTools(store);
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

// What the server offers and says, asked over its own protocol.
function serverSays(dir) {
  const msg = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  const r = spawnSync(process.execPath, [new URL('../src/mcp.js', import.meta.url).pathname], {
    env: { ...env, THINKER_REPO: dir, THINKER_TELEMETRY: 'off' }, encoding: 'utf8', timeout: 30_000,
    input: msg(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } })
      + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + msg(2, 'tools/list'),
  });
  const replies = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { instructions: replies.find(m => m.id === 1).result.instructions, tools: replies.find(m => m.id === 2).result.tools };
}

test('the server neither offers nor mentions a code tool that is off; thinker tools turns them on', () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  const off = serverSays(dir);
  assert.deepEqual(off.tools.map(t => t.name).filter(n => ['orient', 'lookup', 'find', 'drilldown'].includes(n)), ['orient', 'lookup']);
  // no instruction and no tool description sends the agent to a tool that is not there
  assert.doesNotMatch(off.instructions, /\bfind\b|\bdrilldown\b/);
  // ("find the code that upholds the rule" in a description is the verb, not the tool)
  for (const t of off.tools) assert.doesNotMatch(t.description, /drilldown|`find`|\bfind (lists|takes|for code)|(call|use|with) find\b|thinker__find/, `${t.name} names a tool that is off`);

  const cli = (...args) => execFileSync('node', [CLI, ...args, '--repo', dir], { encoding: 'utf8', env });
  assert.match(cli('tools'), /find: off\ndrilldown: off/);
  assert.match(cli('tools', 'enable', 'find', 'drilldown'), /find: on\ndrilldown: on/);
  assert.deepEqual(store.config().disabledTools, []);
  const on = serverSays(dir);
  assert.ok(['find', 'drilldown'].every(n => on.tools.some(t => t.name === n)));
  assert.match(on.instructions, /drilldown for a note's file:symbol pointers, find for code no note maps/);
  assert.match(cli('tools', 'disable', 'find'), /find: off\ndrilldown: on/);
  assert.deepEqual(serverSays(dir).tools.map(t => t.name).filter(n => ['find', 'drilldown'].includes(n)), ['drilldown']);
});
