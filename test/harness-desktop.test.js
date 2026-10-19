// The Claude desktop app's sessions for `thinker harness` (harness-desktop.js): what the app adds to a
// Claude Code session beyond its transcript, and its Connectors switch, flipped by the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { desktopSessionsDir, desktopRecords, CONNECTOR_TOOL } from '../src/harness-desktop.js';
import { claudeSessionHarness, harnessUsage, harnessAdvice, scheduleHarnessSuggestion, harnessOffer, answerHarness, undoHarness, harnessSavings, readHarnessState } from '../src/harness.js';

const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const long = n => 'x'.repeat(n);
const T0 = Date.parse('2026-10-18T12:00:00Z');
const DOCS = '1a59c906-04da-521d-bda7-7f71b9f9e01c';
const DESKTOP = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, TERMINAL = { CLAUDE_CODE_ENTRYPOINT: 'cli' };
const APPEND = `\n\nYou are running inside the Claude desktop app (Code tab).\n\n## Starting other sessions\n\n${long(8000)}\n\n# Task list and wrap-up (this app)\n${long(2000)}\n\n<browsers>\n${long(600)}\n</browsers>\n\n<built_in_browser>\n${long(600)}\n</built_in_browser>\n`;
const docsServer = { uuid: DOCS, name: 'Claude Docs', url: 'https://example.invalid/mcp', tools: [
  { name: 'batch', description: long(600), inputSchema: { type: 'object' }, _meta: { 'anthropic/alwaysLoad': true } },
  { name: 'read', description: long(600), inputSchema: { type: 'object' } },
] };
const call = name => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input: {} }] } });
const lines = (start, extra = [], { docs = true } = {}) => [
  { type: 'attachment', cwd: '/r', timestamp: new Date(start).toISOString(), attachment: { type: 'deferred_tools_delta', addedNames: ['Monitor', ...(docs ? [`mcp__${DOCS}__read`] : []), 'mcp__ccd_session__start_session'] } },
  { type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: docs ? [DOCS] : [], addedBlocks: docs ? [long(1600)] : [] } },
  { type: 'attachment', attachment: { type: 'skill_listing', content: `- tiny: ${long(40)}\n`, names: ['tiny'] } },
  ...extra,
];

// a Claude home with the app's data under it, and sessions the app ran (a record each) or the terminal ran (none)
function machine(t) {
  const h = tmp('thinker-desktop-home-'), dir = tmp('thinker-desktop-tx-');
  t.after(() => { fs.rmSync(h, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(h, '.claude.json'), '{}');
  const recs = path.join(desktopSessionsDir(h), 'acct', 'org');
  fs.mkdirSync(recs, { recursive: true });
  const add = (id, { desktop = true, start = T0 - 86400_000, extra = [], docs = true } = {}) => {
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines(start, extra, { docs }).map(j => JSON.stringify(j)).join('\n') + '\n');
    // the app lists every connector, the ones switched off with each tool false in enabledMcpTools
    const enabledMcpTools = docs ? undefined : Object.fromEntries(docsServer.tools.map(t => [`${DOCS}:${t.name}`, false]));
    if (desktop) fs.writeFileSync(path.join(recs, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, remoteMcpServersConfig: [docsServer], enabledMcpTools, promptAppendSnapshot: { append: APPEND } }));
    return { client: 'claude', file: path.join(dir, `${id}.jsonl`), session: id, mtime: start };
  };
  return { h, add };
}
function checkout(t) {
  const dir = tmp('thinker-desktop-store-'); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', '-b', 'main'], { cwd: dir });
  return new Store(dir).init();
}

test('a desktop session adds its connectors\' always-loaded tools and the app\'s own instructions', t => {
  const { h, add } = machine(t);
  const s = add('d1', { extra: [call('mcp__ccd_session__start_session')] }), cli = add('c1', { desktop: false });
  const records = desktopRecords(desktopSessionsDir(h));
  assert.equal(records.size, 1);
  const d = claudeSessionHarness(s.file, records), c = claudeSessionHarness(cli.file, records);
  const docs = `mcp:${DOCS.replace(/-/g, '_')}`;
  assert.ok(d.loaded.get(docs) > c.loaded.get(docs) + 100, 'the always-loaded tool definition counts beside the deferred name and the instructions');
  assert.ok(d.loaded.get('desktop:side-sessions') > 1500 && d.loaded.get('desktop:browser') > 200);
  assert.equal(d.loaded.has('desktop:ios-simulator'), false, 'a section the session did not have');
  assert.equal(d.used.has('desktop:side-sessions'), true, 'used: its tools were called');
  assert.equal(d.desktop, true); assert.equal(c.desktop, false);
  assert.equal([...c.loaded.keys()].some(k => k.startsWith('desktop:')), false, 'a terminal session has none of it');
});

