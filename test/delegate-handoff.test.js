// Delegation through the host's own native subagent (2026-11-12, the owner's call). The rule stays thinker's
// and the execution becomes the host's: the hook denies and the denial names the host's subagent tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  executionFor, fromSubagent, denial, decide, noteHandoff, delegateTool, handoffLabel, hostEvent,
  DELEGATE_DEFAULTS, delegateConfig, HOSTS, OPENCODE_EXPLORE, OPENCODE_VERIFY,
} from '../src/delegate.js';
import {
  renderOpencodeAgent, installOpencodeAgents, removeOpencodeAgents, opencodeAgentFile,
  isThinkerDelegateAgent, delegateExploreModel, DELEGATE_MARK,
} from '../src/delegate-agents.js';

const CLI = new URL('../src/cli.js', import.meta.url).pathname;
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-handoff-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const bigFile = (dir, name, lines = 3000) => { const f = path.join(dir, name); fs.writeFileSync(f, Array.from({ length: lines }, (_, i) => `def f${i}(x):\n    return x + ${i}\n`).join('')); return f; };

test('executionFor: the host that has a subagent runs it; thinker\'s own is a named fallback, off by default', () => {
  const on = DELEGATE_DEFAULTS;
  // Claude Code: the Agent tool, subagent_type, the built-in Explore and general-purpose
  assert.deepEqual(executionFor('claude', 'explore', on), { mode: 'handoff', tool: 'Agent', alias: 'Task', param: 'subagent_type', agent: 'Explore' });
  assert.equal(executionFor('claude', 'verify', on).agent, 'general-purpose');
  // OpenCode 2: the subagent tool, `agent`, and the two agents thinker installs (it has none built in)
  const oc = executionFor('opencode', 'explore', on);
  assert.equal(oc.tool, 'subagent'); assert.equal(oc.param, 'agent'); assert.equal(oc.agent, OPENCODE_EXPLORE);
  assert.equal(executionFor('opencode', 'verify', on).agent, OPENCODE_VERIFY);
  assert.equal(oc.alias, undefined, 'only Claude Code renamed its tool');
  // a host with no subagent door: the call goes through, with the reason in the log
  assert.deepEqual(executionFor('codex', 'explore', on), { mode: 'none', reason: 'no-native-subagent' });
  assert.deepEqual(executionFor('codex', 'explore', { ...on, fallback: true }), { mode: 'report' });
  // handoff off, fallback off: nothing runs and the reason says which switch
  assert.equal(executionFor('claude', 'explore', { ...on, handoff: false }).reason, 'handoff-off');
  assert.equal(executionFor('claude', 'explore', { ...on, handoff: false, fallback: true }).mode, 'report');
});

test('fromSubagent: a subagent\'s own reads are never delegated again', () => {
  // Claude Code names the agent on a sidechain tool call (`agent_type`, `agent_id`); the main conversation has neither
  assert.equal(fromSubagent({ tool_name: 'Read' }, 'claude'), false);
  assert.equal(fromSubagent({ agent_type: 'Explore', agent_id: 'a1' }, 'claude'), true);
  assert.equal(fromSubagent({ agent_type: 'general-purpose' }, 'claude'), true);
  // OpenCode puts `agent` on every call, so only its primary agents are the conversation's own
  assert.equal(fromSubagent({ agent: 'build' }, 'opencode'), false);
  assert.equal(fromSubagent({ agent: 'plan' }, 'opencode'), false);
  assert.equal(fromSubagent({ agent: OPENCODE_EXPLORE }, 'opencode'), true);
  assert.equal(fromSubagent({ agent: 'someone-elses-agent' }, 'opencode'), true, 'an unknown name fails closed into reading as before');
  assert.equal(fromSubagent({}, 'opencode'), false);
  assert.equal(fromSubagent({ agent: 'build' }, 'nosuchhost'), false);
});

