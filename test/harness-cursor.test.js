import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { cursorInventory, cursorProjectDir, cursorSessionUse, snapshotCursorInventory, cursorSnapshots } from '../src/harness-cursor.js';
import { harnessUsage, harnessAdvice, switchOffNow, undoHarness, readHarnessState, harnessSavings, scheduleHarnessSuggestion, harnessOffer, answerHarness } from '../src/harness.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-cursor-harness-'))), repo = path.join(root, 'repo'), home = path.join(root, 'home'), tHome = path.join(root, 'thinker');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  const old = process.env.CURSOR_DATA_DIR; process.env.CURSOR_DATA_DIR = path.join(home, '.cursor');
  t.after(() => { if (old === undefined) delete process.env.CURSOR_DATA_DIR; else process.env.CURSOR_DATA_DIR = old; fs.rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q', repo]);
  const store = new Store(repo); store.init();
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ harness: { enabled: true } })); // off until released (harnessOn)
  const mcpJson = path.join(home, '.cursor', 'mcp.json');
  fs.writeFileSync(mcpJson, JSON.stringify({ mcpServers: { docs: { command: 'docs', env: { TOKEN: 'keep-secret' } }, thinker: { command: 'node' } } }, null, 2));
  const project = cursorProjectDir(repo, { home });
  const server = (id, name, words) => {
    const dir = path.join(project, 'mcps', id);
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SERVER_METADATA.json'), JSON.stringify({ serverIdentifier: id, serverName: name }));
    fs.writeFileSync(path.join(dir, 'INSTRUCTIONS.md'), words.repeat(80));
    fs.writeFileSync(path.join(dir, 'tools', 'search.json'), '{}');
  };
  server('user-docs', 'docs', 'Search documentation. '); server('user-thinker', 'thinker', 'Notes about the repo. '); server('cursor-ide-browser', 'cursor-ide-browser', 'Drive a browser tab. ');
  const call = ns => ({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'CallDynamicTool', input: { namespace: ns, toolName: 'x' } }] } });
  const chat = (id, rows = [], at) => {
    const transcript = path.join(project, 'agent-transcripts', id, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, [{ role: 'user', message: { content: [{ type: 'text', text: 'hi' }] } }, ...rows].map(r => JSON.stringify(r)).join('\n'));
    return snapshotCursorInventory({ session: id, roots: [repo], transcript, thinkerHome: tHome, home, now: at ? Date.parse(at) : Date.now() });
  };
  return { root, repo, home, tHome, store, mcpJson, project, server, call, chat, options: { home: tHome, userHome: home, now: Date.parse('2026-10-10T00:00:00Z') } };
}

test('the inventory prices each server by its catalog entry, and the snapshot is taken once per chat', t => {
  const f = fixture(t), inv = cursorInventory(f.project);
  assert.deepEqual(Object.keys(inv).sort(), ['cursor-ide-browser', 'user-docs', 'user-thinker']);
  assert.equal(inv['user-docs'].name, 'docs'); assert.ok(inv['user-docs'].tokens > 100);
  assert.ok(f.chat('a')); assert.equal(f.chat('a'), null);
  assert.equal(snapshotCursorInventory({ session: 'cli', roots: [path.join(f.root, 'elsewhere')], thinkerHome: f.tHome, home: f.home }), null, 'no inventory, no evidence');
  assert.equal(cursorSnapshots(f.tHome).length, 1);
});

test('dynamic tool calls count as use by identifier or bare name; built-ins and thinker are never offered', t => {
  const f = fixture(t);
  f.chat('a', [f.call('user-thinker')]); f.chat('b', [f.call('thinker')]); f.chat('c', [f.call('cursor-ide-browser')]);
  const one = cursorSnapshots(f.tHome).find(s => s.session === 'a');
  assert.ok(cursorSessionUse(one.transcript).has('user-thinker'));
  const usage = harnessUsage(f.repo, { home: f.home, sessions: [], cursor: cursorSnapshots(f.tHome) }), by = Object.fromEntries(usage.sources.map(s => [s.id, s]));
  assert.equal(usage.byClient.cursor, 3);
  assert.equal(by['user-docs'].used, 0); assert.equal(by['user-thinker'].used, 2); assert.equal(by['user-docs'].scope, 'machine');
  const advice = harnessAdvice(usage);
  assert.deepEqual(advice.map(s => s.key), ['cursor:mcp:user-docs']);
  assert.match(advice[0].action, /every repository/);
});

