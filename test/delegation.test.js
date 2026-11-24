// Delegation: a big read or a whole-suite test run handed to a subagent on a cheaper model, through the one
// door that can refuse a tool call and answer in its place. What a person notices when it breaks: a file they
// told the model to read taken away from it, a read refused with nowhere to take it, or small reads handed
// off. The rule is thinker's (`decide`, the keep list, the holdout, the log row) and the run is the host's.
import { tmp, repo } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DELEGATE_DEFAULTS, delegateConfig, delegateTool, preToolHook, decide, readOf, suiteCommand,
  hostEvent, HOSTS, OPENCODE_EXPLORE, CLAUDE_VERIFY,
} from '../src/delegate.js';
import { installClaudeVerifier, claudeVerifierPath } from '../src/delegate-agents.js';
import { runHosted, hostedCredits, hostedConfig, parseRun, HOSTED } from '../src/hosted.js';
import { opencodeV2 } from '../src/integrations/opencode-v2.js';
import { Store } from '../src/store.js';

const { threshold: THRESHOLD, handoffsPerTurn: BUDGET, repeatMin: REPEAT_MIN } = DELEGATE_DEFAULTS;

// Files of 40-character lines, sized so a whole read of one lands where the test wants it. A read is sized
// from the bytes on disk, so the first test checks the fixtures against the threshold rather than trusting it.
const dir = tmp('files');
const sized = (name, tokens) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, ('x'.repeat(39) + '\n').repeat(Math.ceil(tokens / 20)));
  return f;
};
const BIG = sized('core.py', THRESHOLD);
const SMALL = sized('small.py', THRESHOLD * 0.5);
const NOTES = sized('notes.md', THRESHOLD);
const MID = sized('mid.py', REPEAT_MIN);           // big enough to be pointed at, too small to be handed over
const WHOLE = sized('whole.py', THRESHOLD * 1.5);  // over the threshold as a shell read too, which carries no
const tokensOf = f => readOf('Read', { file_path: f }, dir).tokens;  // line numbers to pay for

const CFG = { ...DELEGATE_DEFAULTS, holdout: 0, repeats: false };
// The whole decision for one tool call, with the session's state, the log, the person's request and the
// subagent runner injected: no files but the one being read, no home, no process.
const door = (ev, o = {}) => delegateTool({
  ev, state: { update: fn => fn(o.st || {}) }, session: o.session || 'session-1', cwd: dir,
  client: o.client || 'claude', cfg: { ...CFG, ...o.cfg }, log: o.log || (() => {}),
  lastPrompt: () => ({ prompt: o.prompt ?? 'rename the handler' }), run: o.run, hosted: o.hosted, verifier: o.verifier,
  readCap: o.readCap || 0,
});
const read = (file, extra = {}) => ({ tool_name: 'Read', tool_input: { file_path: file, ...extra }, prompt_id: 'turn-1' });
const shell = command => ({ tool_name: 'Bash', tool_input: { command }, prompt_id: 'turn-1' });
const answer = out => JSON.parse(out).hookSpecificOutput;

// One scratch checkout for the tests that go through the hook itself (its state file, its lock, its log).
let only;
const store = () => (only ||= new Store(repo()).init());
const logged = s => fs.readFileSync(path.join(s.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('a big read is handed to a subagent and the denial says where to take it, while a smaller one goes through', async () => {
  assert.ok(tokensOf(BIG) >= THRESHOLD && tokensOf(SMALL) < THRESHOLD, 'the fixtures bracket the threshold');
  // the rule is one comparison, at the threshold itself
  const st = {};
  assert.equal(decide(st, { prompt: 'p', read: { tokens: THRESHOLD, files: ['a'] }, cfg: CFG }).fire, true, 'at the threshold');
  assert.equal(decide(st, { prompt: 'p', read: { tokens: THRESHOLD - 1, files: ['b'] }, cfg: CFG }).fire, false, 'one token under');
  // and nothing is added up: a turn of small reads never makes the next small read fire
  for (let i = 0; i < 30; i++) {
    assert.equal(decide(st, { prompt: 'p', read: { tokens: THRESHOLD - 1, files: [`s${i}`] }, cfg: CFG }).fire, false, `small read ${i}`);
  }
  const rows = [];
  const got = answer(await door(read(BIG), { log: r => rows.push(r) }));
  assert.equal(got.permissionDecision, 'deny');
  assert.match(got.permissionDecisionReason, /core\.py/, 'the file it would have read');
  assert.match(got.permissionDecisionReason, /Explore/, 'the subagent to take it to');
  assert.match(got.permissionDecisionReason, /Nothing has gone wrong/, 'a denial read as a fault is routed around');
  assert.match(got.permissionDecisionReason, /rename the handler/, 'the subagent is told what the person asked');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].kind, rows[0].agent, rows[0].held], ['explore', 'Explore', false]);
  assert.equal(rows[0].model, DELEGATE_DEFAULTS.model, 'the model it will be billed at, where thinker pins one');

  const quiet = [];
  assert.equal(await door(read(SMALL), { log: r => quiet.push(r) }), null, 'the small read goes through');
  assert.equal(quiet[0].declined, 'below-threshold');
});