test('the advice names the desktop connector by its name and switches it through the app; the app\'s sections are reported only', t => {
  const { h, add } = machine(t);
  const sessions = [0, 1, 2, 3].map(i => add(`d${i}`));
  const usage = harnessUsage('/nonexistent-repo', { home: h, sessions });
  const docs = usage.sources.find(s => s.id === DOCS);
  assert.equal(docs.kind, 'connector'); assert.equal(docs.scope, 'desktop'); assert.equal(docs.name, 'Claude-Docs');
  const side = usage.sources.find(s => s.key === 'desktop:side-sessions');
  assert.equal(side.kind, 'desktop'); assert.equal(side.used, 0);
  const advice = harnessAdvice(usage);
  assert.equal(advice.find(a => a.id === DOCS).how, 'desktop-connector');
  assert.equal(advice.some(a => a.kind === 'desktop'), false, 'thinker switches nothing of the app\'s own');
});

test('the question offers a desktop connector only in the desktop app; the answer has the agent flip the app\'s switch', t => {
  const { h, add } = machine(t), store = checkout(t), th = tmp('thinker-desktop-th-');
  t.after(() => fs.rmSync(th, { recursive: true, force: true }));
  const sessions = [0, 1, 2, 3].map(i => add(`d${i}`));
  const picks = scheduleHarnessSuggestion(store, { now: T0, home: th, usage: harnessUsage(store.repo, { home: h, sessions }) });
  assert.deepEqual(picks.map(p => p.how), ['desktop-connector']);
  assert.equal(harnessOffer(store, { client: 'claude', home: th, now: T0, env: TERMINAL }), '', 'nothing to ask in the terminal');
  assert.equal(readHarnessState(store).pending.offeredAt, undefined, 'still waiting for a desktop session');
  const ask = harnessOffer(store, { client: 'claude', home: th, now: T0, env: DESKTOP });
  assert.match(ask, /Claude-Docs connector/);
  assert.match(ask, /every new session on this machine/);
  const said = answerHarness(store, 'Claude-Docs connector', { client: 'claude', home: th, userHome: h, now: T0 });
  assert.ok(said.includes(CONNECTOR_TOOL) && said.includes(JSON.stringify(DOCS)) && /enabled false/.test(said));
  assert.doesNotMatch(said, /Switched off here/, 'no file was written');
  assert.equal(fs.existsSync(path.join(store.repo, '.claude', 'settings.local.json')), false);

  // measured in desktop sessions only: a terminal session never had the connector
  const later = T0 + 3600_000, after = [add('a1', { start: later, docs: false }), add('a2', { start: later }), add('t1', { start: later, desktop: false, docs: false })];
  const saved = harnessSavings(store, { sessions: after, home: h }).sources[0];
  assert.deepEqual([saved.sessions, saved.absent, saved.stillLoaded, saved.scope], [2, 1, 1, 'desktop']);

  assert.match(undoHarness(store, { home: th, now: T0 }), /Connectors/);
  assert.equal(readHarnessState(store).applied, undefined);
});

test('outside the desktop app a desktop connector is left out of the question and of its answer', t => {
  const { h, add } = machine(t), store = checkout(t), th = tmp('thinker-desktop-th-');
  t.after(() => fs.rmSync(th, { recursive: true, force: true }));
  // a big skill every session loads and none calls, beside the connector
  const sessions = [0, 1, 2, 3].map(i => add(`d${i}`, { extra: [{ type: 'attachment', attachment: { type: 'skill_listing', content: `- bulky: ${long(2000)}\n`, names: ['bulky'] } }] }));
  scheduleHarnessSuggestion(store, { now: T0, home: th, usage: harnessUsage(store.repo, { home: h, sessions }) });
  const ask = harnessOffer(store, { client: 'claude', home: th, now: T0, env: TERMINAL });
  assert.match(ask, /bulky skill/); assert.doesNotMatch(ask, /Claude-Docs/);
  answerHarness(store, 'none', { client: 'claude', home: th, userHome: h, now: T0 });
  const declined = Object.keys(readHarnessState(store).declined);
  assert.ok(declined.includes('skill:bulky')); assert.equal(declined.some(k => k.includes('1a59c906')), false, 'not declined: never asked');
});
