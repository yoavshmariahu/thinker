// The Report page (report.js, `thinker report`): the average a session cost each week by part and by model, the
// cost view at list prices (prices.js), the trend rule, the merge over repositories and the text the command prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { reportView, mergeReports, renderReport, trend, change, weekColumns, weekStart, cacheMetrics, PARTS } from '../src/report.js';
import { listPrice, providerOf, costOf, formatDollars } from '../src/prices.js';

function fixture(t) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-report-')));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Rules\n\nRun the tests.\n');
  const store = new Store(repo); store.init();
  return { repo, store, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-report-tx-')) };
}
// A Claude Code transcript with one tool call, on `model`, reporting `usage` on each of its two model turns
function transcript(dir, name, { model, usage, mtime, client = 'claude' }) {
  const rows = [
    { type: 'user', message: { role: 'user', content: 'tidy a' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model, usage, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat src/a.js' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export const a = 1;\n' }] } },
    { type: 'assistant', message: { id: 'm2', role: 'assistant', model, usage, content: [{ type: 'text', text: 'done' }] } },
  ];
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.utimesSync(file, new Date(mtime), new Date(mtime));
  return { client, file, session: name, mtime };
}
const NOW = new Date('2026-10-22T12:00:00').getTime(), DAY = 86400_000;
const OPUS = { input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50 }; // 500 input a turn (reads included), 50 output

test('weeks run Monday to Sunday, the current week last; a cell trends at 5%', () => {
  const cols = weekColumns(NOW, 5);
  assert.equal(cols.length, 5);
  assert.equal(new Date(cols[4].t).getDay(), 1, 'a Monday');
  assert.equal(cols[4].t, weekStart(NOW));
  assert.equal(cols[3].end, cols[4].t);
  assert.equal(cols[0].t, weekStart(NOW - 28 * DAY));
  assert.equal(trend(100, 106), 'up'); assert.equal(trend(100, 104), null); assert.equal(trend(100, 94), 'down'); assert.equal(trend(null, 5), null); assert.equal(trend(0, 5), null);
  assert.equal(change(100, 150), 0.5); assert.equal(change(0, 5), null); assert.equal(change(200, 100), -0.5);
});