test('after a denial the model can still read the lines it needs', async () => {
  const ranged = read(BIG, { offset: 10, limit: 20 });
  assert.ok(readOf('Read', ranged.tool_input, dir).tokens < THRESHOLD, 'twenty lines are a small read');
  assert.equal(await door(ranged), null);
});

test('a picture is never handed away, whatever its size on disk', async () => {
  // a screenshot the model took to look at its own page: big in bytes, and a report of it is not the picture
  for (const name of ['shot.png', 'page.JPG']) {
    const rows = [];
    assert.equal(await door(read(sized(name, THRESHOLD * 20)), { log: r => rows.push(r) }), null, name);
    assert.deepEqual([rows.length, rows[0].declined, rows[0].fired, 'tokens' in rows[0]], [1, 'image', false, false], name);
  }
  // an SVG is text, and a big one is a read like any other
  assert.equal(answer(await door(read(sized('logo.svg', THRESHOLD)))).permissionDecision, 'deny');
});

test('a file the person keeps is never handed away', async () => {
  const cases = [
    { name: 'their own notes', ev: read(NOTES), prompt: 'rename the handler', why: 'pattern' },
    { name: 'a file they named in this turn', ev: read(BIG), prompt: 'read core.py yourself and fix it', why: 'named' },
  ];
  for (const c of cases) {
    const rows = [];
    assert.equal(await door(c.ev, { prompt: c.prompt, log: r => rows.push(r) }), null, c.name);
    assert.deepEqual([rows[0].declined, rows[0].kept], ['kept', c.why], c.name);
  }
});

test('a held-out session is decided and logged but never denied', async () => {
  const rows = [];
  assert.equal(await door(read(BIG), { cfg: { holdout: 1 }, log: r => rows.push(r) }), null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].held, true);
  assert.equal(rows[0].tokens, tokensOf(BIG), 'the row says what the read would have cost');
});

test('a subagent reading for the model is never sent to another subagent', async () => {
  const cases = [
    { name: 'the main conversation on Claude Code', ev: read(BIG), client: 'claude', through: false },
    { name: 'a Claude Code subagent', ev: { ...read(BIG), agent_type: 'Explore' }, client: 'claude', through: true },
    { name: 'OpenCode\'s own build agent', ev: { ...read(BIG), agent: 'build' }, client: 'opencode', through: false },
    { name: 'thinker\'s OpenCode explorer', ev: { ...read(BIG), agent: OPENCODE_EXPLORE }, client: 'opencode', through: true },
    { name: 'an agent nobody knows', ev: { ...read(BIG), agent: 'someone-elses' }, client: 'opencode', through: true },
  ];
  for (const c of cases) {
    const out = await door(c.ev, { client: c.client });
    assert.equal(out === null, c.through, c.name);
  }
});

test('a turn hands over its budget of reads and no more, and never the same file twice', async () => {
  const st = {}, rows = [];
  const files = Array.from({ length: BUDGET + 1 }, (_, i) => sized(`part${i}.py`, THRESHOLD));
  for (const [i, f] of files.slice(0, BUDGET).entries()) {
    assert.ok(await door(read(f), { st, log: r => rows.push(r) }), `read ${i} of the budget`);
  }
  const over = [];
  assert.equal(await door(read(files[BUDGET]), { st, log: r => over.push(r) }), null, 'one read past the budget');
  assert.equal(over[0].after, 'budget');
  const again = [];
  assert.equal(await door(read(files[0]), { st, log: r => again.push(r) }), null, 'a file already handed over');
  assert.equal(again[0].after, 'handoff', 'the model that insists is given the file');
  // a new prompt is a new turn with a budget of its own
  assert.ok(await door({ ...read(files[0]), prompt_id: 'turn-2' }, { st }));
});

