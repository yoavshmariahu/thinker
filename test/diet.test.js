// The context diet (diet.js): a tool's result replaced before it enters the agent's context. Off by
// default; a whole-file read becomes the lines around the session's search terms, a test run its
// failure causes, a large search its hits grouped by file. Everything else passes untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { DIET, dietConfig, dietResult, trimFile, groupSearch, promptTerms, searchTerms, rememberTerms, trimTestOutput, capMcpResult, levelOf, dietTimeline } from '../src/diet.js';
import { toolOutput } from '../src/clients.js';

process.env.THINKER_TELEMETRY = 'off';
const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const env = { ...process.env, THINKER_LOG: 'local', THINKER_HOLDOUT: 'off', THINKER_NO_BG_VERIFY: '1', THINKER_NO_LEARN: '1', THINKER_CE: 'off' };
delete env.THINKER_DIET;
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
const hook = (dir, kind, input, over = {}) => execFileSync('node', [CLI, 'hook', kind, '--repo', dir], { input: JSON.stringify(input), encoding: 'utf8', env: { ...env, ...over } });
const logs = store => fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

// 200 lines: an import header, 60 helpers, one of them the target
const BIG = 'import os\nimport sys\n\n' + Array.from({ length: 60 }, (_, i) => `def helper_${i}(x):\n    """helper ${i}"""\n    return x + ${i}\n`).join('\n');
function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-diet-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/big.py'), BIG);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const on = (store, over = {}) => fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ diet: { enabled: true, ...over } }));

test('off by default; the config and THINKER_DIET turn it on and off', t => {
  const store = new Store(repo(t)).init();
  assert.equal(dietConfig(store).enabled, false);
  assert.equal(DIET.enabled, false);
  on(store); assert.equal(dietConfig(store).enabled, true);
  process.env.THINKER_DIET = 'off'; assert.equal(dietConfig(store).enabled, false);
  process.env.THINKER_DIET = 'on'; fs.writeFileSync(path.join(store.dir, 'config.json'), '{}'); assert.equal(dietConfig(store).enabled, true);
  delete process.env.THINKER_DIET;
});

