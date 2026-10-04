// Spending less on learning: one distill per session rather than per turn, the model call without
// Claude Code's own system prompt, fewer and less repetitive notes, and `find` behind a miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createNote } from '../src/ops.js';
import { batchDue, BATCH_CHARS, relatedNotes, distillEvents, MAX_NOTES } from '../src/distill.js';
import { installClient } from '../src/clients.js';
import { complete, resetFallback } from '../src/llm.js';

process.env.THINKER_TELEMETRY = 'off';
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const git = (repo, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
function gitRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-spend-')));
  git(dir, 'init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), 'export function fetchRows() {\n  return 1;\n}\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
const withEnv = async (vars, fn) => {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : process.env[k] = v; resetFallback(); }
};

const read = (i, result) => ({ t: 'tool', name: 'Read', input: { file_path: `src/f${i}.js` }, result });

test('a small backlog is left for the end of the session; one near the trace limit is distilled', () => {
  const small = [{ t: 'prompt', text: 'fix it' }, read(1, 'x'.repeat(500)), { t: 'say', text: 'done' }];
  assert.equal(batchDue(small), false);
  const big = [{ t: 'prompt', text: 'fix it' }, ...Array.from({ length: Math.ceil(BATCH_CHARS / 900) + 5 }, (_, i) => read(i, 'y'.repeat(2000))), { t: 'say', text: 'done' }];
  assert.equal(batchDue(big), true);
});

test('distill --batch makes no model call for a small backlog, and the session end distills it', () => {
  const dir = gitRepo();
  new Store(dir).init();
  const marker = path.join(dir, 'called');
  const script = path.join(dir, 'model.js');
  fs.writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(marker)}, 'x'); process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ notes: [] })));`);
  const trace = path.join(dir, 'trace.jsonl');
  fs.writeFileSync(trace, [{ t: 'prompt', text: 'where are rows fetched' }, ...[1, 2, 3].map(i => ({ t: 'tool', name: 'Read', input: { file_path: 'src/a.js' }, result: 'export function fetchRows' + i })), { t: 'say', text: 'in src/a.js:fetchRows' }].map(e => JSON.stringify(e)).join('\n') + '\n');
  const env = { ...process.env, THINKER_LLM_CMD: `node "${script}"`, THINKER_LLM: '', ANTHROPIC_API_KEY: '', THINKER_LOG: 'local', THINKER_QUIET: '1' };
  const run = extra => execFileSync('node', [CLI, 'distill', trace, '--format', 'events', '--incremental', '--session', 's1', '--repo', dir, ...extra], { encoding: 'utf8', env });
  assert.match(run(['--batch']), /left for the end of the session/);
  assert.ok(!fs.existsSync(marker), 'no model call at the end of a turn');
  run([]);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x', 'one model call when the session ends');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Claude Code gets a SessionEnd hook beside Stop when learning is on', () => {
  const dir = gitRepo();
  installClient('claude', { repo: dir, cli: CLI, mcpEntry: { command: 'node', args: ['/x/mcp.js'] }, hooks: true, learn: true, late: false, shared: false, mcp: false });
  const hooks = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8')).hooks;
  assert.ok(hooks.Stop[0].hooks[0].command.endsWith('hook stop'));
  assert.ok(hooks.SessionEnd[0].hooks[0].command.endsWith('hook stop'));
  installClient('claude', { repo: dir, cli: CLI, mcpEntry: { command: 'node', args: ['/x/mcp.js'] }, hooks: true, learn: false, late: false, shared: false, mcp: false });
  const again = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.local.json'), 'utf8')).hooks;
  assert.ok(!again.SessionEnd && !again.Stop, 'learning off: neither');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claude -p runs with its system prompt replaced, no settings and no skills', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-fakeclaude-')));
  const argsFile = path.join(dir, 'args.json');
  fs.writeFileSync(path.join(dir, 'claude'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: 'ok', usage: {}, total_cost_usd: 0, model: 'claude-haiku-4-5' })));\n`);
  fs.chmodSync(path.join(dir, 'claude'), 0o755);
  await withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH}`, THINKER_LLM: 'claude', THINKER_LLM_CMD: undefined, ANTHROPIC_API_KEY: undefined, THINKER_QUIET: '1' }, async () => {
    await complete({ system: 'You check notes.', prompt: 'hi', model: 'haiku' });
    const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.equal(args[args.indexOf('--system-prompt') + 1], 'You check notes.');
    assert.ok(!args.includes('--append-system-prompt'), 'appending kept ~7k tokens of agent instructions in every call');
    assert.equal(args[args.indexOf('--setting-sources') + 1], '');
    assert.ok(args.includes('--disable-slash-commands'));
    await complete({ prompt: 'hi', model: 'haiku' });
    const bare = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.ok(bare[bare.indexOf('--system-prompt') + 1].length > 0, 'a short prompt of its own when the caller gives none');
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the distiller is shown notes on the topic of the session even when it touched none of their files', () => {
  const repo = gitRepo();
  const store = new Store(repo).init();
  const tests = createNote(store, { title: 'Run the test suite with telemetry off', kind: 'howto', answers: ['how do I run the tests', 'which env for the test suite'], body: 'THINKER_TELEMETRY=off node --test test/*.test.js', deps: [{ path: 'src/a.js' }] }).note;
  const events = [{ t: 'prompt', text: '<thinker-cache>notes about billing</thinker-cache> run the test suite and fix what fails' }, { t: 'tool', name: 'Bash', input: { command: 'npm test' }, result: 'ok' }];
  assert.deepEqual(relatedNotes(store, events).map(n => n.id), [tests.id]);
  assert.deepEqual(relatedNotes(store, [{ t: 'prompt', text: 'rename the billing page header' }]).map(n => n.id), [], 'nothing on another topic');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('one distill keeps at most MAX_NOTES notes, the surest first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-max-'));
  const script = path.join(dir, 'model.js');
  const notes = [0.5, 0.9, 0.6, 0.8, 0.7].map((c, i) => ({ title: `note ${i}`, kind: 'gotcha', answers: [], body: 'b', deps: [], tags: [], confidence: c }));
  fs.writeFileSync(script, `process.stdin.resume(); process.stdin.on('end', () => console.log(${JSON.stringify(JSON.stringify({ notes }))}));`);
  await withEnv({ THINKER_LLM_CMD: `node "${script}"`, THINKER_LLM: undefined, ANTHROPIC_API_KEY: undefined, THINKER_QUIET: '1' }, async () => {
    const r = await distillEvents([{ t: 'prompt', text: 'x' }, { t: 'say', text: 'y' }]);
    assert.equal(r.notes.length, MAX_NOTES);
    assert.deepEqual(r.notes.map(n => n.confidence), [0.9, 0.8, 0.7]);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('find does not credit a one-line definition with the text that follows it', async () => {
  const { findSymbols } = await import('../src/codegraph.js');
  const dir = gitRepo();
  fs.writeFileSync(path.join(dir, 'src/cli.js'), [
    'const entry = () => ({ command: "node" });', '',
    'const HELP = `usage:', '  compare versions of the install', '  semver versions compared here', '  installed versions listed`;', '',
    'export function compareVersions(a, b) {', '  // semver: compare installed versions part by part', '  return a.split(".").map(Number)[0] - b.split(".").map(Number)[0];', '}', '',
  ].join('\n'));
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'cli');
  const r = await withEnv({ THINKER_AST: 'off', THINKER_CODEGRAPH: 'git' }, () => findSymbols(dir, 'semver comparison of installed versions'));
  assert.equal(r.hits[0].symbol, 'compareVersions');
  assert.ok(!r.hits.some(h => h.symbol === 'entry'), 'the help text below it is not its body');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a long request is not answered by a note that shares one word counted twice', async () => {
  const { rank } = await import('../src/rank.js');
  const note = (id, title, body) => ({ id, kind: 'location', title, answers: [], body, deps: [], status: 'fresh', confidence: 0.9 });
  const notes = [
    note('notice', 'Cache hit notice display', 'The hook prints cache hit counts; claude shows the usage line, the hit total and tokens.'),
    note('retry', 'Waiting before a retry when claude hits a usage limit', 'llm.js:viaCli waits ten minutes and retries when claude reports a usage limit.'),
    ...['ranking floors', 'store layout', 'sync server', 'review strategies', 'cochange mining'].map((t, i) => note('f' + i, t, `${t} live in their own module.`)),
  ];
  const ids = rank(notes, { query: 'change how long we wait before retrying when claude -p hits a usage limit' }).filter(r => r.rel > 0).map(r => r.note.id);
  assert.ok(ids.includes('retry'));
  assert.ok(!ids.includes('notice'), 'hit, claude and usage: three words, one of them counted on both sides');
});
