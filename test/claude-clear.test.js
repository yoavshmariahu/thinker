import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_ENV, claudeClearDir, withClearDir, withoutClearDir, clearDirIn, claudeCardDir } from '../src/claude-card.js';
import { installClient, uninstallWiring } from '../src/clients.js';
import { PROXY_DEFAULTS, TOKENS_PER_CHAR, RESULT_TOKENS_PER_CHAR } from '../src/proxy.js';
import { COLD_MS, WRITE_1H, PAYBACK, readRate, LONG_CONTEXT, isRewrite, chargedRewrite, policyId, POLICY_REV } from '../src/cutting.js';
import { SERVICE_HOLDOUT } from '../src/proxy-service.js';
import { noteCompression, compressionDir, readCompression } from '../src/compression.js';
import { pointer, POINTER_OPENS } from '../src/tool-stubs.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const MOD = path.join(ROOT, 'src', 'integrations', 'claude-clear');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const D = path.delimiter;
const MOD_SRC = path.join('src', 'integrations', 'claude-clear', 'hooks', 'register.tsx');
const src = () => fs.readFileSync(path.join(MOD, 'hooks', 'register.tsx'), 'utf8');
// the value of an `export const NAME = <expr>` in the mod, so a constant written as `65 * 60 * 1000` compares
const modConst = (s, name) => {
  const m = s.match(new RegExp(`export const ${name} = (.+)\\n`));
  return m ? new Function(`return ${m[1]}`)() : undefined;
};

// Every key of the proxy's clearing policy must reach the desktop door, or say here why it cannot.
// The drift this stops: PR #588 turned `clearDeep` on in src/proxy.js alone, and the suite stayed green
// because the test below pinned four constants by hand and knew nothing of a fifth key. Desktop sessions
// kept a policy the replay had measured as a loss until it was found by hand. So the check is keyed on
// `Object.keys(PROXY_DEFAULTS)` now: a key added there fails this test until someone either wires it into
// the mod or writes down why a mod inside the session cannot have it.
//   reads   - what `policyOf` must contain for the key to reach the mod's own policy
//   mirrors - a constant in the mod that must equal the proxy's default (`value` where it differs by design)
//   acts    - what the mod must contain to act on the key, where reading it is not the whole of it
//   exempt  - why the key has no desktop meaning; a sentence, not a word
// What this cannot check: that the two doors *behave* alike. It pins the policy surface, not the mechanism;
// the mod's own behaviour is `claude plugin test src/integrations/claude-clear`.
const DESKTOP_POLICY = {
  trigger: { reads: 'p.trigger,', mirrors: 'TRIGGER' },
  clearAtLeast: { reads: 'p.clearAtLeast,', mirrors: 'CLEAR_AT_LEAST' },
  keepMin: { reads: 'p.keepMin,', mirrors: 'KEEP_MIN' },
  // the share the service runs with, not PROXY_DEFAULTS' 0: a held-out desktop session stays held out
  holdout: { reads: 'p.holdout,', mirrors: 'HOLDOUT', value: SERVICE_HOLDOUT },
  clearDeep: { reads: 'p.clearDeep !== false', acts: 'clearPays(policy, {' },
  upstream: { exempt: 'where the proxy forwards a request; a mod inside the session edits the conversation and sends nothing anywhere' },
};

test('the clearing mod ships beside the CLI, with a manifest and one hooks module', () => {
  assert.equal(claudeClearDir(CLI), MOD);
  const manifest = JSON.parse(fs.readFileSync(path.join(MOD, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'thinker-clear');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(MOD, 'hooks', 'hooks.json'), 'utf8')).modules, ['./register.tsx']);
});

