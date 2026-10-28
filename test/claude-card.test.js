import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_ENV, claudeCardDir, withCardDir, withoutCardDir, cardDirIn, claudeCardActive } from '../src/claude-card.js';
import { installClient, uninstallWiring } from '../src/clients.js';
import { FILE_CAP, MAX_FILES, NOT_READING } from '../src/usage.js';
import { TURNS_AFTER, compressionHeader } from '../src/compression.js';
import { formatTokens } from '../src/model-usage.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const MOD = path.join(ROOT, 'src', 'integrations', 'claude-card');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const D = path.delimiter;

test('the card folder ships beside the CLI, with a manifest and one hooks module', () => {
  assert.equal(claudeCardDir(CLI), MOD);
  const manifest = JSON.parse(fs.readFileSync(path.join(MOD, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'thinker-card');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(MOD, 'hooks', 'hooks.json'), 'utf8')).modules, ['./register.tsx']);
  assert.ok(fs.existsSync(path.join(MOD, 'hooks', 'register.tsx')));
});

test('the card estimates as usage.js:cacheHitSavings does: same file cap, files per note and skipped paths', () => {
  const src = fs.readFileSync(path.join(MOD, 'hooks', 'register.tsx'), 'utf8');
  assert.match(src, new RegExp(`export const MAX_FILES = ${MAX_FILES}\\n`));
  assert.match(src, new RegExp(`export const FILE_CAP = ${FILE_CAP}\\n`));
  assert.ok(src.includes(`export const NOT_READING = ${NOT_READING}\n`), 'NOT_READING matches usage.js');
  assert.ok(src.includes('st.size / 3.6'), 'tokens per byte match');
});

test('the card waits as long as the notice does, and words the saving the same way', () => {
  const src = fs.readFileSync(path.join(MOD, 'hooks', 'register.tsx'), 'utf8');
  assert.match(src, new RegExp(`export const TURNS_AFTER = ${TURNS_AFTER}\\n`), 'the wait matches compression.js');
  assert.ok(src.includes('state/compression/${id}.json'), 'the card reads the state the proxy writes');
  // The two write the same sentence; the mod has its own copy because it runs inside Claude Code.
  const saving = { saved: 1_234_000, requests: 17 };
  const mod = src.match(/export const compressionHeader = \(s: Saving\) =>\n  (`[^`]+`)/);
  assert.ok(mod, 'the mod exports a header');
  const built = new Function('s', 'formatTokens', `return ${mod[1]};`)(saving, formatTokens);
  assert.equal(built, compressionHeader(saving, formatTokens));
});

test('the settings name one copy\'s card folder and keep every other plugin folder', () => {
  const mine = '/opt/thinker/src/integrations/claude-card';
  const old = '/old/thinker/src/integrations/claude-card';
  assert.deepEqual(withCardDir({}, mine), { env: { [CARD_ENV]: mine } });
  const set = withCardDir({ model: 'x', env: { A: '1', [CARD_ENV]: ['/my/mod', old].join(D) } }, mine);
  assert.deepEqual(set, { model: 'x', env: { A: '1', [CARD_ENV]: ['/my/mod', mine].join(D) } }, 'another copy\'s folder is replaced');
  assert.deepEqual(withCardDir(set, mine), set, 'idempotent');
  assert.equal(cardDirIn(set), mine);
  assert.deepEqual(withoutCardDir(set), { model: 'x', env: { A: '1', [CARD_ENV]: '/my/mod' } });
  assert.deepEqual(withoutCardDir({ env: { [CARD_ENV]: mine } }), {}, 'an emptied env block goes');
});

test('connect names the card folder in the user\'s Claude settings, and uninstall takes it out', () => {
  const home = tmp('thinker-card-home-');
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = home; delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ env: { [CARD_ENV]: '/my/mod' } }));
    installClient('claude', { scope: 'user', cli: CLI, mcpEntry: { command: 'node', args: [] }, hooks: true, late: true, learn: false, mcp: false });
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(s.env[CARD_ENV], ['/my/mod', MOD].join(D));
    assert.ok(s.hooks.Stop, 'the hooks are written as before');
    uninstallWiring({ scope: 'user' });
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), { env: { [CARD_ENV]: '/my/mod' } }, 'only thinker\'s folder and hooks go');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a checkout\'s own Claude settings get no card folder: the card is the user\'s, once', () => {
  const repo = tmp('thinker-card-repo-');
  try {
    installClient('claude', { scope: 'repo', repo, cli: CLI, mcpEntry: { command: 'node', args: [] }, hooks: true, late: false, learn: false, mcp: false });
    const s = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'settings.local.json'), 'utf8'));
    assert.equal(s.env, undefined);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a session is carded only once the mod marked it, and old marks are cleared', () => {
  const home = tmp('thinker-card-marks-');
  try {
    assert.equal(claudeCardActive('s1', { home }), false);
    const dir = path.join(home, 'state', 'claude-card');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's1'), '');
    assert.equal(claudeCardActive('s1', { home }), true);
    assert.equal(claudeCardActive('unknown', { home }), false);
    const old = new Date(Date.now() - 3 * 86400e3);
    for (let i = 0; i < 101; i++) { const f = path.join(dir, `old-${i}`); fs.writeFileSync(f, ''); fs.utimesSync(f, old, old); }
    claudeCardActive('s1', { home });
    assert.deepEqual(fs.readdirSync(dir), ['s1']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
