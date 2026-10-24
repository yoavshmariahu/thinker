import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { instructionFile, valueSections, sessionActivity, appliedSections, instructionValue, judgeSessionFile, judgeRecent, valueOf, readValueState, IDLE_MS } from '../src/instruction-value.js';
import { contextView, skillOutcomes } from '../src/context-view.js';
import { setCore } from '../src/instructions-core.js';

const AGENTS = `# Repo

## API views

Keep views thin; logic goes in \`src/api/\` services.

## Commits and pull requests

Use conventional commits.

## History

We tried a cache server once.
`;

function fixture(t, { agents = AGENTS, claude } = {}) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ivalue-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/api/views.js'), 'export const view = 1;\n');
  if (agents != null) fs.writeFileSync(path.join(repo, 'AGENTS.md'), agents);
  if (claude != null) fs.writeFileSync(path.join(repo, 'CLAUDE.md'), claude);
  const store = new Store(repo); store.init();
  return { repo, store };
}

// A Claude Code transcript: each call one model turn, the tool's result in the next user message.
function transcript(dir, name, calls, { mtime } = {}) {
  const rows = [{ type: 'user', message: { role: 'user', content: 'tidy the api views' } }];
  calls.forEach(([tool, input, result], i) => {
    rows.push({ type: 'assistant', message: { id: `m${i}`, role: 'assistant', model: 'claude-x', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'tool_use', id: `t${i}`, name: tool, input }] } });
    rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: result || 'ok' }] } });
  });
  rows.push({ type: 'assistant', message: { id: 'end', role: 'assistant', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'text', text: 'done' }] } });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  if (mtime) fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return { client: 'claude', file, session: name, mtime: mtime || Date.now() - 3600_000 };
}

test('the instruction file is AGENTS.md for every agent unless CLAUDE.md has text of its own', t => {
  assert.deepEqual(instructionFile(fixture(t).repo).notClients, []);
  assert.deepEqual(instructionFile(fixture(t, { claude: '@AGENTS.md\n' }).repo).notClients, [], 'a CLAUDE.md that imports AGENTS.md reads the same text');
  assert.deepEqual(instructionFile(fixture(t, { claude: '# our own\n' }).repo).notClients, ['claude'], 'Claude Code reads its own file then');
  const onlyClaude = instructionFile(fixture(t, { agents: null, claude: AGENTS }).repo);
  assert.equal(onlyClaude.file, 'CLAUDE.md'); assert.deepEqual(onlyClaude.onlyClients, ['claude']);
  assert.equal(instructionFile(fixture(t, { agents: null }).repo), null);
});

test('a section applies when the session touches its files or runs its command; one naming nothing never does', t => {
  const { repo, store } = fixture(t);
  const secs = valueSections(store);
  assert.deepEqual(secs.map(s => s.id), ['api-views', 'commits-and-pull-requests', 'history']);
  assert.deepEqual(secs.map(s => s.triggered), [true, true, false]);
  const events = [
    { t: 'prompt', text: 'tidy' },
    { t: 'tool', name: 'Read', input: { file_path: path.join(repo, 'src/api/views.js') }, result: 'export const view = 1;' },
    { t: 'tool', name: 'Bash', input: { command: 'git commit -m "fix: views"' }, result: '' },
    { t: 'say', text: 'done' },
  ];
  const a = sessionActivity(repo, events);
  assert.deepEqual(a.read, ['src/api/views.js']);
  assert.deepEqual(appliedSections(secs, a), { 'api-views': 'path', 'commits-and-pull-requests': 'cmd' });
  assert.deepEqual(appliedSections(secs, sessionActivity(repo, [{ t: 'tool', name: 'Bash', input: { command: 'ls' }, result: '' }])), {});
});

