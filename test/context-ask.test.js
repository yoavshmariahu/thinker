// The installer's question on the Context report (setup/context-ask.js): browser or terminal, and in the terminal
// the suggestions as a multi-select applied at once. Driven through a mock terminal; nothing is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { askMachineReport, canOpenBrowser, ASK_WHERE } from '../src/setup/context-ask.js';

class Stdin extends EventEmitter { constructor() { super(); this.isTTY = true; this.isRaw = false; } setRawMode(v) { this.isRaw = v; } resume() {} pause() {} }
class Stdout { constructor() { this.isTTY = true; this.writes = []; } write(s) { this.writes.push(s); } }
const tick = () => new Promise(r => setTimeout(r, 5));

// a report over two repositories with one section to remove and one tool to switch off everywhere
function report() {
  const tool = { key: 'Artifact', name: 'Artifact', client: 'claude', group: 'builtin', label: 'tool:Artifact', text: '', perSession: 10000, usedShare: 0.1, used: 1, loaded: 10, waste: 'high', wasted: 9000 };
  const sec = { id: 'api', title: 'API views', file: 'AGENTS.md', text: 'x', waste: 'high', wasted: 3000, tokens: 300, perSession: 4000, usedShare: 0, usedBy: 'triggers', applied: 0, sessions: 8, triggered: true };
  const totals = { instructions: { tokens: 1, perSession: 2 }, custom: { tokens: 3, perSession: 4 }, builtin: { tokens: 5, perSession: 6 }, outputs: { tokens: 7, perSession: 8 } };
  const v1 = { days: 30, sessions: 8, totals, instructions: { sessions: 8, sections: [sec] }, skills: [], tools: [tool], outputs: { tools: [] } };
  const v2 = { days: 30, sessions: 2, totals, instructions: { sessions: 0, sections: [] }, skills: [], tools: [{ ...tool, used: 0, loaded: 2 }], outputs: { tools: [] } };
  const view = { all: true, days: 30, totals, instructions: { sections: [{ ...sec, repo: 'r1', repoName: 'r1' }] }, skills: [], tools: [{ ...tool, repos: 2, label: null, used: 1, loaded: 12, usedShare: 1 / 12 }], outputs: { tools: [] } };
  const r = { days: 30, repos: [{ id: 'r1', name: 'r1', checkout: '/c1', sessions: 8 }, { id: 'r2', name: 'r2', checkout: '/c2', sessions: 2 }], skipped: [], more: 0, view, views: [{ repo: 'r1', name: 'r1', checkout: '/c1', view: v1 }, { repo: 'r2', name: 'r2', checkout: '/c2', view: v2 }] };
  const recs = { items: [
    { kind: 'tool', group: 'builtin', key: 'Artifact', title: 'Artifact', client: 'claude', repos: 2, wasted: 9000, perSession: 10000, used: 1, of: 12, by: 'called' },
    { kind: 'section', id: 'api', title: 'API views', file: 'AGENTS.md', repo: 'r1', repoId: 'r1', wasted: 3000, perSession: 4000, used: 0, of: 8, by: 'triggers' },
    { kind: 'tool', group: 'builtin', key: 'Workflow', title: 'Workflow', client: 'claude', repos: 2, wasted: 2000, perSession: 2000, used: 0, of: 12, by: 'called' },
  ], flagged: 3, potential: 14000 };
  return { r, recs };
}
const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-ask-')));

test('without a terminal the report is printed as the command prints it, with nothing asked', async () => {
  const { r, recs } = report(), out = [];
  const res = await askMachineReport({ r, recs, store, out: l => out.push(l), stdin: { isTTY: false }, stdout: new Stdout(), ui: () => { throw new Error('not started'); } });
  assert.equal(res.mode, 'printed');
  assert.ok(out.some(l => /^Cut first/.test(l)) && out.some(l => /Review and apply in the browser: thinker ui/.test(l)), out.join('\n'));
});

