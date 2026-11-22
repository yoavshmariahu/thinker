// The installer's question on the Context report (setup/context-ask.js): the suggestions as a multi-select applied
// at once, in the terminal. Driven through a mock terminal; nothing is spawned. (The browser answer went with the
// Find Savings page, 2026-11-21.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.js';
import { askMachineReport } from '../src/setup/context-ask.js';

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
  const res = await askMachineReport({ r, recs, store, out: l => out.push(l), stdin: { isTTY: false }, stdout: new Stdout() });
  assert.equal(res.mode, 'printed');
  assert.ok(out.some(l => /^Cut first/.test(l)) && out.some(l => /Review and apply in each repository: thinker context --approve <numbers>/.test(l)), out.join('\n'));
});

test('in the terminal: the summary, the cuts, where the figures are, then the picks applied through one call', async () => {
  const { r, recs } = report(), out = [], stdin = new Stdin(), stdout = new Stdout(), applied = [];
  const p = askMachineReport({ r, recs, store, out: l => out.push(l), stdin, stdout, apply: async picks => { applied.push(picks); return picks.map(x => `${x.title}: done`); } });
  await tick();
  assert.ok(out.some(l => /^Where your agents' context goes, from 10 sessions/.test(l)), 'the summary came first');
  assert.ok(out.some(l => /^Cut first/.test(l)), 'then the cuts');
  // no page to send anyone to: the figures are the command's, and no link and no question about a browser is drawn
  assert.ok(out.some(l => /Every part with its figures: .*thinker context/.test(l)), out.join('\n'));
  assert.ok(!out.some(l => /127\.0\.0\.1|tab=save|Find Savings/.test(l)), 'no address of a page that no longer shows the parts');
  assert.ok(!out.some(l => /See what to cut first/.test(l)) && !stdout.writes.join('').includes('In the browser'), 'no browser-or-terminal choice');
  assert.ok(!out.some(l => /thinker instructions --remove|thinker harness --off/.test(l)), 'no commands to type');
  const drawn = stdout.writes.join('');
  assert.ok(drawn.includes('Create tool reference for the built-in tool "Artifact" in 2 repositories'), drawn);
  assert.ok(drawn.includes('Remove the AGENTS.md section "API views" in r1'), drawn);
  assert.ok(drawn.includes('needed in 0% of prompts'), drawn);
  assert.ok(drawn.includes('Create tool reference for the built-in tool "Workflow"') && drawn.includes('nothing switches it off per repository'), 'a suggestion with no action is a disabled row');
  // the suggestions come checked: unchecking is the work, and Enter is the Apply
  assert.match(drawn, /\[x\].*Create tool reference for the built-in tool "Artifact"/);
  assert.match(drawn, /\[x\].*Remove the AGENTS\.md section "API views"/);
  assert.ok(out.some(l => /Apply the checked\?/.test(l)), out.join('\n'));
  assert.match(drawn, /n clears all, Enter applies the checked/);
  stdin.emit('keypress', null, { name: 'return' });     // the checked rows, nothing else pressed
  const res = await p;
  assert.equal(res.mode, 'terminal');
  assert.equal(applied.length, 1); assert.deepEqual(applied[0].map(x => [x.title, x.act]), [['Artifact', 'off'], ['API views', 'remove']]);
  assert.ok(out.some(l => /Artifact: done/.test(l)) && out.some(l => /API views: done/.test(l)), out.join('\n'));
  assert.ok(out.some(l => /A section's rewrite goes on in the background/.test(l)));
});

test('Esc skips: nothing applied, and the suggestions stay in the command', async () => {
  const { r, recs } = report();
  const out = [], stdin = new Stdin(), stdout = new Stdout(); let applied = 0;
  const p = askMachineReport({ r, recs, store, out: l => out.push(l), stdin, stdout, apply: async () => { applied++; return []; } });
  await tick();
  stdin.emit('keypress', null, { name: 'escape' });     // checked or not, Esc applies nothing
  const res = await p;
  assert.equal(applied, 0); assert.deepEqual(res.picked, []); assert.equal(res.mode, 'terminal');
  assert.ok(out.some(l => /Nothing changed\. The suggestions stay in .*thinker context/.test(l)), out.join('\n'));
});

test('n clears the checked suggestions, and Enter then applies nothing', async () => {
  const { r, recs } = report(), out = [], stdin = new Stdin(), stdout = new Stdout();
  let applied = 0;
  const p = askMachineReport({ r, recs, store, out: l => out.push(l), stdin, stdout, apply: async () => { applied++; return []; } });
  await tick();
  stdin.emit('keypress', 'n', { name: 'n' });
  stdin.emit('keypress', null, { name: 'return' });
  const res = await p;
  assert.equal(applied, 0); assert.deepEqual(res.picked, []);
  assert.ok(out.some(l => /Nothing changed/.test(l)), out.join('\n'));
});