test('a whole-suite run goes to the verifier and one test file stays with the model', async () => {
  const cases = [
    ['npm test', 'npm test'], ['pytest', 'pytest'], ['cargo test', 'cargo test'],
    ['go test ./...', 'go test ./...'], ['node --test', 'node --test'],
    ['cd src && npm test', 'cd src && npm test'],
    ['pytest -q 2>&1 | tail -5', 'pytest -q'],
    ['pytest tests/test_one.py', null], ['npm test -- test/one.test.js', null],
    ['python script.py', null], ['ls', null],
  ];
  for (const [command, handed] of cases) assert.equal(suiteCommand('Bash', { command }), handed, command);
  const rows = [];
  const got = answer(await door(shell('npm test'), { verifier: true, log: r => rows.push(r) }));
  assert.equal(got.permissionDecision, 'deny');
  assert.match(got.permissionDecisionReason, new RegExp(CLAUDE_VERIFY), 'the suite run has a subagent of its own');
  assert.match(got.permissionDecisionReason, /Nothing has gone wrong/);
  // each handoff carries its own work and not the other's: a command to run here, a file to read above
  assert.match(got.permissionDecisionReason, /npm test/, 'the command the verifier is to run');
  assert.doesNotMatch(got.permissionDecisionReason, /core\.py|rename the handler/, 'nothing of a read\'s brief');
  assert.equal(rows[0].kind, 'verify');
  assert.equal(await door(shell('pytest tests/test_one.py')), null, 'one file is the model checking its own edit');
});

test('a shell line that prints a whole file is a read, and one that trims for itself is not', async () => {
  const rows = [];
  const call = command => door(shell(command), { log: r => rows.push(r) });
  assert.ok(await call('cat whole.py'), 'cat of a big file');
  assert.equal(await call('cat whole.py | grep def'), null, 'piped into grep');
  assert.equal(await call("sed -n '20,40p' whole.py"), null, 'a range of twenty lines');
  assert.equal(await call('head -n 5 whole.py'), null, 'the first five lines');
  assert.equal(await call('ls -la'), null, 'no file in it at all');
  // only a read leaves a row: a shell call thinker has no opinion on stays out of the log entirely
  assert.deepEqual(rows.map(r => r.declined ?? 'fired'), ['fired', 'below-threshold', 'below-threshold']);
});

test('each switch lets its own kind of work through', async () => {
  const off = [];
  assert.equal(await preToolHook({ ev: read(BIG), store: store(), session: 'switches', cwd: dir, cfg: { ...CFG, enabled: false } }), null, 'delegation off');
  assert.equal(await door(read(BIG), { cfg: { reads: false }, log: r => off.push(r) }), null, 'reads kept with the model');
  assert.equal(await door(shell('npm test'), { cfg: { suites: false }, log: r => off.push(r) }), null, 'suite runs kept with the model');
  assert.deepEqual(off, [], 'a switch that is off decides nothing and logs nothing');
});

test('what a person set in their own settings is what the trigger does', () => {
  const dir = tmp('settings');
  const set = delegate => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ delegate }));
    return delegateConfig({ env: {}, home: dir });
  };
  const chosen = set({ threshold: THRESHOLD * 4 });
  assert.equal(chosen.threshold, THRESHOLD * 4, 'the size they chose');
  assert.equal(chosen.enabled, true, 'and everything they did not choose left as it was');
  assert.equal(set(false).enabled, false, 'switched off altogether');
  assert.equal(set({ enabled: false }).enabled, false, 'switched off by its own key');
  assert.equal(delegateConfig({ env: {}, home: tmp('no-settings') }).threshold, THRESHOLD, 'nothing set, the default');
});