test('in the terminal: the summary, the choice, the cuts with the page\'s address, then the picks applied through one call', async () => {
  const { r, recs } = report(), out = [], stdin = new Stdin(), stdout = new Stdout(), applied = [], opened = [];
  const p = askMachineReport({ r, recs, store, out: l => out.push(l), stdin, stdout, browser: true, ui: () => 'http://127.0.0.1:7777/', open: x => { opened.push(x); return true; }, apply: async picks => { applied.push(picks); return picks.map(x => `${x.title}: done`); } });
  stdin.emit('keypress', 't', { name: 't' });           // here in the terminal
  await tick();
  assert.ok(out.some(l => /^Where your agents' context goes, from 10 sessions/.test(l)), 'the summary came first');
  assert.ok(out.some(l => /^Cut first/.test(l)), 'then the cuts');
  assert.ok(out.some(l => l.includes('http://127.0.0.1:7777/#tab=save&view=all')), 'and the page\'s address');
  assert.ok(!out.some(l => /thinker instructions --remove|thinker harness --off/.test(l)), 'no commands to type');
  const drawn = stdout.writes.join('');
  assert.ok(drawn.includes('Switch off the built-in tool "Artifact" in 2 repositories'), drawn);
  assert.ok(drawn.includes('Remove the AGENTS.md section "API views" in r1'), drawn);
  assert.ok(drawn.includes('applied in 0 of 8 sessions'), drawn);
  assert.ok(drawn.includes('Switch off the built-in tool "Workflow"') && drawn.includes('nothing switches it off per repository'), 'a suggestion with no action is a disabled row');
  stdin.emit('keypress', 'a', { name: 'a' });           // every row
  stdin.emit('keypress', null, { name: 'return' });
  const res = await p;
  assert.equal(res.mode, 'terminal'); assert.equal(opened.length, 0);
  assert.equal(applied.length, 1); assert.deepEqual(applied[0].map(x => [x.title, x.act]), [['Artifact', 'off'], ['API views', 'remove']]);
  assert.ok(out.some(l => /Artifact: done/.test(l)) && out.some(l => /API views: done/.test(l)), out.join('\n'));
  assert.ok(out.some(l => /uncommitted: review them with git diff/.test(l)));
});

test('Esc skips: nothing applied; the browser choice opens the page and prints no list; --no-browser asks no choice', async () => {
  const { r, recs } = report();
  let out = [], stdin = new Stdin(), stdout = new Stdout(), applied = 0;
  let p = askMachineReport({ r, recs, store, out: l => out.push(l), stdin, stdout, browser: true, ui: () => null, apply: async () => { applied++; return []; } });
  stdin.emit('keypress', 't', { name: 't' }); await tick();
  stdin.emit('keypress', null, { name: 'escape' });
  let res = await p;
  assert.equal(applied, 0); assert.deepEqual(res.picked, []);
  assert.ok(out.some(l => /Nothing changed\. The suggestions stay on the page \(thinker ui\)/.test(l)), out.join('\n'));
  // the browser
  out = []; stdin = new Stdin(); stdout = new Stdout(); const opened = [];
  p = askMachineReport({ r, recs, store, out: l => out.push(l), stdin, stdout, browser: true, ui: () => { throw new Error('no'); }, open: x => { opened.push(x.store); return true; }, apply: async () => { applied++; return []; } });
  stdin.emit('keypress', null, { name: 'return' });     // the first option
  res = await p;
  assert.equal(res.mode, 'browser'); assert.deepEqual(opened, [store]); assert.equal(applied, 0);
  assert.ok(out.some(l => /Opening the Find Savings page in your browser .* suggested savings already checked/.test(l)));
  assert.ok(!out.some(l => /^Cut first/.test(l)), 'the list is on the page');
  assert.equal(ASK_WHERE[0].value, 'browser');
  // no browser to offer: straight to the list
  out = []; stdin = new Stdin(); stdout = new Stdout();
  p = askMachineReport({ r, recs, store, out: l => out.push(l), stdin, stdout, browser: false, ui: () => null, apply: async () => { applied++; return []; } });
  await tick();
  assert.ok(!stdout.writes.join('').includes('In the browser'), 'no choice drawn');
  assert.ok(out.some(l => /^Cut first/.test(l)));
  stdin.emit('keypress', null, { name: 'escape' });
  await p;
  assert.equal(applied, 0);
});

test('the browser is offered on a display, not in tests, CI or over ssh', () => {
  assert.equal(canOpenBrowser({}, 'darwin'), true);
  assert.equal(canOpenBrowser({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(canOpenBrowser({}, 'linux'), false);
  assert.equal(canOpenBrowser({ THINKER_TEST: '1' }, 'darwin'), false);
  assert.equal(canOpenBrowser({ CI: '1' }, 'darwin'), false);
  assert.equal(canOpenBrowser({ SSH_CONNECTION: 'x' }, 'darwin'), false);
});
