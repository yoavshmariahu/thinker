import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CARD_ENV, claudeClearDir, withClearDir, withoutClearDir, clearDirIn, claudeCardDir } from '../src/claude-card.js';
import { installClient, uninstallWiring } from '../src/clients.js';
import { PROXY_DEFAULTS, TOKENS_PER_CHAR, RESULT_TOKENS_PER_CHAR, RESULT_WEIGHTS, resultTokens } from '../src/proxy.js';
import { COLD_MS, WRITE_1H, PAYBACK, readRate, chargedRewrite, policyId, VERSION, priceCut } from '../src/cutting.js';
import { SERVICE_HOLDOUT } from '../src/proxy-service.js';
import { noteCompression, compressionDir, readCompression } from '../src/compression.js';
import { pointer, POINTER_OPENS } from '../src/tool-stubs.js';
import { clearAnswer, clearPays, desktopPolicy, HOLD_GROWTH } from '../src/clear-door.js';
import { REPORT_SLOT, DELEGATE_SESSION_MARK, DELEGATE_DEFAULTS, denial } from '../src/delegate.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const MOD = path.join(ROOT, 'src', 'integrations', 'claude-clear');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const D = path.delimiter;
const MOD_SRC = path.join('src', 'integrations', 'claude-clear', 'hooks', 'register.tsx');
const src = () => fs.readFileSync(path.join(MOD, 'hooks', 'register.tsx'), 'utf8');
// the value of an `export const NAME = <expr>` in the mod, so a constant written as `65 * 60 * 1000` compares
const modLet = (s, name) => { const m = s.match(new RegExp(`\nlet ${name} = ([^\n/]+)`)); return m ? new Function(`return ${m[1]}`)() : undefined; };
// a function of the mod's, run here: the signature's type annotations stripped and nothing else, so what is
// tested is the mod's own code and not a copy of it
const modFn = (s, name) => {
  const at = s.indexOf(`export function ${name}(`);
  const end = s.indexOf('\n}', at);
  const src = s.slice(at, end + 2).replace(`export function ${name}`, 'function ' + name).replace(/\)\s*:[^{]+\{/, ') {').replace(/(\w+): string \| undefined|(\w+): string|(\w+): any/g, '$1$2$3');
  return new Function(`${src}; return ${name};`)();
};
const modConst = (s, name) => {
  const m = s.match(new RegExp(`export const ${name} = (.+)\\n`));
  return m ? new Function(`return ${m[1]}`)() : undefined;
};

// Every key of the proxy's clearing policy must reach the desktop door, or say here why it cannot.
// The drift this stops: PR #588 turned `clearDeep` on in src/proxy.js alone, and the suite stayed green
// because a test pinned four constants by hand and knew nothing of a fifth key. Desktop sessions kept a
// policy the replay had measured as a loss until it was found by hand. So the check is keyed on
// `Object.keys(PROXY_DEFAULTS)`: a key added there fails this test until someone either honours it in
// clear-door.js:desktopPolicy (where this door's policy has lived since 2026-11-18; the mod carries none) or
// writes down why a mod inside the session cannot have it.
//   honoured - the key is in this door's policy, at the proxy's default (`value` where it differs by design)
//   exempt   - why the key has no desktop meaning; a sentence, not a word
const DESKTOP_POLICY = {
  // the one switch over the rest, off since 2026-11-19: this door clears nothing while the proxy cuts nothing
  cut: { honoured: true },
  trigger: { honoured: true },
  clearAtLeast: { honoured: true },
  keepMin: { honoured: true },
  // the share the service runs with, not PROXY_DEFAULTS' 0: a held-out desktop session stays held out
  holdout: { honoured: true, value: SERVICE_HOLDOUT },
  clearDeep: { honoured: true },
  upstream: { exempt: 'where the proxy forwards a request; a mod inside the session edits the conversation and sends nothing anywhere' },
  cutInputs: { exempt: 'the mod clears results in the desktop app, where a call\'s own text is a file path and not a heredoc: the 2026-11-04 measurement that took input cutting out (#611) still holds for that shape' },
  cutBreakpoint: { exempt: 'a cache breakpoint is a field of the request to the API, which the proxy forwards and a mod inside the session never sees; the door keeps pricing a cut as the whole conversation written again' },
  cutThinking: { exempt: 'a thinking block is part of the request to the API, which the proxy forwards; the host hands a mod the tool results alone, so the model\'s earlier thinking is not there for it to leave out' },
  thinkingKeepTurns: { exempt: 'how many earlier turns keep their thinking when `cutThinking` is on, which the mod cannot do at all' },
  cutImages: { exempt: 'the host hands a mod each tool result as its text alone, so a screenshot is not there for it to save or to take out; the proxy does both' },
};

test('the clearing mod ships beside the CLI, with a manifest and one hooks module', () => {
  assert.equal(claudeClearDir(CLI), MOD);
  const manifest = JSON.parse(fs.readFileSync(path.join(MOD, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'thinker-clear');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(MOD, 'hooks', 'hooks.json'), 'utf8')).modules, ['./register.tsx']);
});