test('a read nothing can answer for goes through', async () => {
  const missing = [];
  assert.equal(await door(read(path.join(dir, 'gone.py')), { log: r => missing.push(r) }), null, 'a file that is not there');
  assert.deepEqual(missing, []);
  // thinker's own fallback subagent, where a host has none of its own: a run that fails or times out allows the read
  const rows = [];
  const out = await door(read(BIG), { cfg: { handoff: false, fallback: true }, run: async () => ({ error: 'timeout', ms: 2 }), log: r => rows.push(r) });
  assert.equal(out, null, 'the subagent failed');
  assert.equal(rows[0].error, 'timeout');
});

test('a file read again unchanged is answered with a pointer to the copy the model already has', async () => {
  const s = store(), session = 'pointer';
  assert.ok(tokensOf(MID) >= REPEAT_MIN && tokensOf(MID) < THRESHOLD, 'big enough to point at, too small to hand over');
  const hook = () => preToolHook({ ev: read(MID), store: s, session, cwd: dir, cfg: { ...DELEGATE_DEFAULTS, repeatHoldout: 0 } });
  assert.equal(await hook(), null, 'the first read lands in the context');
  const got = answer(await hook());
  assert.equal(got.permissionDecision, 'deny');
  assert.match(got.permissionDecisionReason, /you already have/);
  assert.match(got.permissionDecisionReason, /has not changed/);
  assert.match(got.permissionDecisionReason, /mid\.py/);
  assert.equal(await hook(), null, 'asked once more, it goes through');
  fs.appendFileSync(MID, 'def changed(): pass\n');
  assert.equal(await hook(), null, 'a file that changed is read again');
  const rows = logged(s).filter(r => r.op === 'repeat' && r.session === session);
  assert.deepEqual(rows.map(r => r.fired), [true, false]);
});

test('one tool call seen by both of Claude Code\'s doors is decided once', async () => {
  const s = store(), session = 'two-doors';
  const call = o => preToolHook({ ev: { ...read(BIG), tool_use_id: 'toolu_01', ...o }, store: s, session, cwd: dir, cfg: CFG });
  assert.ok(await call({ host_runs: true }), 'the door that gets there first decides');
  assert.equal(await call({}), null, 'the other door stands down');
  assert.equal(logged(s).filter(r => r.op === 'delegate' && r.session === session).length, 1, 'and writes no second row');
});

test('thinker writes its own subagent file and removes it again, and leaves a person\'s own alone', () => {
  const claudeDir = tmp('claude');
  const file = claudeVerifierPath(claudeDir);
  assert.equal(installClaudeVerifier({ claudeDir, model: 'claude-haiku-5-5' }).action, 'written');
  assert.match(fs.readFileSync(file, 'utf8'), /claude-haiku-5-5/, 'pinned to the cheap model');
  assert.equal(installClaudeVerifier({ claudeDir, model: 'claude-haiku-5-5' }).action, 'unchanged');
  assert.equal(installClaudeVerifier({ claudeDir, model: null }).action, 'removed');
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, '---\nname: thinker-verify\n---\nmy own agent\n');
  assert.equal(installClaudeVerifier({ claudeDir, model: 'claude-haiku-5-5' }).action, 'kept');
  assert.equal(installClaudeVerifier({ claudeDir, model: null }).action, 'kept');
  assert.equal(fs.readFileSync(file, 'utf8'), '---\nname: thinker-verify\n---\nmy own agent\n', 'untouched');
});

test('on OpenCode the read is understood in its own words and the denial comes back as the call\'s result', async () => {
  // its tools are lower case and its Read takes `path`
  const ev = hostEvent('opencode', { tool_name: 'read', tool_input: { path: BIG }, prompt_id: 'turn-1', agent: 'build' });
  assert.equal(ev.tool_name, 'Read');
  const rows = [];
  const got = answer(await door(ev, { client: 'opencode', readCap: HOSTS.opencode.readCap, log: r => rows.push(r) }));
  assert.match(got.permissionDecisionReason, new RegExp(OPENCODE_EXPLORE), 'the agent thinker installed there');
  assert.match(got.permissionDecisionReason, /Nothing has gone wrong/);
  assert.equal('model' in rows[0], false, 'it runs on the session\'s own model, so the row claims none');

  // the plugin's own door: what the hook denies is thrown, which OpenCode makes the tool call's result
  const hooks = {}, asked = [];
  await opencodeV2({ hooks: true, cli: 'cli.js', client: 'opencode', repo: dir }, async (what, e) => {
    asked.push([what, e.tool_name]);
    return JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'thinker stopped this call: all of core.py ... Nothing has gone wrong.' } });
  }).setup({
    location: { directory: dir },
    tool: { hook: (name, fn) => { hooks[name] = fn; } },
    session: { hook: () => {} },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  });
  await assert.rejects(() => hooks['execute.before']({ tool: 'read', input: { path: BIG }, sessionID: 'oc-1' }), /Nothing has gone wrong/);
  await hooks['execute.before']({ tool: 'edit', input: { filePath: BIG }, sessionID: 'oc-1' });
  assert.deepEqual(asked, [['pretool', 'read']], 'only a read or a shell call is ever asked about');
});