test('the report counts applied sessions and the cost of each section a session, and keeps records by transcript size', t => {
  const { repo, store } = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ivalue-tr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessions = [
    transcript(dir, 's1', [['Read', { file_path: path.join(repo, 'src/api/views.js') }], ['Bash', { command: 'git commit -m x' }]]),
    transcript(dir, 's2', [['Bash', { command: 'ls' }]]),
  ];
  const v = instructionValue(store, { sessions });
  assert.equal(v.file, 'AGENTS.md'); assert.equal(v.sessions, 2);
  const api = v.sections.find(s => s.id === 'api-views');
  assert.equal(api.applied, 1); assert.equal(api.judged, 0); assert.equal(api.success, null);
  assert.equal(api.perSession, api.tokens * v.calls, 'its tokens, read again by each model call');
  assert.ok(v.calls >= 2);
  assert.equal(Object.keys(readValueState(store).sessions).length, 2);
  // a Claude Code session does not count when CLAUDE.md is its own text
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# ours\n');
  assert.equal(instructionValue(store, { sessions }).sessions, 0);
});

test('the judge keeps verdicts for known sections only, once a session, and the report sums them', async t => {
  const { repo, store } = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ivalue-tr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const s = transcript(dir, 's1', [['Bash', { command: 'git commit -m x' }]]);
  let prompt = '', calls = 0;
  const completeFn = async q => { calls++; prompt = q.prompt; return { json: { sections: [
    { id: 'commits-and-pull-requests', verdict: 'violated', evidence: 'git commit -m x is not conventional' },
    { id: 'api-views', verdict: 'applicable', evidence: 'read the views' },
    { id: 'no-such-section', verdict: 'followed', evidence: 'x' },
    { id: 'history', verdict: 'nonsense', evidence: 'x' },
  ] }, tokens: { totalTokens: 1234 } }; };
  const r = await judgeSessionFile(store, s.file, { session: 's1', client: 'claude', completeFn });
  assert.deepEqual(Object.keys(r.verdicts).sort(), ['api-views', 'commits-and-pull-requests']);
  assert.match(prompt, /\[id: commits-and-pull-requests\]/); assert.match(prompt, /git commit -m x/);
  assert.equal((await judgeSessionFile(store, s.file, { session: 's1', completeFn })).skipped, 'judged');
  assert.equal(calls, 1);
  const v = instructionValue(store, { sessions: [s] });
  const commits = v.sections.find(x => x.id === 'commits-and-pull-requests');
  assert.deepEqual([commits.judged, commits.violated, commits.followed, commits.bore, commits.success], [1, 1, 0, 1, 0]);
  assert.equal(v.sections.find(x => x.id === 'history').bore, 0);
  const line = fs.readFileSync(path.join(store.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).find(e => e.op === 'instruction-value');
  assert.equal(line?.sections?.['commits-and-pull-requests'], 'violated');
});

test('judging recent sessions skips one still being written and those judged', async t => {
  const { store } = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ivalue-tr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  const live = transcript(dir, 'live', [['Bash', { command: 'ls' }]], { mtime: now - 60_000 });
  const old = transcript(dir, 'old', [['Bash', { command: 'ls' }]], { mtime: now - IDLE_MS - 60_000 });
  const seen = [];
  const completeFn = async () => ({ json: { sections: [] } });
  const r = await judgeRecent(store, { n: 5, sessions: [live, old], completeFn, now, onEach: s => seen.push(s.session) });
  assert.deepEqual(seen, ['old']); assert.equal(r.judged, 1);
  assert.equal((await judgeRecent(store, { n: 5, sessions: [live, old], completeFn, now })).judged, 0);
});

test('value labels need enough sessions to say anything', () => {
  assert.equal(valueOf({ sessions: 2, applied: 0, triggered: true, judged: 0, bore: 0, followed: 0, violated: 0 }), 'unknown');
  assert.equal(valueOf({ sessions: 20, applied: 0, triggered: true, judged: 0, bore: 0, followed: 0, violated: 0 }), 'rare');
  assert.equal(valueOf({ sessions: 20, applied: 9, triggered: true, judged: 0, bore: 0, followed: 0, violated: 0 }), 'situational');
  assert.equal(valueOf({ sessions: 20, applied: 9, triggered: true, judged: 10, bore: 4, followed: 2, violated: 1 }), 'used');
  assert.equal(valueOf({ sessions: 20, applied: 9, triggered: true, judged: 10, bore: 0, followed: 0, violated: 0 }), 'rare');
});

test('skill outcomes: rules kept among the checked sessions that read the skill, and misses', () => {
  const now = Date.parse('2026-10-20T00:00:00Z'), t = '2026-10-19T00:00:00.000Z';
  const log = [
    { op: 'skill-outcome', t, skills: ['writing-tests', 'naming'], read: ['writing-tests'], credited: [{ skill: 'naming', verdict: 'missed' }] },
    { op: 'skill-outcome', t, skills: ['writing-tests'], read: ['writing-tests'], credited: [{ skill: 'writing-tests', verdict: 'broken-after-read' }] },
    { op: 'skill-outcome', t, skills: ['writing-tests'], read: ['writing-tests'], credited: [] },
    { op: 'skill-outcome', t: '2026-08-01T00:00:00.000Z', skills: ['writing-tests'], read: [], credited: [] },
  ];
  const o = skillOutcomes(null, { days: 30, now, log });
  assert.deepEqual([o['writing-tests'].checked, o['writing-tests'].read, o['writing-tests'].brokenAfterRead], [3, 3, 1]);
  assert.equal(Math.round(100 * o['writing-tests'].success), 67);
  assert.deepEqual([o.naming.read, o.naming.missed, o.naming.success], [0, 1, null]);
});

test('the context view puts sections, skills and tools side by side, with the kept sections and switches', t => {
  const { store } = fixture(t);
  const usage = { sessions: 4, calls: { claude: 10 }, builtinTools: false, sources: [
    { key: 'skill:naming', name: 'naming', kind: 'skill', scope: 'project', loaded: 4, used: 0, tokens: 120, skills: [] },
    { key: 'mcp:rea', name: 'rea', kind: 'mcp', scope: 'user', loaded: 4, used: 0, tokens: 2000, skills: [] },
    { key: 'tool:Workflow', name: 'Workflow', kind: 'tool', scope: 'builtin', loaded: 4, used: 0, tokens: 2400, skills: [] },
  ] };
  const log = [{ op: 'skill-outcome', t: new Date().toISOString(), skills: ['naming'], read: [], credited: [{ skill: 'naming', verdict: 'missed' }] }];
  let v = contextView(store, { sessions: [], usage, log });
  assert.equal(v.harnessOn, false);
  // a label even with the harness off: picking it on the tab turns the harness on (context-view.js:switchSources)
  assert.deepEqual(v.skills.map(s => [s.name, s.perSession, !!s.label, s.outcome.missed]), [['naming', 1200, true, 1]]);
  assert.deepEqual(v.tools.map(s => s.name), ['rea', 'Workflow']);
  assert.equal(v.totals.tools.perSession, 44000);
  assert.ok(v.instructions.sections.every(s => !s.kept)); assert.equal(v.instructions.coreOn, false);
  // the label `thinker harness --off` takes, for a built-in tool too (switching it off turns built-in tool switching on)
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ harness: { enabled: true } }));
  v = contextView(store, { sessions: [], usage, log });
  assert.equal(v.tools.find(s => s.name === 'rea').label, 'rea MCP server');
  assert.ok(v.tools.find(s => s.name === 'Workflow').label);
  setCore(store, ['API views']);
  v = contextView(store, { sessions: [], usage, log });
  assert.equal(v.instructions.coreOn, true);
  assert.deepEqual(v.instructions.sections.filter(s => s.kept).map(s => s.id), ['api-views']);
});