test('switching off takes the entry out of ~/.cursor/mcp.json, keeps it out of thinker state, and undo puts it back', t => {
  const f = fixture(t);
  for (const id of ['a', 'b', 'c']) f.chat(id, [], '2026-10-01T00:00:00Z');
  const usage = harnessUsage(f.repo, { home: f.home, sessions: [], cursor: cursorSnapshots(f.tHome, { now: Date.parse('2026-10-02T00:00:00Z') }) });
  assert.match(switchOffNow(f.store, 'Cursor: docs MCP server', { ...f.options, usage }), /every repository/);
  let j = JSON.parse(fs.readFileSync(f.mcpJson, 'utf8'));
  assert.equal(j.mcpServers.docs, undefined); assert.ok(j.mcpServers.thinker);
  assert.doesNotMatch(JSON.stringify(readHarnessState(f.store)), /keep-secret/);
  const stash = path.join(f.tHome, 'state', 'cursor-mcp-off.json');
  assert.equal(fs.statSync(stash).mode & 0o777, 0o600);
  assert.match(undoHarness(f.store, f.options), /Turned back on/);
  j = JSON.parse(fs.readFileSync(f.mcpJson, 'utf8'));
  assert.equal(j.mcpServers.docs.env.TOKEN, 'keep-secret');
  assert.deepEqual(JSON.parse(fs.readFileSync(stash, 'utf8')), {});
});

test('savings count the chats since whose inventory no longer holds the server, and only those', t => {
  const f = fixture(t);
  for (const id of ['a', 'b', 'c']) f.chat(id, [], '2026-10-01T00:00:00Z');
  const usage = harnessUsage(f.repo, { home: f.home, sessions: [], cursor: cursorSnapshots(f.tHome, { now: Date.parse('2026-10-02T00:00:00Z') }) });
  switchOffNow(f.store, 'Cursor: docs MCP server', { ...f.options, usage });
  f.chat('still', [], '2026-10-11T00:00:00Z');
  fs.rmSync(path.join(f.project, 'mcps', 'user-docs'), { recursive: true });
  f.chat('gone', [], '2026-10-11T00:00:00Z');
  const saved = harnessSavings(f.store, { sessions: [], cursor: cursorSnapshots(f.tHome, { sinceMs: 1e12 }) });
  const s = saved.sources[0];
  assert.equal(s.sessions, 2); assert.equal(s.absent, 1); assert.equal(s.stillLoaded, 1); assert.equal(s.tokens, s.tokensPerSession); assert.equal(s.inputTokens, 0);
});

test('a Cursor prompt asks through AskQuestion, and the answer accepts the label with its counts', t => {
  const f = fixture(t);
  for (const id of ['a', 'b', 'c']) f.chat(id, [], '2026-10-01T00:00:00Z');
  const usage = harnessUsage(f.repo, { home: f.home, sessions: [], cursor: cursorSnapshots(f.tHome, { now: Date.parse('2026-10-02T00:00:00Z') }) });
  scheduleHarnessSuggestion(f.store, { ...f.options, usage, force: true });
  const offer = harnessOffer(f.store, { ...f.options, client: 'cursor' });
  assert.match(offer, /AskQuestion/); assert.doesNotMatch(offer, /AskUserQuestion/); assert.match(offer, /--client cursor/); assert.match(offer, /Cursor: docs MCP server/); assert.match(offer, /every repository/);
  assert.match(answerHarness(f.store, 'Cursor: docs MCP server (~1k tokens a chat used in 0 of 3)', { ...f.options, client: 'cursor' }), /Switched off/);
  assert.equal(JSON.parse(fs.readFileSync(f.mcpJson, 'utf8')).mcpServers.docs, undefined);
});
