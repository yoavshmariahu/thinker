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
  DELEGATE_DEFAULTS, delegateConfig, HOSTS, OPENCODE_EXPLORE, OPENCODE_VERIFY, EXPLORER_FAMILIES, explorerFor, familyAgent, hostRunOrder, REPORT_SLOT, DELEGATE_SESSION_MARK, preToolHook,
} from '../src/delegate.js';
import { opencodeV2, hostRun, canRun } from '../src/integrations/opencode-v2.js';
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

test('decide: a budget of one hands a turn\'s reads over once, and the suite run has its own', () => {
  const cfg = { ...DELEGATE_DEFAULTS, threshold: 35000, minRead: 8000, handoffsPerTurn: 1 };
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

  // the same read again goes through and says it is after the handoff: a file is never denied twice in a turn
  assert.equal(await call(ev), null);
  assert.equal(rows[1].after, 'handoff'); assert.equal(rows[1].fired, false);
  // a different big read of the same turn is handed over too (five a turn since 2026-11-15)
  const second = JSON.parse(await call({ ...ev, tool_input: { file_path: other } })).hookSpecificOutput.permissionDecisionReason;
  assert.match(second, /subagent_type: "Explore"/);
  assert.deepEqual(rows[2].files, ['more.py']); assert.equal(rows[2].agent, 'Explore');

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
  assert.equal(c.handoff, true); assert.equal(c.fallback, false); assert.equal(c.handoffsPerTurn, 5);
  assert.equal(c.holdout, 0.25, 'a quarter of the sessions are held out for the live measure');
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
  // the two plain agents first, then one pinned explorer a family (their own test is below)
  const n = 2 + EXPLORER_FAMILIES.length, all = a => Array(n).fill(a);
  assert.deepEqual(w.map(x => x.action), all('written'));
  assert.equal(w[0].name, OPENCODE_EXPLORE); assert.equal(w[1].name, OPENCODE_VERIFY);
  assert.ok(fs.existsSync(opencodeAgentFile(dir, OPENCODE_EXPLORE)));
  assert.deepEqual(installOpencodeAgents({ configDir: dir, on: true }).map(x => x.action), all('unchanged'));
  assert.deepEqual(removeOpencodeAgents({ configDir: dir }).map(x => x.action), all('removed'));
  assert.deepEqual(removeOpencodeAgents({ configDir: dir }).map(x => x.action), all('absent'));
  fs.writeFileSync(opencodeAgentFile(dir, OPENCODE_EXPLORE), 'my own agent\n');
  assert.equal(installOpencodeAgents({ configDir: dir, on: true })[0].action, 'kept');
  assert.equal(fs.readFileSync(opencodeAgentFile(dir, OPENCODE_EXPLORE), 'utf8'), 'my own agent\n');

  // Claude Code lets a user file pin the model of the built-in Explore, so that is where the Sonnet half lives
  const home = tmp(t);
  assert.equal(delegateExploreModel({ env: {}, home }), DELEGATE_DEFAULTS.model, 'on by default');
  assert.equal(delegateExploreModel({ env: { THINKER_DELEGATE: 'off' }, home }), null);
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

test('decide: five reads a turn are handed over, a file only once, a suite run only once', () => {
  const cfg = { ...DELEGATE_DEFAULTS, threshold: 35000, minRead: 8000 };
  const st = {}, big = f => ({ tokens: 40000, files: [f] });
  for (const f of ['a', 'b', 'c', 'd', 'e']) {
    const d = decide(st, { prompt: 'p1', read: big(f), cfg, handoff: true });
    assert.equal(d.fire, true, f);
    noteHandoff(st, 'p1', 'explore', d.key);
  }
  // the sixth goes through, and says it is after a handoff
  const sixth = decide(st, { prompt: 'p1', read: big('f'), cfg, handoff: true });
  assert.equal(sixth.fire, false); assert.equal(sixth.spent, true);
  // a lead that asks again for a file already handed over gets the file: never denied twice in a turn
  const st2 = {};
  const first = decide(st2, { prompt: 'p1', read: big('a'), cfg, handoff: true });
  noteHandoff(st2, 'p1', 'explore', first.key);
  const again = decide(st2, { prompt: 'p1', read: big('a'), cfg, handoff: true });
  assert.equal(again.fire, false); assert.equal(again.spent, true);
  assert.equal(decide(st2, { prompt: 'p1', read: big('b'), cfg, handoff: true }).fire, true, 'another file still is');
  assert.equal(decide(st2, { prompt: 'p2', read: big('a'), cfg, handoff: true }).fire, true, 'and a new turn starts over');
  // the suite run stays at one whatever the reads' budget is
  const v = decide(st2, { prompt: 'p1', suite: 'pytest', cfg, handoff: true });
  assert.equal(v.fire, true); noteHandoff(st2, 'p1', 'verify');
  assert.equal(decide(st2, { prompt: 'p1', suite: 'pytest', cfg, handoff: true }).spent, true);
});

// The explorer is the lead's own family's cheap model on a gateway (2026-11-15; delegate.js:EXPLORER_FAMILIES).
test('explorerFor: a lead on OpenRouter gets its family\'s cheap model; everything else gets nothing', () => {
  const or = id => explorerFor({ providerID: 'openrouter', id });
  assert.deepEqual(or('anthropic/claude-opus-5.5'), { family: 'anthropic', agent: 'thinker-explore-anthropic', model: 'openrouter/anthropic/claude-haiku-5.5' });
  assert.equal(or('anthropic/claude-fable-5.2').model, 'openrouter/anthropic/claude-haiku-5.5');
  assert.equal(or('openai/gpt-6.1-sol').model, 'openrouter/openai/gpt-6-luna');
  assert.equal(or('openai/gpt-6-astra-pro').model, 'openrouter/openai/gpt-6-luna');
  assert.equal(or('z-ai/glm-5.3-flashx').model, 'openrouter/z-ai/glm-5.3-flash', 'flashx is a lead; flash is the explorer');
  assert.equal(or('google/gemini-4-carbon').family, 'google');
  assert.equal(or('deepseek/deepseek-v4-pro').family, 'deepseek');
  assert.equal(or('qwen/qwen3.8-max-prime').family, 'qwen');
  assert.equal(or('mistralai/mistral-large-4-0').family, 'mistral');
  // a variant after a colon and OpenRouter's moving alias are the same model
  assert.equal(or('openai/gpt-6.1-sol:thinking').family, 'openai');
  assert.equal(or('~anthropic/claude-opus-latest').family, 'anthropic');
  // a lead that is already the cheap tier keeps the plain agent
  for (const id of ['anthropic/claude-haiku-5.5', '~anthropic/claude-haiku-latest', 'openai/gpt-6-luna', 'z-ai/glm-5.3-flash', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash']) assert.equal(or(id), null, id);
  // a family with no pair, a provider that is not a gateway, and nothing to go on
  assert.equal(or('x-ai/grok-4.7'), null); assert.equal(or('moonshotai/kimi-k3'), null); assert.equal(or('minimax/minimax-m3'), null);
  assert.equal(explorerFor({ providerID: 'anthropic', id: 'claude-opus-5' }), null, 'a direct provider reaches one vendor: the id would not resolve');
  assert.equal(explorerFor(null), null); assert.equal(explorerFor({ providerID: 'openrouter' }), null);
  // every row's own explorer is a model its own rule would leave alone
  for (const f of EXPLORER_FAMILIES) assert.equal(or(f.explorer), null, `${f.family}: the explorer is not handed to itself`);
});

test('delegateTool, OpenCode on a gateway: the denial names the family\'s explorer and the row names its model', async t => {
  const d = tmp(t); const big = bigFile(d, 'core.py');
  let st = {}; const state = { update: fn => fn(st) }; const rows = [];
  const call = (ev, cfg = { ...DELEGATE_DEFAULTS, holdout: 0 }) => delegateTool({ ev: hostEvent('opencode', ev), state, session: 's', cwd: d, cfg, log: r => rows.push(r), run: async () => { throw Error('must not run'); }, client: 'opencode', readCap: HOSTS.opencode.readCap });
  const lead = { providerID: 'openrouter', id: 'anthropic/claude-opus-5.5' };
  const r = JSON.parse(await call({ tool_name: 'read', tool_input: { path: big }, agent: 'build', model: lead })).hookSpecificOutput.permissionDecisionReason;
  assert.match(r, /Call the subagent tool now with agent: "thinker-explore-anthropic"/);
  assert.equal(rows[0].agent, familyAgent('anthropic')); assert.equal(rows[0].model, 'openrouter/anthropic/claude-haiku-5.5'); assert.equal(rows[0].family, 'anthropic');
  // the family explorer's own reads are the delegation, as the plain agent's are
  st = {};
  assert.equal(await call({ tool_name: 'read', tool_input: { path: big }, agent: familyAgent('anthropic'), model: { providerID: 'openrouter', id: 'anthropic/claude-haiku-5.5' } }), null);
  // a suite run stays with the verify agent, whatever the lead
  st = {};
  assert.match(JSON.parse(await call({ tool_name: 'shell', tool_input: { command: 'npm test' }, agent: 'build', model: lead })).hookSpecificOutput.permissionDecisionReason, /agent: "thinker-verify"/);
  // switched off, an unpaired family, and a host that did not say: the plain agent, and no model on the row
  for (const [ev, cfg] of [[{ model: lead }, { ...DELEGATE_DEFAULTS, holdout: 0, families: false }], [{ model: { providerID: 'openrouter', id: 'x-ai/grok-4.7' } }], [{}]]) {
    st = {}; rows.length = 0;
    assert.match(JSON.parse(await call({ tool_name: 'read', tool_input: { path: big }, agent: 'build', ...ev }, cfg)).hookSpecificOutput.permissionDecisionReason, /agent: "thinker-explore"/);
    assert.equal(rows[0].agent, OPENCODE_EXPLORE); assert.equal(rows[0].model, undefined);
  }
  // Claude Code names its own agents and pins its own model: a lead's model there changes nothing
  assert.equal(executionFor('claude', 'explore', DELEGATE_DEFAULTS, { lead }).agent, 'Explore');
});

test('installOpencodeAgents: one pinned explorer a family beside the two plain agents, and all of them go together', t => {
  const dir = tmp(t);
  const w = installOpencodeAgents({ configDir: dir, on: true });
  assert.deepEqual(w.map(x => x.name), [OPENCODE_EXPLORE, OPENCODE_VERIFY, ...EXPLORER_FAMILIES.map(f => familyAgent(f.family))]);
  assert.ok(w.every(x => x.action === 'written'));
  for (const f of EXPLORER_FAMILIES) {
    const text = fs.readFileSync(opencodeAgentFile(dir, familyAgent(f.family)), 'utf8');
    assert.ok(text.startsWith(`---\nmodel: openrouter/${f.explorer}\ndescription: `), f.family);
    assert.ok(isThinkerDelegateAgent(text));
    // the frontmatter is `additionalProperties: false`: the keys OpenCode knows and nothing else
    const keys = text.split('---')[1].split('\n').filter(l => /^[a-z]+:/.test(l)).map(l => l.split(':')[0]);
    assert.deepEqual(keys, ['model', 'description', 'mode', 'permissions']);
  }
  assert.doesNotMatch(fs.readFileSync(opencodeAgentFile(dir, OPENCODE_EXPLORE), 'utf8').split('---')[1], /^model:/m, 'the plain agent names no model');
  // a person's own file under a family's name is theirs
  fs.writeFileSync(opencodeAgentFile(dir, familyAgent('openai')), '---\nmode: subagent\n---\nmine');
  assert.equal(installOpencodeAgents({ configDir: dir, on: true }).find(x => x.name === familyAgent('openai')).action, 'kept');
  removeOpencodeAgents({ configDir: dir });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'agent')), [`${familyAgent('openai')}.md`], 'only thinker\'s own files go');
});

// The host runs the subagent, not the lead (2026-11-15): a denial's words were not followed by Claude and GPT
// leads on OpenCode, so the hook hands the plugin an order and the report comes back as the call's result.
test('delegateTool, a host that runs subagents itself: the order rides beside the words, with the request in the brief', async t => {
  const d = tmp(t); const big = bigFile(d, 'core.py');
  let st = {}; const state = { update: fn => fn(st) }; const rows = [];
  const call = ev => delegateTool({ ev: hostEvent('opencode', ev), state, session: 's', cwd: d, cfg: { ...DELEGATE_DEFAULTS, holdout: 0 }, log: r => rows.push(r), run: async () => { throw Error('must not run'); }, client: 'opencode', readCap: HOSTS.opencode.readCap,
    lastPrompt: () => ({ prompt: ev.user_prompt }) });
  const lead = { providerID: 'openrouter', id: 'anthropic/claude-sonnet-5.5' };
  const out = JSON.parse(await call({ tool_name: 'read', tool_input: { path: big }, agent: 'build', model: lead, host_runs: true, user_prompt: 'where is sort_commands defined?' }));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Call the subagent tool now/, 'the words are still there, for a run that fails');
  const o = out.thinkerRun;
  assert.equal(o.agent, 'thinker-explore-anthropic');
  assert.deepEqual(o.model, { providerID: 'openrouter', id: 'anthropic/claude-haiku-5.5' });
  assert.match(o.prompt, /where is sort_commands defined\?/, 'the explorer is told what the person asked');
  assert.match(o.wrap, /^thinker read core\.py through a claude-haiku-5\.5 subagent/);
  assert.equal(o.wrap.split(REPORT_SLOT).length, 2, 'one slot for the report');
  assert.ok(o.title.length > 0 && o.kind === 'explore');
  // no pair: the child is still given a model, the lead's own, never the host's default
  st = {};
  const plain = JSON.parse(await call({ tool_name: 'read', tool_input: { path: big }, agent: 'build', model: { providerID: 'openrouter', id: 'x-ai/grok-4.7' }, host_runs: true })).thinkerRun;
  assert.equal(plain.agent, OPENCODE_EXPLORE); assert.deepEqual(plain.model, { providerID: 'openrouter', id: 'x-ai/grok-4.7' });
  // a host that did not say it can run: the words alone, as before
  st = {};
  assert.equal(JSON.parse(await call({ tool_name: 'read', tool_input: { path: big }, agent: 'build', model: lead })).thinkerRun, undefined);
  assert.deepEqual(hostRunOrder({ exec: { agent: 'a' }, lead: null, kind: 'explore', files: [big], cwd: d, brief: 'b', label: 'l' }).model, null);
});