test('trimFile keeps the header and the lines around the hits, outlines the gaps, says how to read the rest', () => {
  const r = trimFile(BIG, { file: 'src/big.py', terms: ['helper_42'], window: 4, minLines: 50 });
  assert.ok(r.text, 'trimmed');
  assert.match(r.text, /^\s+1\timport os\n/, 'header kept with cat -n numbering');
  assert.match(r.text, /def helper_42\(x\)/);
  assert.doesNotMatch(r.text, /def helper_10\(x\)/, 'far lines omitted');
  assert.match(r.text, /… lines \d+-\d+ omitted \(defines helper_0 L4, helper_1 L8/, 'the omitted range names its definitions');
  assert.match(r.text, /\[thinker: \d+ of 242 lines shown, around what you searched for; sed -n 'A,Bp' src\/big\.py reads any omitted range\]/);
  assert.ok(r.kept < r.n * 0.3);
  assert.match(trimFile(BIG, { file: 'src/big.py', terms: ['helper_42'], window: 4, minLines: 50, how: 'Read' }).text, /Read with offset and limit/);
});

test('trimFile passes a file whole when it is small, when nothing is known to look for, when nothing hits, and when the hits cover most of it', () => {
  assert.equal(trimFile(BIG, { file: 'src/big.py', terms: ['helper_42'], minLines: 1000 }).skip, 'small');
  assert.equal(trimFile(BIG, { file: 'src/big.py', terms: [], minLines: 50 }).skip, 'no-terms');
  assert.equal(trimFile(BIG, { file: 'src/big.py', terms: ['ab'], minLines: 50 }).skip, 'no-terms', 'two letters are not a term');
  assert.equal(trimFile(BIG, { file: 'src/big.py', terms: ['nothing_here'], minLines: 50 }).skip, 'no-hits');
  assert.equal(trimFile(BIG, { file: 'src/big.py', terms: ['helper_'], minLines: 50 }).skip, 'over-cap');
  assert.equal(trimFile(BIG, { file: 'src/big.py', terms: ['helper_('], minLines: 50 }).skip, 'no-hits', 'a broken regex is taken literally');
});

test('the terms: identifiers of the request and the patterns of recent searches, kept per session', t => {
  assert.deepEqual(promptTerms('Fix `save_rows` so fetchRows and the Loader do not race; see initKea.ts'), ['save_rows', 'fetchRows', 'initKea']);
  assert.deepEqual(searchTerms('Grep', { pattern: 'fetchRows\\b' }), ['fetchRows\\b']);
  assert.deepEqual(searchTerms('Bash', { command: `rg -n -g '*.py' 'helper_42' src && grep -rn "other_term" lib | head -20` }), ['helper_42', 'other_term']);
  assert.deepEqual(searchTerms('Bash', { command: 'git grep -n -i -e needle -- src' }), ['needle']);
  const store = new Store(repo(t)).init(); on(store);
  rememberTerms(store, 's1', { prompt: 'fix helper_42' });
  for (let i = 0; i < 12; i++) rememberTerms(store, 's1', { name: 'Grep', input: { pattern: `term_${i}` } });
  const st = JSON.parse(fs.readFileSync(path.join(store.dir, 'state', 'session-s1.json'), 'utf8'));
  assert.deepEqual(st.dietPrompt, ['helper_42']);
  assert.equal(st.dietTerms.length, DIET.terms, 'only the recent searches are kept');
  assert.equal(st.dietTerms[st.dietTerms.length - 1], 'term_11');
});

test('a whole-file Read and a cat of the file are trimmed in the shape the client gave them; ranges and other commands pass', t => {
  const dir = repo(t); const store = new Store(dir).init(); on(store, { minLines: 50, window: 4 });
  rememberTerms(store, 's1', { prompt: 'fix helper_42' });
  const content = fs.readFileSync(path.join(dir, 'src/big.py'), 'utf8');
  const read = dietResult(store, { session: 's1', repo: dir, name: 'Read', input: { file_path: path.join(dir, 'src/big.py') }, response: { type: 'text', file: { filePath: path.join(dir, 'src/big.py'), content, numLines: 242, startLine: 1, totalLines: 242 } } });
  assert.equal(read.kind, 'read'); assert.equal(read.file, 'src/big.py');
  assert.equal(read.output.type, 'text'); assert.equal(read.output.file.filePath, path.join(dir, 'src/big.py'));
  // Claude Code numbers a Read result itself, so every line keeps its place: the omitted ranges are a marker and empty lines
  const got = read.output.file.content.split('\n');
  assert.equal(got.length - 2, content.split('\n').length - 1, 'one line per line of the file, plus the footer');
  assert.ok(got[171].startsWith('def helper_42('), 'line 172 is still line 172');
  assert.match(got[2], /^… lines 3-\d+ omitted \(defines helper_0 L4/); assert.equal(got[3], '');
  assert.match(got[got.length - 2], /\[thinker: \d+ of 242 lines shown.*Read with offset and limit/);
  assert.ok(read.output.file.content.length < content.length / 2);
  assert.equal(read.output.file.numLines, got.length - 1);
  assert.equal(dietResult(store, { session: 's1', repo: dir, name: 'Read', input: { file_path: path.join(dir, 'src/big.py'), offset: 10, limit: 20 }, response: { type: 'text', file: { filePath: path.join(dir, 'src/big.py'), content } } }), null, 'a ranged read is what the agent asked for');
  const cat = dietResult(store, { session: 's1', repo: dir, cwd: dir, name: 'Bash', input: { command: `cd ${dir} && cat -n src/big.py` }, response: { stdout: content, stderr: '', interrupted: false } });
  assert.equal(cat.kind, 'read'); assert.equal(cat.output.stderr, ''); assert.equal(cat.output.interrupted, false);
  assert.match(cat.output.stdout, /def helper_42/); assert.match(cat.output.stdout, /sed -n 'A,Bp' src\/big\.py/);
  assert.equal(dietResult(store, { session: 's1', repo: dir, cwd: dir, name: 'Bash', input: { command: 'sed -n 10,40p src/big.py' }, response: { stdout: 'x' } }), null);
  assert.equal(dietResult(store, { session: 's1', repo: dir, cwd: dir, name: 'Bash', input: { command: 'cat src/big.py | head -50' }, response: { stdout: 'x' } }), null, 'a pipe is not a whole read');
  assert.equal(dietResult(store, { session: 's1', repo: dir, cwd: dir, name: 'Bash', input: { command: 'cat /etc/hosts' }, response: { stdout: 'x' } }), null, 'outside the repository');
  assert.equal(dietResult(store, { session: 's1', repo: dir, name: 'Edit', input: {}, response: { ok: true } }), null);
  const ops = logs(store).filter(l => l.op === 'diet' || l.op === 'diet-skip');
  assert.deepEqual(ops.map(l => [l.op, l.kind, l.file]), [['diet', 'read', 'src/big.py'], ['diet', 'read', 'src/big.py']]);
  assert.ok(ops[0].before > ops[0].after);
  // a file with nothing to centre on passes whole, and the skip is logged with its reason
  const s2 = dietResult(store, { session: 's2', repo: dir, cwd: dir, name: 'Bash', input: { command: 'cat src/big.py' }, response: { stdout: content } });
  assert.equal(s2, null);
  assert.equal(logs(store).filter(l => l.op === 'diet-skip').pop().why, 'no-terms');
});

test('a large search is grouped by file, a small one passes', t => {
  const dir = repo(t); const store = new Store(dir).init(); on(store, { searchChars: 100, perFile: 2, maxFiles: 3 });
  const stdout = Array.from({ length: 5 }, (_, f) => Array.from({ length: 4 }, (_, i) => `src/f${f}.py:${i + 1}:    x = helper_${i}(y)`).join('\n')).join('\n') + '\n';
  const r = dietResult(store, { session: 's1', repo: dir, name: 'Bash', input: { command: "rg -n 'helper_' src" }, response: { stdout } });
  assert.equal(r.kind, 'search');
  assert.match(r.output.stdout, /src\/f0\.py:1:/); assert.match(r.output.stdout, /src\/f0\.py: \+2 more matching lines/);
  assert.doesNotMatch(r.output.stdout, /src\/f4\.py:1:/); assert.match(r.output.stdout, /… \+2 more files with matches/);
  assert.match(r.output.stdout, /\[thinker: 20 matching lines in 5 files, 2 shown per file/);
  assert.equal(dietResult(store, { session: 's1', repo: dir, name: 'Bash', input: { command: "rg -n 'helper_' src" }, response: { stdout: 'src/f0.py:1: x\n' } }), null, 'small');
  assert.equal(groupSearch('just some text\nwithout paths\n'), null);
  assert.equal(dietResult(store, { session: 's1', repo: dir, name: 'Bash', input: { command: "rg -n 'helper_' src | head -3" }, response: { stdout } }), null, 'the agent limited it already');
});

test('a test run becomes its failure causes, the whole log kept in a file', t => {
  const dir = repo(t); const store = new Store(dir).init(); on(store, { testChars: 0 });
  const stdout = fs.readFileSync(new URL('./fixtures/test-output/pytest.txt', import.meta.url), 'utf8');
  const r = dietResult(store, { session: 's1', repo: dir, name: 'Bash', input: { command: 'pytest tests/test_rows.py -q' }, response: { stdout, stderr: '', interrupted: false } });
  assert.equal(r.kind, 'test');
  assert.match(r.output.stdout, /^pytest: .*failed/); assert.match(r.output.stdout, /distinct cause/); assert.match(r.output.stdout, /full log \(\d+ lines\): \.thinker\/state\/tests\//);
  assert.equal(r.output.stderr, ''); assert.equal(r.output.interrupted, false);
  assert.ok(r.output.stdout.length < stdout.length);
  const log = /full log \(\d+ lines\): (\S+)/.exec(r.output.stdout)[1];
  assert.equal(fs.readFileSync(path.join(dir, log), 'utf8'), stdout);
  assert.equal(trimTestOutput(store, { repo: dir, command: 'pytest -q', stdout: 'nothing here', cfg: { ...DIET, testChars: 0 } }), null, 'not a test report');
  on(store, { testChars: 0, tests: false });
  assert.equal(dietResult(store, { session: 's1', repo: dir, name: 'Bash', input: { command: 'pytest -q' }, response: { stdout } }), null, 'tests: false leaves test runs alone');
});

test('the hooks: the prompt remembers the request, the tool hook answers Claude Code with updatedToolOutput, and nothing changes while it is off', t => {
  const dir = repo(t); const store = new Store(dir).init();
  const content = fs.readFileSync(path.join(dir, 'src/big.py'), 'utf8');
  const ev = { session_id: 'h1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'cat src/big.py' }, tool_response: { stdout: content, stderr: '', interrupted: false } };
  hook(dir, 'prompt', { session_id: 'h1', cwd: dir, prompt: 'fix helper_42 in the helpers' });
  assert.equal(hook(dir, 'tool', ev), '', 'off: no answer');
  on(store, { minLines: 50, window: 4 });
  hook(dir, 'prompt', { session_id: 'h1', cwd: dir, prompt: 'fix helper_42 in the helpers' });
  const o = JSON.parse(hook(dir, 'tool', ev));
  assert.equal(o.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(o.hookSpecificOutput.additionalContext, undefined, 'nothing added to the context');
  assert.match(o.hookSpecificOutput.updatedToolOutput.stdout, /def helper_42/);
  assert.ok(o.hookSpecificOutput.updatedToolOutput.stdout.length < content.length / 2);
  assert.equal(o.hookSpecificOutput.updatedToolOutput.interrupted, false);
  assert.ok(logs(store).some(l => l.op === 'diet' && l.kind === 'read' && l.session === 'h1'));
  // the search the agent ran is remembered for the next read
  hook(dir, 'tool', { session_id: 'h2', cwd: dir, tool_name: 'Bash', tool_input: { command: "rg -n 'helper_7\\b' src" }, tool_response: { stdout: 'src/big.py:25:def helper_7(x):\n' } });
  const o2 = JSON.parse(hook(dir, 'tool', { ...ev, session_id: 'h2' }));
  assert.match(o2.hookSpecificOutput.updatedToolOutput.stdout, /def helper_7\(x\)/);
  assert.doesNotMatch(o2.hookSpecificOutput.updatedToolOutput.stdout, /def helper_42\(x\)/);
  // the environment overrides the config for an experiment arm
  assert.equal(hook(dir, 'tool', { ...ev, session_id: 'h1' }, { THINKER_DIET: 'off' }), '');
  // other clients get the result untouched
  assert.equal(hook(dir, 'tool', { ...ev, session_id: 'h3' }, { THINKER_CLIENT: 'codex' }).includes('updatedToolOutput'), false);
});

test('an MCP result is capped in the shape it came: a string, or the text blocks of a list with its images kept', t => {
  const long = Array.from({ length: 600 }, (_, i) => `row ${i}`).join('\n');
  assert.equal(capMcpResult('short', 4000), null);
  const s = capMcpResult(long, 1000);
  assert.ok(typeof s.output === 'string' && s.output.length < 1200 && /left out by thinker/.test(s.output) && s.before === long.length);
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const list = capMcpResult([{ type: 'text', text: long }, image, { type: 'text', text: 'tail' }], 1000);
  assert.equal(list.output.length, 2, 'the text blocks become one, the image stays');
  assert.deepEqual(list.output[1], image);
  assert.ok(list.output[0].type === 'text' && list.output[0].text.endsWith('tail') && list.output[0].text.length < 1200);
  assert.equal(capMcpResult([{ type: 'text', text: 'ok' }, image], 1000), null, 'an image alone is never cut');
  const obj = capMcpResult({ content: [{ type: 'text', text: long }], isError: false }, 1000);
  assert.equal(obj.output.isError, false); assert.equal(obj.output.content.length, 1);
  // through the hook: only a server given a level, answered with updatedMCPToolOutput beside updatedToolOutput
  const dir = repo(t); const store = new Store(dir).init();
  on(store, { tools: { 'mcp:rea': 'high' } });
  const longer = Array.from({ length: 1500 }, (_, i) => `row ${i}`).join('\n');
  const ev = { session_id: 'm1', cwd: dir, tool_name: 'mcp__rea__q', tool_input: { q: 'x' }, tool_response: longer };
  const o = JSON.parse(hook(dir, 'tool', ev)).hookSpecificOutput;
  // the moderate cap (12k) however the server was set, so the 4k high cap is never applied to an MCP result
  assert.ok(typeof o.updatedMCPToolOutput === 'string' && o.updatedMCPToolOutput.length > 4200 && o.updatedMCPToolOutput.length < 12200 && o.updatedToolOutput === o.updatedMCPToolOutput);
  assert.ok(logs(store).some(l => l.op === 'diet' && l.kind === 'cap' && l.tool === 'mcp:rea'));
  assert.equal(hook(dir, 'tool', { ...ev, tool_name: 'mcp__other__q' }), '', 'another server passes');
  assert.equal(hook(dir, 'tool', { ...ev, tool_response: [{ type: 'text', text: 'small' }] }), '', 'a result within the cap passes');
});

test('toolOutput carries the replacement beside the context only for Claude Code', () => {
  assert.deepEqual(JSON.parse(toolOutput('claude', '', { updated: 'y', mcp: true })), { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'y', updatedMCPToolOutput: 'y' } });
  assert.deepEqual(JSON.parse(toolOutput('claude', 'ctx', { updated: { stdout: 'x' } })), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'ctx', updatedToolOutput: { stdout: 'x' } } });
  assert.deepEqual(JSON.parse(toolOutput('claude', '', { updated: { stdout: 'x' } })), { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: 'x' } } });
  assert.deepEqual(JSON.parse(toolOutput('claude', 'ctx')), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'ctx' } });
  assert.deepEqual(JSON.parse(toolOutput('gemini', 'ctx', { updated: { stdout: 'x' } })), { hookSpecificOutput: { hookEventName: 'AfterTool', additionalContext: 'ctx' } });
});

