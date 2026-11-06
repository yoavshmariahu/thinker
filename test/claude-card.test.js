import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_ENV, claudeCardDir, withCardDir, withoutCardDir, cardDirIn, claudeCardActive } from '../src/claude-card.js';
import { installClient, uninstallWiring } from '../src/clients.js';
import { FILE_CAP, MAX_FILES, NOT_READING } from '../src/usage.js';
import { CARD_TOOLS, TURNS_AFTER, compressionHeader, compressionTools, shortTool } from '../src/compression.js';
import { NOTICE_PROMPTS, NOTICE_HOURS } from '../src/notice-cadence.js';
import { formatTokens } from '../src/model-usage.js';
import { dayKey, savingsStatus } from '../src/savings-ledger.js';
import { formatDollars } from '../src/prices.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const MOD = path.join(ROOT, 'src', 'integrations', 'claude-card');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const D = path.delimiter;

test('the card folder ships beside the CLI, with a manifest and one hooks module', () => {
  assert.equal(claudeCardDir(CLI), MOD);
  const manifest = JSON.parse(fs.readFileSync(path.join(MOD, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'thinker');   // the desktop app labels a pinned status line with this name
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(MOD, 'hooks', 'hooks.json'), 'utf8')).modules, ['./register.tsx']);
  assert.ok(fs.existsSync(path.join(MOD, 'hooks', 'register.tsx')));
});

