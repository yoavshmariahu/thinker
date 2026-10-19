import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'smol-toml';
import { Store } from '../src/store.js';
import { codexSessionHarness, codexHarnessConfig, editCodexSetting } from '../src/harness-codex.js';
import { harnessUsage, harnessAdvice, switchOffNow, undoHarness, readHarnessState, harnessSavings, scheduleHarnessSuggestion, harnessOffer, harnessRecall } from '../src/harness.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-codex-harness-'))), repo = path.join(root, 'repo'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  const old = process.env.CODEX_HOME; process.env.CODEX_HOME = path.join(home, '.codex');
  t.after(() => { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; fs.rmSync(root, { recursive: true, force: true }); });
  execFileSync('git', ['init', '-q', repo]);
  const store = new Store(repo); store.init();
  const skill = path.join(home, '.agents/skills/writer/SKILL.md'), plugin = path.join(home, '.codex/plugins/cache/local/writing/1/skills/write/SKILL.md');
  for (const f of [skill, plugin]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '# instructions'); }
  fs.writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.docs]\ncommand="false"\n[mcp_servers.used]\ncommand="false"\n[plugins."writing@local"]\nenabled=true\n');
  const catalog = `## Skills\n### Skill roots\n- \`r0\` = \`${path.dirname(skill)}\`\n### Available skills\n- writer: ${'Writes documents. '.repeat(60)} (file: r0/SKILL.md)\n- writing:write: ${'Builds artifacts. '.repeat(60)} (file: ${plugin})\n`;
  const tools = { mcp__docs: 'Search documentation. '.repeat(60), mcp__used: 'Read files. '.repeat(60), mcp__cloud__remote: 'Account connector. '.repeat(60) };
  const session = (id, extra = [], opts = {}) => {
    const file = path.join(root, `${id}.jsonl`);
    const rows = [{ type: 'session_meta', payload: { id, cwd: repo, timestamp: opts.start || '2026-10-01T00:00:00Z', parent_thread_id: opts.parent, thread_source: opts.guardian ? 'guardian' : 'user' } },
      ...(opts.empty ? [] : [{ type: 'world_state', payload: { state: { host_skills: { body: opts.catalog ?? catalog }, tools: opts.tools ?? tools } } }]), ...extra];
    fs.writeFileSync(file, rows.map(j => JSON.stringify(j)).join('\n'));
    return { client: 'codex', session: id, file, mtime: Date.now() };
  };
  const call = (name, input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name, input } });
  return { root, repo, home, store, skill, plugin, catalog, tools, session, call, options: { home: path.join(root, 'thinker'), userHome: home, now: Date.parse('2026-10-10T00:00:00Z') } };
}

test('Codex catalogs count once, and direct, orchestrated and shell skill calls count as use', t => {
  const f = fixture(t), s = f.session('a', [f.call('functions.exec', 'await tools.mcp__used__read({}); await tools.exec_command({cmd: "cat ' + f.skill + '"});'),
    { type: 'response_item', payload: { type: 'function_call', name: 'mcp__cloud__remote__search', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: f.catalog }] } },
    { type: 'token_usage_record', payload: { response_id: 'r' } }, { type: 'token_usage_record', payload: { response_id: 'r' } }]);
  const h = codexSessionHarness(s.file), once = codexSessionHarness(f.session('b').file);
  assert.deepEqual(h.loaded, once.loaded);
  assert.ok(h.used.has('skill:writer')); assert.ok(h.used.has('mcp:used')); assert.ok(h.used.has('mcp:cloud__remote')); assert.ok(!h.used.has('mcp:docs'));
  assert.equal(h.calls, 1);
  const fake = f.session('fake', [{ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: f.catalog }] } }], { empty: true });
  assert.equal(codexSessionHarness(fake.file).loaded.size, 0);
  assert.equal(codexSessionHarness(f.session('guardian', [], { guardian: true }).file).loaded.size, 0);
});

test('Codex recommendations use recorded evidence and only supported switches, including subagent use', t => {
  const f = fixture(t), sessions = [0, 1, 2].map(i => f.session(`s${i}`));
  sessions.push(f.session('child', [f.call('functions.exec', `tools.mcp__docs__read({}); cat ${f.skill}`)], { parent: 's0', empty: true }));
  const usage = harnessUsage(f.repo, { home: f.home, sessions }), by = Object.fromEntries(usage.sources.map(s => [s.name, s]));
  assert.equal(usage.sessions, 3); assert.equal(by.docs.used, 1); assert.equal(by.writer.used, 1);
  assert.ok(harnessAdvice(usage).some(s => s.key === 'codex:mcp:used'));
  assert.ok(!harnessAdvice(usage).some(s => s.name === 'cloud__remote'), 'cloud connector lacks a verified project switch');
  assert.ok(!harnessAdvice(usage).some(s => s.name === 'writing'), 'unknown plugin tool ownership is kept when MCP calls were made');
});