// The settings over time, from the log of every setting made: what a tool's output was compressed at when a call was made
test('dietTimeline: the level a tool had at a time, from the diet-settings log, the config of now from the last entry on', () => {
  const log = [
    { t: '2026-10-22T20:00:54.033Z', op: 'diet-settings', tools: { 'mcp:artemis': 'moderate' } },
    { t: '2026-10-22T20:00:54.036Z', op: 'diet-settings', tools: { 'mcp:artemis': 'moderate', 'Bash:sed': 'moderate' } },
    { t: '2026-10-23T09:00:00.000Z', op: 'diet', kind: 'cap', before: 1, after: 1 },
  ];
  const cfg = { enabled: true, tools: { 'mcp:artemis': 'moderate', 'Bash:sed': 'moderate' } };
  const tl = dietTimeline(cfg, log), at = s => Date.parse(s);
  assert.equal(tl.levelAt('Bash:sed', at('2026-10-22T19:00:00Z')), null, 'none before the first setting');
  assert.equal(tl.levelAt('Bash:sed', at('2026-10-22T20:00:54.034Z')), null, 'between the two: sed not yet set');
  assert.equal(tl.levelAt('Bash:sed', at('2026-10-23T00:00:00Z')), 'moderate');
  assert.equal(tl.levelAt('mcp:artemis', at('2026-10-23T00:00:00Z')), 'moderate');
  assert.equal(tl.levelAt('Bash:grep', at('2026-10-23T00:00:00Z')), null);
  assert.equal(tl.since('Bash:sed', 'moderate'), at('2026-10-22T20:00:54.036Z'));
  assert.equal(tl.since('Bash:sed', null), null, 'not what it is now');
  // a config edited by hand since the last entry is the truth from that entry on; with no entry at all, for all time
  const hand = dietTimeline({ enabled: true, tools: { 'Bash:sed': 'high' } }, log);
  assert.equal(hand.levelAt('Bash:sed', at('2026-10-23T00:00:00Z')), 'high');
  assert.equal(hand.levelAt('Bash:sed', at('2026-10-22T20:00:54.034Z')), null);
  assert.equal(dietTimeline(cfg, []).levelAt('Bash:sed', at('2020-01-01T00:00:00Z')), 'moderate');
  assert.equal(dietTimeline({ enabled: false }, []).levelAt('Bash:sed', at('2026-10-23T00:00:00Z')), null);
  // the key names the timeline: another snapshot, or another config of now, is another key
  assert.notEqual(tl.key, hand.key); assert.equal(tl.key, dietTimeline(cfg, log).key); assert.notEqual(tl.key, dietTimeline(cfg, log.slice(1)).key);
  // levelOf as toolLevel sees a call: a program's own level, else Bash's; an MCP server moderate at any level set
  assert.equal(levelOf({ tools: { Bash: 'high' } }, 'Bash:sed'), 'high');
  assert.equal(levelOf({ tools: { 'mcp:x': 'high' } }, 'mcp:x'), 'moderate');
  assert.equal(levelOf({ enabled: true }, 'Bash:sed'), 'moderate', 'a config without tools: moderate for every compressible tool');
  assert.equal(levelOf({ enabled: true }, 'Grep'), null);
});