test('a repository with no instruction file still has a context view: empty instructions, the tools and skills as before', t => {
  const { store } = fixture(t);
  fs.rmSync(path.join(store.repo, 'AGENTS.md'));
  const usage = { sessions: 2, calls: { claude: 5 }, builtinTools: false, sources: [{ key: 'mcp:rea', name: 'rea', kind: 'mcp', scope: 'user', loaded: 2, used: 0, tokens: 1000, skills: [] }] };
  const v = contextView(store, { sessions: [], usage, log: [] });
  assert.equal(v.instructions.file, null);
  assert.deepEqual(v.instructions.sections, []);
  assert.deepEqual(v.totals.instructions, { tokens: 0, perSession: 0 });
  assert.deepEqual(v.tools.map(s => s.name), ['rea']);
  assert.deepEqual(v.timeline, []);
});

test('a tool output costs its tokens once for each model call after it, scaled to the calls the session made', async () => {
  const { sessionOutputs, toolKey } = await import('../src/tool-outputs.js');
  const ev = (name, chars) => ({ t: 'tool', name, input: {}, result: 'x'.repeat(chars) });
  const events = [ev('Read', 400), ev('Bash', 40), ev('mcp__rea__q', 80), { t: 'say', text: 'done' }];
  // one call a model call: the Read is read by the three calls after it (two tools, then the answer)
  const one = sessionOutputs(events);
  // never used again (no edit copies it, no later call names its file): every read but the first is unneeded
  assert.deepEqual(one.Read, { calls: 1, tokens: 100, input: 300, unneeded: 200, saveModerate: 0, saveHigh: 0 }, 'under both caps: nothing to save');
  const big = sessionOutputs([ev('Bash', 8000), { t: 'say', text: 'x' }]);
  assert.deepEqual([big.Bash.tokens, big.Bash.saveModerate, big.Bash.saveHigh], [2000, 0, 1000], 'past the high cap of 1k tokens');
  assert.equal(one['mcp:rea'].input, 20, 'an MCP server is one row, its last result read once');
  // two model calls for three tool calls: each result is read by half as many calls, never less than once
  const two = sessionOutputs(events, 2);
  assert.equal(two.Read.input, 150);
  assert.equal(two['mcp:rea'].input, 20);
  assert.equal(toolKey('mcp__claude-in-chrome__navigate'), 'mcp:claude-in-chrome');
  // a screenshot costs what the parser read from its pixels, never its base64; the caps cut text alone
  const shot = sessionOutputs([{ t: 'tool', name: 'mcp__claude-in-chrome__computer', input: {}, result: '[image]', images: 1, imageTokens: 1500 }, { t: 'say', text: 'x' }]);
  assert.deepEqual(shot['mcp:claude-in-chrome'], { calls: 1, tokens: 1502, input: 1502, unneeded: 0, saveModerate: 0, saveHigh: 0 });
  const mcpText = sessionOutputs([ev('mcp__rea__q', 16000), { t: 'say', text: 'x' }]);
  assert.deepEqual([mcpText['mcp:rea'].tokens, mcpText['mcp:rea'].saveModerate, mcpText['mcp:rea'].saveHigh], [4000, 1000, 1000], 'an MCP server past the cap is a saving, the moderate one at either level');
});