test('the installed hook answers a big read with a denial, and says nothing at all in a test run', () => {
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const checkout = repo();
  const file = path.join(checkout, 'core.py');
  fs.copyFileSync(BIG, file);
  // the two runs differ in one thing only: whether the hooks are allowed to speak in a test run. Each gets a
  // session of its own, or the second would be the same read as the first and go through for that reason.
  const run = (session, hooks) => execFileSync('node', [cli, 'hook', 'pretool', '--client', 'claude', '--user'], {
    input: JSON.stringify({ session_id: session, cwd: checkout, prompt_id: 'turn-1', tool_name: 'Read', tool_input: { file_path: file } }),
    encoding: 'utf8', env: { ...process.env, THINKER_DELEGATE_HOLDOUT: 'off', ...hooks },
  });
  const out = run('smoke-on', { THINKER_HOOKS: 'on' });
  assert.equal(answer(out).permissionDecision, 'deny');
  assert.match(answer(out).permissionDecisionReason, /core\.py/);
  assert.equal(run('smoke-off', {}), '', 'a test run must never reach a person\'s session');
});

// ---- thinker's hosted models: the read run by thinker itself, in OpenCode, on a model thinker serves ----
const HOSTED_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';

test('a read goes to thinker\'s hosted model when one is named, and the lead works from its report', async () => {
  const rows = [], runs = [];
  const hosted = async o => { runs.push(o); return { report: 'core.py:12 handler() is the one to rename', model: HOSTED_MODEL, cost: 0.0004, usage: { input_tokens: 4000, output_tokens: 90 }, ms: 900, sessionId: 'ses_1' }; };
  const o = { st: {}, cfg: { hosted: HOSTED_MODEL }, hosted, log: r => rows.push(r) };
  const said = answer(await door(read(BIG), o));
  assert.equal(said.permissionDecision, 'deny');
  assert.match(said.permissionDecisionReason, /thinker read core\.py through a DeepSeek-V4-Flash subagent/);
  assert.match(said.permissionDecisionReason, /core\.py:12 handler\(\) is the one to rename/);
  assert.equal(runs.length, 1);
  assert.match(runs[0].brief, /rename the handler/, 'the explorer is told what the person asked');
  assert.match(runs[0].system, /You explore a codebase/, 'and its standing instructions ride as the system prompt, not in the brief');
  assert.deepEqual([rows[0].mode, rows[0].hosted, rows[0].model, rows[0].cost, rows[0].subagent], ['report', true, HOSTED_MODEL, 0.0004, 'ses_1'], 'the row names the model and what the run cost');
  // the same read again this turn is answered from the report already made
  assert.match(answer(await door(read(BIG), o)).permissionDecisionReason, /handler\(\) is the one to rename/);
  assert.equal(runs.length, 1);
  // nothing is named, nothing is hosted; a suite run is never hosted; a held-out session is left alone
  assert.match(answer(await door(read(BIG), { hosted })).permissionDecisionReason, /Call the Agent tool/);
  assert.match(answer(await door(shell('npm test'), { cfg: { hosted: HOSTED_MODEL }, hosted })).permissionDecisionReason, /Call the Agent tool/);
  assert.equal(await door(read(BIG), { cfg: { hosted: HOSTED_MODEL, holdout: 1 }, hosted }), null);
  assert.equal(runs.length, 1);
});