test('Codex local plugin and skill switches preserve unrelated TOML; undo restores the targeted values', t => {
  const f = fixture(t), sessions = [0, 1, 2].map(i => f.session(`s${i}`));
  const usage = harnessUsage(f.repo, { home: f.home, sessions });
  fs.mkdirSync(path.join(f.repo, '.codex')); const local = path.join(f.repo, '.codex/config.toml');
  fs.writeFileSync(local, 'model="keep-me"\n[mcp_servers.docs]\nenabled=true\nargs=["with space"]\n[mcp_servers.docs.env]\nTOKEN="preserve-secret"\n'); fs.chmodSync(local, 0o600);
  const beforeUser = fs.readFileSync(path.join(f.home, '.codex/config.toml'), 'utf8');
  assert.match(switchOffNow(f.store, 'codex:mcp:docs,codex:plugin:writing@local,codex:skill:writer', { ...f.options, usage }), /Switched off/);
  let j = parse(fs.readFileSync(local, 'utf8'));
  assert.equal(j.mcp_servers.docs.enabled, false); assert.equal(j.plugins['writing@local'].enabled, false); assert.equal(j.skills.config[0].enabled, false);
  assert.equal(j.model, 'keep-me'); assert.equal(j.mcp_servers.docs.env.TOKEN, 'preserve-secret'); assert.deepEqual(j.mcp_servers.docs.args, ['with space']);
  assert.equal(fs.statSync(local).mode & 0o777, 0o600); assert.equal(fs.readFileSync(path.join(f.home, '.codex/config.toml'), 'utf8'), beforeUser);
  assert.doesNotMatch(JSON.stringify(readHarnessState(f.store)), /preserve-secret/);
  assert.match(undoHarness(f.store, f.options), /Turned back on/);
  j = parse(fs.readFileSync(local, 'utf8')); assert.equal(j.mcp_servers.docs.enabled, true); assert.equal(j.plugins['writing@local'].enabled, undefined); assert.equal(j.skills.config, undefined);
});

test('Codex undo respects later edits, and invalid TOML and escaping symlinks are left untouched', t => {
  const f = fixture(t), usage = harnessUsage(f.repo, { home: f.home, sessions: [0, 1, 2].map(i => f.session(`s${i}`)) });
  fs.mkdirSync(path.join(f.repo, '.codex')); const local = path.join(f.repo, '.codex/config.toml'); fs.writeFileSync(local, 'invalid = [');
  assert.match(switchOffNow(f.store, 'codex:mcp:docs', { ...f.options, usage }), /Not switched off/); assert.equal(fs.readFileSync(local, 'utf8'), 'invalid = [');
  fs.unlinkSync(local); fs.symlinkSync(path.join(f.home, '.codex/config.toml'), local);
  assert.match(switchOffNow(f.store, 'codex:mcp:docs', { ...f.options, usage }), /outside this checkout/);
  const source = { kind: 'mcp', name: 'docs' };
  assert.equal(parse(editCodexSetting('[mcp_servers.docs]\nenabled=true\n', source, { prev: undefined }).text).mcp_servers.docs.enabled, true);
});

test('Codex savings require comparable inventories and ignore other harnesses and children', t => {
  const f = fixture(t), usage = harnessUsage(f.repo, { home: f.home, sessions: [0, 1, 2].map(i => f.session(`s${i}`)) });
  switchOffNow(f.store, 'codex:mcp:docs', { ...f.options, usage });
  const start = '2026-10-11T00:00:00Z';
  const sessions = [f.session('absent', [{ type: 'token_usage_record', payload: { response_id: 'r' } }], { start, tools: {} }), f.session('still', [], { start }), f.session('unknown', [], { start, empty: true }), f.session('child', [], { start, parent: 'absent', tools: {} })];
  const saved = harnessSavings(f.store, { sessions });
  assert.equal(saved.sources[0].sessions, 2); assert.equal(saved.sources[0].absent, 1); assert.equal(saved.sources[0].stillLoaded, 1); assert.ok(saved.tokens > 0); assert.equal(saved.inputTokens, saved.tokens);
});