test('waste: high or medium by what a section cost in the sessions that did not use it, as a share of the file', async () => {
  const { wasteLevel, use } = await import('../src/instruction-value.js');
  // acted on in 1 of 10 judged sessions, 100k a session: wastes 90k
  const r = use({ sessions: 20, applied: 0, triggered: false, judged: 10, followed: 1 }, 100_000);
  assert.deepEqual(r, { usedShare: 0.1, usedBy: 'judge', wasted: 90_000 });
  assert.equal(wasteLevel(r, 1_000_000).waste, 'high', '9% of the file');
  assert.equal(wasteLevel(r, 3_000_000).waste, 'medium', '3% of the file');
  assert.equal(wasteLevel(r, 10_000_000).waste, 'low', 'under 2%');
  assert.equal(wasteLevel({ usedShare: 0.6, wasted: 400_000 }, 1_000_000).waste, 'high', 'used in most sessions, but 40% of the file in the rest');
  assert.equal(wasteLevel({ usedShare: 0.9, wasted: 10_000 }, 1_000_000).waste, 'low', '1% of the file');
  assert.equal(wasteLevel({ usedShare: null, wasted: null }, 1_000_000).waste, 'unknown');
});

test('remove and compress: a diff first, then exactly that text written to the working tree, never over a changed file', async t => {
  const { previewEdit, applyEdit, locate } = await import('../src/instruction-edit.js');
  const { repo, store } = fixture(t);
  assert.equal(locate(AGENTS, 'history').end - locate(AGENTS, 'history').start, 4);
  const p = await previewEdit(store, 'history', 'remove');
  assert.ok(p.diff.every(([k]) => k === '-')); assert.equal(p.tokensAfter, 0);
  assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), AGENTS, 'a preview writes nothing');
  assert.match(applyEdit(store, 'history').said, /Removed/);
  // several at once: one preview, one apply
  const m = await previewEdit(store, ['api-views', 'commits-and-pull-requests'], 'remove');
  assert.equal(m.key, 'bulk'); assert.equal(m.sections.length, 2);
  assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8').includes('## API views'), true);
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), AGENTS.replace('## History\n\nWe tried a cache server once.\n', ''));
  const after = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(!after.includes('## History') && after.includes('## Commits and pull requests'));
  // compress: the model's text, under the section's own heading
  const completeFn = async () => ({ text: 'Conventional commits.' });
  const c = await previewEdit(store, 'commits-and-pull-requests', 'compress', { completeFn });
  assert.ok(c.diff.some(([k, l]) => k === '+' && l === 'Conventional commits.'));
  fs.appendFileSync(path.join(repo, 'AGENTS.md'), '\nedited meanwhile\n');
  assert.match(applyEdit(store, 'commits-and-pull-requests').error, /changed since the preview/);
  assert.match(applyEdit(store, 'nothing').error, /preview/);
});