// the session API as OpenCode 2.2.7 answered it when probed: create -> prompt -> wait -> context
const fakeSession = ({ answer = [{ type: 'reasoning', text: 'hm' }, { type: 'text', text: 'core.py:12 sort_commands' }], wait = async () => {}, fail = null } = {}) => {
  const calls = [];
  const s = {
    create: async a => { calls.push(['create', a]); if (fail === 'create') throw Error('no'); return { id: 'ses_child' }; },
    prompt: async a => { calls.push(['prompt', a]); },
    wait: async a => { calls.push(['wait', a]); return wait(); },
    context: async a => { calls.push(['context', a]); return [{ type: 'user', text: 'brief' }, { type: 'assistant', content: [{ type: 'text', text: 'first' }] }, { type: 'assistant', content: answer }, { type: 'idle' }]; },
    interrupt: async a => { calls.push(['interrupt', a]); },
  };
  return { session: s, calls };
};
const order = { agent: 'thinker-explore-openai', model: { providerID: 'openrouter', id: 'openai/gpt-6-luna' }, title: 'Read core.py', prompt: 'the brief', wrap: `thinker read core.py through a subagent.\n\n${REPORT_SLOT}`, kind: 'explore' };

test('hostRun: a child session on the named agent and model, and its last answer\'s text is the report', async () => {
  const f = fakeSession();
  assert.equal(await hostRun(f, 'ses_parent', order), 'core.py:12 sort_commands');
  // agent and model belong on create: given to prompt they are accepted and ignored
  assert.deepEqual(f.calls[0], ['create', { parentID: 'ses_parent', title: 'Read core.py', agent: 'thinker-explore-openai', model: { providerID: 'openrouter', id: 'openai/gpt-6-luna' } }]);
  assert.deepEqual(f.calls[1], ['prompt', { sessionID: 'ses_child', text: 'the brief' }]);
  assert.deepEqual(f.calls.map(c => c[0]), ['create', 'prompt', 'wait', 'context']);
  // every failure is '' -- the read goes through, since a hook may not fail a tool call
  assert.equal(await hostRun(fakeSession({ fail: 'create' }), 'p', order), '');
  assert.equal(await hostRun(fakeSession({ answer: [{ type: 'reasoning', text: 'only thought' }] }), 'p', order), '');
  const slow = fakeSession({ wait: () => new Promise(() => {}) });
  assert.equal(await hostRun(slow, 'p', order, { timeoutMs: 20 }), '');
  assert.equal(slow.calls.at(-1)[0], 'interrupt', 'a run past its time is stopped, not left spending');
  assert.equal(canRun(f), true); assert.equal(canRun({ session: { create() {} } }), false); assert.equal(canRun({}), false);
});

