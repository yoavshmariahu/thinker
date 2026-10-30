import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { switchOffNow, undoHarness, setHarnessSettings, readHarnessState, claudeHarnessConfig } from '../src/harness.js';
import { readScopedState, writeScopedState } from '../src/scoped-state.js';
import { recordReviewed, changeHistory, revertDecision } from '../src/context-suggest.js';
import { createUiServer } from '../src/ui/server.js';
import { codexHarnessConfig } from '../src/harness-codex.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-machine-tools-'));
  const home = path.join(root, 'home'), th = path.join(root, 'thinker');
  fs.mkdirSync(home, { recursive: true });
  const before = { THINKER_HOME: process.env.THINKER_HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.THINKER_HOME = th; process.env.CODEX_HOME = path.join(home, '.codex');
  t.after(() => { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; fs.rmSync(root, { recursive: true, force: true }); });
  const stores = ['one', 'two'].map(name => {
    const repo = path.join(root, name); fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const st = new Store(repo).init(); setHarnessSettings(st, { enabled: true, builtinTools: true }); return st;
  });
  return { root, home, th, stores };
}
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const source = (kind, name, more = {}) => ({ client: 'claude', kind, key: `${kind}:${name}`, name, scope: kind === 'tool' ? 'builtin' : 'user', tokens: 1000, loaded: 10, used: 0, ...more });
const usage = (...sources) => ({ sources, builtinTools: true });

test('tool switches use user settings, are visible in another repository, and undo preserves unrelated settings', t => {
  const { home, th, stores: [a, b] } = fixture(t), settings = path.join(home, '.claude/settings.json');
  write(settings, { permissions: { deny: ['Read(.env)'] }, env: { KEEP: 'yes' } });
  write(path.join(home, '.claude.json'), { mcpServers: { docs: { command: 'docs', env: { TOKEN: 'kept' } } } });
  const opts = { home: th, userHome: home, global: true, any: true, usage: usage(source('tool', 'Workflow'), source('mcp', 'docs')) };
  assert.match(switchOffNow(a, 'Workflow tool,docs MCP server', opts), /every repository/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)).permissions.deny, ['Read(.env)', 'Workflow', 'mcp__docs__*']);
  assert.equal(fs.existsSync(path.join(a.repo, '.claude/settings.local.json')), false);
  assert.equal(claudeHarnessConfig(b.repo, { home, managedFile: null }).denied.has('Workflow'), true);
  assert.equal(claudeHarnessConfig(b.repo, { home, managedFile: null }).servers.get('docs').off, true);
  assert.equal(readHarnessState(b).applied.length, 2);
  switchOffNow(b, 'Workflow tool,docs MCP server', opts);
  assert.equal(readHarnessState(a).applied.length, 2, 'repeat does not replace the original undo');
  assert.match(undoHarness(b, { home: th, userHome: home, names: ['tool:Workflow', 'mcp:docs'] }), /Turned back on/);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), { permissions: { deny: ['Read(.env)'] }, env: { KEEP: 'yes' } });
  assert.equal(readHarnessState(a).applied?.length || 0, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'))).mcpServers.docs.env.TOKEN, 'kept');
});

test('Codex machine tool switch and undo use the same user config from another repository', t => {
  const { home, th, stores: [a, b] } = fixture(t), config = path.join(home, '.codex/config.toml');
  write(config, '[mcp_servers.docs]\ncommand = "docs"\nenabled = true\n');
  const s = source('mcp', 'docs', { client: 'codex', key: 'codex:mcp:docs', how: 'codex-mcp' });
  assert.match(switchOffNow(a, s.key, { home: th, userHome: home, global: true, any: true, usage: usage(s) }), /Switched off/);
  assert.equal(codexHarnessConfig(b.repo, { home }).servers.get('docs').off, true);
  assert.equal(fs.existsSync(path.join(a.repo, '.codex/config.toml')), false);
  assert.match(undoHarness(b, { home: th, userHome: home, names: [s.key] }), /Turned back on/);
  assert.equal(codexHarnessConfig(a.repo, { home }).servers.get('docs').off, false);
  assert.match(fs.readFileSync(config, 'utf8'), /command = "docs"/);
});