test('all repositories: the timeline joined, sections tagged with their repository, a tool merged by name', async () => {
  const { mergeViews } = await import('../src/context-view.js');
  const view = (sessions, tool, sec) => ({ days: 30, sessions, totals: { custom: { tokens: 10, perSession: 100, count: 1 } }, skills: [], tools: [tool], outputs: { sessions, tools: [] },
    instructions: { file: 'AGENTS.md', sessions, judged: 0, calls: 10, judge: { judge: false }, sections: [sec], savings: { window: 50, sessions: 1 } }, timeline: [{ t: sessions, custom: 1 }] });
  // each repository's row carries its own waste (its cost times its unused share) and pill, as contextView leaves them
  const tool = (loaded, perSession, used = 1) => ({ client: 'claude', key: 'mcp:rea', name: 'rea', kind: 'mcp', group: 'mcp', loaded, used, tokens: 1000, perSession, usedShare: used / loaded, wasted: Math.round(perSession * (1 - used / loaded)), waste: 'high' });
  const v = mergeViews([{ repo: 'a', name: 'A', view: view(1, tool(1, 100), { id: 's', perSession: 10 }) }, { repo: 'b', name: 'B', view: view(3, tool(3, 500), { id: 's', perSession: 10 }) }]);
  assert.equal(v.all, true); assert.equal(v.sessions, 4); assert.equal(v.timeline.length, 2);
  assert.deepEqual(v.instructions.sections.map(s => s.repoName), ['A', 'B']);
  assert.equal(v.tools.length, 1); assert.equal(v.tools[0].loaded, 4); assert.equal(v.tools[0].perSession, 400, 'weighted by the sessions that loaded it');
  assert.equal(v.instructions.savings.window, 100);
  // waste from the merged figures, never above the merged cost: the first repository's row costs 2,000 a session, all of it
  // unused (used in 0 of 2), the second 100 used every time; merged, 2 of 6 sessions used it at a cost of 733 a session
  const skill = (loaded, used, perSession) => ({ client: 'claude', key: 'skill:x', name: 'x', kind: 'skill', loaded, used, tokens: 100, perSession, usedShare: used / loaded, wasted: Math.round(perSession * (1 - used / loaded)), waste: 'high' });
  const m = mergeViews([
    { repo: 'a', name: 'A', view: { ...view(2, tool(2, 2000, 0), { id: 's', perSession: 10 }), skills: [skill(2, 0, 2000)] } },
    { repo: 'b', name: 'B', view: { ...view(4, tool(4, 100, 4), { id: 's', perSession: 10 }), skills: [skill(4, 2, 100)] } },
  ]);
  for (const r of [m.tools[0], m.skills[0]]) {
    assert.equal(r.perSession, 733); assert.ok(r.wasted <= r.perSession, `waste ${r.wasted} within the merged cost`);
  }
  assert.equal(m.tools[0].usedShare, 4 / 6); assert.equal(m.tools[0].wasted, Math.round(733 * (2 / 6)));
  assert.equal(m.skills[0].usedShare, 2 / 6, 'a merged skill\'s share from the merged counts, not the first repository\'s'); assert.equal(m.skills[0].wasted, Math.round(733 * (4 / 6)));
  assert.equal(m.skills[0].waste, 'high', 'graded against the merged kind cost'); assert.equal(m.tools[0].waste, 'high');
});

