import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readOf, suiteCommand, decide, delegateTool, delegateConfig, denial, DELEGATE_DEFAULTS, TOKENS_PER_CHAR, explorerBrief, hostEvent, HOSTS, lastPromptOf, shellRead } from '../src/delegate.js';
import { installClient } from '../src/clients.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-delegate-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const bigFile = (dir, name, lines = 3000) => { const f = path.join(dir, name); fs.writeFileSync(f, Array.from({ length: lines }, (_, i) => `def f${i}(x):\n    return x + ${i}\n`).join('')); return f; };
const smallFile = (dir, name) => { const f = path.join(dir, name); fs.writeFileSync(f, 'a = 1\nb = 2\n'); return f; };

test('readOf: a Read is sized from the file, a ranged Read from its lines, a cat from its files, a piped cat is not a read', t => {
  const d = tmp(t); const big = bigFile(d, 'core.py'), small = smallFile(d, 'x.py');
  const full = readOf('Read', { file_path: big }, d);
  assert.ok(full.tokens > 30000 && full.tokens < 80000, String(full.tokens));
  assert.deepEqual(full.files, [big]);
  const ranged = readOf('Read', { file_path: big, offset: 100, limit: 40 }, d);
  assert.ok(ranged.tokens < full.tokens / 50, `${ranged.tokens} vs ${full.tokens}`);
  assert.equal(readOf('Read', { file_path: path.join(d, 'missing.py') }, d), null);
  assert.equal(readOf('Bash', { command: 'cat core.py' }, d).files[0], big);
  assert.equal(readOf('Bash', { command: 'cat core.py | grep def' }, d), null);
  assert.equal(readOf('Bash', { command: 'sed -n 1,50p core.py' }, d).files[0], big);
  // a shell line that asks for a range is the model reading the lines it edits, and is sized by that range
  const sedRange = readOf('Bash', { command: "sed -n '273,290p' core.py" }, d);
  assert.ok(sedRange.tokens < 1000, String(sedRange.tokens));
  assert.ok(readOf('Bash', { command: "sed -n '42p' core.py" }, d).tokens < 100);
  assert.deepEqual(shellRead("sed -n '10,+20p' core.py"), { files: ['core.py'], lines: 21 });
  // an open range or a pattern says nothing about the size: the whole file counts
  assert.equal(shellRead("sed -n '100,$p' core.py").lines, 0);
  assert.equal(readOf('Bash', { command: "sed -n '100,$p' core.py" }, d).tokens, readOf('Bash', { command: 'cat core.py' }, d).tokens);
  assert.equal(readOf('Bash', { command: 'ls -la' }, d), null);
  assert.equal(readOf('Grep', { pattern: 'x' }, d), null);
  assert.ok(readOf('Read', { file_path: small }, d).tokens < 100);
});

test('suiteCommand: whole-suite runs only', () => {
  for (const c of ['.venv/bin/python -m pytest -q', 'pytest', 'python -m pytest -v', 'npm test', 'go test ./...', 'cargo test', 'node --test', 'cd src && npm test'])
    assert.equal(suiteCommand('Bash', { command: c }), c, c);
  for (const c of ['pytest tests/test_x.py', '.venv/bin/python -m pytest -q tests/test_a.py::test_b', 'npm test -- test/one.test.js', 'ls', 'python script.py', 'pytest -q | python summarise.py'])
    assert.equal(suiteCommand('Bash', { command: c }), null, c);
  // a pipe that only trims the output still runs the whole suite: the verifier gets the bare command
  assert.equal(suiteCommand('Bash', { command: '.venv/bin/python -m pytest -q 2>&1 | tail -5' }), '.venv/bin/python -m pytest -q');
  assert.equal(suiteCommand('Bash', { command: 'npm test 2>&1 | grep -E "pass|fail" | head -3' }), 'npm test');
  assert.equal(suiteCommand('Bash', { command: 'pytest tests/test_x.py 2>&1 | tail -3' }), null, 'one file stays with the model');
  assert.equal(suiteCommand('Read', { file_path: 'pytest' }), null);
});

test('decide: the turn tally, the thresholds, and the prompt boundary', () => {
  const cfg = { ...DELEGATE_DEFAULTS, threshold: 35000, minRead: 8000 };
  const st = {};
  // one big read fires at once
  assert.equal(decide(st, { prompt: 'p1', read: { tokens: 40000, files: ['a'] }, cfg }).fire, true);
  assert.equal(st.delegate.readTokens, 0, 'a delegated read never enters the context');
  // small reads accumulate but never fire on their own
  for (let i = 0; i < 10; i++) assert.equal(decide(st, { prompt: 'p1', read: { tokens: 3000, files: ['s' + i] }, cfg }).fire, false);
  assert.equal(st.delegate.readTokens, 30000);
  // a medium read that takes the turn past the threshold fires; a tiny one past it does not
  assert.equal(decide(st, { prompt: 'p1', read: { tokens: 2000, files: ['t'] }, cfg }).fire, false);
  assert.equal(decide(st, { prompt: 'p1', read: { tokens: 9000, files: ['m'] }, cfg }).fire, true);
  assert.equal(st.delegate.readTokens, 32000);
  // a new prompt starts the tally again
  assert.equal(decide(st, { prompt: 'p2', read: { tokens: 9000, files: ['m'] }, cfg }).fire, false);
  assert.equal(st.delegate.readTokens, 9000);
  // a suite run fires regardless of the tally
  assert.equal(decide(st, { prompt: 'p2', suite: 'pytest', cfg }).kind, 'verify');
});

