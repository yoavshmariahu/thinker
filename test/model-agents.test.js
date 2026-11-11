// Subagents on a chosen model (model-agents.js) and the model profile's rules (model-profile.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderAgent, installAgents, removeAgents, isAgentName, AGENT_MARK, TEMPLATES } from '../src/model-agents.js';
import { parentIndex, runOf, recommend, figures, routeFigures, pathsOf, MIN_RUNS, WORSE_BY } from '../src/model-profile.js';

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const frontmatter = text => Object.fromEntries(text.split('\n---')[0].replace(/^---\n/, '').split('\n').filter(Boolean).map(l => { const i = l.indexOf(':'); return [l.slice(0, i), l.slice(i + 1).trim()]; }));

test('a reader cannot write, a worker can, both are marked and name their model; Explore is not a name here', () => {
  const r = renderAgent({ name: 'Scout', model: 'thinker/explore' });
  const fm = frontmatter(r);
  assert.equal(fm.name, 'Scout'); assert.equal(fm.model, 'thinker/explore');
  for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent']) assert.match(fm.disallowedTools, new RegExp(`\\b${t}\\b`));
  assert.ok(r.includes(`<!-- ${AGENT_MARK} v1 template=reader`));
  const w = frontmatter(renderAgent({ name: 'Builder', model: 'thinker/gw/gpt-6-sol', template: 'worker', description: 'implements   one bounded change' }));
  assert.equal(w.disallowedTools, undefined); assert.equal(w.description, 'implements one bounded change');
  assert.ok(!isAgentName('Explore') && !isAgentName('explore') && isAgentName('Scout') && !isAgentName('bad name'));
  assert.throws(() => renderAgent({ name: 'Explore', model: 'x' }), /Explore/);
  assert.throws(() => renderAgent({ name: 'X', model: 'x', template: 'nope' }), /template/);
  assert.deepEqual(Object.keys(TEMPLATES), ['reader', 'worker']);
});

test('install writes what the registry names, leaves a person\'s own file alone, and removes thinker\'s files it no longer names', () => {
  const dir = tmp('thinker-agents-');
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'Mine.md'), '---\nname: Mine\nmodel: opus\n---\nmy own agent\n');
  let acts = installAgents({ claudeDir: dir, agents: { Scout: { model: 'thinker/explore' }, Mine: { model: 'thinker/explore' }, Explore: { model: 'x' } } });
  assert.deepEqual(acts.map(a => [a.name, a.action]), [['Scout', 'written'], ['Mine', 'kept']], 'Explore is never written here');
  assert.ok(fs.readFileSync(path.join(dir, 'agents', 'Mine.md'), 'utf8').includes('my own agent'));
  acts = installAgents({ claudeDir: dir, agents: { Scout: { model: 'thinker/explore' } } });
  assert.deepEqual(acts.map(a => a.action), ['unchanged']);
  acts = installAgents({ claudeDir: dir, agents: { Scout: { model: 'thinker/gw/other', template: 'worker' } } });
  assert.deepEqual(acts.map(a => a.action), ['written']);
  assert.equal(frontmatter(fs.readFileSync(path.join(dir, 'agents', 'Scout.md'), 'utf8')).model, 'thinker/gw/other');
  acts = removeAgents({ claudeDir: dir });
  assert.deepEqual(acts.map(a => [a.name, a.action]), [['Scout', 'removed']]);
  assert.ok(fs.existsSync(path.join(dir, 'agents', 'Mine.md')), 'the person\'s file stays');
  assert.deepEqual(installAgents({ claudeDir: tmp('thinker-agents-empty-'), agents: {} }), [], 'no agents dir is fine');
});

const tool = (call, name, input, extra = {}) => ({ t: 'tool', name, input, result: '', call, ...extra });
const calls = (n, out = 100) => Array.from({ length: n }, (_, i) => ({ t: 1000 * (i + 1), fresh: 1000, read: 0, write: 0, out }));