test('a cd prefix is stripped whichever separator follows it', t => {
  const dir = repo(t); const store = new Store(dir).init(); on(store, { minLines: 50, window: 4 });
  rememberTerms(store, 's1', { prompt: 'fix helper_42' });
  const content = fs.readFileSync(path.join(dir, 'src/big.py'), 'utf8');
  const cat = sep => dietResult(store, { session: 's1', repo: dir, cwd: dir, name: 'Bash', input: { command: `cd ${dir}${sep} cat src/big.py` }, response: { stdout: content, stderr: '' } });
  assert.equal(cat(' &&').kind, 'read');
  assert.equal(cat(';').kind, 'read', 'a cd before a semicolon hid the read before');
});

test('a setting named in the config survives the tool level, so the cap can be tuned without a release', t => {
  const dir = repo(t); const store = new Store(dir).init();
  const out = Array.from({ length: 300 }, (_, i) => `src/generated/file_${i}.py`).join('\n') + '\n';
  const call = () => dietResult(store, { session: 's1', repo: dir, cwd: dir, name: 'Bash', input: { command: 'ls -R .' }, response: { stdout: out, stderr: '' } });
  on(store);
  assert.ok(out.length > 4000 && out.length < 12000, 'the fixture sits between the two caps');
  assert.equal(call(), null, 'this much output passes under moderate’s 12k cap');
  on(store, { outputChars: 4000 });
  assert.equal(dietConfig(store).outputChars, 4000);
  const r = call();
  assert.equal(r.kind, 'cap');
  // the kept head and tail fit the cap; the marker naming the gap is added on top of it
  assert.ok(r.after < r.before && r.after <= 4000 + 200, `the cap the person set is the cap that is applied, got ${r.after}`);
  // the rest of the level is untouched by naming one setting
  on(store, { outputChars: 4000, tools: { Bash: 'high' } });
  assert.ok(call().after <= 4000 + 200, 'naming one setting leaves the rest of the level alone');
});
