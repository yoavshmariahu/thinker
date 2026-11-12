import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orcaConfigHomes, orcaDataDirs } from '../src/orca.js';
import { installClient, uninstallWiring, refreshWiring, trustCodexUser } from '../src/clients.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const MCP = path.join(path.dirname(CLI), 'mcp.js');
const entry = { command: 'node', args: [MCP], env: { THINKER_MCP_LAUNCHER: '1' } };
const tmp = name => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `thinker-${name}-`)));
const inEnv = (env, fn) => {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === '') delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } }
};
// A machine with Orca and two managed accounts: one Claude, one Codex. The Claude account is both in
// Orca's own record of the directories it has started the agent with and under claude-profiles; the
// Codex account keeps the agent's files one level down, as Orca does where it sets HOME as well.
function machine() {
  const home = tmp('orca-home'), data = tmp('orca-data');
  const claudeAccount = path.join(data, 'claude-profiles', 'work');
  const codexAccount = path.join(data, 'codex-accounts', 'work', 'home');
  for (const d of [path.join(home, '.claude'), path.join(home, '.codex'), claudeAccount, codexAccount, path.join(data, 'claude-profiles', 'selected-host')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, 'claude-observed-config-dirs.json'), JSON.stringify([path.join(home, '.claude'), claudeAccount]));
  // each home has settings of its own, which must come back untouched when thinker is uninstalled
  for (const d of [path.join(home, '.claude'), claudeAccount]) fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ model: 'opus' }));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');
  fs.writeFileSync(path.join(codexAccount, 'config.toml'), 'model = "gpt-5"\n');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: path.join(home, '.codex'), THINKER_ORCA_HOME: data, THINKER_HOME: tmp('orca-thinker') };
  return { home, data, claudeAccount, codexAccount, env };
}
const hooksOf = file => (JSON.parse(fs.readFileSync(file, 'utf8')).hooks) || {};
const thinkerIn = h => Object.values(h).flat().flatMap(g => g.hooks || [g]).filter(x => String(x.command || '').includes(CLI));

test('Orca\'s managed account homes are found, and nothing else is', () => {
  const m = machine();
  inEnv(m.env, () => {
    // the agent's own directory is not one of them, nor is Orca's pointer at the active account
    assert.deepEqual(orcaConfigHomes('claude'), [m.claudeAccount]);
    assert.deepEqual(orcaConfigHomes('codex'), [m.codexAccount]);
    // a client Orca keeps no account home for, and a machine with no Orca at all
    assert.deepEqual(orcaConfigHomes('cursor'), []);
    assert.deepEqual(orcaConfigHomes('claude', { env: { ...m.env, THINKER_ORCA_HOME: tmp('orca-none') } }), []);
  });
  // real machine state is never read under test unless the test names the directory itself
  assert.deepEqual(orcaDataDirs({ env: { THINKER_TEST: '1' } }), []);
  assert.ok(orcaDataDirs({ env: {}, platform: 'darwin', home: '/h' }).includes('/h/Library/Application Support/Orca'));
});

test('connect wires every Orca managed account home as it wires the agent\'s own, and uninstall takes them back out', () => {
  const m = machine();
  inEnv(m.env, () => {
    const o = { scope: 'user', cli: CLI, mcpEntry: entry, hooks: true, learn: true, late: true, mcp: true };
    const lines = [...installClient('claude', o), ...installClient('codex', o)];
    assert.ok(lines.some(l => l.includes(m.claudeAccount)), `the account home is named: ${lines.join('\n')}`);

    const own = path.join(m.home, '.claude', 'settings.json'), account = path.join(m.claudeAccount, 'settings.json');
    assert.ok(thinkerIn(hooksOf(own)).length, 'the agent\'s own home is wired');
    assert.deepEqual(Object.keys(hooksOf(account)).sort(), Object.keys(hooksOf(own)).sort(), 'the account home gets the same events');
    assert.ok(thinkerIn(hooksOf(account)).every(h => h.command.includes('--user')), 'as user-scope hooks');
    // the account's MCP registration belongs to the account's own directory, never to ~/.claude.json
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(m.claudeAccount, '.claude.json'), 'utf8')).mcpServers.thinker, entry);
    assert.ok(!fs.existsSync(path.join(m.claudeAccount, '..', '.claude.json')));
    assert.ok(thinkerIn(hooksOf(path.join(m.codexAccount, 'hooks.json'))).length, 'the Codex account home is wired');
    assert.match(fs.readFileSync(path.join(m.codexAccount, 'config.toml'), 'utf8'), /\[mcp_servers\.thinker\]/);
    // Codex keeps a hook's review mark in the config of the home that reads it, keyed on that home's
    // hooks file: without one in the account's own config, Codex would ask for a review there.
    trustCodexUser();
    const marked = f => (fs.readFileSync(f, 'utf8').match(/\[hooks\.state\./g) || []).length;
    assert.ok(marked(path.join(m.codexAccount, 'config.toml')) > 0, 'the account home has review marks of its own');
    assert.ok(fs.readFileSync(path.join(m.codexAccount, 'config.toml'), 'utf8').includes(fs.realpathSync(path.join(m.codexAccount, 'hooks.json'))), 'keyed on its own hooks file');
    assert.equal(marked(path.join(m.home, '.codex', 'config.toml')), marked(path.join(m.codexAccount, 'config.toml')), 'as many as the agent\'s own home');

    // a second pass changes nothing, and a file emptied by hand is reported and rewritten
    assert.deepEqual(refreshWiring(null, { scope: 'user', cli: CLI, mcpEntry: entry, clients: ['claude'] }).changed, []);
    fs.writeFileSync(account, JSON.stringify({ model: 'opus' }));
    assert.ok(refreshWiring(null, { scope: 'user', cli: CLI, mcpEntry: entry, clients: ['claude'] }).changed.some(f => f.includes('settings.json')));
    assert.ok(thinkerIn(hooksOf(account)).length, 'rewire wires the account home again');

    uninstallWiring({ scope: 'user' });
    const left = f => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
    assert.deepEqual(left(account), { model: 'opus' }, 'the account home is back to its own settings');
    assert.deepEqual(left(own), { model: 'opus' }, 'and so is the agent\'s own');
    assert.ok(!fs.existsSync(path.join(m.codexAccount, 'hooks.json')), 'the Codex account home keeps no hooks of ours');
    // the review marks go; Codex's own multi_agent setting stays, as in the agent's own home
    const tail = fs.readFileSync(path.join(m.codexAccount, 'config.toml'), 'utf8');
    assert.ok(!tail.includes('[hooks.state.'), 'no review marks of ours are left behind');
    assert.equal(tail.trim(), 'model = "gpt-5"\n\n[features]\nmulti_agent = true');
  });
});