test('every key of the proxy\'s clearing policy reaches the desktop door, or says why it cannot', () => {
  const s = src();
  for (const key of Object.keys(PROXY_DEFAULTS)) {
    assert.ok(DESKTOP_POLICY[key], `proxy.${key} is new in PROXY_DEFAULTS and this door knows nothing about it. `
      + `Either honour it in ${MOD_SRC} (policyOf, and whatever reads it) and add a { reads } entry to DESKTOP_POLICY `
      + `in this test, or add { exempt: '<why a mod inside the session cannot have it>' }.`);
  }
  for (const key of Object.keys(DESKTOP_POLICY)) {
    assert.ok(key in PROXY_DEFAULTS, `DESKTOP_POLICY names proxy.${key}, which PROXY_DEFAULTS no longer has`);
  }
  const policy = s.slice(s.indexOf('export function policyOf'), s.indexOf('export const clearPays'));
  const shape = s.match(/export type Policy = \{(.+?)\}/s)?.[1] ?? '';
  const defaults = s.match(/export const DEFAULTS: Policy = \{(.+?)\}/s)?.[1] ?? '';
  for (const [key, rule] of Object.entries(DESKTOP_POLICY)) {
    if (rule.exempt) {
      assert.ok(rule.exempt.length > 40, `the exemption for proxy.${key} must say why, in a sentence`);
      continue;
    }
    assert.ok(policy.includes(rule.reads), `policyOf must read proxy.${key} (\`${rule.reads}\`)`);
    assert.ok(new RegExp(`\\b${key}\\b`).test(shape), `the mod's Policy type must carry ${key}`);
    assert.ok(new RegExp(`\\b${key}:`).test(defaults), `the mod's DEFAULTS must set ${key}`);
    if (rule.mirrors) {
      const want = 'value' in rule ? rule.value : PROXY_DEFAULTS[key];
      assert.equal(modConst(s, rule.mirrors), want, `${rule.mirrors} in the mod is the proxy's ${key} (${want})`);
    }
    if (rule.acts) assert.ok(s.includes(rule.acts), `the mod must act on proxy.${key}, not only read it`);
  }
  // the mod's own switch, which the proxy has no use for: the automatic clearing off, the command still there
  assert.ok(policy.includes('p.desktop !== false'), 'proxy.desktop: false switches the automatic clearing off');
  // shared mechanism, not policy keys: the token rate the mod estimates with and the cache's own hour
  assert.equal(modConst(s, 'TOKENS_PER_CHAR'), TOKENS_PER_CHAR, 'tokens per char match proxy.js');
  assert.equal(modConst(s, 'RESULT_TOKENS_PER_CHAR'), RESULT_TOKENS_PER_CHAR, 'a result\'s own rate matches proxy.js');
  assert.equal(modConst(s, 'COLD_MS'), COLD_MS, 'the cache-cold pause matches clearing.js');
  // the floor itself: one policy, so a move on either door fails here until the other follows. Nothing pinned it
  // until 2026-11-06, the day the proxy's went from 20 to 25, which is exactly the divergence #588 cost a release.
  assert.equal(modConst(s, 'PAYBACK'), PAYBACK, "the mod's payback floor is the proxy's");
  // One policy means one name for it. Every saving's record carries the policy that made it (cutting.js:policyId),
  // and the two doors must spell the same policy the same way or a dashboard would read one machine as two.
  assert.equal(modConst(s, 'POLICY_REV'), POLICY_REV, "the mod's policy revision is the proxy's");
  const modPolicy = (() => {
    const m = s.match(/export const policyId = \(p: \{[^}]*\}\) =>\n  (`[^`]+`)/);
    assert.ok(m, 'the mod builds a policy id on one line');
    const round = n => (!Number.isFinite(n) ? '?' : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
    return cfg => new Function('p', 'POLICY_REV', 'PAYBACK', 'roundTo', `return ${m[1].replace(/ as number/g, '')}`)(cfg, POLICY_REV, PAYBACK, round);
  })();
  for (const cfg of [PROXY_DEFAULTS, { ...PROXY_DEFAULTS, clearAtLeast: 20000 }, { ...PROXY_DEFAULTS, trigger: 250000, clearDeep: false }, {}]) {
    assert.equal(modPolicy(cfg), policyId(cfg), `the mod names the policy as the proxy does (${policyId(cfg)})`);
  }
  // and the record it writes carries it, or the saving reaches no comparison at all
  assert.ok(/policy: policyId\(policy\),/.test(s), "the mod's session record names the policy that cleared");
  // one price: the mod's reads-per-written-token is the proxy's write rate over its read rate for the model (20 on
  // most models, 40 on Opus 5.5, 80 on Fable; a read priced at 2.5% for every model stopped the first paired smoke on
  // 2026-11-02, and one at 10% for every model would call a losing clear on Opus 5.5 a win)
  const table = s.match(/export const READ_RATES[^=]*= (\[.*\])\n/);
  assert.ok(table, 'READ_RATES is one line');
  const rates = new Function(`return ${table[1]}`)();
  const modRead = m => (rates.find(([re]) => re.test(m.toLowerCase())) || [null, 0.1])[1];
  for (const m of ['claude-opus-5-5', 'claude-opus-5', 'opus', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'gpt-6-astra']) assert.equal(modRead(m), readRate(m), `the mod's read rate for ${m} is clearing.js's`);
  assert.ok(/export const writeRatio = \(model: string\) => 2 \/ readRate\(model\)/.test(s), 'the write is WRITE_1H over the read');
  assert.equal(WRITE_1H, 2);
});

// The second thing the two doors hold together: a switched-off tool's definition is sent as one sentence naming
// its file (tool-stubs.js:pointer, the proxy's door); the mod answers tool.describe with the same sentence.
test('the mod sends a switched-off tool as the sentence the proxy sends, naming the same file', () => {
  const s = src();
  assert.equal(modConst(s, 'POINTER_OPENS'), POINTER_OPENS, 'the clause the two doors recognise a pointer by');
  const m = s.match(/export const toolPointer = \(name: string, file: string\) => `(.+)`\n/);
  assert.ok(m, 'toolPointer is one template literal');
  const said = new Function('name', 'file', 'POINTER_OPENS', 'return `' + m[1] + '`')('Artifact', '/h/tools/Artifact.json', POINTER_OPENS);
  assert.equal(said, pointer('Artifact', '/h/tools/Artifact.json'));
  assert.ok(s.includes("on('tool.describe'"), 'the mod answers tool.describe');
  assert.ok(s.includes('state/tool-stubs.json'), 'from the registry the switch writes');
  // the read the pointer asks for is the mod's to allow, for a file right inside the tools folder, only where the engine would ask
  assert.ok(s.includes("on('tool.check', { tool: 'Read' }"), 'the mod answers the permission check for Read');
  assert.match(s, /if \(r\?\.decision !== 'ask'[^\n]*return r/, 'a deny of the person\'s own stands');
  assert.match(s, /isToolFile\(\(e\.input as any\)\?\.file_path, await toolsDir\(\$\)\)\) return \{ decision: 'allow'/);
  // the predicate itself, its type annotations dropped, so the cases below hold the mod's own code
  const isToolFile = new Function('return ' + s.match(/export const isToolFile = (.+)\n/)[1].replace('(file: unknown, dir: string)', '(file, dir)'))();
  assert.ok(isToolFile('/h/.thinker/tools/Artifact.json', '/h/.thinker/tools'));
  for (const bad of ['/h/.thinker/tools/x/Artifact.json', '/h/.thinker/tools/../config.json', '/h/.thinker/tools/notes.txt', '/h/.thinker/config.json', 42]) assert.ok(!isToolFile(bad, '/h/.thinker/tools'), String(bad));
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'src', 'clients.js'), 'utf8'), /tools\/\*\*|toolsReadRule/, 'the wiring writes no rule for it');
});

test('an automatic clear that would be refused is never started, so the engine prints no skip line', () => {
  const s = src();
  // read the conversation first (reported 2026-11-02: "not compacted: thinker-clear: N tokens to clear,
  // under 100,000" under answer after answer in a desktop session, once the context passed the trigger)
  // the live window, not the saved transcript: the saved rows keep every result from before a compaction
  // boundary whole, so the check found 100k+ to clear that the compaction then refused, on every turn
  // (reported 2026-11-05: a /compact and a skip line after every answer in Claude Desktop)
  assert.ok(s.includes("$.session.messages({ as: 'api' })"), 'the mod reads the live window before scheduling');
  assert.ok(!s.includes('$.session.messages()'), 'never the saved transcript');
  assert.ok(/if \(c && worthIt\(c, policy, 'auto'\) && clearPays\(policy, \{[^\n]*\)\) schedule/.test(s), 'turn.complete schedules only a clear worth a compaction turn, and one that pays');
  assert.ok(/if \(autoDue\(tokens, policy, holdUntil\)\)/.test(s), 'an attempt that did not clear holds the next');
  assert.ok(/worthIt\(await wouldClear\(\$, policy\), policy, 'manual'\)/.test(s), 'the command answers by itself instead of spending a turn');
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

test('the record keeps what the clear cost, counted as the proxy counts a rewrite, and the model that prices it', () => {
  const s = src();
  // one definition of a rewrite (cutting.js:isRewrite): the same long-context floor, and the same test on sample calls
  assert.equal(modConst(s, 'LONG_CONTEXT'), LONG_CONTEXT, 'the mod\'s long-context floor is the proxy\'s');
  const body = s.match(/export const isRewrite = \(u: [^)]*\) => \{ (.+) \}\n/)?.[1];
  assert.ok(body, 'the mod defines isRewrite');
  const mine = new Function('LONG_CONTEXT', 'u', body)
  for (const u of [{ read: 0, write: 150_000, input: 10 }, { read: 200_000, write: 0, input: 10 }, { read: 0, write: 40_000, input: 10 }, { read: 60_000, write: 70_000, input: 0 }, null])
    assert.equal(mine(LONG_CONTEXT, u), isRewrite(u), `the two doors agree on ${JSON.stringify(u)}`);
  // and one rule for which of those the clearing is charged for (cutting.js:chargedRewrite): a read of zero is the cold cache's
  const chargedBody = s.match(/export const chargedRewrite = \(u: [^)]*\) => \{ (.+) \}\n/)?.[1];
  assert.ok(chargedBody, 'the mod defines chargedRewrite');
  const charged = new Function('isRewrite', 'u', chargedBody);
  for (const u of [{ read: 0, write: 150_000, input: 10 }, { read: 12_000, write: 150_000, input: 10 }, { read: 200_000, write: 0, input: 10 }, { read: 1, write: 100_000, input: 0 }, null])
    assert.equal(charged(isRewrite, u), chargedRewrite(u), `the two doors charge alike on ${JSON.stringify(u)}`);
  // counted on every request after a clear, from the usage the engine reports for that request, in the API's spelling
  const step = s.slice(s.indexOf("on('turn.step'"), s.indexOf("on('turn.complete'"));
  assert.ok(step.includes('state.cost = charge(state.cost, r?.usage)'), 'every request after a clear is charged');
  assert.ok(s.includes('if (u && chargedRewrite(u))'), 'the mod charges by the one rule');
  assert.ok(step.includes('state.model = String(r.usage.model)'), 'the model that answered is kept');
  for (const f of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) assert.ok(s.includes(`usage.${f}`), `reads ${f}`);
  // and kept across clears in the same shape compression.js:clearingCostBySession returns
  const record = s.slice(s.indexOf('state = {'));
  assert.ok(record.includes('cost: state?.cost ?? { rewrites: 0, write: 0 }'), 'the record carries cost: { rewrites, write }');
  assert.ok(record.includes('model: state.model'), 'the record carries the model');
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
    assert.equal(s.permissions, undefined, 'no permission rule of thinker\'s: the mod grants the tool-definition read itself');
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