test('denial: the handoff names the host\'s tool, agent and brief, and is an instruction rather than a report', () => {
  const exec = executionFor('claude', 'explore', DELEGATE_DEFAULTS);
  const j = JSON.parse(denial({ kind: 'explore', files: ['/r/core.py'], cwd: '/r', handoff: { ...exec, brief: 'BRIEF-BODY', label: 'Read core.py' } }));
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  const r = j.hookSpecificOutput.permissionDecisionReason;
  assert.match(r, /Call the Agent tool/); assert.match(r, /\(named Task in older versions\)/);
  assert.match(r, /subagent_type: "Explore"/); assert.match(r, /description: "Read core\.py"/);
  assert.match(r, /BRIEF-BODY/); assert.match(r, /core\.py/);
  assert.match(r, /offset and limit/);
  assert.match(r, /Nothing has gone wrong/, 'the live OpenCode check: a denial read as a fault gets routed around');
  assert.doesNotMatch(r, /report is below/, 'a handoff is not a pre-baked report');
  // OpenCode's own names, and its verify agent
  const ov = executionFor('opencode', 'verify', DELEGATE_DEFAULTS);
  const rv = JSON.parse(denial({ kind: 'verify', files: [], cwd: '/r', handoff: { ...ov, brief: 'B', label: handoffLabel('verify') } })).hookSpecificOutput.permissionDecisionReason;
  assert.match(rv, /Call the subagent tool /, 'no alias clause where the host never renamed it');
  assert.match(rv, /agent: "thinker-verify"/);
  assert.match(rv, /run a single test file/);
  // the fallback's words are untouched
  const rep = JSON.parse(denial({ kind: 'explore', report: 'R', files: ['/r/a.py'], cwd: '/r', model: 'm' })).hookSpecificOutput.permissionDecisionReason;
  assert.match(rep, /read a\.py through a m subagent/); assert.match(rep, /\nR$/);
});

test('decide: one handoff of a kind per turn, so a subagent\'s own reads can never be denied in a loop', () => {
  const cfg = { ...DELEGATE_DEFAULTS, threshold: 35000, minRead: 8000 };
  const st = {};
  const big = { tokens: 40000, files: ['a'] };
  const first = decide(st, { prompt: 'p1', read: big, cfg, handoff: true });
  assert.equal(first.fire, true); assert.equal(first.spent, false);
  noteHandoff(st, 'p1', 'explore');
  // every later read of the turn goes through, and says it is after a handoff
  const after = decide(st, { prompt: 'p1', read: { tokens: 50000, files: ['b'] }, cfg, handoff: true });
  assert.equal(after.fire, false); assert.equal(after.spent, true);
  assert.equal(st.delegate.readTokens, 50000, 'a read that goes through enters the tally');
  // the suite run of the same turn has a budget of its own
  const v = decide(st, { prompt: 'p1', suite: 'pytest', cfg, handoff: true });
  assert.equal(v.fire, true); assert.equal(v.kind, 'verify');
  noteHandoff(st, 'p1', 'verify');
  assert.equal(decide(st, { prompt: 'p1', suite: 'pytest', cfg, handoff: true }).spent, true);
  // a new prompt is a new turn and a new budget
  assert.equal(decide(st, { prompt: 'p2', read: big, cfg, handoff: true }).fire, true);
  // the fallback has no such budget: it keeps the cached report instead (no loop, the child has no hooks)
  const st2 = {};
  assert.equal(decide(st2, { prompt: 'p1', read: big, cfg, handoff: false }).fire, true);
  noteHandoff(st2, 'p1', 'explore');
  assert.equal(decide(st2, { prompt: 'p1', read: big, cfg, handoff: false }).fire, true);
});