test('shared state preserves another repository action when an older reader saves', t => {
  const { stores: [a, b] } = fixture(t);
  const f = st => path.join(st.dir, 'state/test.json');
  const x = readScopedState(f(a), 'history'), y = readScopedState(f(b), 'history');
  x.history = [{ id: 'a', scope: 'machine', value: 1 }]; writeScopedState(f(a), 'history', x);
  y.history = [{ id: 'b', scope: 'machine', value: 2 }]; writeScopedState(f(b), 'history', y);
  assert.equal(readScopedState(f(a), 'history').history.length, 2);
  const older = readScopedState(f(a), 'history'), newer = readScopedState(f(b), 'history');
  newer.history[1].value = 3; writeScopedState(f(b), 'history', newer);
  older.history[0].value = 4; writeScopedState(f(a), 'history', older);
  assert.deepEqual(readScopedState(f(a), 'history').history.map(x => x.value), [4, 3]);
});

test('machine tool history appears once across repositories and can be reverted from either', async t => {
  const { home, th, stores: [a, b] } = fixture(t);
  // The undo record is deliberately machine scoped; reverting from b must find both it and the switch.
  switchOffNow(a, 'Workflow tool', { home: th, userHome: home, global: true, any: true, usage: usage(source('tool', 'Workflow')) });
  recordReviewed(a, { scope: 'machine', kind: 'tool', key: 'claude:tool:Workflow', title: 'Workflow', default: { act: 'off' } }, 'Switched off across all repositories', { undo: { kind: 'off', key: 'tool:Workflow' } });
  assert.equal(changeHistory(b).length, 1);
  const entry = changeHistory(b)[0];
  // Use a kept inventory of both repositories so this also checks the API's deduplication.
  write(path.join(th, 'state/machine-checkouts.json'), { at: Date.now(), transcripts: home, checkouts: [a.repo, b.repo] });
  const server = createUiServer(a, { home: th, transcriptsHome: home, refreshFn() {}, refreshReportFn() {}, refreshReposFn() {} });
  const { port } = await server.listen(0);
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${port}/api/activity?repo=all`);
  const data = await res.json();
  assert.equal(data.history.length, 1); assert.equal(data.history[0].scope, 'machine');
  assert.match((await revertDecision(b, entry.id)).said, /turned back on/);
  assert.ok(changeHistory(a)[0].revertedAt);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'))).permissions.deny.includes('Workflow'), false);
});

test('a project-only Codex server produces a valid disabled user entry and undo removes the inherited entry', t => {
  const { home, th, stores: [a, b] } = fixture(t), local = path.join(a.repo, '.codex/config.toml'), user = path.join(home, '.codex/config.toml');
  write(local, '[mcp_servers.docs]\ncommand = "docs"\nargs = ["--stdio"]\nenabled = true\n[mcp_servers.docs.env]\nTOKEN = "keep-private"\n');
  const s = source('mcp', 'docs', { client: 'codex', key: 'codex:mcp:docs', scope: 'project', how: 'codex-mcp' });
  assert.match(switchOffNow(a, s.key, { home: th, userHome: home, global: true, any: true, usage: usage(s) }), /Switched off/);
  assert.equal(codexHarnessConfig(b.repo, { home }).servers.get('docs').off, true);
  assert.equal(codexHarnessConfig(a.repo, { home }).servers.get('docs').off, true, 'project enabled=true cannot defeat the machine switch');
  assert.match(fs.readFileSync(user, 'utf8'), /command = "docs"/);
  assert.doesNotMatch(JSON.stringify(readHarnessState(a)), /keep-private/, 'undo state never copies server credentials');
  assert.match(undoHarness(b, { home: th, userHome: home, names: [s.key] }), /Turned back on/);
  assert.equal(codexHarnessConfig(b.repo, { home }).servers.has('docs'), false);
  assert.match(fs.readFileSync(local, 'utf8'), /keep-private/);
});