// The fallback path: thinker's own `claude -p` subagent, which is off by default since 2026-11-12 (the host's
// own subagent does the work; test/delegate-handoff.test.js covers that). These tests ask for it by name.
test('delegateTool: denies with the report, caches per file and turn, holds out by session, and allows on a subagent failure', async t => {
  const d = tmp(t); const big = bigFile(d, 'core.py');
  const cfg = { ...DELEGATE_DEFAULTS, holdout: 0, handoff: false, fallback: true };
  let st = {}; const state = { update: fn => fn(st) }; const rows = []; const runs = [];
  const run = async ({ kind, brief }) => { runs.push({ kind, brief }); return { report: 'core.py:10 class Foo: the thing', usage: { output_tokens: 5 }, cost: 0.01, model: 'claude-sonnet-5-5', ms: 5 }; };
  const ev = { tool_name: 'Read', tool_input: { file_path: big }, prompt_id: 'p1' };
  const o = await delegateTool({ ev, state, session: 'sess', cwd: d, cfg, log: r => rows.push(r), run, lastPrompt: () => ({ prompt: 'add sort_commands', lastSay: 'Let me read core.py' }) });
  const j = JSON.parse(o);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /core\.py:10 class Foo/);
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /offset and limit/);
  assert.equal(runs.length, 1); assert.equal(runs[0].kind, 'explore');
  assert.match(runs[0].brief, /add sort_commands/); assert.match(runs[0].brief, /Let me read core\.py/); assert.match(runs[0].brief, /core\.py/);
  assert.equal(rows[0].op, 'delegate'); assert.equal(rows[0].held, false); assert.equal(rows[0].cost, 0.01); assert.deepEqual(rows[0].files, ['core.py']);
  // the same read again this turn: the cached report, no second run
  const o2 = await delegateTool({ ev, state, session: 'sess', cwd: d, cfg, log: r => rows.push(r), run });
  assert.match(JSON.parse(o2).hookSpecificOutput.permissionDecisionReason, /class Foo/);
  assert.equal(runs.length, 1); assert.equal(rows[1].cached, true);
  // a ranged read of the same file is never delegated
  assert.equal(await delegateTool({ ev: { ...ev, tool_input: { file_path: big, offset: 10, limit: 30 } }, state, session: 'sess', cwd: d, cfg, log: r => rows.push(r), run }), null);
  // a held-out session logs the would-have-fired row and lets the read through
  st = {};
  const held = await delegateTool({ ev, state, session: 'sess', cwd: d, cfg: { ...cfg, holdout: 1 }, log: r => rows.push(r), run });
  assert.equal(held, null); assert.equal(rows.at(-1).held, true); assert.equal(runs.length, 1);
  // a subagent failure lets the read through and logs the error
  st = {};
  const failed = await delegateTool({ ev, state, session: 'sess', cwd: d, cfg, log: r => rows.push(r), run: async () => ({ error: 'timeout', ms: 1 }) });
  assert.equal(failed, null); assert.equal(rows.at(-1).error, 'timeout');
  // a suite run goes to the verifier
  st = {};
  const v = await delegateTool({ ev: { tool_name: 'Bash', tool_input: { command: 'pytest -q' }, prompt_id: 'p1' }, state, session: 'sess', cwd: d, cfg, log: r => rows.push(r), run });
  assert.match(JSON.parse(v).hookSpecificOutput.permissionDecisionReason, /ran this test command/);
  assert.equal(runs.at(-1).kind, 'verify'); assert.match(runs.at(-1).brief, /pytest -q/);
  // not a read, not a suite: nothing
  assert.equal(await delegateTool({ ev: { tool_name: 'Bash', tool_input: { command: 'git status' }, prompt_id: 'p1' }, state, session: 'sess', cwd: d, cfg, log: r => rows.push(r), run }), null);
});