test('delegateTool, handoff: denies with the handoff, spawns nothing, logs the mode and agent, and lets the rest of the turn through', async t => {
  const d = tmp(t); const big = bigFile(d, 'core.py'), other = bigFile(d, 'more.py');
  const cfg = { ...DELEGATE_DEFAULTS, holdout: 0 };
  let st = {}; const state = { update: fn => fn(st) };
  const rows = []; let ran = 0;
  const run = async () => { ran++; return { report: 'NOPE' }; };
  const call = (ev, over = {}) => delegateTool({ ev, state, session: 'sess', cwd: d, cfg, log: r => rows.push(r), run, client: 'claude', lastPrompt: () => ({ prompt: 'add sort_commands', lastSay: 'Let me read core.py' }), ...over });
  const ev = { tool_name: 'Read', tool_input: { file_path: big }, prompt_id: 'p1' };

  const out = await call(ev);
  const r = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
  assert.equal(ran, 0, 'a handoff runs no model process of thinker\'s own');
  assert.match(r, /subagent_type: "Explore"/);
  assert.match(r, /add sort_commands/, 'the brief carries the request');
  assert.match(r, /Let me read core\.py/);
  assert.match(r, /You explore a codebase/, 'the brief carries the report rules: thinker owns no system prompt there');
  assert.equal(rows[0].op, 'delegate'); assert.equal(rows[0].mode, 'handoff'); assert.equal(rows[0].agent, 'Explore');
  assert.equal(rows[0].handoffTool, 'Agent'); assert.equal(rows[0].held, false); assert.equal(rows[0].kind, 'explore');
  assert.deepEqual(rows[0].files, ['core.py']);
  assert.equal(rows[0].cost, undefined, 'the host bills its own subagent');

  // the same read again, and a different big read: both go through, both say they are after the handoff
  assert.equal(await call(ev), null);
  assert.equal(rows[1].after, 'handoff'); assert.equal(rows[1].fired, false);
  assert.equal(await call({ ...ev, tool_input: { file_path: other } }), null);
  assert.equal(rows[2].after, 'handoff');

  // the subagent's own read of the same file: nothing at all, not even a row
  const before = rows.length;
  assert.equal(await call({ ...ev, agent_type: 'Explore', prompt_id: 'p1' }), null);
  assert.equal(rows.length, before, 'a subagent\'s read is the delegation, not a trigger');

  // a suite run of the same turn still goes over, to the host's general-purpose agent
  const v = JSON.parse(await call({ tool_name: 'Bash', tool_input: { command: 'pytest -q' }, prompt_id: 'p1' })).hookSpecificOutput.permissionDecisionReason;
  assert.match(v, /subagent_type: "general-purpose"/);
  assert.match(v, /You verify work for a lead engineer/);
  assert.equal(rows.at(-1).kind, 'verify'); assert.equal(rows.at(-1).mode, 'handoff');

  // held out: the row says so and the read goes through, with no handoff spent
  st = {};
  assert.equal(await call(ev, { cfg: { ...cfg, holdout: 1 } }), null);
  assert.equal(rows.at(-1).held, true); assert.equal(rows.at(-1).mode, 'handoff');
  st = {};
  assert.ok(await call(ev), 'the holdout never spends the turn\'s handoff');

  // a host with no subagent and no fallback: through, with the reason on the row
  st = {};
  assert.equal(await call(ev, { client: 'codex' }), null, 'an unknown host is not a door at all');
  st = {};
  assert.equal(await delegateTool({ ev, state, session: 'sess', cwd: d, cfg: { ...cfg, handoff: false }, log: r => rows.push(r), run, client: 'claude' }), null);
  assert.equal(rows.at(-1).skipped, 'handoff-off'); assert.equal(rows.at(-1).fired, false);
  assert.equal(ran, 0);
});

