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
  assert.deepEqual(v.skills.map(s => [s.name, s.perSession, s.label, s.outcome.missed]), [['naming', 1200, null, 1]]);
  assert.deepEqual(v.tools.map(s => s.name), ['rea', 'Workflow']);
  assert.equal(v.totals.tools.perSession, 44000);
  assert.ok(v.instructions.sections.every(s => !s.kept)); assert.equal(v.instructions.coreOn, false);
  // with the harness on, a source with a setting gets the label `thinker harness --off` takes; a built-in tool only where they are on
  fs.writeFileSync(path.join(store.dir, 'config.json'), JSON.stringify({ harness: { enabled: true } }));
  v = contextView(store, { sessions: [], usage, log });
  assert.equal(v.tools.find(s => s.name === 'rea').label, 'rea MCP server');
  assert.equal(v.tools.find(s => s.name === 'Workflow').label, null);
  setCore(store, ['API views']);
  v = contextView(store, { sessions: [], usage, log });
  assert.equal(v.instructions.coreOn, true);
  assert.deepEqual(v.instructions.sections.filter(s => s.kept).map(s => s.id), ['api-views']);
});