test('where the hosted model cannot take a read, it goes to the host\'s own subagent as before', async () => {
  for (const error of ['no-credits', 'no-key', 'no-opencode', 'timeout']) {
    const rows = [];
    const said = answer(await door(read(BIG), { st: {}, cfg: { hosted: HOSTED_MODEL }, hosted: async () => ({ error, ms: 3 }), log: r => rows.push(r) }));
    assert.match(said.permissionDecisionReason, /Call the Agent tool .*subagent_type: "Explore"/, error);
    assert.deepEqual(rows.map(r => [r.mode, r.hosted ?? false, r.error ?? null]), [['report', true, error], ['handoff', false, null]], 'one row says why, the next is the handoff');
  }
  // a file the hosted run would be refused -- outside the project, or an .env -- is never sent to it
  let asked = 0;
  const hosted = async () => { asked += 1; return { report: 'x', model: HOSTED_MODEL }; };
  const elsewhere = path.join(tmp('elsewhere'), 'far.py');
  fs.writeFileSync(elsewhere, ('x'.repeat(39) + '\n').repeat(Math.ceil(THRESHOLD / 20) + 10));
  const env = path.join(dir, '.env');
  fs.writeFileSync(env, ('K=' + 'v'.repeat(37) + '\n').repeat(Math.ceil(THRESHOLD / 20) + 10));
  for (const file of [elsewhere, env]) assert.match(answer(await door(read(file), { cfg: { hosted: HOSTED_MODEL }, hosted })).permissionDecisionReason, /Call the Agent tool/);
  assert.equal(asked, 0);
  fs.rmSync(env);
});