test('list prices: Anthropic from the relative rates, the other providers from the table, the config on top', () => {
  assert.deepEqual(listPrice('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.equal(listPrice('claude-fable-5-1').input, 10);
  assert.equal(listPrice('gpt-6-astra').output, 50);
  assert.equal(listPrice('gemini-3.8-flash-high').input, 0.75);
  assert.equal(listPrice('codex-auto-review'), null);
  assert.deepEqual(listPrice('gpt-7', { config: { prices: { 'gpt-7': { input: 2, output: 8 } } } }), { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 });
  assert.equal(providerOf('claude-opus-5-5'), 'Anthropic'); assert.equal(providerOf('gpt-6-astra'), 'OpenAI'); assert.equal(providerOf('gemini-3.8-flash'), 'Google'); assert.equal(providerOf(null, 'cursor'), 'Cursor');
  // fresh input at the input rate, cache reads at theirs, output at the output rate
  assert.equal(costOf({ input: 1000, cacheRead: 600, cacheWrite: 0, output: 100 }, listPrice('claude-opus-5-5')), (400 * 4 + 600 * 0.2 + 100 * 20) / 1e6);
  assert.equal(formatDollars(0.00372), '$0.004'); assert.equal(formatDollars(3.8), '$3.80'); assert.equal(formatDollars(127.4), '$127'); assert.equal(formatDollars(12345), '$12.3k');
});

test('the report averages each week over its sessions, by part and by model under its provider, in tokens and at list prices', t => {
  const { store, dir } = fixture(t);
  const thisWeek = weekStart(NOW) + DAY, lastWeek = weekStart(NOW) - 3 * DAY;
  const sessions = [
    transcript(dir, 's1', { model: 'claude-opus-5-5', usage: OPUS, mtime: thisWeek }),
    transcript(dir, 's2', { model: 'claude-opus-5-5', usage: OPUS, mtime: thisWeek + 3600_000 }),
    transcript(dir, 's3', { model: 'gpt-6-astra', usage: { input_tokens: 2000, output_tokens: 10 }, mtime: lastWeek }),
    transcript(dir, 's4', { model: 'mystery-9', usage: { input_tokens: 100, output_tokens: 1 }, mtime: lastWeek + 3600_000, client: 'codex' }),
    transcript(dir, 's5', { model: null, usage: undefined, mtime: thisWeek, client: 'cursor' }),
  ];
  // an action taken on Save in the window, and one before it
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [
    { id: 'h1', at: new Date(lastWeek).toISOString(), title: 'Workflow tool', kind: 'tool', key: 'claude:tool:Workflow', act: 'off', decision: 'approved', saving: 4000 },
    { id: 'h0', at: new Date(NOW - 60 * DAY).toISOString(), title: 'old one', kind: 'section', key: 'section:AGENTS.md:old', act: 'remove', decision: 'approved' },
  ] }));
  const v = reportView(store, { now: NOW, sessions });
  assert.equal(v.columns.length, 5);
  assert.deepEqual(v.columns.map(c => c.sessions), [0, 0, 0, 2, 2]);
  assert.deepEqual(v.columns.map(c => c.priced), [0, 0, 0, 1, 2], 'the unpriced model counts in the sessions, not the cost');
  assert.equal(v.columns[4].unmeasured, 1, 'the Cursor session reports no usage');
  // this week: two Opus sessions of 1,000 input (two turns of 500, cache reads included) and 100 output each
  const last = 4, avg = (cells, w) => cells[w].tokens / v.columns[w].sessions;
  assert.equal(avg(v.totals, last), 1100);
  assert.equal(avg(v.parts.find(p => p.key === 'output').cells, last), 100);
  const inputParts = v.parts.filter(p => p.key !== 'output').reduce((a, p) => a + p.cells[last].tokens, 0);
  assert.equal(inputParts, 2000, 'the input parts add up to the measured input');
  assert.ok(v.parts.find(p => p.key === 'outputs').cells[last].tokens > 0, 'the tool output read again by the call after it');
  assert.ok(v.parts.find(p => p.key === 'instructions').cells[last].tokens > 0, 'the instruction file, in every call');
  assert.deepEqual(v.parts.map(p => p.key), PARTS.map(([k]) => k));
  // last week: one gpt-6-astra session (4,020 tokens) and one on an unpriced model (202)
  assert.equal(avg(v.totals, 3), (4020 + 202) / 2);
  assert.deepEqual(v.unpriced, ['mystery-9']);
  // by model: the biggest provider first, each model's share of the average session, the provider's subtotal the sum
  assert.deepEqual(v.providers.map(p => p.name), ['OpenAI', 'Anthropic']);
  const opus = v.models.find(m => m.model === 'claude-opus-5-5'), astra = v.models.find(m => m.model === 'gpt-6-astra');
  assert.equal(opus.provider, 'Anthropic'); assert.equal(opus.cells[last].sessions, 2); assert.equal(opus.cells[last].tokens, 2200);
  assert.equal(v.providers.find(p => p.name === 'Anthropic').cells[last].tokens, 2200);
  assert.equal(v.providers.find(p => p.name === 'OpenAI').cells[3].tokens, astra.cells[3].tokens + v.models.find(m => m.model === 'mystery-9').cells[3].tokens);
  assert.equal(v.models.find(m => m.model === 'mystery-9').priced, false);
  // cost: an Opus session is 400 fresh at $4, 600 cache reads at $0.20, 100 output at $20 per million
  const sessionCost = (400 * 4 + 600 * 0.2 + 100 * 20) / 1e6;
  assert.ok(Math.abs(v.totals[last].cost - 2 * sessionCost) < 1e-9);
  assert.ok(Math.abs(v.parts.reduce((a, p) => a + p.cells[last].cost, 0) - 2 * sessionCost) < 1e-9, 'the parts\' cost adds up to the sessions\' cost');
  assert.ok(Math.abs(v.parts.find(p => p.key === 'output').cells[last].cost - 2 * 100 * 20 / 1e6) < 1e-12);
  assert.ok(Math.abs(v.totals[3].cost - costOf({ input: 4000, output: 20 }, listPrice('gpt-6-astra'))) < 1e-9, 'the unpriced session adds no cost');
  // the actions in the window, the cache's numbers over it
  assert.deepEqual(v.actions.map(a => a.id), ['h1']);
  assert.equal(v.cache.hits, 0); assert.equal(v.cache.dollarsSaved, 0); assert.equal(v.cache.acted, null);
  // the command's text: the two tables with totals, the marks, the actions and the cache
  const text = renderReport(v).join('\n');
  assert.match(text, /By part of the context/); assert.match(text, /TOTAL/); assert.match(text, /ANTHROPIC/); assert.match(text, /claude-opus-5-5/);
  assert.match(text, /mystery-9 \(unpriced\)/); assert.match(text, /Workflow tool/); assert.match(text, /\$ saved\s+\$0\.00/);
  assert.match(renderReport(v, { cost: true }).join('\n'), /list prices/);
  assert.match(renderReport(v, { total: true }).join('\n'), /Total tokens over the week's sessions/);
  // every repository's report merged: the sums and the sessions add, the actions name their repository
  const m = mergeReports([{ repo: 'a', name: 'A', view: v }, { repo: 'b', name: 'B', view: v }]);
  assert.deepEqual(m.columns.map(c => c.sessions), [0, 0, 0, 4, 4]);
  assert.equal(m.totals[last].tokens, 4400);
  assert.equal(m.models.find(x => x.model === 'claude-opus-5-5').cells[last].sessions, 4);
  assert.deepEqual(m.actions.map(a => a.repoName), ['A', 'B']);
  assert.equal(mergeReports([]), null);
});