// THE WHOLE FILE MUST PARSE (2026-11-20). Every other test here reads register.tsx as text and runs one
// function of it (`modFn` extracts the lines and compiles those alone), which is blind to the file as a file:
// #888 left two `const answer` in one function, the engine refused the module, the mod did nothing in any
// session -- and the suite was green, because the one test that loads it (`hooks/clear.test.tsx`, run by
// `claude plugin test`) is not a node test and `npm test` never reaches it. This is the cheap half of that
// test: the mod transpiled by the runtime the host uses, which is the step that rejects a redeclaration.
// Skipped where bun is not installed, so the check never costs a contributor who has no mod to run.
const bun = ['bun', path.join(os.homedir(), '.bun', 'bin', 'bun')]
  .find(b => spawnSync(b, ['--version'], { encoding: 'utf8' }).status === 0);
test('the clearing mod is a file the engine can load', { skip: bun ? false : 'bun is not installed' }, () => {
  const r = spawnSync(bun, ['build', '--no-bundle', MOD_SRC], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, `the mod does not parse:\n${r.stderr}`);
});

test('every key of the proxy\'s clearing policy reaches the desktop door, or says why it cannot', () => {
  const door = desktopPolicy(null);
  for (const key of Object.keys(PROXY_DEFAULTS)) {
    const d = DESKTOP_POLICY[key];
    assert.ok(d, `proxy.${key} is new in PROXY_DEFAULTS and this door knows nothing about it. `
      + 'Either honour it in src/clear-door.js (desktopPolicy, and whatever reads it) and add { honoured: true } to DESKTOP_POLICY '
      + 'in this test, or add { exempt: \'<why a mod inside the session cannot have it>\' }.');
    if (d.honoured) assert.equal(door[key], 'value' in d ? d.value : PROXY_DEFAULTS[key], `this door's ${key} is the proxy's`);
    else assert.ok(String(d.exempt || '').length > 40 && !(key in door), `proxy.${key} is exempt with a reason, and not half-honoured`);
  }
  for (const key of Object.keys(DESKTOP_POLICY)) {
    assert.ok(key in PROXY_DEFAULTS, `DESKTOP_POLICY names proxy.${key}, which PROXY_DEFAULTS no longer has`);
  }
  // and a config that moves a key moves this door with it
  assert.equal(desktopPolicy({ proxy: { trigger: 90000, clearAtLeast: 20000, keepMin: 5, clearDeep: false } }).trigger, 90000);
  assert.deepEqual(desktopPolicy({ proxy: { clearAtLeast: 20000, keepMin: 5, clearDeep: false, desktop: false } }), { cut: false, keepMin: 5, clearAtLeast: 20000, trigger: PROXY_DEFAULTS.trigger, holdout: SERVICE_HOLDOUT, auto: false, clearDeep: false });
});