test('a hosted run is OpenCode on thinker\'s endpoint under the machine\'s key, allowed to read and nothing else', async () => {
  const home = tmp('hosted-home'), out = tmp('hosted-out'), key = 'thk_live_' + 'a'.repeat(43);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ fleet: { inference: 'http://127.0.0.1:9/v1/' } }));
  const step = (reason, cost, tokens) => JSON.stringify({ type: 'step_finish', sessionID: 'ses_9', part: { type: 'step-finish', reason, cost, tokens } });
  const text = t => JSON.stringify({ type: 'text', sessionID: 'ses_9', part: { type: 'text', text: t } });
  // what `opencode run --format json` prints on 2.2.7: a line an event, the report in the last step
  const events = [JSON.stringify({ type: 'step_start', sessionID: 'ses_9', part: { type: 'step-start' } }), text('Reading it.'),
    JSON.stringify({ type: 'tool_use', sessionID: 'ses_9', part: { type: 'tool', tool: 'read', state: { status: 'completed' } } }),
    step('tool-calls', 0.0001, { input: 1200, output: 40, reasoning: 0, cache: { read: 0, write: 0 } }),
    JSON.stringify({ type: 'step_start', sessionID: 'ses_9', part: { type: 'step-start' } }), text('core.py:12 handler()'), text(' is the one.'),
    step('stop', 0.0002, { input: 1500, output: 50, reasoning: 10, cache: { read: 500, write: 0 } })].join('\n');
  assert.deepEqual(parseRun(events), { report: 'core.py:12 handler() is the one.', usage: { input: 2700, output: 100, cacheRead: 500 }, cost: 0.00030000000000000003, sessionId: 'ses_9', steps: 2, tools: 1, error: null, status: null });
  fs.writeFileSync(path.join(out, 'events.jsonl'), events + '\n');
  const bin = path.join(out, 'opencode');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf \'%s\' "$OPENCODE_CONFIG_CONTENT" > "$FAKE_OUT/config.json"\nprintf \'%s\\n\' "$@" > "$FAKE_OUT/args.txt"\nenv > "$FAKE_OUT/env.txt"\ncat "$FAKE_OUT/events.jsonl"\n', { mode: 0o755 });
  const asked = [];
  let balance = 0;
  const fetchFn = async (url, init) => {
    asked.push([String(url), init.headers.authorization]);
    return String(url).endsWith('/credits') ? Response.json({ balance_usd: balance, granted_usd: balance, spent_usd: 0 })
      : Response.json({ data: [{ id: HOSTED_MODEL, context_length: 1048576, pricing: { prompt: '9e-8', completion: '1.8e-7', input_cache_read: '1.8e-8' } }] });
  };
  const go = (extra = {}) => runHosted({ brief: 'Read core.py for the rename.', cwd: dir, cfg: { hosted: HOSTED_MODEL, timeoutMs: 20_000 }, system: 'You explore.', home, bin, fetchFn,
    env: { PATH: process.env.PATH, FAKE_OUT: out }, ...extra });
  // not logged in: nothing is asked of anybody
  assert.equal((await go()).error, 'no-key');
  assert.equal((await go({ cfg: {} })).error, 'no-model');
  assert.equal(asked.length, 0);
  fs.writeFileSync(path.join(home, 'fleet-key'), key + '\n', { mode: 0o600 });
  // logged in with no credits: the endpoint is asked once, and its answer stands for the next read
  assert.equal((await go()).error, 'no-credits');
  assert.equal((await go()).error, 'no-credits');
  assert.deepEqual(asked, [['http://127.0.0.1:9/v1/credits', 'Bearer ' + key]]);
  assert.equal(fs.existsSync(path.join(out, 'args.txt')), false, 'and no run is started');
  // credits: the run
  balance = 0.5;
  assert.deepEqual(await hostedCredits({ home, env: {}, fetchFn, fresh: true }), { balance: 0.5, granted: 0.5, spent: 0, at: (await hostedCredits({ home, env: {}, fetchFn })).at });
  const done = await go();
  assert.deepEqual({ ...done, ms: 0 }, { report: 'core.py:12 handler() is the one.', usage: { input_tokens: 2700, output_tokens: 100, cache_read_input_tokens: 500 },
    cost: 0.00030000000000000003, ms: 0, sessionId: 'ses_9', model: HOSTED_MODEL, steps: 2, tools: 1 });
  const args = fs.readFileSync(path.join(out, 'args.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(args.slice(0, 9), ['run', '--standalone', '--archived', '--format', 'json', '--agent', HOSTED.agent, '--model', `thinker/${HOSTED_MODEL}`]);
  assert.equal(args.at(-1), 'Read core.py for the rename.');
  const config = JSON.parse(fs.readFileSync(path.join(out, 'config.json'), 'utf8'));
  assert.deepEqual(config.provider.thinker.options, { baseURL: 'http://127.0.0.1:9/v1', apiKey: key });
  assert.deepEqual(config.provider.thinker.models[HOSTED_MODEL].cost, { input: 0.09, output: 0.18, cache_read: 0.018 }, 'the endpoint\'s own prices, so the harness prices the run');
  const agent = config.agent[HOSTED.agent];
  assert.equal(agent.prompt, 'You explore.');
  assert.deepEqual(agent.permission, { '*': 'deny', read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' }, glob: 'allow', grep: 'allow' });
  assert.deepEqual(Object.keys(config.provider), ['thinker'], 'no other provider, and nothing of the person\'s own OpenCode');
  const env = Object.fromEntries(fs.readFileSync(path.join(out, 'env.txt'), 'utf8').trim().split('\n').map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.deepEqual([env.THINKER_IN_LLM, env.OPENCODE_DISABLE_PROJECT_CONFIG, env.OPENCODE_DISABLE_CLAUDE_CODE, env.PWD], ['1', '1', '1', dir]);
  assert.equal(env.OPENCODE_CONFIG_DIR, path.join(home, 'state', 'hosted-opencode'), 'a config directory of its own: none of the person\'s plugins or agents load');
  assert.deepEqual(hostedConfig({ url: 'u', key: 'k', model: 'm', system: 's' }).provider.thinker.models.m, { name: 'm' }, 'a model with no known price is still run');
  // the balance ran out mid-run: the run says so, and the next read does not start another
  fs.writeFileSync(path.join(out, 'events.jsonl'), JSON.stringify({ type: 'step_start', sessionID: 'ses_9', part: { type: 'step-start' } }) + '\n'
    + JSON.stringify({ type: 'error', sessionID: 'ses_9', error: { type: 'provider.quota', message: 'This organization has no credits for thinker\'s hosted models.', status: 402 } }) + '\n');
  assert.equal((await go()).error, 'no-credits');
  fs.rmSync(path.join(out, 'args.txt'));
  assert.equal((await go()).error, 'no-credits');
  assert.equal(fs.existsSync(path.join(out, 'args.txt')), false);
  // ten minutes on the endpoint is asked again, and a harness that cannot be started is an error of its own
  const later = Date.now() + HOSTED.creditsMs + 1000;
  assert.match((await go({ now: later, bin: path.join(out, 'nothing-here') })).error, /^spawn: /);
  assert.equal(asked.filter(([url]) => url.endsWith('/credits')).length, 3);
});