test('a run is costed at its own model, and the parent\'s follow-up is read from the exchange that launched it', () => {
  const parent = { events: [
    { t: 'prompt', text: 'find x' },
    tool(0, 'Agent', { subagent_type: 'Explore' }, { id: 'toolu_launch' }),
    tool(1, 'Read', { file_path: '/a' }), tool(1, 'Read', { file_path: '/z' }), tool(2, 'Edit', { file_path: '/a' }),
    { t: 'prompt', text: 'now y' },
    tool(3, 'Read', { file_path: '/b' }),
  ] };
  const idx = parentIndex(parent);
  assert.equal(idx.tools.find(t => t.id === 'toolu_launch').exchange, 1);
  const sub = { model: 'gpt-6-sol', calls: calls(3), events: [tool(0, 'Read', { file_path: '/a' }), tool(1, 'Grep', { path: '/b' }), tool(2, 'Bash', { command: 'ls' }, { error: true })] };
  assert.deepEqual([...pathsOf(tool(0, 'Bash', { command: 'sed -n 1,40p src/a.js && grep -n x /r/.worktrees/w/src/b.js | head; cat ./docs/c.md' }), '/r')], ['src/a.js', 'src/b.js', 'docs/c.md'], 'paths in a command, read relative to the checkout, a worktree\'s prefix dropped');
  const r = runOf(sub, idx, { price: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 }, toolUseId: 'toolu_launch' });
  assert.equal(r.calls, 3); assert.equal(r.files, 2); assert.equal(r.errors, 1); assert.equal(r.durationMs, 2000);
  assert.ok(Math.abs(r.cost - (3 * 1000 * 2 + 3 * 100 * 8) / 1e6) < 1e-9);
  assert.deepEqual(r.follow, { calls: 2, reReads: 1, reReadsEver: 2, edited: true, corrected: false, exchange: 1 }, 'the parent read /a again in the exchange, /b in the next, and edited');
  // a background subagent returns in an exchange a task notification opened, which is not the person's: the follow-up is still read
  const bg = parentIndex({ events: [{ t: 'prompt', text: 'go' }, tool(0, 'Agent', {}, { id: 'l' }), { t: 'prompt', text: '<task-notification>done</task-notification>' }, tool(1, 'Read', { file_path: '/a' })] });
  assert.equal(runOf(sub, bg, { toolUseId: 'l' }).follow.reReads, 1);
  assert.equal(runOf(sub, idx, { price: null, toolUseId: 'toolu_launch', corrected: new Set([1]) }).follow.corrected, true);
  assert.equal(runOf(sub, idx, { price: null, toolUseId: 'toolu_launch', corrected: new Set() }).cost, null, 'unpriced is null, never zero');
  assert.equal(runOf(sub, idx, { price: null, toolUseId: 'toolu_missing' }).follow, null, 'a run the parent did not launch by that id has no follow-up');
  const interrupted = parentIndex({ events: [{ t: 'prompt', text: 'x' }, tool(0, 'Agent', {}, { id: 'l' }), { t: 'interrupt' }] });
  assert.equal(runOf(sub, interrupted, { toolUseId: 'l' }).follow.corrected, true, 'an interruption is a correction');
});

test('the recommendation is a rule over the figures: cheaper and no worse by WORSE_BY, past MIN_RUNS runs', () => {
  const g = (model, type, runs, cost, reReads, files, corrected, followed = runs) => ({ model, type, runs, priced: runs, cost, tokens: 0, out: 0, calls: runs * 4, durationMs: 0, errors: 0, files, followed, followCalls: 0, reReads, edits: 0, corrected });
  const groups = {
    'opus|Explore': g('claude-opus-5-5', 'Explore', 30, 12, 15, 100, 3),
    'sol|Explore': g('gpt-6-sol', 'Explore', 10, 1, 8, 40, 1),             // cheaper, re-read 20% vs 15%, corrected 10% vs 10%: within WORSE_BY
    'cheap|Explore': g('tiny-model', 'Explore', 12, 0.6, 30, 48, 6),       // cheapest but re-read 62%, corrected 50%: worse
    'new|Explore': g('newcomer', 'Explore', 2, 0.1, 0, 4, 0),
    'opus|general-purpose': g('claude-opus-5-5', 'general-purpose', 8, 40, 0, 10, 2),
  };
  const rec = recommend(groups);
  const ex = rec.find(r => r.type === 'Explore');
  assert.equal(ex.verdict, 'switch'); assert.equal(ex.recommend, 'gpt-6-sol'); assert.equal(ex.baseline, 'claude-opus-5-5');
  assert.ok(Math.abs(ex.saving - (12 / 30 - 1 / 10)) < 1e-9);
  assert.deepEqual(ex.waiting, [{ model: 'newcomer', runs: 2, need: MIN_RUNS - 2 }]);
  assert.match(ex.why[0], /gpt-6-sol: \$0\.10 a run over 10 runs, parent re-read 20% of its files, corrected 10%/);
  const gp = rec.find(r => r.type === 'general-purpose');
  assert.equal(gp.verdict, 'too-early'); assert.equal(gp.baseline, 'claude-opus-5-5');
  // the same candidate a little worse than the band is a keep
  groups['sol|Explore'].reReads = 12;   // 30% against 15%: worse by 15 points
  assert.equal(recommend(groups).find(r => r.type === 'Explore').verdict, 'keep');
  assert.equal(WORSE_BY, 0.10);
  const f = figures(groups['opus|Explore']);
  assert.equal(f.costPerRun, 0.4); assert.equal(f.reReadShare, 0.15); assert.equal(f.correctedShare, 0.1); assert.equal(f.callsPerRun, 4);
  assert.equal(figures({ ...groups['opus|Explore'], priced: 0, files: 0, followed: 0, calls: 0 }).costPerRun, null);
});

