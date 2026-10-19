import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { createNote, SERVE_MIN_NOTES } from '../src/ops.js';

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
// the hooks serve from a cache once it holds SERVE_MIN_NOTES (ops.js); these caches hold one note
const serveFromOne = store => fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), minNotes: 1 }));

test('with the code tools off, as shipped, the bundle comes without an intro and names neither tool', () => {
  const dir = gitRepo(); const store = new Store(dir).init(); serveFromOne(store);
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'rule', answers: ['how are rows fetched', 'where does fetchRows read the rows from'], body: 'src/a.js:fetchRows reads the rows table; nothing else may', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  const first = hook(dir, 'prompt', { session_id: 'off1', prompt: 'where does fetchRows read the rows from' });
  assert.ok(first.startsWith('<thinker-cache>'), 'no tool intro');
  assert.match(first, /fetchRows reads the rows table/);
  assert.doesNotMatch(first, /<thinker-tools>|\bfind\b|\bdrilldown\b/);
  assert.equal(logOps(dir).filter(op => op === 'intro').length, 0);
  // one tool on: it alone is introduced
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), disabledTools: ['find'] }));
  const one = hook(dir, 'prompt', { session_id: 'off2', prompt: 'where does fetchRows read the rows from' });
  assert.match(one, /<thinker-tools>[\s\S]*drilldown \(definitions whole, line-numbered/);
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
  enableCodeTools(store); serveFromOne(store);
  // an empty cache: nothing to orient on, so no notes and no intro; with find on, only the code the request names
  const empty = hook(dir, 'prompt', { session_id: 's0', prompt: 'where does fetchRows read the rows from' });
  assert.doesNotMatch(empty, /thinker-cache|thinker-tools/, 'an empty cache injects no notes and no intro');
  assert.match(empty, /^<thinker-code>[\s\S]*src\/a\.js:fetchRows/);
  assert.equal(hook(dir, 'prompt', { session_id: 's0b', prompt: 'where are the rows read from' }).trim(), '', 'naming no definition, it injects nothing');
  createNote(store, { title: 'fetchRows reads the rows table', kind: 'rule', answers: ['how are rows fetched', 'where does fetchRows read the rows from'], body: 'src/a.js:fetchRows reads the rows table; nothing else may', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  // a note for the request: the intro opens the bundle
  const first = hook(dir, 'prompt', { session_id: 's1', prompt: 'where does fetchRows read the rows from' });
  assert.match(first, /<thinker-tools>[\s\S]*<thinker-cache>/);
  assert.match(first, /find \(where code is defined, by the words it would use/);
  assert.match(first, /they do not replace one batched search/);
  assert.doesNotMatch(first, /before the first grep|instead of grepping/);
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
  enableCodeTools(store); serveFromOne(store);
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
function serverSays(dir, ...args) {
  const msg = (id, method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  const r = spawnSync(process.execPath, [new URL('../src/mcp.js', import.meta.url).pathname, ...args], {
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
  assert.deepEqual(off.tools.map(t => t.name).filter(n => ['orient', 'lookup', 'find', 'drilldown'].includes(n)), ['lookup']);
  // no instruction and no tool description sends the agent to a tool that is not there
  assert.doesNotMatch(off.instructions, /\bfind\b|\bdrilldown\b|\borient\b/);
  for (const t of off.tools) assert.doesNotMatch(t.description, /\borient\b/, `${t.name} names orient, which is off`);
  // ("find the code that upholds the rule" in a description is the verb, not the tool)
  for (const t of off.tools) assert.doesNotMatch(t.description, /drilldown|`find`|\bfind (lists|takes|for code)|(call|use|with) find\b|thinker__find/, `${t.name} names a tool that is off`);

  const cli = (...args) => execFileSync('node', [CLI, ...args, '--repo', dir], { encoding: 'utf8', env });
  assert.match(cli('tools'), /orient: off\nfind: off\ndrilldown: off/);
  assert.match(cli('tools', 'enable', 'find', 'drilldown'), /find: on\ndrilldown: on/);
  assert.deepEqual(store.config().disabledTools, []);
  const on = serverSays(dir);
  assert.ok(['find', 'drilldown'].every(n => on.tools.some(t => t.name === n)));
  assert.match(on.instructions, /find when you do not know where the code is; drilldown when you need a definition whole/);
  assert.match(cli('tools', 'disable', 'find'), /find: off\ndrilldown: on/);
  assert.deepEqual(serverSays(dir).tools.map(t => t.name).filter(n => ['find', 'drilldown'].includes(n)), ['drilldown']);
  // orient is off by default and switches the same way, kept as enabledTools beside the code tools' list
  assert.match(cli('tools'), /orient: off/);
  assert.match(cli('tools', 'enable', 'orient'), /orient: on\nfind: off\ndrilldown: on/);
  assert.deepEqual(store.config().enabledTools, ['orient']);
  assert.deepEqual(store.config().disabledTools, ['find']);
  const withOrient = serverSays(dir);
  assert.ok(withOrient.tools.some(t => t.name === 'orient'));
  assert.match(withOrient.instructions, /Call orient once with the task/);
  assert.match(cli('tools', 'disable', 'orient'), /orient: off/);
  assert.equal(store.config().enabledTools, undefined);
  assert.ok(!serverSays(dir).tools.some(t => t.name === 'orient'));
  // a list written by 0.1.65, which could switch orient but never wrote enabledTools, does not keep it on
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), disabledTools: [] }));
  assert.match(cli('tools'), /orient: off\nfind: on\ndrilldown: on/);
  // an experiment arm names its tools in the server's own command: `thinker mcp --enable orient` (mcp-server.js:toolsOff)
  const armed = serverSays(dir, 'mcp', '--enable', 'orient');
  assert.ok(armed.tools.some(t => t.name === 'orient'));
  assert.match(armed.instructions, /Call orient once with the task/);
  assert.match(cli('tools'), /orient: off/, 'the checkout is left as it was');
});

// Every git repository has a cache (cli.js, hooks.js: store.init on first use), empty until it learns.
// A prompt the empty cache has nothing for says nothing, as before, and is logged as a request all the
// same: the telemetry's active devices and `thinker usage` read requests, and on 2026-10-12 seven of
// eight reporting devices read as idle while their agents ran thinker on every prompt.
test('a prompt in a repository whose cache is empty says nothing and logs the request', () => {
  const dir = gitRepo();
  assert.ok(!fs.existsSync(path.join(dir, '.thinker')));
  const outp = hook(dir, 'prompt', { session_id: 'e1', prompt: 'where does fetchRows read the rows from' });
  assert.equal(outp.trim(), '', 'an empty cache injects nothing');
  assert.ok(fs.existsSync(path.join(dir, '.thinker')), 'the cache is started on first use');
  const orients = fs.readFileSync(path.join(dir, '.thinker/log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === 'orient');
  assert.equal(orients.length, 1);
  assert.deepEqual(orients[0].served, []);
  assert.equal(orients[0].empty, 'too-few-notes');
  assert.equal(orients[0].session, 'e1');
  assert.equal(orients[0].client, 'claude');
  // the request counts in the usage summary, unanswered
  const u = execFileSync('node', [CLI, 'usage', '--json', '--repo', dir], { encoding: 'utf8', env });
  const j = JSON.parse(u);
  assert.equal(j.requests, 1); assert.equal(j.answered, 0);
});

// A harness event (a background task's notification, a subagent's hand-back) is no request in a young cache
// either: until 2026-10-19 the hook logged it as one before it checked, whenever the cache was under its threshold.
test('a harness event in a cache under the serving threshold is logged as no request', () => {
  const dir = gitRepo();
  hook(dir, 'prompt', { session_id: 'h1', prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>' });
  hook(dir, 'prompt', { session_id: 'h1', prompt: '<agent-message from="a7">\n[Subagent hand-back] done' });
  hook(dir, 'prompt', { session_id: 'h1', prompt: 'where does fetchRows read the rows from' });
  const orients = fs.readFileSync(path.join(dir, '.thinker/log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === 'orient');
  assert.deepEqual(orients.map(e => e.task), ['where does fetchRows read the rows from']);
});

// The hooks serve from a cache once it holds a few notes (ops.js:SERVE_MIN_NOTES; `minNotes` in the
// repository's config overrides): one or two are not yet a map of the repository, and a cache that
// young is treated as the empty one above, by the prompt hook and by the late notes alike.
test('a cache under the serving threshold is served by neither hook, and the threshold is the repository\'s to set', () => {
  const dir = gitRepo(); const store = new Store(dir).init();
  // two notes on other topics first, then the one the prompt asks about
  createNote(store, { title: 'Exports are written as CSV with a header row', kind: 'rule', answers: ['export format'], body: 'src/a.js:fetchRows feeds the CSV export', deps: [{ path: 'src/a.js' }] });
  createNote(store, { title: 'Config is read from the environment once', kind: 'rule', answers: ['where config comes from'], body: 'src/a.js: config is read once at start', deps: [{ path: 'src/a.js' }] });
  const note = () => createNote(store, { title: 'fetchRows reads the rows table', kind: 'rule', answers: ['how are rows fetched', 'where does fetchRows read the rows from'], body: 'src/a.js:fetchRows reads the rows table; nothing else may', deps: [{ path: 'src/a.js', symbol: 'fetchRows' }] });
  assert.equal(store.list().length, 2);
  assert.equal(SERVE_MIN_NOTES, 3);
  assert.equal(hook(dir, 'prompt', { session_id: 'u1', prompt: 'where does fetchRows read the rows from' }).trim(), '', 'two notes: nothing served');
  assert.equal(hook(dir, 'tool', { session_id: 'u1', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src/a.js') }, tool_response: 'x' }).trim(), '', 'no late notes either');
  const orients = fs.readFileSync(path.join(dir, '.thinker/log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.op === 'orient');
  assert.equal(orients.length, 1); assert.equal(orients[0].empty, 'too-few-notes');
  note();
  assert.match(hook(dir, 'prompt', { session_id: 'u2', prompt: 'where does fetchRows read the rows from' }), /<thinker-cache>/, 'three notes: served');
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ ...store.config(), minNotes: 10 }));
  assert.equal(hook(dir, 'prompt', { session_id: 'u3', prompt: 'where does fetchRows read the rows from' }).trim(), '', 'the repository raised the threshold');
});

test('with find on, the prompt hook hands over the definitions the request names, notes or none; off, as shipped, nothing', () => {
  const dir = gitRepo();
  // a Python class: the regex definition search finds `def` members (a JS method has no keyword to find it by)
  fs.writeFileSync(path.join(dir, 'src/b.py'), 'class RowStore:\n    def row_count(self):\n        return 2\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'b');
  const store = new Store(dir).init();
  const ask = prompt => hook(dir, 'prompt', { prompt, session_id: 's-' + Math.random(), hook_event_name: 'UserPromptSubmit' }, '--client', 'claude');
  // off by default: an empty cache says nothing, as before
  assert.doesNotMatch(ask('why does fetchRows return 1?'), /thinker-code/);
  enableCodeTools(store);
  const out = ask('why does fetchRows return 1, and what does RowStore.row_count count?');
  assert.match(out, /<thinker-code>[\s\S]*src\/a\.js:fetchRows \(L1–L3[\s\S]*1  export function fetchRows\(\) \{/, 'an empty cache still hands over the code');
  assert.match(out, /src\/b\.py:RowStore\.row_count \(L2–L3/, 'Class.member resolves to the member');
  assert.doesNotMatch(ask('make the rows load faster'), /thinker-code/, 'no identifier named: nothing');
  assert.ok(logOps(dir).includes('code'), 'what was handed over is logged');
});