test('delegateConfig: defaults, the machine config, and the environment', t => {
  const home = tmp(t);
  assert.equal(delegateConfig({ env: {}, home }).enabled, false, 'off by default');
  assert.equal(delegateConfig({ env: { THINKER_DELEGATE: 'on' }, home }).enabled, true);
  assert.equal(delegateConfig({ env: {}, home }).threshold, 35000);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ delegate: { enabled: true, threshold: 20000, model: 'claude-haiku-5-5' } }));
  const c = delegateConfig({ env: {}, home });
  assert.equal(c.threshold, 20000); assert.equal(c.model, 'claude-haiku-5-5'); assert.equal(c.enabled, true);
  assert.equal(delegateConfig({ env: { THINKER_DELEGATE: 'off' }, home }).enabled, false);
  assert.equal(delegateConfig({ env: { THINKER_DELEGATE: 'claude-opus-5-5' }, home }).model, 'claude-opus-5-5');
  assert.equal(delegateConfig({ env: { THINKER_DELEGATE_HOLDOUT: 'off' }, home }).holdout, 0);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ delegate: false }));
  assert.equal(delegateConfig({ env: {}, home }).enabled, false);
});

test('the hook command: a small read passes in silence, a big read is denied with the subagent report, off is off', t => {
  const repo = tmp(t); const home = tmp(t);
  execFileSync('git', ['init', '-q', repo]);
  const big = bigFile(repo, 'core.py'), small = smallFile(repo, 'x.py');
  // a fake claude binary: answers the JSON shape of `claude -p --output-format json`
  const bin = path.join(home, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\necho '{"result":"core.py:1 def f0: the first function","session_id":"sub1","total_cost_usd":0.02,"model":"claude-sonnet-5-5","usage":{"output_tokens":9}}'\n`); fs.chmodSync(bin, 0o755);
  const env = { ...process.env, THINKER_HOME: home, THINKER_TEST: '1', THINKER_HOOKS: 'on', THINKER_LOG: 'local', THINKER_DELEGATE: 'on', THINKER_DELEGATE_BIN: bin, THINKER_DELEGATE_HOLDOUT: 'off', THINKER_DELEGATE_HANDOFF: 'off', THINKER_DELEGATE_FALLBACK: 'on' };
  const hook = (input, over = {}) => execFileSync('node', [CLI, 'hook', 'pretool', '--client', 'claude', '--user'], { input: JSON.stringify(input), encoding: 'utf8', env: { ...env, ...over } });
  const ev = f => ({ session_id: 'hooksess', prompt_id: 'p1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: f } });
  assert.equal(hook(ev(small)), '');
  const out = hook(ev(big));
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /def f0: the first function/);
  const rowsOf = () => fs.readFileSync(path.join(repo, '.thinker', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.op === 'delegate');
  const log = rowsOf();
  // The small read passed in silence, but it still left a row saying it was declined: without one,
  // "the hook never ran" and "the hook ran and the turn never reached the threshold" are the same
  // silence, and on 2026-11-14 a whole PostHog pair could not be read for exactly that reason.
  assert.equal(log.length, 2);
  assert.equal(log[0].fired, false); assert.equal(log[0].declined, 'below-threshold');
  assert.deepEqual(log[0].files, ['x.py']); assert.equal(typeof log[0].turnTokens, 'number');
  assert.equal(log[1].cost, 0.02); assert.equal(log[1].subagent, 'sub1'); assert.deepEqual(log[1].files, ['core.py']);
  // the same read again: the cached report, no second log row with a cost
  assert.match(JSON.parse(hook(ev(big))).hookSpecificOutput.permissionDecisionReason, /def f0/);
  const log2 = rowsOf();
  assert.equal(log2.length, 3); assert.equal(log2[2].cached, true);
  // off: silence, and no row
  assert.equal(hook(ev(big), { THINKER_DELEGATE: 'off' }), '');
  // another client's event: nothing
  assert.equal(execFileSync('node', [CLI, 'hook', 'pretool', '--client', 'codex', '--user'], { input: JSON.stringify(ev(big)), encoding: 'utf8', env }), '');
});

test('wiring: Claude Code gets the PreToolUse entry on Read|Bash only while the trigger is on, with a timeout that covers a subagent run', t => {
  const dir = tmp(t);
  // the wiring reads the machine config, so the test needs a home of its own: on a machine that has the
  // trigger switched on, `delete process.env.THINKER_DELEGATE` alone left `delegate.enabled` true and the
  // "off by default" assertion below failed against the real config.
  const was = { d: process.env.THINKER_DELEGATE, h: process.env.THINKER_HOME };
  t.after(() => { for (const [k, v] of [['THINKER_DELEGATE', was.d], ['THINKER_HOME', was.h]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  delete process.env.THINKER_DELEGATE;
  process.env.THINKER_HOME = path.join(dir, 'home');
  fs.mkdirSync(process.env.THINKER_HOME, { recursive: true });
  installClient('claude', { repo: dir, cli: CLI, hooks: true, learn: false, late: false, shared: true, mcp: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).hooks.PreToolUse, undefined, 'off by default: no entry, no node process per tool call');
  process.env.THINKER_DELEGATE = 'on';
  installClient('claude', { repo: dir, cli: CLI, hooks: true, learn: false, late: false, shared: true, mcp: false });
  const c = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.equal(c.hooks.PreToolUse.length, 1);
  assert.equal(c.hooks.PreToolUse[0].matcher, 'Read|Bash');
  assert.match(c.hooks.PreToolUse[0].hooks[0].command, /hook pretool/);
  // a handoff spawns nothing, so the hook answers at once and does not need the fallback's long timeout
  assert.ok(c.hooks.PreToolUse[0].hooks[0].timeout <= 60, 'a handoff needs no room for a subagent run');
  process.env.THINKER_DELEGATE_FALLBACK = 'on';
  t.after(() => { delete process.env.THINKER_DELEGATE_FALLBACK; });
  installClient('claude', { repo: dir, cli: CLI, hooks: true, learn: false, late: false, shared: true, mcp: false });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].timeout >= 240, 'the fallback subagent run takes minutes');
  delete process.env.THINKER_DELEGATE_FALLBACK;
  installClient('claude', { repo: dir, cli: CLI, hooks: true, learn: false, late: false, shared: true, mcp: false });
  // a rewire replaces, never doubles
  installClient('claude', { repo: dir, cli: CLI, hooks: true, learn: false, late: false, shared: true, mcp: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8')).hooks.PreToolUse.length, 1);
});

test('hostEvent and readCap: OpenCode names its tools in lower case, takes `path`, and returns one read in chunks', t => {
  const d = tmp(t); const big = bigFile(d, 'core.py');
  const ev = hostEvent('opencode', { tool_name: 'read', tool_input: { path: big, offset: 1 } });
  assert.equal(ev.tool_name, 'Read'); assert.equal(ev.tool_input.file_path, big); assert.equal(ev.tool_input.offset, 1);
  assert.equal(hostEvent('opencode', { tool_name: 'shell', tool_input: { command: 'pytest' } }).tool_name, 'Bash');
  assert.equal(hostEvent('claude', { tool_name: 'Read', tool_input: { file_path: big } }).tool_name, 'Read');
  const full = readOf('Read', { file_path: big }, d), capped = readOf('Read', { file_path: big }, d, { readCap: HOSTS.opencode.readCap });
  assert.ok(capped.tokens < full.tokens && capped.tokens > 20000, `${capped.tokens} of ${full.tokens}`);
  assert.equal(capped.fileTokens, full.tokens, 'the file asked for is the whole file');
  // the first chunk of a big file fires, since the model would read the rest anyway; a chunk of a small one does not
  const st = {}, cfg = { ...DELEGATE_DEFAULTS, threshold: 35000, minRead: 8000 };
  assert.equal(decide(st, { prompt: 'p', read: capped, cfg }).fire, true);
  assert.equal(decide(st, { prompt: 'p', read: { tokens: 20000, fileTokens: 20000, files: ['m'] }, cfg }).fire, false);
  assert.equal(decide(st, { prompt: 'p', read: { tokens: 20000, fileTokens: 20000, files: ['m'] }, cfg }).fire, true, 'the tally still adds up');
});

test('denial and brief shapes', () => {
  const j = JSON.parse(denial({ kind: 'explore', report: 'R', files: ['/r/a.py'], cwd: '/r', model: 'm' }));
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /read a\.py through a m subagent/);
  assert.match(explorerBrief({ files: ['/r/a.py'], prompt: 'P', cwd: '/r' }), /At most 25 lines/);
  assert.ok(TOKENS_PER_CHAR > 0.4 && TOKENS_PER_CHAR < 0.5);
});

test('lastPromptOf: the request is found past the tail window', t => {
  const d = tmp(t), f = path.join(d, 'session.jsonl');
  const rows = [JSON.stringify({ type: 'user', message: { content: 'rewrite the savings footer in dollars' } })];
  // one prompt and a hundred tool calls: the person's words sit far behind the tail thinker reads first
  for (let i = 0; i < 200; i++) {
    rows.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${i} ` + 'x'.repeat(200) }] } }));
    rows.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'y'.repeat(2000) }] } }));
  }
  fs.writeFileSync(f, rows.join('\n') + '\n');
  assert.ok(fs.statSync(f).size > 400_000, 'the fixture must outgrow the tail');
  const r = lastPromptOf(f);
  assert.equal(r.prompt, 'rewrite the savings footer in dollars');
  assert.ok(r.lastSay.startsWith('step 199'));
  // the tail alone is what a short session costs, and it still answers
  assert.equal(lastPromptOf(f, 600_000).prompt, 'rewrite the savings footer in dollars');
  assert.deepEqual(lastPromptOf(path.join(d, 'gone.jsonl')), {});
});