test('Codex offers use the available question tool and recall remains opt-in and client scoped', async t => {
  const f = fixture(t), usage = harnessUsage(f.repo, { home: f.home, sessions: [0, 1, 2].map(i => f.session(`s${i}`)) });
  scheduleHarnessSuggestion(f.store, { ...f.options, usage, force: true });
  assert.equal(harnessOffer(f.store, { ...f.options, client: 'claude' }), '');
  const offer = harnessOffer(f.store, { ...f.options, client: 'codex' });
  assert.match(offer, /request_user_input_async/); assert.doesNotMatch(offer, /AskUserQuestion/); assert.match(offer, /--client codex/); assert.match(offer, /Codex: docs MCP server/);
  switchOffNow(f.store, 'codex:mcp:docs', { ...f.options, usage });
  assert.equal(await harnessRecall(f.store, 'search docs documentation', { client: 'codex' }), '');
  fs.writeFileSync(path.join(f.store.dir, 'config.json'), JSON.stringify({ harness: { recall: true } }));
  assert.equal(await harnessRecall(f.store, 'search docs documentation', { client: 'claude', scoreFn: rows => rows }), '');
  const recall = await harnessRecall(f.store, 'search docs documentation', { client: 'codex', scoreFn: rows => rows });
  assert.match(recall, /thinker harness --undo codex:mcp:docs/); assert.doesNotMatch(recall, /\/mcp enable/);
});

test('CODEX_HOME and project overrides are honored; an invalid config layer yields no advice', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.repo, '.codex')); fs.writeFileSync(path.join(f.repo, '.codex/config.toml'), '[mcp_servers.docs]\nenabled=false\n');
  assert.equal(codexHarnessConfig(f.repo, { home: '/unused' }).servers.get('docs').off, true);
  fs.writeFileSync(path.join(f.repo, '.codex/config.toml'), 'invalid = [');
  assert.deepEqual(harnessAdvice(harnessUsage(f.repo, { home: f.home, sessions: [0, 1, 2].map(i => f.session(`s${i}`)) })), []);
});

test('Codex skill overrides preserve inherited disables and restore inheritance on undo', t => {
  const f = fixture(t), user = path.join(f.home, '.codex/config.toml');
  fs.appendFileSync(user, '\n[[skills.config]]\npath="/tmp/other-skill"\nenabled=false\n');
  const usage = harnessUsage(f.repo, { home: f.home, sessions: [0, 1, 2].map(i => f.session(`s${i}`)) });
  switchOffNow(f.store, 'codex:skill:writer', { ...f.options, usage });
  const file = path.join(f.repo, '.codex/config.toml');
  assert.deepEqual(JSON.parse(JSON.stringify(parse(fs.readFileSync(file, 'utf8')).skills.config)), [{ path: '/tmp/other-skill', enabled: false }, { path: path.dirname(f.skill), enabled: false }]);
  undoHarness(f.store, f.options);
  assert.equal(parse(fs.readFileSync(file, 'utf8')).skills.config, undefined);
});

test('local plugin manifests link differently named tools and distinguish skill-only plugins', t => {
  const f = fixture(t), dir = path.resolve(path.dirname(f.plugin), '../..');
  fs.mkdirSync(path.join(dir, '.codex-plugin'));
  fs.writeFileSync(path.join(dir, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'writing', skills: './skills' }));
  let sessions = [0, 1, 2].map(i => f.session(`s${i}`, [f.call('functions.exec', 'tools.mcp__used__read({})')]));
  let usage = harnessUsage(f.repo, { home: f.home, sessions });
  assert.ok(harnessAdvice(usage).some(s => s.name === 'writing'), 'a skill-only plugin does not own unrelated calls');
  fs.writeFileSync(path.join(dir, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'writing', mcpServers: './.mcp.json' }));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { used: { command: 'false' } } }));
  usage = harnessUsage(f.repo, { home: f.home, sessions });
  assert.equal(usage.sources.find(s => s.name === 'writing').used, 3);
  assert.ok(!harnessAdvice(usage).some(s => s.name === 'writing'));
});

test('Claude and Codex sources with the same name remain distinct in switches and savings', t => {
  const f = fixture(t), sessions = [0, 1, 2].map(i => f.session(`s${i}`));
  fs.writeFileSync(path.join(f.home, '.claude.json'), JSON.stringify({ mcpServers: { docs: { command: 'false' } } }));
  for (let i = 0; i < 3; i++) {
    const file = path.join(f.root, `claude${i}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: ['docs'], addedBlocks: ['documentation '.repeat(200)] } }));
    sessions.push({ client: 'claude', file, mtime: Date.now() });
  }
  const usage = harnessUsage(f.repo, { home: f.home, sessions });
  assert.deepEqual(usage.byClient, { claude: 3, codex: 3 });
  assert.equal(harnessAdvice(usage).filter(s => s.name === 'docs').length, 2);
  switchOffNow(f.store, 'codex:mcp:docs', { ...f.options, usage });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.claude.json'), 'utf8')).projects, undefined);
  assert.equal(readHarnessState(f.store).applied.length, 1);
  const later = f.session('later', [], { start: '2026-10-11T00:00:00Z', empty: true });
  fs.appendFileSync(later.file, '\n' + JSON.stringify({ type: 'world_state', full: false, payload: { full: false, state: { tools: {}, host_skills: { body: f.catalog } } } }));
  assert.equal(harnessSavings(f.store, { sessions: [later, ...sessions.filter(s => s.client === 'claude')] }).sources[0].sessions, 0);
});