test('bash outputs by program; compression per tool or per command, high keeping less than moderate', async t => {
  const { bashProgram, toolKey } = await import('../src/tool-outputs.js');
  const { setDietLevel, dietConfig, toolLevel, capOutput, compressible } = await import('../src/diet.js');
  assert.equal(bashProgram('cd src && rg -n foo'), 'rg');
  assert.equal(bashProgram('FOO=1 timeout 60 npm test'), 'npm test');
  assert.equal(bashProgram('git -C x log --oneline'), 'git log');
  assert.equal(bashProgram('for f in *; do cat $f; done'), 'shell loop');
  assert.equal(toolKey('Bash', { command: 'sed -n 1,200p a.py' }), 'Bash:sed');
  assert.ok(compressible('Bash:sed') && compressible('Read') && compressible('mcp:rea') && !compressible('Grep'));
  const { store } = fixture(t);
  setDietLevel(store, ['Bash:sed', 'Read', 'mcp:rea', 'Grep'], 'high');
  setDietLevel(store, ['Bash'], 'moderate');
  const cfg = dietConfig(store);
  assert.equal(cfg.enabled, true); assert.deepEqual(cfg.tools, { 'Bash:sed': 'high', Read: 'high', 'mcp:rea': 'moderate', Bash: 'moderate' }, 'an MCP server by its key, at moderate however asked; a tool the diet cannot replace is never set');
  assert.equal(toolLevel(cfg, 'Bash', { command: 'sed -n 1p a' }), 'high', "a command's own level first");
  assert.equal(toolLevel(cfg, 'Bash', { command: 'ls' }), 'moderate', "else Bash's");
  assert.equal(toolLevel(cfg, 'Grep', {}), null);
  assert.equal(toolLevel(cfg, 'mcp__rea__q', {}), 'moderate', "an MCP tool takes its server's level");
  assert.equal(toolLevel({ ...cfg, tools: { 'mcp:rea': 'high' } }, 'mcp__rea__q', {}), 'moderate', 'a high stored before reads as moderate');
  assert.equal(toolLevel(cfg, 'mcp__other__q', {}), null);
  const { setOutputCompression } = await import('../src/context-view.js');
  assert.match(setOutputCompression(store, ['mcp:rea', 'Read'], 'high'), /High compression for mcp:rea, Read .* An MCP server takes moderate only \(mcp:rea\)/);
  assert.equal(dietConfig(store).tools['mcp:rea'], 'moderate');
  setDietLevel(store, ['Bash:sed', 'Read', 'Bash', 'mcp:rea'], null);
  assert.equal(dietConfig(store).enabled, false, 'nothing set: off');
  const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  const c = capOutput(long, 1000);
  assert.ok(c.length < 1200 && c.startsWith('line 0') && c.endsWith('line 399') && /lines left out/.test(c));
});

