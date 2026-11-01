import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_ENV, claudeClearDir, withClearDir, withoutClearDir, clearDirIn, claudeCardDir } from '../src/claude-card.js';
import { installClient, uninstallWiring } from '../src/clients.js';
import { PROXY_DEFAULTS, TOKENS_PER_CHAR } from '../src/proxy.js';
import { SERVICE_HOLDOUT } from '../src/proxy-service.js';
import { noteCompression, compressionDir, readCompression } from '../src/compression.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const MOD = path.join(ROOT, 'src', 'integrations', 'claude-clear');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const D = path.delimiter;
const src = () => fs.readFileSync(path.join(MOD, 'hooks', 'register.tsx'), 'utf8');

test('the clearing mod ships beside the CLI, with a manifest and one hooks module', () => {
  assert.equal(claudeClearDir(CLI), MOD);
  const manifest = JSON.parse(fs.readFileSync(path.join(MOD, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'thinker-clear');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(MOD, 'hooks', 'hooks.json'), 'utf8')).modules, ['./register.tsx']);
});

test('the mod clears by the proxy\'s policy: same trigger, floor, kept results, holdout and token rate', () => {
  const s = src();
  assert.match(s, new RegExp(`export const TRIGGER = ${PROXY_DEFAULTS.trigger}\\n`));
  assert.match(s, new RegExp(`export const CLEAR_AT_LEAST = ${PROXY_DEFAULTS.clearAtLeast}\\n`));
  assert.match(s, new RegExp(`export const KEEP_MIN = ${PROXY_DEFAULTS.keepMin}\\n`));
  assert.match(s, new RegExp(`export const HOLDOUT = ${SERVICE_HOLDOUT}\\n`));
  const rate = s.match(/export const TOKENS_PER_CHAR = (.+)\n/);
  assert.ok(rate && new Function(`return ${rate[1]}`)() === TOKENS_PER_CHAR, 'tokens per char match proxy.js');
  // the same config keys the service reads (proxy-service.js:serviceArgs), plus the desktop switch
  for (const key of ['keepMin', 'clearAtLeast', 'trigger', 'holdout']) assert.ok(s.includes(`p.${key},`), `reads proxy.${key}`);
  assert.ok(s.includes('p.desktop !== false'), 'proxy.desktop: false switches the automatic clearing off');
  for (const key of ['clearInputs', 'clearThinking']) {
    assert.equal(PROXY_DEFAULTS[key], true, `${key} is on in the proxy`);
    assert.ok(s.includes(`p.${key} !== false`), `proxy.${key}: false switches it off here as in proxy-service.js:serviceArgs`);
  }
});

test('the mod writes the record the proxy writes, where the card and the report read it', () => {
  const s = src();
  assert.ok(s.includes('state/compression/${id}.json'), 'same file as compression.js:fileFor');
  const home = tmp('thinker-clear-home-');
  try {
    const dir = compressionDir(home);
    const state = noteCompression(dir, { op: 'proxy', session: 's1', at: 5, cleared: 1000, clearedUses: 2 }, { now: 5, actions: [{ name: 'Read', calls: 2, tokens: 1000 }] });
    // every key the proxy's record carries is set by the mod's state, in the same spelling
    for (const key of Object.keys(state)) assert.ok(new RegExp(`\\b${key}:`).test(s.slice(s.indexOf('state = {'))), `the mod sets ${key}`);
    assert.deepEqual(readCompression(dir, 's1'), state);
    // and this door's own breakdown beside them, which the proxy's record does not have (the API reports one figure)
    for (const key of ['results', 'inputs', 'thinking', 'total', 'measured']) assert.ok(s.includes(`${key}:`), `kinds carry ${key}`);
    assert.ok(s.includes('kinds,'), 'the record carries kinds');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the settings name one copy\'s clearing folder beside the card and keep every other plugin folder', () => {
  const mine = path.join(os.tmpdir(), 'copy-a', 'src', 'integrations', 'claude-clear');
  const other = path.join(os.tmpdir(), 'copy-b', 'src', 'integrations', 'claude-clear');
  const set = withClearDir({ model: 'x', env: { A: '1', [CARD_ENV]: ['/my/mod', other].join(D) } }, mine);
  assert.deepEqual(set, { model: 'x', env: { A: '1', [CARD_ENV]: ['/my/mod', mine].join(D) } }, 'the other copy\'s folder is replaced');
  assert.equal(clearDirIn(set), mine);
  assert.deepEqual(withoutClearDir(set), { model: 'x', env: { A: '1', [CARD_ENV]: '/my/mod' } });
  assert.deepEqual(withoutClearDir({ env: { [CARD_ENV]: mine } }), {}, 'an emptied env block goes');
});

test('connect names the clearing folder with the card in the user\'s Claude settings, and uninstall takes both out', () => {
  const home = tmp('thinker-clear-wire-');
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ env: { [CARD_ENV]: '/my/mod' } }));
    installClient('claude', { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: [] }, hooks: true, late: true, learn: false, mcp: false });
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(s.env[CARD_ENV], ['/my/mod', claudeCardDir(CLI), MOD].join(D));
    uninstallWiring({ scope: 'user' });
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { env: { [CARD_ENV]: '/my/mod' } });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the first desktop session on a machine is told once that clearing reaches it now', () => {
  const s = src();
  assert.ok(s.includes("(await $.env.get('CLAUDE_CODE_ENTRYPOINT')) === 'claude-desktop'"), 'the desktop app alone: the terminal had the proxy all along');
  assert.ok(s.includes('await $.store.get(INTRODUCED)') && s.includes('await $.store.set(INTRODUCED, Date.now())'), 'once per machine, kept across sessions');
  assert.match(s, /export const INTRO = 'thinker now clears old tool results[^']*Claude Desktop[^']*'/);
});