test('delegateTool, OpenCode: the host\'s lower-case tools, its agent names, and its own agent field', async t => {
  const d = tmp(t); const big = bigFile(d, 'core.py');
  const cfg = { ...DELEGATE_DEFAULTS, holdout: 0 };
  let st = {}; const state = { update: fn => fn(st) }; const rows = [];
  // `preToolHook` maps the host's event into the hook's own shape before the rule sees it, as it does live
  const call = ev => delegateTool({ ev: hostEvent('opencode', ev), state, session: 's', cwd: d, cfg, log: r => rows.push(r), run: async () => { throw Error('must not run'); }, client: 'opencode', readCap: HOSTS.opencode.readCap });
  const r = JSON.parse(await call({ tool_name: 'read', tool_input: { path: big }, agent: 'build' })).hookSpecificOutput.permissionDecisionReason;
  assert.match(r, /Call the subagent tool now with agent: "thinker-explore"/);
  assert.doesNotMatch(r, /older versions/);
  assert.equal(rows[0].agent, OPENCODE_EXPLORE); assert.equal(rows[0].mode, 'handoff');
  // the agent thinker installed reading the same file: nothing
  st = {};
  assert.equal(await call({ tool_name: 'read', tool_input: { path: big }, agent: OPENCODE_EXPLORE }), null);
  // its shell is `shell`, and a whole-suite run goes to the verify agent
  st = {};
  const v = JSON.parse(await call({ tool_name: 'shell', tool_input: { command: 'npm test' }, agent: 'build' })).hookSpecificOutput.permissionDecisionReason;
  assert.match(v, /agent: "thinker-verify"/);
});

test('delegateConfig: the handoff is the default, the fallback is asked for by name', t => {
  const home = tmp(t);
  const c = delegateConfig({ env: {}, home });
  assert.equal(c.handoff, true); assert.equal(c.fallback, false); assert.equal(c.handoffsPerTurn, 1);
  assert.equal(c.holdout, 0.5, 'the live measure is half the sessions, as before');
  assert.equal(delegateConfig({ env: { THINKER_DELEGATE_HANDOFF: 'off' }, home }).handoff, false);
  assert.equal(delegateConfig({ env: { THINKER_DELEGATE_FALLBACK: 'on' }, home }).fallback, true);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ delegate: { enabled: true, fallback: true, handoff: false } }));
  const f = delegateConfig({ env: {}, home });
  assert.equal(f.fallback, true); assert.equal(f.handoff, false);
  assert.equal(delegateConfig({ env: { THINKER_DELEGATE_HANDOFF: 'on' }, home }).handoff, true);
});

