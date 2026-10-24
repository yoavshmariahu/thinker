// The Report page (report.js, `thinker report`): the average a prompt (one call to the model) cost each week by part and by model, the
// cost view at list prices (prices.js), the trend rule, the merge over repositories and the text the command prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { reportView, mergeReports, renderReport, trend, change, weekColumns, weekStart, cacheMetrics, PARTS, BREAKDOWN, outputComparison, actionEffect, itemCost, effectSpan, reportTop, withEffects } from '../src/report.js';
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
    { type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: ['You are an agent.'] } },
    { type: 'attachment', attachment: { type: 'environment', text: 'cwd is here' } },
    { type: 'user', message: { role: 'user', content: 'tidy a' } },
    { type: 'assistant', message: { id: 'm1', role: 'assistant', model, usage: usage && { ...usage, output_tokens_details: { thinking_tokens: 40 } }, content: [{ type: 'thinking', thinking: '', signature: 'x'.repeat(172) }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat src/a.js' } }] } },
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
  // an action taken on Save in the window (half an hour after the first session of last week), and one before it
  fs.mkdirSync(path.join(store.dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(store.dir, 'state', 'context-suggest.json'), JSON.stringify({ history: [
    { id: 'h1', at: new Date(lastWeek + 1800_000).toISOString(), title: 'Workflow tool', kind: 'tool', key: 'claude:tool:Workflow', act: 'off', decision: 'approved', saving: 4000 },
    { id: 'h0', at: new Date(NOW - 60 * DAY).toISOString(), title: 'old one', kind: 'section', key: 'section:AGENTS.md:old', act: 'remove', decision: 'approved' },
  ] }));
  const v = reportView(store, { now: NOW, sessions });
  assert.equal(v.columns.length, 6);
  assert.deepEqual(v.columns.map(c => c.sessions), [0, 0, 0, 0, 2, 2]);
  assert.deepEqual(v.columns.map(c => c.priced), [0, 0, 0, 0, 1, 2], 'the unpriced model counts in the sessions, not the cost');
  assert.equal(v.columns[5].unmeasured, 1, 'the Cursor session reports no usage');
  // this week: two Opus sessions of 1,000 input (two turns of 500, cache reads included) and 100 output each: 550 a prompt
  // (a prompt is one call to the model, two a session here; the average is the week's sum over its prompts)
  const last = 5, avg = (cells, w) => cells[w].tokens / v.columns[w].prompts;
  assert.equal(v.columns[last].prompts, 4); assert.equal(v.columns[last].sessions, 2);
  assert.equal(avg(v.sessionTotals, last), 550, 'the whole prompt, under the model table');
  assert.equal(v.sessionTotals[last].prompts, 4, 'a cell carries its prompts');
  const bd = k => v.breakdown.find(p => p.key === k);
  assert.equal(avg(bd('output').cells, last), 50);
  const inputParts = v.breakdown.filter(p => p.key !== 'output').reduce((a, p) => a + p.cells[last].tokens, 0);
  assert.equal(inputParts, 2000, 'the input parts add up to the measured input');
  assert.ok(v.parts.find(p => p.key === 'outputs').cells[last].tokens > 0, 'the tool output read again by the call after it');
  assert.ok(v.parts.find(p => p.key === 'instructions').cells[last].tokens > 0, 'the instruction file, in every call');
  // the conversation's own cost, from the transcript: the second call reads the first turn's thinking (40 tokens by the
  // usage), the prompt and the tool call before it; the system prompt once a call
  assert.equal(bd('thinking').cells[last].tokens, 2 * 40);
  assert.ok(bd('prompts').cells[last].tokens > 0);
  assert.ok(bd('agentCalls').cells[last].tokens > 0);
  assert.equal(bd('system').cells[last].tokens, 2 * 2 * Math.ceil('["You are an agent."]'.length / 4));
  assert.equal(bd('notes').cells[last].tokens, 2 * 2 * Math.ceil(JSON.stringify({ type: 'environment', text: 'cwd is here' }).length / 4), 'an environment note, read by both calls');
  assert.deepEqual(v.parts.map(p => p.key), PARTS.map(([k]) => k));
  assert.deepEqual(v.parts.map(p => p.key), ['instructions', 'custom', 'builtin', 'outputs'], 'the tables show the four the Save page controls');
  assert.deepEqual(v.breakdown.map(p => p.key), BREAKDOWN.map(([k]) => k));
  assert.equal(v.totals[last].tokens, v.parts.reduce((a, p) => a + p.cells[last].tokens, 0), 'the parts table totals the four');
  // last week: one gpt-6-astra session (4,020 tokens) and one on an unpriced model (202)
  assert.equal(avg(v.sessionTotals, 4), (4020 + 202) / 4);
  assert.deepEqual(v.unpriced, ['mystery-9']);
  // by model: the biggest provider first, each model's share of the average prompt, the provider's subtotal the sum
  assert.deepEqual(v.providers.map(p => p.name), ['OpenAI', 'Anthropic']);
  const opus = v.models.find(m => m.model === 'claude-opus-5-5'), astra = v.models.find(m => m.model === 'gpt-6-astra');
  assert.equal(opus.provider, 'Anthropic'); assert.equal(opus.cells[last].sessions, 2); assert.equal(opus.cells[last].prompts, 4); assert.equal(opus.cells[last].tokens, 2200);
  assert.equal(v.providers.find(p => p.name === 'Anthropic').cells[last].tokens, 2200); assert.equal(v.providers.find(p => p.name === 'Anthropic').cells[last].prompts, 4);
  assert.equal(v.providers.find(p => p.name === 'OpenAI').cells[4].tokens, astra.cells[4].tokens + v.models.find(m => m.model === 'mystery-9').cells[4].tokens);
  assert.equal(v.models.find(m => m.model === 'mystery-9').priced, false);
  // cost: an Opus session is 400 fresh at $4, 600 cache reads at $0.20, 100 output at $20 per million
  const sessionCost = (400 * 4 + 600 * 0.2 + 100 * 20) / 1e6;
  assert.ok(Math.abs(v.sessionTotals[last].cost - 2 * sessionCost) < 1e-9);
  assert.ok(Math.abs(v.breakdown.reduce((a, p) => a + p.cells[last].cost, 0) - 2 * sessionCost) < 1e-9, 'the breakdown\'s cost adds up to the sessions\' cost');
  assert.ok(Math.abs(bd('output').cells[last].cost - 2 * 100 * 20 / 1e6) < 1e-12);
  assert.ok(Math.abs(v.sessionTotals[4].cost - costOf({ input: 4000, output: 20 }, listPrice('gpt-6-astra'))) < 1e-9, 'the unpriced session adds no cost');
  // the actions in the window, the cache's numbers over it
  assert.deepEqual(v.actions.map(a => a.id), ['h1']);
  assert.equal(v.cache.hits, 0); assert.equal(v.cache.dollarsSaved, 0); assert.equal(v.cache.acted, null);
  // one row a measured session: its input, the four parts, and the things it cost (the files read with the calls, each
  // source loaded, each tool's outputs), for the actions' attribution
  assert.equal(v.sessionRows.length, 4, 'the Cursor session reports no usage and has no row');
  assert.deepEqual(Object.keys(v.sessionRows[0].parts), ['instructions', 'custom', 'builtin', 'outputs']);
  assert.deepEqual(Object.keys(v.sessionRows[0]).sort(), ['calls', 'files', 'input', 'outputs', 'parts', 'prompts', 'sources', 't']); assert.equal(v.sessionRows[0].prompts, 2);
  // the action in the window with what it alone saved: the Workflow tool was loaded in no fixture session, so before and
  // since cost 0 a prompt, over 1 session before and 3 since; the Report's top list holds it
  const f = v.actions[0].effect;
  assert.deepEqual([f.before.sessions, f.after.sessions, f.before.prompts, f.after.prompts, f.before.perPrompt, f.after.perPrompt, f.delta, f.window, f.few], [1, 3, 2, 6, 0, 0, 0, 0, true]);
  assert.deepEqual(v.top.map(a => a.id), ['h1']);
  // the command's text: the two tables with totals, the marks, the actions and the cache
  const text = renderReport(v).join('\n');
  assert.match(text, /By part of the context/); assert.match(text, /TOTAL/); assert.match(text, /ANTHROPIC/); assert.match(text, /claude-opus-5-5/);
  assert.match(text, /mystery-9 \(unpriced\)/); assert.match(text, /Workflow tool/); assert.match(text, /\$ saved\s+\$0\.00/); assert.match(text, /per prompt \(one call to the model\), by week \(.*sessions, 0, 0, 0, 0, 4, 4 prompts\)/);
  // --total: the improvements over the prompts since
  assert.match(renderReport(v, { total: true }).join('\n'), /saved since {11}pull request  change/);
  // Recent improvements: one line an action with before, after, saved a prompt and the pull request
  assert.match(text, /Recent improvements\n  decided {6}before {3}after  saved a prompt {8}pull request  change\n  \d{4}-\d\d-\d\d {8}0 {7}0  −0 \(few\) {14}– {13}Workflow tool\n/);
  assert.doesNotMatch(text, /Saved with thinker/);
  assert.match(renderReport(v, { cost: true }).join('\n'), /list prices/);
  assert.match(renderReport(v, { total: true }).join('\n'), /Total tokens over the week's sessions/);
  // every repository's report merged: the sums and the sessions add, the actions name their repository
  const m = mergeReports([{ repo: 'a', name: 'A', view: v }, { repo: 'b', name: 'B', view: v }]);
  assert.deepEqual(m.columns.map(c => c.sessions), [0, 0, 0, 0, 4, 4]);
  assert.equal(m.sessionTotals[last].tokens, 4400); assert.equal(m.columns[last].prompts, 8); assert.equal(m.sessionTotals[last].prompts, 8);
  assert.equal(m.models.find(x => x.model === 'claude-opus-5-5').cells[last].sessions, 4);
  assert.deepEqual(m.actions.map(a => a.repoName), ['A', 'B']);
  assert.deepEqual(m.top.map(a => a.repoName), ['A', 'B'], 'the top list over every repository');
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

test('outputComparison: a compressed tool against itself before, the saving a session over the sessions since', () => {
  const rows = [
    { name: 'Bash:sed', level: null, sessions: 277, from: 1, to: 2, calls: 8.5, perCall: 1000, perSession: 889_000, wasted: 732_000 },
    { name: 'Bash:sed', level: 'moderate', sessions: 8, from: 3, to: 4, calls: 7, perCall: 1600, perSession: 463_000, wasted: 277_000 },
    { name: 'Bash:cat', level: null, sessions: 285, perCall: 700, perSession: 300_000 },
  ];
  const m = outputComparison(rows, 'Bash:sed');
  assert.deepEqual([m.before.sessions, m.after.sessions, m.after.level], [277, 8, 'moderate']);
  assert.deepEqual(m.perSession, { before: 889_000, after: 463_000, delta: 426_000, share: 426_000 / 889_000 });
  assert.deepEqual([m.perCall.delta, m.window, m.few], [-600, 426_000 * 8, false]);
  assert.equal(outputComparison(rows, 'Bash:cat'), null, 'nothing measured under a setting yet');
  assert.equal(outputComparison(rows, 'Read'), null);
});

test('actionEffect: what one decision saved, attributed to the thing it changed alone; reportTop the five in effect that saved most', () => {
  const T0 = Date.parse('2026-10-01T00:00:00Z'), H = 3600_000;
  const row = (h, x) => ({ t: T0 + h * H, input: 10000, prompts: 1, parts: { instructions: 0, custom: 0, builtin: 0, outputs: 0 }, calls: 10, files: ['AGENTS.md'], sources: {}, outputs: {}, ...x });
  const rows = [row(0, { sources: { 'claude:tool:Workflow': 4000 }, outputs: { 'Bash:grep': 9000 } }), row(1, { sources: { 'claude:tool:Workflow': 4000 }, files: [] }), row(10, { outputs: { 'Bash:grep': 1000 } }), row(11, { calls: 20 }), row(20, { sources: { 'claude:tool:Workflow': 2000 } })];
  const at = h => new Date(T0 + h * H).toISOString(), now = T0 + 30 * H;
  // the thing's cost in a session: a section its tokens on that side times the calls where the file was read; a source
  // what the session loaded it at; a tool's outputs what they cost; a section without recorded tokens cannot be costed
  const sec = { kind: 'section', key: 'section:AGENTS.md:x', file: 'AGENTS.md', tokens: { before: 300, after: 0 }, at: at(5), decision: 'applied after review' };
  assert.equal(itemCost(sec, rows[0], 'before'), 3000); assert.equal(itemCost(sec, rows[1], 'before'), 0, 'the file was not read'); assert.equal(itemCost(sec, rows[3], 'after'), 0);
  assert.equal(itemCost({ ...sec, tokens: { before: 300, after: 100 } }, rows[3], 'after'), 2000);
  assert.equal(itemCost({ kind: 'section', key: 'section:AGENTS.md:x', at: at(5) }, rows[0], 'before'), null);
  assert.equal(itemCost({ kind: 'tool', key: 'claude:tool:Workflow' }, rows[0], 'before'), 4000); assert.equal(itemCost({ kind: 'tool', key: 'claude:tool:Workflow' }, rows[2], 'after'), 0);
  assert.equal(itemCost({ kind: 'output', key: 'output:Bash:grep' }, rows[0], 'before'), 9000);
  assert.equal(itemCost({ kind: 'output', key: 'output:Bash:grep' }, { outputs: { 'Bash:grep@moderate': 400, 'Bash:grep': 100, 'Bash:grepx': 5 } }, 'after'), 500, 'a compressed tool\'s key carries its level');
  // the section removed at hour 5 (one prompt a session here): 1,500 a prompt before (3,000 and 0), 0 since, over 3 prompts
  const f = actionEffect(sec, rows, now);
  assert.deepEqual([f.before.sessions, f.after.sessions, f.before.prompts, f.after.prompts, f.before.perPrompt, f.after.perPrompt, f.delta, f.share, f.window, f.few, f.to], [2, 3, 2, 3, 1500, 0, 1500, 1, 4500, true, null]);
  // per prompt: the side's sum over its prompts, so a session of many calls weighs by them (the first session 4 prompts: 3,000 over 5)
  const fp = actionEffect(sec, rows.map((r, i) => i === 0 ? { ...r, prompts: 4 } : r), now);
  assert.deepEqual([fp.before.prompts, fp.before.perPrompt, fp.window], [5, 600, 1800]);
  // the totals: a side's sum, and over the prompts since what the thing would have cost at the before rate against as it was
  assert.deepEqual([f.before.total, f.after.total, f.since], [3000, 0, { prompts: 3, atBefore: 4500, total: 0 }]);
  // the tool switched off at hour 5: 4,000 a prompt before; since, one of three sessions still loaded it (2,000 → 667)
  const tool = { kind: 'tool', key: 'claude:tool:Workflow', at: at(5), decision: 'approved' };
  const g = actionEffect(tool, rows, now);
  assert.deepEqual([g.before.perPrompt, g.after.perPrompt, g.delta, g.window], [4000, 667, 3333, 10000]);
  assert.equal(g.since.atBefore - g.since.total, g.window, 'the window is exactly the gap: 12,000 at the before rate against 2,000');
  // the output compressed at hour 5: 4,500 a prompt before (9,000 and 0), 333 since
  const out = actionEffect({ kind: 'output', key: 'output:Bash:grep', at: at(5), decision: 'approved' }, rows, now);
  assert.deepEqual([out.before.perPrompt, out.after.perPrompt, out.delta], [4500, 333, 4167]);
  // independent of each other: the section's figure does not move with the tool's
  assert.equal(actionEffect(sec, rows.map(r => ({ ...r, sources: {} })), now).delta, 1500);
  // reverted: the since side ends at the revert; dismissed, or a pull request not merged: not in effect; merged: from the merge
  assert.equal(actionEffect({ ...sec, revertedAt: at(15) }, rows, now).after.sessions, 2);
  assert.equal(effectSpan({ ...sec, decision: 'dismissed' }, now), null);
  assert.equal(effectSpan({ ...sec, pr: { state: 'open' } }, now), null);
  assert.equal(effectSpan({ ...sec, pr: { state: 'closed', at: at(6) } }, now), null);
  assert.equal(effectSpan({ ...sec, pr: { state: 'merged', at: at(6) } }, now).from, T0 + 6 * H);
  // a section's change running in the background or failed is not in effect; written when its job was done, from then
  assert.equal(effectSpan({ ...sec, decision: 'pull request', job: { state: 'running', pr: true } }, now), null);
  assert.equal(effectSpan({ ...sec, decision: 'applied', job: { state: 'failed', error: 'no model' } }, now), null);
  assert.equal(effectSpan({ ...sec, decision: 'applied', job: { state: 'done', finishedAt: at(7) } }, now).from, T0 + 7 * H);
  // no session on a side, or a thing that cannot be costed: nothing yet
  assert.equal(actionEffect({ ...sec, at: at(25) }, rows, now), null);
  assert.equal(actionEffect(sec, [], now), null);
  assert.equal(actionEffect({ ...sec, tokens: null }, rows, now), null);
  // the Report's five: in effect only (never reverted, dismissed, pending or failed), the ones that saved most first, the
  // unmeasured after them by their estimate, newest first among equals
  const hs = withEffects([
    { ...tool, id: 'tool' }, { ...sec, id: 'sec' }, { ...sec, id: 'rev', revertedAt: at(15) }, { ...sec, id: 'dis', decision: 'dismissed' }, { ...sec, id: 'pend', pr: { state: 'open' } },
    { ...sec, id: 'late', at: at(25), total: 50 }, { ...sec, id: 'later', at: at(26), total: 900 }, { ...tool, id: 'tool2', key: 'claude:tool:Other', at: at(2) },
  ], rows, now);
  assert.deepEqual(reportTop(hs, { now }).map(e => e.id), ['tool', 'sec', 'tool2', 'later', 'late']);
  assert.deepEqual(reportTop(hs, { now, max: 2 }).map(e => e.id), ['tool', 'sec']);
  // the same thing decided twice: the first is measured until the second is in effect (hours 5 to 15: two sessions since)
  const twice = withEffects([{ ...tool, id: 'first' }, { ...tool, id: 'second', at: at(15) }, { ...tool, id: 'dis', at: at(12), decision: 'dismissed' }], rows, now);
  assert.equal(twice.find(e => e.id === 'first').effect.after.sessions, 2, 'hours 10 and 11'); assert.equal(twice.find(e => e.id === 'second').effect.after.sessions, 1, 'hour 20');
  assert.equal(twice.find(e => e.id === 'first').effect.to, null, 'not a revert');
});