test('switching a tool off from the tab turns the harness on here, and built-in tool switching for a built-in tool', async t => {
  const { switchSources } = await import('../src/context-view.js');
  const { store } = fixture(t);
  assert.equal(switchSources(store, { labels: [] }), 'nothing chosen');
  switchSources(store, { labels: ['Workflow tool'], builtin: true });
  const h = store.config().harness;
  assert.equal(h.enabled, true); assert.equal(h.builtinTools, true);
});

test('nested instruction files and rules count in the sessions that read them, and can be compressed or removed', async t => {
  const { instructionFiles, instructionValue } = await import('../src/instruction-value.js');
  const { previewEdit, applyEdit } = await import('../src/instruction-edit.js');
  const { repo, store } = fixture(t);
  fs.mkdirSync(path.join(repo, 'web'), { recursive: true }); fs.mkdirSync(path.join(repo, '.claude/rules'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'web/AGENTS.md'), '# Web\n\n## Components\n\nUse function components.\n');
  fs.writeFileSync(path.join(repo, 'web/CLAUDE.md'), '@AGENTS.md\n');
  fs.writeFileSync(path.join(repo, 'web/app.js'), 'x\n');
  fs.writeFileSync(path.join(repo, '.claude/rules/api.md'), '---\npaths:\n  - "src/api/**"\n---\nValidate every request body.\n');
  fs.writeFileSync(path.join(repo, '.claude/rules/always.md'), 'Be brief.\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  const files = instructionFiles(repo);
  assert.deepEqual(files.map(f => [f.file, f.kind]), [['AGENTS.md', 'root'], ['.claude/rules/always.md', 'rule'], ['.claude/rules/api.md', 'rule'], ['web/AGENTS.md', 'nested']], "web/CLAUDE.md is web/AGENTS.md: once");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ivalue-tr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // one session in src/api (the api rule loads), one in web/ (the nested file loads)
  const sessions = [transcript(dir, 'api', [['Read', { file_path: path.join(repo, 'src/api/views.js') }]]), transcript(dir, 'web', [['Read', { file_path: path.join(repo, 'web/app.js') }]])];
  const v = instructionValue(store, { sessions });
  assert.equal(v.file, 'AGENTS.md + 3 more'); assert.equal(v.sessions, 2);
  const f = Object.fromEntries(v.files.map(x => [x.file, x.loadedIn]));
  assert.deepEqual(f, { 'AGENTS.md': 2, '.claude/rules/always.md': 2, '.claude/rules/api.md': 1, 'web/AGENTS.md': 1 });
  const comp = v.sections.find(s => s.file === 'web/AGENTS.md'), root = v.sections.find(s => s.id === 'api-views');
  assert.equal(comp.id, 'web-agents-md--components'); assert.equal(comp.loadedIn, 1);
  assert.equal(comp.perSession, Math.round(comp.tokens * v.calls * 0.5), 'its cost averaged over every session');
  assert.equal(root.loadedIn, 2);
  // a rule with no headings is one section; removed, the file goes
  const rule = v.sections.find(s => s.file === '.claude/rules/api.md');
  assert.equal(rule.whole, true);
  const p = await previewEdit(store, [rule.id, comp.id], 'remove');
  assert.equal(p.files.length, 2);
  assert.match(applyEdit(store, p.key).said, /2 sections in 2 files/);
  assert.equal(fs.existsSync(path.join(repo, '.claude/rules/api.md')), false);
  assert.ok(!fs.readFileSync(path.join(repo, 'web/AGENTS.md'), 'utf8').includes('## Components'));
});
