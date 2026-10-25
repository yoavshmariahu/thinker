// The machine's Context report (context-machine.js): what the installer prints from the sessions that ran before
// thinker was installed, kept for the page, and the suggestions drawn from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { machineContext, recommendations, recommendationLine, renderMachineReport, MACHINE_REPOS, MACHINE_TOP } from '../src/context-machine.js';
import { readSnapshot } from '../src/context-snapshot.js';
import { keptCheckouts } from '../src/ui/server.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const AGENTS = '# R\n\n## API views\n\nKeep views thin; logic goes in `src/api/` services.\n\n## History\n\nWe tried a cache server once.\n';

function repo(t, { agents = AGENTS } = {}) {
  const dir = tmp('thinker-cm-repo-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '-b', 'main', dir]);
  fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/api/views.js'), 'export const view = 1;\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# r\n');
  if (agents) fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents);
  return dir;
}
// a Claude Code session in `dir` that read the README and nothing under src/api
function session(home, dir, name) {
  const folder = path.join(home, '.claude', 'projects', dir.replace(/[/.]/g, '-')); fs.mkdirSync(folder, { recursive: true });
  const rows = [
    { type: 'user', cwd: dir, sessionId: name, message: { role: 'user', content: 'tidy the readme' } },
    { type: 'assistant', cwd: dir, message: { id: 'm1', role: 'assistant', model: 'claude-x', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(dir, 'README.md') } }] } },
    { type: 'user', cwd: dir, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '# r' }] } },
    { type: 'assistant', cwd: dir, message: { id: 'm2', role: 'assistant', model: 'claude-x', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'text', text: 'done' }] } },
  ];
  fs.writeFileSync(path.join(folder, `${name}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
function machine(t) {
  const home = tmp('thinker-cm-home-'), th = tmp('thinker-cm-th-');
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, THINKER_LOG: process.env.THINKER_LOG };
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude'); process.env.CODEX_HOME = path.join(home, '.codex'); process.env.THINKER_LOG = 'local';
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(th, { recursive: true, force: true }); });
  // any store: the machine's log is read through it, and the directory need not be a repository (the installer runs anywhere)
  const store = new Store(tmp('thinker-cm-cwd-'));
  return { home, th, store };
}

test('the installer\'s report reads the most active repositories, keeps each report for the page, and lists what to cut', t => {
  const { home, th, store } = machine(t);
  const a = repo(t), b = repo(t, { agents: null });
  session(home, a, 's1'); session(home, a, 's2'); session(home, b, 's3');
  const r = machineContext(store, { home, limit: 1, thinkerHome: th });
  assert.deepEqual(r.repos.map(x => x.checkout), [a], 'the repository with more sessions, within the limit');
  assert.equal(r.repos[0].sessions, 2);
  assert.equal(r.more, 1, 'one more repository was not read');
  assert.deepEqual(r.skipped, []);
  // a cache started there, as the first session would, and the page's reports kept for both windows
  const st = new Store(a);
  assert.ok(st.exists());
  assert.ok(readSnapshot(st, 30)); assert.ok(readSnapshot(st, 7));
  assert.ok(keptCheckouts({ home: th, transcriptsHome: home }).checkouts.includes(a), 'the page\'s list names it');
  // merged as the page's All repositories: the sections carry their repository
  assert.equal(r.view.all, true);
  const views = r.view.instructions.sections.find(s => s.title === 'API views');
  assert.equal(views.repoName, path.basename(a));
  assert.equal(views.applied, 0); assert.equal(views.sessions, 2);
  // what to cut: the section nothing applied to, by its triggers; History names no file and is unknown, not listed
  const recs = recommendations(r.view);
  assert.equal(recs.items[0].kind, 'section'); assert.equal(recs.items[0].title, 'API views');
  assert.equal(recs.items[0].used, 0); assert.equal(recs.items[0].of, 2); assert.equal(recs.items[0].by, 'triggers');
  assert.ok(!recs.items.some(x => x.title === 'History'));
  const lines = renderMachineReport(r, recs);
  assert.match(lines[0], /from 2 sessions of the last 30 days/);
  assert.match(lines[0], /1 more repository not read/);
  assert.ok(lines.some(l => /1\. AGENTS\.md section "API views" \(.*\): ~.* tokens a prompt .*applied in 0 of 2 sessions/.test(l)), lines.join('\n'));
  assert.match(lines[lines.length - 1], /thinker ui \(Context, All repositories\)/);
  // both repositories within a larger limit, the busier first; one without an instruction file reads fine
  const both = machineContext(store, { home, limit: MACHINE_REPOS, thinkerHome: th });
  assert.deepEqual(both.repos.map(x => x.checkout), [a, b]);
  assert.equal(both.more, 0);
});

test('with no sessions the report says so and suggests nothing', t => {
  const { home, th, store } = machine(t);
  const r = machineContext(store, { home, thinkerHome: th });
  assert.equal(r.view, null); assert.deepEqual(r.repos, []);
  assert.deepEqual(recommendations(r.view), { items: [], flagged: 0, potential: 0 });
  assert.match(renderMachineReport(r, recommendations(null))[0], /No agent sessions on this machine in the last 30 days/);
});

test('suggestions are the flagged parts, costliest first, tools switched off left out, with the judge\'s counts where it judged', () => {
  const view = {
    all: true,
    instructions: { sections: [
      { id: 'a', title: 'A', file: 'AGENTS.md', repoName: 'r', waste: 'high', wasted: 3000, perPrompt: 4000, usedShare: 0.25, usedBy: 'triggers', applied: 2, sessions: 8 },
      { id: 'j', title: 'J', file: 'AGENTS.md', repoName: 'r', waste: 'medium', wasted: 1000, perPrompt: 2000, usedShare: 0.4, usedBy: 'judge', applied: 7, sessions: 8, followed: 2, judged: 5 },
      { id: 'ok', title: 'OK', waste: 'low', wasted: 10, perPrompt: 5000, usedShare: 0.9 },
      { id: 'u', title: 'U', waste: 'unknown', wasted: null, perPrompt: 5000, usedShare: null },
    ] },
    skills: [{ key: 'sk', name: 'sk', client: 'claude', perPrompt: 2000, usedShare: 0, used: 0, loaded: 10, label: 'skill:sk' }],
    tools: [
      { key: 'Artifact', name: 'Artifact', client: 'claude', group: 'builtin', perPrompt: 10000, usedShare: 0.1, used: 1, loaded: 10, repos: 2 },
      { key: 'Workflow', name: 'Workflow', client: 'claude', group: 'builtin', perPrompt: 100, usedShare: 0, used: 0, loaded: 10, off: true },
      { key: 'mcp:x', name: 'x', client: 'codex', group: 'mcp', perPrompt: 500, usedShare: 0.2, used: 2, loaded: 10, repos: 1 },
    ],
  };
  const recs = recommendations(view, { top: 10 });
  assert.deepEqual(recs.items.map(x => [x.kind, x.title, x.wasted]), [['tool', 'Artifact', 9000], ['section', 'A', 3000], ['skill', 'sk', 2000], ['section', 'J', 1000], ['tool', 'x', 400]]);
  assert.equal(recs.flagged, 5); assert.equal(recs.potential, 15400);
  const j = recs.items.find(x => x.title === 'J');
  assert.equal(j.used, 2); assert.equal(j.of, 5); assert.equal(j.by, 'judge');
  assert.match(recommendationLine(j), /followed in 2 of 5 sessions/);
  assert.match(recommendationLine(recs.items[0]), /^built-in tool "Artifact" \(2 repositories\): ~9k tokens a prompt .*called in 1 of 10 sessions/);
  assert.match(recommendationLine(recs.items[4]), /^codex MCP server "x"/);
  assert.match(recommendationLine(recs.items[2]), /read in 0 of 10 sessions/);
  // the top cuts the list, not the totals
  const top = recommendations(view, { top: 2 });
  assert.equal(top.items.length, 2); assert.equal(top.flagged, 5); assert.equal(top.potential, 15400);
  assert.equal(MACHINE_TOP, 5);
  const lines = renderMachineReport({ days: 30, repos: [{ name: 'r', sessions: 8 }], view: { ...view, totals: { instructions: { tokens: 1, perPrompt: 2 }, custom: { tokens: 3, perPrompt: 4 }, builtin: { tokens: 5, perPrompt: 6 }, outputs: { tokens: 7, perPrompt: 8 } } } }, top);
  assert.ok(lines.some(l => /about ~12k tokens a prompt in these 2, ~15k over all 5 flagged/.test(l)), lines.join('\n'));
});

// the installer's picker (setup/context-ask.js): the suggestions as the changes the page's rows make, in their repositories
test('machineChanges: a section never applied is removed in its repository, a tool in every repository; applyMachinePicks goes through approveChanges per repository', async t => {
  const { machineChanges, pickLine, pickNote, applyMachinePicks, suggestedPicks } = await import('../src/context-machine.js');
  const { changeHistory } = await import('../src/context-suggest.js');
  const { home, th, store } = machine(t);
  const a = repo(t), b = repo(t, { agents: null });
  session(home, a, 's1'); session(home, a, 's2'); session(home, b, 's3');
  const r = machineContext(store, { home, thinkerHome: th });
  assert.equal(r.views.length, 2); assert.equal(r.views[0].checkout, a);
  const recs = recommendations(r.view);
  const picks = machineChanges(r, recs);
  const sec = picks.find(p => p.kind === 'section');
  assert.ok(sec, 'the section is a pick');
  assert.equal(sec.act, 'remove', 'applied in 0 of 2 sessions by its triggers: removed');
  assert.deepEqual(sec.targets.map(x => x.checkout), [a], 'in its own repository only');
  assert.equal(sec.targets[0].change.chosen, 'remove'); assert.equal(sec.targets[0].change.key, `section:AGENTS.md:${sec.id}`);
  // the page the installer opens pre-checks the same rows with the same actions (suggestedPicks, sent with /api/context)
  const sp = suggestedPicks(r.view);
  assert.equal(sp.length, recs.items.length);
  assert.deepEqual(sp.find(s => s.kind === 'section'), { kind: 'section', key: `section:AGENTS.md:${sec.id}`, repo: r.views[0].repo, act: 'remove' });
  for (const s of sp.filter(s => s.kind !== 'section')) { assert.equal(s.act, 'off'); assert.equal(s.repo, null); }
  assert.equal(pickLine(sec), `Remove the AGENTS.md section "API views" in ${path.basename(a)}`);
  assert.match(pickNote(sec), /tokens a prompt, applied in 0 of 2 sessions$/);
  // a section the judge saw, or one applied somewhere, is compressed; a tool is switched off in every repository that has it
  const views = [
    { repo: 'r1', name: 'r1', checkout: '/c1', view: { days: 30, instructions: { sections: [{ id: 'j', title: 'J', file: 'AGENTS.md', text: 't', waste: 'medium', wasted: 1000, tokens: 100, perPrompt: 2000, usedShare: 0.4 }] }, skills: [], tools: [{ key: 'Artifact', name: 'Artifact', client: 'claude', group: 'builtin', label: 'tool:Artifact', text: '', perSession: 10000, usedShare: 0.1, used: 1, loaded: 10, waste: 'high', wasted: 9000 }], outputs: { tools: [] } } },
    { repo: 'r2', name: 'r2', checkout: '/c2', view: { days: 30, instructions: { sections: [] }, skills: [], tools: [{ key: 'Artifact', name: 'Artifact', client: 'claude', group: 'builtin', label: 'tool:Artifact', text: '', perSession: 10000, usedShare: 0, used: 0, loaded: 5, waste: 'high', wasted: 10000 }, { key: 'mcp:x', name: 'x', client: 'claude', group: 'mcp', kind: 'mcp', text: '', perSession: 500, usedShare: 0, used: 0, loaded: 5, waste: 'high', wasted: 500 }], outputs: { tools: [] } } },
  ];
  const recs2 = { items: [
    { kind: 'section', id: 'j', title: 'J', file: 'AGENTS.md', repo: 'r1', repoId: 'r1', wasted: 1000, perSession: 2000, used: 2, of: 5, by: 'judge' },
    { kind: 'tool', group: 'builtin', key: 'Artifact', title: 'Artifact', client: 'claude', repos: 2, wasted: 9000, perSession: 10000, used: 1, of: 15, by: 'called' },
    { kind: 'tool', group: 'mcp', key: 'mcp:x', title: 'x', client: 'claude', repos: 1, wasted: 500, perSession: 500, used: 0, of: 5, by: 'called' },
  ] };
  const p2 = machineChanges({ views }, recs2);
  assert.deepEqual(p2.map(p => [p.title, p.act, p.targets.map(x => x.checkout)]), [['J', 'compress', ['/c1']], ['Artifact', 'off', ['/c1', '/c2']], ['x', 'off', []]], 'the MCP server nothing switches off has no target');
  assert.equal(pickLine(p2[2]), 'Switch off the MCP server "x"');
  assert.deepEqual(await applyMachinePicks([p2[2]]), [], 'and nothing to apply');
  assert.equal(pickLine(p2[1]), 'Remove the built-in tool "Artifact" in 2 repositories'.replace('Remove', 'Switch off'));
  assert.match(pickNote(p2[0]), /followed in 2 of 5 sessions, a model call$/);
  // applied: the removal in repository a through approveChanges, recorded in that repository's history, nothing in b
  const said = await applyMachinePicks([sec]);
  assert.equal(said.length, 1); assert.match(said[0], /^AGENTS\.md · API views: Removed: ~\d+ → ~\d+ tokens in AGENTS\.md, uncommitted$/);
  assert.ok(!fs.readFileSync(path.join(a, 'AGENTS.md'), 'utf8').includes('API views'), 'the section is gone from the working tree');
  assert.equal(changeHistory(new Store(a)).length, 1); assert.equal(changeHistory(new Store(a))[0].decision, 'approved');
  assert.equal(changeHistory(new Store(b)).length, 0);
  // several repositories: each line named, each store its own; a failure is a line, not a throw
  const calls = [];
  const approve = async (st, changes) => { calls.push([st.repo, changes.map(c => c.chosen)]); if (st.repo === c2) throw new Error('boom'); return changes.map(c => `${c.title}: off`); };
  const c1 = repo(t), c2 = repo(t);
  const two = { ...p2[1], targets: p2[1].targets.map((x, i) => ({ ...x, checkout: i ? c2 : c1 })) };
  const lines = await applyMachinePicks([two], { approve });
  assert.deepEqual(calls.map(([d, acts]) => acts), [['off'], ['off']]);
  assert.deepEqual(lines, [`r1: Artifact tool: off`, `r2: boom`]);
});