test('the OpenCode plugin: the report is the denied call\'s result, a repeat read gets the same one, a failed run lets the read through', async t => {
  const saved = process.env.THINKER_DELEGATE; process.env.THINKER_DELEGATE = 'on';
  t.after(() => { if (saved === undefined) delete process.env.THINKER_DELEGATE; else process.env.THINKER_DELEGATE = saved; });
  const setup = async (f, answerFor) => {
    const hooks = {}, events = [];
    const reg = scope => ({ hook: async (name, fn) => { hooks[`${scope}.${name}`] = fn; } });
    const ctx = { tool: reg('tool'), session: { ...f.session, ...reg('session'), get: async () => ({ model: { id: 'openai/gpt-6.1-terra', providerID: 'openrouter' } }), synthetic: async () => {} }, event: { subscribe: async () => {} }, location: { directory: '/repo' } };
    const run = async (what, ev) => { events.push([what, ev]); return what === 'pretool' ? answerFor(ev) : ''; };
    await opencodeV2({ client: 'opencode', hooks: true, mcp: false, learn: false, late: false }, run).setup(ctx);
    return { before: hooks['tool.execute.before'], prompt: hooks['session.prompt'], events };
  };
  const denied = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Call the subagent tool now' }, thinkerRun: order });
  const read = (sid, input = { path: '/repo/core.py' }) => ({ tool: 'read', sessionID: sid, agent: 'build', input });

  const f = fakeSession();
  const p = await setup(f, () => denied);
  await p.prompt({ sessionID: 's1', prompt: { text: 'where is sort_commands?' } });
  await assert.rejects(p.before(read('s1')), /^Error: thinker read core\.py through a subagent\.\n\ncore\.py:12 sort_commands$/);
  const sent = p.events.find(e => e[0] === 'pretool')[1];
  assert.deepEqual(sent.model, { id: 'openai/gpt-6.1-terra', providerID: 'openrouter' });
  assert.equal(sent.host_runs, true); assert.equal(sent.user_prompt, 'where is sort_commands?');
  // the same whole read again this turn: the same report, no second hook call and no second child
  const n = p.events.length, creates = f.calls.filter(c => c[0] === 'create').length;
  await assert.rejects(p.before(read('s1')), /core\.py:12 sort_commands/);
  assert.equal(p.events.length, n); assert.equal(f.calls.filter(c => c[0] === 'create').length, creates);
  // a ranged read is the hook's to decide, never answered from the kept report
  await assert.rejects(p.before(read('s1', { path: '/repo/core.py', offset: 10, limit: 20 })), /core\.py:12/);
  assert.equal(p.events.length, n + 1, 'the hook was asked');
  // a new prompt is a new turn: the kept report goes
  await p.prompt({ sessionID: 's1', prompt: { text: 'next' } });
  const m = p.events.length;
  await assert.rejects(p.before(read('s1')), /core\.py:12/);
  assert.ok(p.events.length > m, 'asked again after the turn changed');

  // the run fails: the read goes through (no throw), since the words alone are what leads did not follow
  const bad = await setup(fakeSession({ fail: 'create' }), () => denied);
  assert.equal(await bad.before(read('s2')), undefined);
  // the hook gave words and no order (a host that cannot run, an older CLI): the words are thrown, as before
  const old = await setup(fakeSession(), () => JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'Call the subagent tool now' } }));
  await assert.rejects(old.before(read('s3')), /Call the subagent tool now/);
  // nothing to say: the call goes through, and a tool that is neither a read nor a shell is never asked about
  const quiet = await setup(fakeSession(), () => '');
  assert.equal(await quiet.before(read('s4')), undefined);
  assert.equal(await quiet.before({ tool: 'edit', sessionID: 's4', input: {} }), undefined);
  assert.equal(quiet.events.filter(e => e[0] === 'pretool').length, 1);
});