// An open session keeps the mod it loaded at its start, for days (claude-card.js: the folder is named by its bytes
// and an update never replaces it). Whatever policy the mod carried was therefore frozen at the release the session
// was opened under: measured on the fleet 2026-11-18, one machine was still being cut by the first revision of the
// rules a day and four updates later, and its losing sessions were those. So the mod carries none. A constant or a
// rule that comes back into it fails here, with the reason.
test('the mod holds no clearing policy of its own: it asks the installed CLI, which an update replaces', () => {
  const s = src();
  for (const name of ['TRIGGER', 'CLEAR_AT_LEAST', 'KEEP_MIN', 'HOLDOUT', 'PAYBACK', 'COLD_MS', 'MIN_CHARS', 'READ_RATES', 'RESULT_WEIGHTS', 'TOKENS_PER_CHAR', 'HOLD_GROWTH', 'VERSION', 'POLICY_REV', 'DEFAULTS', 'KEEP_DEFAULT']) {
    assert.ok(!new RegExp(`\\b(const|let) ${name}\\b`).test(s), `${name} is the CLI's (src/clear-door.js, cutting.js): a copy in the mod is frozen for as long as a session stays open`);
  }
  for (const fn of ['policyOf', 'policyId', 'clearPays', 'clearLadder', 'chooseDepth', 'clearOld', 'keptOf', 'keepMatcher', 'heldOut', 'resultTokens', 'placeholder', 'readRate']) {
    assert.ok(!new RegExp(`\\b(function|const) ${fn}\\b`).test(s), `${fn} is decided in the CLI, not in the mod`);
  }
  assert.ok(s.includes("$.process.run(['node', cli, 'hook', 'clear', '--client', 'claude', '--user']"), 'the mod asks thinker hook clear');
  // the three questions, and each is one clear-door.js answers
  for (const op of ['start', 'decide', 'apply']) {
    assert.ok(s.includes(`op: '${op}'`), `the mod asks "${op}"`);
    assert.ok(Object.keys(clearAnswer({ op, from: 'auto', session: 's', messages: [] }, { config: {} })).length > 1, `and the CLI answers "${op}"`);
  }
  // the CLI it asks is the one the settings' hooks name, found whether or not delegation is on
  const start = s.slice(s.indexOf("on('session.start'"), s.indexOf("on('turn.step'"));
  assert.ok(start.indexOf('await findCli($)') > 0 && start.indexOf('await findCli($)') < start.indexOf('await delegateSetup($)'), 'the CLI is found first, for both');
  // no answer -- no CLI, a timeout, the hooks off for this session -- is "leave it alone", never a guess
  assert.ok(s.includes('if (!cli) return null') && /catch \{ return null \}/.test(s), 'ask resolves null where there is no answer');
  // the stamp on the record is the answer's, which is the version of the thinker that decided
  assert.ok(s.includes('...(c.policy ? { policy: c.policy }'), "the mod's session record names the policy the answer names");
  assert.ok(s.includes('state.policy !== c.policy ? { policyChanged: true }'), 'and a session that spans two says so');
  assert.equal(clearAnswer({ op: 'apply', from: 'auto', session: 's', messages: [] }, { config: {} }).policy, policyId({ ...PROXY_DEFAULTS, cutInputs: false, cutImages: false, cutBreakpoint: false, cutThinking: false }), 'the proxy\'s spelling of the policy this door can run');
  assert.match(clearAnswer({ op: 'start', session: 's' }, { config: {} }).policy, new RegExp(`^v${VERSION.replace(/\./g, '\\.')}-`));
});

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
  const done = s.slice(s.indexOf("on('turn.complete'"), s.indexOf("on('session.compact'"));
  assert.ok(/const a = await ask\(\$, \{ op: 'decide', from: 'auto', messages: [^\n]*tokens, idle: wasIdle, cleared: clearedAt > 0, holdUntil, model \}\)/.test(done), 'the turn\'s end asks whether some rung repays, with what the session knows');
  assert.ok(/if \(a\.clear && a\.depth != null\) \{ pendingDepth = a\.depth; schedule\(\$, 'auto', tokens\) \}/.test(done), 'and schedules only when the answer chose a depth');
  // the conversation travels only with a question that can end in a clear; the every-few-turns check goes without it
  assert.ok(done.includes('const due = tokens >= askAt') && done.includes('const rows = due ? await liveMessages($) : null'), 'below the context it was told to come back at, the mod sends no conversation');
  assert.ok(done.includes("if (typeof a.askAt === 'number') askAt = a.askAt"), 'and it comes back where the answer says');
  // the rung the check chose is the rung the compaction applies, never the whole set by accident
  const compact = s.slice(s.indexOf("on('session.compact'"), s.indexOf("on('command.run', { command: DISABLE }"));
  assert.ok(/const chosen = pendingDepth; pendingDepth = null/.test(compact), 'the chosen depth is taken once');
  assert.ok(compact.includes("await ask($, { op: 'apply', from, depth: chosen, messages: slim(e.messages) })"), 'the clear asks for that rung; a hand-run clear (no depth) takes everything eligible');
  assert.ok(compact.includes('return { messages: applyPlan(e.messages, c.replace) }'), 'and puts in place exactly what the answer names');
  assert.ok(/if \(!c \|\| c\.skip \|\| !c\.cleared \|\| !c\.replace\) \{\n\s+hold\(\)/.test(compact), 'a clear not made holds the next attempt');
  // The latch is NOT the size floor. They were the same 60,000 until the floor fell to 8,000 with the ladder,
  // which silently cut the hold to 8k -- no hold at all, a working session grows that in a turn -- and put the
  // skip-line-after-every-answer bug back (reported 2026-11-02 and 2026-11-05).
  assert.equal(HOLD_GROWTH, 60000, 'the hold window is a constant of its own, the 60k the latch had while the floor was 60k');
  assert.equal(clearAnswer({ op: 'decide', from: 'auto', session: 's', tokens: 0, messages: null }, { config: { proxy: { cut: true, clearAtLeast: 8000 } } }).hold, HOLD_GROWTH, 'the answer carries it, whatever the size floor');
  assert.ok(/holdUntil = attemptAt \+ holdGrowth/.test(s) && s.includes("if (typeof a.hold === 'number') holdGrowth = a.hold"), 'the latch holds on the window the answer gave');
  assert.equal(modLet(s, 'holdGrowth'), HOLD_GROWTH, 'and on the same 60k before any answer has come');
  // the command answers by itself instead of spending a turn
  const cmd = s.slice(s.indexOf("on('command.run', { command: COMMAND }"));
  assert.ok(cmd.indexOf("op: 'decide', from: 'manual'") > 0 && cmd.indexOf("op: 'decide', from: 'manual'") < cmd.indexOf("schedule($, 'manual')"), 'a hand-run clear is asked for before it is scheduled');
  assert.ok(cmd.includes("if (!a.clear) return { text: 'thinker-clear: nothing old enough to clear' }"));
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

test('the record keeps what the clear cost, counted as the proxy counts it, and the model that prices it', () => {
  const s = src();
  // one rule for what the clearing is charged (cutting.js:chargedRewrite): a write into a warm cache, of any size.
  // The report's rewrite heuristic is no part of it: its floor on the context after the cut made large cuts free.
  assert.ok(!/\bisRewrite\b|\bLONG_CONTEXT\b/.test(s), 'the mod charges by no context floor and no share of the context');
  const chargedBody = s.match(/export const chargedRewrite = \(u: [^)]*\) => \{ (.+) \}\n/)?.[1];
  assert.ok(chargedBody, 'the mod defines chargedRewrite');
  const charged = new Function('u', chargedBody);
  for (const u of [{ read: 0, write: 150_000, input: 10 }, { read: 12_000, write: 150_000, input: 10 }, { read: 200_000, write: 0, input: 10 }, { read: 1, write: 100_000, input: 0 },
    { read: 68_000, write: 46_000, input: 0 }, { read: 20_000, write: 59_000, input: 0 }, { read: 35_000, write: 55_000, input: 0 }, { read: 0, write: 40_000, input: 10 }, null])
    assert.equal(charged(u), chargedRewrite(u), `the two doors charge alike on ${JSON.stringify(u)}`);
  assert.equal(chargedRewrite({ read: 35_000, write: 55_000, input: 0 }), true, 'a warm cut that left 90k of context is charged');
  assert.equal(chargedRewrite({ read: 68_000, write: 46_000, input: 0 }), true, 'a warm cut that wrote 40% of its context is charged');
  assert.equal(chargedRewrite({ read: 0, write: 349_000, input: 0 }), false, 'a cold one is not');
  // counted on the first request after a clear alone, the one whose prefix the clear changed (compression.js:
  // clearingCostBySession charges the row that made a cut), from the usage the engine reports for it
  const step = s.slice(s.indexOf("on('turn.step'"), s.indexOf("on('turn.complete'"));
  assert.ok(step.includes('const first = settle') && step.includes('state.cost = charge(state.cost, r?.usage, first)'), 'only the first request after a clear is charged');
  assert.ok(s.includes('if (!caused) return c'), 'a later rewrite is not the clear\'s');
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

// One policy, two spellings. The proxy prices a cut in tokens (cutting.js:priceCut) and the mod decides it in
// ratios, so neither reads the other's arithmetic and only this test holds them to the same answer. It matters
// most for the correction of 2026-11-13: a rewrite is charged less the read it displaces, which in the mod's
// form is `writeRatio - 1` on one side and `PAYBACK + 1` on the other. A move on either door fails here.
test('the desktop door decides a clear exactly where the proxy prices one', () => {
  // one rule, two spellings: the door's is (writeRatio - 1) x recache against (PAYBACK + 1) x dropped
  // (clear-door.js:clearPays), the proxy's is priceCut's payback against PAYBACK. They must agree on every
  // priced model, on both sides of the floor.
  const p = desktopPolicy(null);
  let agreed = 0;
  for (const model of ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']) {
    for (const tokens of [6000, 20000, 60000, 105472, 200000]) {
      for (const ratio of [0.5, 1, 1.21, 1.5, 1.94, 2.5, 4, 10]) {
        const recache = Math.round(tokens * ratio);
        const proxy = priceCut({ prompt: recache + tokens }, { tokens, recache }, { model }).pays;
        const door = clearPays(p, { dropped: tokens, recache, idle: 0, cleared: false, model });
        assert.equal(door, proxy, `${model} tail/cut ${ratio} of ${tokens}: door ${door}, proxy ${proxy}`);
        agreed++;
      }
    }
  }
  assert.ok(agreed >= 160, 'the grid covers both sides of the floor on every priced model');
  assert.equal(WRITE_1H / readRate(''), 20, 'a written token needs 20 read back where the model is unknown');
  // A cut can price at or below zero -- already ahead on the call that makes it. On Anthropic it is unreachable:
  // it needs a tail under read/(write-read) of what the cut removes, 5% at these rates. It is ordinary wherever
  // a read is dear, so the state is checked at GLM's rates, which this door never sees (the mod runs only in
  // Claude Desktop). Zero is the floor and it is reachable: payback is recache x (write-read) / (removed x read)
  // - 1, so a positive tail can never price below -1 and the whole number can never be under 0.
  const glm = { read: 0.5, write: 1.0 };
  const pay = (tokens, recache, opts) => priceCut({ prompt: recache + tokens }, { tokens, recache }, opts).payback;
  assert.equal(pay(100000, 100000, { rates: glm }), 0, 'at GLM rates a tail equal to what the cut removes is repaid at once');
  assert.equal(pay(200000, 100000, { rates: glm }), 0, 'and taking out twice the tail is no later than at once');
  assert.equal(pay(100000, 300000, { rates: glm }), 2, 'a tail three times the cut takes two later calls');
  assert.equal(pay(100000, 100000, { model: 'claude-opus-5' }), 18, 'where on Anthropic that same shape needs 18');
});

// The mod runs delegated reads (register.tsx:delegateCall) on the CLI's rule, so what the two share by name must match.
test('the mod\'s delegation hook shares the report slot, the session mark and the timeout with delegate.js, and asks the CLI', () => {
  const s = src();
  assert.equal(modConst(s, 'REPORT_SLOT'), REPORT_SLOT);
  assert.equal(modConst(s, 'DELEGATE_SESSION_MARK'), DELEGATE_SESSION_MARK);
  assert.equal(modConst(s, 'DELEGATE_TIMEOUT_MS'), DELEGATE_DEFAULTS.timeoutMs);
  assert.match(s, /'hook', 'pretool', '--client', 'claude', '--user'/, 'one copy of the rule: the CLI\'s');
  assert.match(s, /host_runs: true/);
  assert.match(s, /for \(const tool of \['Read', 'Bash'\]\) on\('tool\.call'/);
  // A denial with no order is the answer itself -- the pointer at a copy the model already has
  // (delegate.js:denial, kind `repeat`). The mod is the door in every session it marks, so it must return those
  // words; it read only orders until 2026-11-20 and dropped them.
  assert.match(s, /export function reasonOf/);
  assert.match(s, /const words = reasonOf\(\w+\)\n\s*if \(words\) return words/);
  assert.match(s, /!j\?\.thinkerRun && h\?\.permissionDecision === 'deny'/);
  // and the branch itself, run: a denial with no order is the words, an order is not, and nothing else is either
  const reasonOf = modFn(s, 'reasonOf');
  const deny = r => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r } });
  assert.equal(reasonOf(denial({ kind: 'repeat', files: ['/r/a.js'], cwd: '/r' })).startsWith('thinker stopped this call'), true);
  assert.equal(reasonOf(deny('words')), 'words');
  assert.equal(reasonOf(JSON.stringify({ ...JSON.parse(deny('words')), thinkerRun: { agent: 'x' } })), null, 'an order is the host\'s to run');
  assert.equal(reasonOf(''), null);
  assert.equal(reasonOf('{}'), null);
  assert.equal(reasonOf(deny('')), null);
  // and the rule's own name is the CLI's: `repeats` off in the machine config switches the pointer off, the
  // hook entry and this branch alike
  assert.equal(DELEGATE_DEFAULTS.repeats, true);
});