test('the agent definitions: OpenCode gets two files it can resolve, Claude Code gets its Explore pinned', t => {
  const dir = tmp(t);
  // the frontmatter is OpenCode's own schema: no `name` (the file is the id), permissions as a rule list
  for (const kind of ['explore', 'verify']) {
    const text = renderOpencodeAgent(kind);
    const fm = text.split('---')[1];
    assert.doesNotMatch(fm, /^name:/m, 'Config.AgentEncoded has no name field and forbids extras');
    assert.match(fm, /^mode: subagent$/m);
    assert.doesNotMatch(fm, /^model:/m, 'the host\'s own model, never one of thinker\'s choosing');
    assert.match(fm, /^permissions:$/m);
    assert.match(fm, /- \{ action: edit, resource: "\*", effect: deny \}/);
    assert.match(fm, /- \{ action: task, resource: "\*", effect: deny \}/);
    // a plain YAML scalar may not hold ": "
    for (const line of fm.split('\n')) if (/^description: /.test(line)) assert.doesNotMatch(line.slice(13), /: /);
    assert.ok(isThinkerDelegateAgent(text));
    assert.match(text, new RegExp(DELEGATE_MARK));
  }
  assert.match(renderOpencodeAgent('explore'), /You explore a codebase/);
  assert.match(renderOpencodeAgent('verify'), /You verify work/);

  // written, idempotent, removed when off, and a person's own file left alone
  const w = installOpencodeAgents({ configDir: dir, on: true });
  assert.deepEqual(w.map(x => x.action), ['written', 'written']);
  assert.equal(w[0].name, OPENCODE_EXPLORE); assert.equal(w[1].name, OPENCODE_VERIFY);
  assert.ok(fs.existsSync(opencodeAgentFile(dir, OPENCODE_EXPLORE)));
  assert.deepEqual(installOpencodeAgents({ configDir: dir, on: true }).map(x => x.action), ['unchanged', 'unchanged']);
  assert.deepEqual(removeOpencodeAgents({ configDir: dir }).map(x => x.action), ['removed', 'removed']);
  assert.deepEqual(removeOpencodeAgents({ configDir: dir }).map(x => x.action), ['absent', 'absent']);
  fs.writeFileSync(opencodeAgentFile(dir, OPENCODE_EXPLORE), 'my own agent\n');
  assert.equal(installOpencodeAgents({ configDir: dir, on: true })[0].action, 'kept');
  assert.equal(fs.readFileSync(opencodeAgentFile(dir, OPENCODE_EXPLORE), 'utf8'), 'my own agent\n');

  // Claude Code lets a user file pin the model of the built-in Explore, so that is where the Sonnet half lives
  const home = tmp(t);
  assert.equal(delegateExploreModel({ env: {}, home }), null, 'off by default');
  assert.equal(delegateExploreModel({ env: { THINKER_DELEGATE: 'on' }, home }), DELEGATE_DEFAULTS.model);
  assert.equal(delegateExploreModel({ env: { THINKER_DELEGATE: 'claude-haiku-5-5' }, home }), 'claude-haiku-5-5');
  assert.equal(delegateExploreModel({ env: { THINKER_DELEGATE: 'on', THINKER_DELEGATE_HANDOFF: 'off' }, home }), null);
  // OpenCode names `providerID/modelID` from the person's own providers: thinker pins nothing there
  assert.equal(delegateExploreModel({ env: { THINKER_DELEGATE: 'on' }, home, client: 'opencode' }), null);
  assert.equal(HOSTS.opencode.subagent.pins, false);
});

test('the hook command, handoff: a big read is denied with the handoff and no model process is started', t => {
  const repo = tmp(t); const home = tmp(t);
  execFileSync('git', ['init', '-q', repo]);
  const big = bigFile(repo, 'core.py');
  // a `claude` binary that would fail the test if it were ever reached
  const bin = path.join(home, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\necho SPAWNED-THE-FALLBACK >&2\nexit 9\n'); fs.chmodSync(bin, 0o755);
  const env = { ...process.env, THINKER_HOME: home, THINKER_TEST: '1', THINKER_HOOKS: 'on', THINKER_LOG: 'local', THINKER_DELEGATE: 'on', THINKER_DELEGATE_BIN: bin, THINKER_DELEGATE_HOLDOUT: 'off' };
  const hook = (input, client = 'claude') => execFileSync('node', [CLI, 'hook', 'pretool', '--client', client, '--user'], { input: JSON.stringify(input), encoding: 'utf8', env });
  const ev = { session_id: 'hs', prompt_id: 'p1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: big } };

  const j = JSON.parse(hook(ev));
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(j.hookSpecificOutput.permissionDecisionReason, /subagent_type: "Explore"/);
  const rows = () => fs.readFileSync(path.join(repo, '.thinker', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.op === 'delegate');
  assert.equal(rows().length, 1);
  assert.equal(rows()[0].mode, 'handoff'); assert.equal(rows()[0].agent, 'Explore');
  assert.equal(rows()[0].cost, undefined); assert.equal(rows()[0].subagent, undefined);
  // the rest of the turn reads as before
  assert.equal(hook(ev), '');
  assert.equal(rows().at(-1).after, 'handoff');
  // the subagent's own read: silence
  assert.equal(hook({ ...ev, agent_type: 'Explore', agent_id: 'a1' }), '');
  // OpenCode's event shape through the same subcommand
  assert.match(JSON.parse(hook({ ...ev, session_id: 'hs2', tool_name: 'read', tool_input: { path: big }, agent: 'build' }, 'opencode')).hookSpecificOutput.permissionDecisionReason, /agent: "thinker-explore"/);
});