// Claude Code's mod is the same door (2026-11-15): it asks from inside the harness with `host_runs`, gets the
// order and spawns the subagent itself (claude-clear:delegateCall). The settings hook's copy of the call stands down.
test('Claude Code, the mod runs the subagent: the order names the host\'s Explore, and the settings hook stands down in a session the mod marked', async t => {
  const d = tmp(t); const big = bigFile(d, 'core.py');
  let st = {}; const rows = [];
  const out = JSON.parse(await delegateTool({ ev: { tool_name: 'Read', tool_input: { file_path: big }, host_runs: true, user_prompt: 'where is sort_commands defined?' }, state: { update: fn => fn(st) }, session: 's', cwd: d,
    cfg: { ...DELEGATE_DEFAULTS, holdout: 0 }, log: r => rows.push(r), run: async () => { throw Error('must not run'); }, client: 'claude', lastPrompt: () => ({ prompt: 'where is sort_commands defined?' }) }));
  const o = out.thinkerRun;
  assert.equal(o.agent, 'Explore');
  assert.equal(o.model, null, 'no model named: the agent\'s own definition picks it');
  assert.match(o.prompt, /where is sort_commands defined\?/);
  assert.equal(o.wrap.split(REPORT_SLOT).length, 2);
  assert.match(o.wrap, /^thinker read core\.py through a claude-haiku-5-5 subagent/, 'the model Explore.md is pinned to');

  // the stand-down: the same call through the settings hook, in a session the mod marked
  const was = process.env.THINKER_HOME; t.after(() => { if (was === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = was; });
  const home = process.env.THINKER_HOME = path.join(d, 'home');
  const cfg = { ...DELEGATE_DEFAULTS, enabled: true, holdout: 0 };
  const store = { log: () => { throw Error('a call the mod decides is not decided twice'); } };
  fs.mkdirSync(path.join(home, 'state', DELEGATE_SESSION_MARK), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', DELEGATE_SESSION_MARK, 'sess-1'), '');
  assert.equal(await preToolHook({ ev: { tool_name: 'Read', tool_input: { file_path: big } }, store, session: 'sess-1', cwd: d, cfg, client: 'claude' }), null);
  // the mod's own asking carries `host_runs` and is decided; so is a session no mod marked (an older Claude Code)
  await assert.rejects(preToolHook({ ev: { tool_name: 'Read', tool_input: { file_path: big }, host_runs: true }, store, session: 'sess-1', cwd: d, cfg, client: 'claude' }));
  await assert.rejects(preToolHook({ ev: { tool_name: 'Read', tool_input: { file_path: big } }, store, session: 'sess-2', cwd: d, cfg, client: 'claude' }));
});

// Devin, from the payloads its CLI 3000.11.234 sent on 2026-11-16 (two live probes, swe-2-high and swe-2-medium).
// Its PreToolUse is Claude Code's shape with lower-case tools and no `cwd`; a subagent's calls carry the lead's
// session id and prompt id and nothing that marks them, so they are known by the window between `run_subagent`'s
// PreToolUse and its PostToolUse.
test('Devin: a big read is handed to its own explore subagent in its own words, and the subagent\'s reads go through until it answers', t => {
  const repo = tmp(t); const home = tmp(t);
  execFileSync('git', ['init', '-q', repo]);
  const big = bigFile(repo, 'core.py'), other = bigFile(repo, 'other.py');
  const env = { ...process.env, THINKER_HOME: home, THINKER_TEST: '1', THINKER_HOOKS: 'on', THINKER_LOG: 'local', THINKER_DELEGATE: 'on', THINKER_DELEGATE_HOLDOUT: 'off', DEVIN_PROJECT_DIR: repo };
  const hook = (what, input) => execFileSync('node', [CLI, 'hook', what, '--client', 'devin', '--user', ...(what === 'pretool' ? [] : ['--record'])], { input: JSON.stringify(input), encoding: 'utf8', env, cwd: repo });
  const base = { session_id: 'aback-ferry', prompt_id: 'b88ff14b', hook_event_name: 'PreToolUse' };
  const read = (file, extra = {}) => ({ ...base, tool_name: 'read', tool_use_id: 'read:0#99f0', tool_input: { file_path: file, ...extra } });
  // the person's prompt reaches the brief from thinker's own trace: Devin's hook payload names no transcript
  hook('prompt', { session_id: 'aback-ferry', hook_event_name: 'UserPromptSubmit', prompt: 'where is the retry ladder decided?' });

  assert.deepEqual(executionFor('devin', 'explore', DELEGATE_DEFAULTS), { mode: 'handoff', tool: 'run_subagent', alias: undefined, param: 'profile', fields: { label: 'title', brief: 'task' }, agent: 'subagent_explore' });
  assert.equal(executionFor('devin', 'verify', DELEGATE_DEFAULTS).agent, 'subagent_general');

  const j = JSON.parse(hook('pretool', read(big)));
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  const words = j.hookSpecificOutput.permissionDecisionReason;
  assert.match(words, /Call the run_subagent tool now with profile: "subagent_explore", title: "[^"]+", and task: the brief below/);
  assert.doesNotMatch(words, /subagent_type|description:|prompt: the brief/, 'Devin\'s field names, not Claude Code\'s');
  assert.match(words, /where is the retry ladder decided\?/, 'the request is in the brief');
  const rows = () => fs.readFileSync(path.join(repo, '.thinker', 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(r => r.op === 'delegate');
  assert.equal(rows().length, 1);
  assert.deepEqual([rows()[0].client, rows()[0].mode, rows()[0].agent, rows()[0].handoffTool], ['devin', 'handoff', 'subagent_explore', 'run_subagent']);

  // a short range is the lead's own, before and after
  assert.equal(hook('pretool', read(big, { offset: 1140, limit: 60 })), '');
  // the subagent starts: its reads carry the lead's ids and nothing else, so the window is what lets them through
  const launch = { ...base, tool_name: 'run_subagent', tool_use_id: 'run_subagent:1#9282', tool_input: { title: 'Inspect core.py', task: 'Read core.py in full and report.', profile: 'subagent_explore' } };
  assert.equal(hook('pretool', launch), '');
  assert.equal(hook('pretool', read(big)), '', 'the file it was sent to read');
  assert.equal(hook('pretool', read(other)), '', 'and any other file it explores: a second denial would ask a subagent for a subagent');
  assert.equal(rows().length, 2, 'inside the window nothing is decided or logged: the second row is the lead\'s own short range');
  assert.equal(rows()[1].fired, false);
  // the subagent answers (PostToolUse of the same call): the window closes and the lead's next big read is decided again
  hook('tool', { ...launch, hook_event_name: 'PostToolUse', tool_response: { success: true, output: 'Subagent agent_id=7d997de2 completed successfully' } });
  assert.equal(JSON.parse(hook('pretool', read(other))).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(rows().at(-1).mode, 'handoff');
  // a whole-suite run goes to the general subagent, through Devin's `exec`
  const suite = JSON.parse(hook('pretool', { ...base, prompt_id: 'p2', tool_name: 'exec', tool_use_id: 'exec:0#1', tool_input: { command: 'pytest' } }));
  assert.match(suite.hookSpecificOutput.permissionDecisionReason, /profile: "subagent_general"/);
});

test('Devin: a subagent that never answers does not hold the window open for good', async () => {
  const { subagentRunning, noteSubagent, SUBAGENT_WINDOW_MS, windowTool } = await import('../src/delegate.js');
  const st = {}, t0 = 1_000_000;
  assert.equal(subagentRunning(st, t0), false);
  noteSubagent(st, true, t0);
  assert.equal(subagentRunning(st, t0 + 60_000), true);
  assert.equal(subagentRunning(st, t0 + SUBAGENT_WINDOW_MS + 1), false, 'past the window the next read is the lead\'s again');
  noteSubagent(st, true, t0); noteSubagent(st, true, t0 + 1000);
  noteSubagent(st, false, t0 + 2000);
  assert.equal(subagentRunning(st, t0 + 3000), true, 'two running, one answered');
  noteSubagent(st, false, t0 + 4000); noteSubagent(st, false, t0 + 5000);
  assert.equal(subagentRunning(st, t0 + 6000), false, 'and an answer with nothing open stays at none');
  assert.equal(windowTool('devin', 'run_subagent'), true);
  assert.equal(windowTool('claude', 'Agent'), false, 'Claude Code marks its subagent\'s calls and needs no window');
});