test('the card estimates as usage.js:cacheHitSavings does: same file cap, files per note and skipped paths', () => {
  const src = fs.readFileSync(path.join(MOD, 'hooks', 'register.tsx'), 'utf8');
  assert.match(src, new RegExp(`export const MAX_FILES = ${MAX_FILES}\\n`));
  assert.match(src, new RegExp(`export const FILE_CAP = ${FILE_CAP}\\n`));
  assert.ok(src.includes(`export const NOT_READING = ${NOT_READING}\n`), 'NOT_READING matches usage.js');
  assert.ok(src.includes('note.reads?.files'), 'the card reads the measurement kept on the note (usage.js:readsOf) before the disk');
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
  // the breakdown, with the same cap, the same name cut and the same wording
  assert.match(src, new RegExp(`export const CARD_TOOLS = ${CARD_TOOLS}\\n`));
  const modTools = src.match(/\.slice\(0, CARD_TOOLS\)\.map\(t => (`[^`]+`)\)\.join\(', '\)/);
  assert.ok(modTools, 'the mod exports the breakdown');
  const tools = { tools: [{ name: 'Bash', calls: 41, tokens: 1_100_000 }, { name: 'mcp__artemis__get_experiment', calls: 11, tokens: 62_000 }] };
  const builtTools = tools.tools.map(t => new Function('t', 'formatTokens', 'shortTool', `return ${modTools[1]};`)(t, formatTokens, shortTool)).join(', ');
  assert.equal(builtTools, compressionTools(tools, formatTokens, { limit: CARD_TOOLS }));
  assert.ok(builtTools.includes('artemis/get_experiment'), 'an MCP name is written as the person reads it');
});

test('the card comes due as the notice does, and speaks for the turns it held', () => {
  const src = fs.readFileSync(path.join(MOD, 'hooks', 'register.tsx'), 'utf8');
  // the mod runs inside Claude Code, so it has its own copy of the floors and reads the same state file
  assert.match(src, new RegExp(`export const NOTICE_PROMPTS = ${NOTICE_PROMPTS}\\n`), 'the prompts floor matches notice-cadence.js');
  assert.match(src, new RegExp(`export const NOTICE_HOURS = ${NOTICE_HOURS}\\n`), 'the hours floor matches notice-cadence.js');
  assert.ok(src.includes('/state/notice.json'), 'one cadence for every door');
  assert.ok(!/countPrompt|st\.prompts = /.test(src), 'the Stop hook counts the prompts; the card only reads the count');
  // a held turn keeps its notes for the next card, and the header says the span
  assert.ok(src.includes('if (!(await noticeDue($))) held++'));
  assert.ok(src.includes('prompts: held + 1'));
  const header = src.match(/export const cardHeader = \(n: number, tokens: number, prompts = 0\) =>\n  (.+)/);
  assert.ok(header, 'the mod exports a header');
  const build = (n, tokens, prompts) => new Function('n', 'tokens', 'prompts', 'formatTokens', `return ${header[1]};`)(n, tokens, prompts, formatTokens);
  assert.equal(build(1, 7000, 0), '1 note this turn \u00b7 Estimated tokens saved: ~7k');
  assert.equal(build(3, 0, 24), '3 notes over the last 24 prompts');
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
    assert.equal(s.env[CARD_ENV], ['/my/mod', MOD, path.join(ROOT, 'src', 'integrations', 'claude-clear')].join(D), 'the card and the clearing mod, after the person\'s own');
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

test('the status row says what the ledger says, in the same words and the same dollars', () => {
  const src = fs.readFileSync(path.join(MOD, 'hooks', 'register.tsx'), 'utf8');
  // The mod runs inside Claude Code, so it carries its own copy of the sentence and of the two
  // helpers under it. These hold the copies to src/savings-ledger.js and src/prices.js.
  // the line's own template, to the end of its line: it nests a template inside itself
  const mod = src.match(/export const savingsStatus = \(today: string \| null, lifetime: string\) =>\n  (.+)/);
  assert.ok(mod, 'the mod exports the status line');
  const built = (today, lifetime) => new Function('today', 'lifetime', `return ${mod[1]};`)(today, lifetime);
  const day = dayKey(Date.parse('2026-11-05T12:00:00Z'));
  const ledger = { day, today: { cost: 3.65, tokens: 5_636_787 }, lifetime: { cost: 849.2, tokens: 1_339_960_865 } };
  const now = Date.parse('2026-11-05T15:00:00Z');
  assert.equal(built(formatDollars(3.65), formatDollars(849.2)), savingsStatus(ledger, { now }));
  // and the day the figure was stamped on having passed, both say lifetime alone
  assert.equal(built(null, formatDollars(849.2)), savingsStatus(ledger, { now: now + 86400e3 }));
  // the two helpers, as text
  // the mod's copies are src's with the types put back on; the mod is always given a time, where src
  // defaults it, and that one difference in the signature is allowed for here
  const strip = s => s.replace(/: (number|string)\b/g, '').replace(/\): string/g, ')').replace(/;$/gm, '').replace(/\(now = Date\.now\(\)\)/, '(now)');
  for (const [name, from] of [['formatDollars', path.join(ROOT, 'src', 'prices.js')], ['dayKey', path.join(ROOT, 'src', 'savings-ledger.js')]]) {
    const one = src.match(new RegExp(`export (?:function|const) ${name}[\\s\\S]*?\\n}`))[0];
    const two = fs.readFileSync(from, 'utf8').match(new RegExp(`export (?:function|const) ${name}[\\s\\S]*?\\n}`))[0];
    assert.equal(strip(one), strip(two), `the mod's ${name} matches ${path.basename(from)}`);
  }
  // the figures ride the engine's own status row through PromptHint's tail -- where on the row is the
  // engine's to decide -- and thinker still writes no statusLine into the person's settings: that
  // surface is theirs
  assert.match(src, /component: 'PromptHint'/);
  assert.match(src, /tail: statusTail\(line\)/);
  // the desktop app draws no tail but does draw the engine's status line under the prompt (seen live,
  // 2026-11-06), so there the line is `$.ui.status`, on that surface alone, and /thinker-hide clears it
  assert.match(src, /\$\.ui\.status\(line && hiddenOn !== dayKey\(Date\.now\(\)\) \? desktopStatus\(line\) : undefined\)/);
  assert.match(src, /desktopStatus = \(line: string\) => line\.replace\(\/\^thinker: \/, ''\)/, 'the app heads the line with the plugin name, so the line drops its own');
  assert.match(src, /if \(surface !== 'desktop'\) return/);
  assert.match(src, /name: 'thinker-hide'/);
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src', 'clients.js'), 'utf8'), /statusLine/, 'thinker writes no statusLine into the agent\'s settings');
});