test('the proxy log\'s routed rows give each route its calls, failures and median first byte', () => {
  const f = path.join(tmp('thinker-mp-'), 'proxy.jsonl');
  const at = new Date().toISOString();
  fs.writeFileSync(f, [
    { at, op: 'proxy', route: 'thinker/explore', provider: 'gw', routedModel: 'gpt-6-sol', format: 'chat', status: 200, firstByteMs: 300, input: 10, read: 5, out: 2 },
    { at, op: 'proxy', route: 'thinker/explore', provider: 'gw', routedModel: 'gpt-6-sol', format: 'chat', status: 200, firstByteMs: 900, input: 10, read: 0, out: 2 },
    { at, op: 'proxy', route: 'thinker/explore', provider: 'gw', routedModel: 'gpt-6-sol', format: 'chat', status: 500, firstByteMs: 100, input: 0, out: 0 },
    { at, op: 'proxy', model: 'claude-opus-5-5', status: 200, input: 99 },
    { at: '2000-01-01T00:00:00.000Z', op: 'proxy', route: 'thinker/explore', status: 200 },
    { at, op: 'proxy-route-refused', route: 'thinker/nope' },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  const r = routeFigures({ logFile: f, days: 30 });
  assert.deepEqual(Object.keys(r), ['thinker/explore']);
  assert.equal(r['thinker/explore'].calls, 3); assert.equal(r['thinker/explore'].errors, 1); assert.equal(r['thinker/explore'].firstByteMs, 300); assert.equal(r['thinker/explore'].input, 20); assert.equal(r['thinker/explore'].read, 5);
  assert.deepEqual(routeFigures({ logFile: path.join(path.dirname(f), 'none.jsonl') }), {});
});

// --- the profile over transcripts on disk --------------------------------------------------------------------------------
import { measureRuns, refreshProfile, readProfile, profileView, renderProfile, mergedGroups } from '../src/model-profile.js';
import { Store } from '../src/store.js';
import { execFileSync } from 'node:child_process';

test('measureRuns reads each subagent beside its parent, ties the run to the Agent call that launched it, and keeps the profile per repository', () => {
  const home = tmp('thinker-mp-home-'), repo = tmp('thinker-mp-repo-');
  execFileSync('git', ['init', '-q', repo]);
  const old = { HOME: process.env.HOME, THINKER_HOME: process.env.THINKER_HOME };
  process.env.HOME = home; process.env.THINKER_HOME = home;
  try {
    const proj = path.join(home, '.claude', 'projects', fs.realpathSync(repo).replace(/[\/.]/g, '-'));
    const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    const ts = i => new Date(Date.now() - 3600_000 + i * 1000).toISOString();
    const usage = { input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 };
    const line = (i, type, message, extra = {}) => JSON.stringify({ type, uuid: `u${i}`, timestamp: ts(i), cwd: repo, sessionId: 'p1', message, ...extra }) + '\n';
    const asst = (i, model, content) => line(i, 'assistant', { id: `m${i}`, role: 'assistant', model, usage, content });
    const user = (i, content) => line(i, 'user', { role: 'user', content });
    // the parent: a prompt, an Agent call, then it reads /a (which the subagent had read) and /c, then edits
    put(path.join(proj, 'p1.jsonl'),
      user(0, 'find where x is set') +
      asst(1, 'claude-opus-5-5', [{ type: 'tool_use', id: 'toolu_launch', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'find x' } }]) +
      user(2, [{ type: 'tool_result', tool_use_id: 'toolu_launch', content: 'x is set in /a' }]) +
      asst(3, 'claude-opus-5-5', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a' } }, { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: '/c' } }]) +
      user(4, [{ type: 'tool_result', tool_use_id: 't2', content: 'a' }, { type: 'tool_result', tool_use_id: 't3', content: 'c' }]) +
      asst(5, 'claude-opus-5-5', [{ type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: '/a', old_string: 'x', new_string: 'y' } }]) +
      user(6, [{ type: 'tool_result', tool_use_id: 't4', content: 'ok' }]) +
      asst(7, 'claude-opus-5-5', [{ type: 'text', text: 'done' }]));
    // the subagent: two reads on a routed model, priced by the registry
    const sub = (id, model, meta, files) => {
      put(path.join(proj, 'p1', 'subagents', `agent-${id}.jsonl`),
        line(0, 'user', { role: 'user', content: 'find x' }, { agentId: id, isSidechain: true }) +
        files.map((f, i) => asst(1 + 2 * i, model, [{ type: 'tool_use', id: `s${id}${i}`, name: 'Read', input: { file_path: f } }]) + user(2 + 2 * i, [{ type: 'tool_result', tool_use_id: `s${id}${i}`, content: 'x' }])).join('') +
        asst(9, model, [{ type: 'text', text: 'x is set in /a' }]));
      put(path.join(proj, 'p1', 'subagents', `agent-${id}.meta.json`), JSON.stringify(meta));
    };
    sub('a1b2c3d4e5f6a7b8c', 'vendor/model-a', { agentType: 'Explore', toolUseId: 'toolu_launch' }, ['/a', '/b']);
    sub('ffffffffffffffff0', 'claude-sonnet-5-5', { agentType: 'general-purpose' }, ['/q']);
    fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ version: 1, providers: { gw: { url: 'http://gw', auth: { none: true }, formats: ['chat'], models: { 'vendor/model-a': { source: 'provider', price: { input: 1, output: 4 } } } } }, routes: {}, agents: {} }));
    const store = new Store(repo); store.init();
    const m = measureRuns(store, { days: 7 });
    assert.equal(m.runs, 2);
    const a = m.groups['vendor/model-a|Explore'];
    assert.equal(a.runs, 1); assert.equal(a.calls, 3); assert.equal(a.files, 2); assert.equal(a.priced, 1);
    assert.ok(Math.abs(a.cost - (3 * 1000 * 1 + 3 * 100 * 4) / 1e6) < 1e-9, 'priced at the registry\'s price for the routed model');
    assert.equal(a.followed, 1); assert.equal(a.reReads, 1, 'the parent read /a again, not /b'); assert.equal(a.reReadsEver, 1); assert.equal(a.edits, 1); assert.equal(a.followCalls, 2);
    const s = m.groups['claude-sonnet-5-5|general-purpose'];
    assert.equal(s.runs, 1); assert.equal(s.followed, 0, 'no toolUseId in its meta: no follow-up read'); assert.equal(s.priced, 1);
    const prof = refreshProfile(store, { home, days: 7, logFile: path.join(home, 'none.jsonl') });
    assert.ok(fs.existsSync(path.join(home, 'state', 'model-profile.json')));
    assert.deepEqual(Object.keys(prof.repos), [store.repo]);
    const v = profileView(readProfile(home));
    assert.equal(v.groups.length, 2); assert.equal(v.groups[0].type, 'Explore');
    assert.equal(v.recommendations.find(r => r.type === 'Explore').verdict, 'too-early');
    const text = renderProfile(v).join('\n');
    assert.match(text, /Explore\s+vendor\/model-a\s+1/); assert.match(text, /too early/);
    assert.equal(mergedGroups({ repos: { x: { groups: m.groups }, y: { groups: m.groups } } })['vendor/model-a|Explore'].runs, 2, 'repositories add up');
    assert.deepEqual(renderProfile(profileView({ repos: {}, routes: {} })).length, 1);
  } finally { process.env.HOME = old.HOME; if (old.THINKER_HOME === undefined) delete process.env.THINKER_HOME; else process.env.THINKER_HOME = old.THINKER_HOME; }
});