test('the cache\'s numbers price the saving at each model\'s input rate and keep the unpriced apart', t => {
  const { store } = fixture(t);
  const base = { assessed: { confirmed: 3, contradicted: 1, unused: 0 }, servings: { prompt: 5, file: 1 }, requests: 20, answered: 6 };
  // the servings acted on: 500k tokens on Opus 5.5 at $4 a million, 500k on a model nobody priced
  const est = cacheMetrics(store, { days: 35, usage: { ...base, saved: { tokens: 1e6, byModel: { 'claude-opus-5-5': { servings: 2, tokens: 500000 }, 'mystery-9': { servings: 1, tokens: 500000 } } } } });
  assert.equal(est.measured, false); assert.equal(est.tokensSaved, 1e6); assert.equal(est.dollarsSaved, 2); assert.equal(est.unpricedTokens, 500000);
  assert.equal(est.hits, 6); assert.equal(est.judged, 4); assert.equal(est.acted, 0.75); assert.equal(est.requests, 20);
  // the holdout, where it is measured: (held-out − served) per prompt × the served prompts, by model
  const ho = { enough: true, saved: { inputTokens: 300000 }, byModel: { 'claude-opus-5-5': { served: { perPrompt: { inputTokens: 1000 }, measured: { inputTokens: 100 } }, heldOut: { perPrompt: { inputTokens: 4000 } } } } };
  const m = cacheMetrics(store, { days: 35, usage: { ...base, holdout: ho, saved: { tokens: 1e6, byModel: {} } } });
  assert.equal(m.measured, true); assert.equal(m.tokensSaved, 300000); assert.equal(m.dollarsSaved, 300000 * 4 / 1e6); assert.equal(m.unpricedTokens, 0);
  // read from the log: nothing served, nothing saved
  process.env.THINKER_LOG = 'local'; t.after(() => { delete process.env.THINKER_LOG; });
  const c = cacheMetrics(store, { days: 35 });
  assert.equal(c.hits, 0); assert.equal(c.dollarsSaved, 0); assert.equal(c.acted, null);
});
