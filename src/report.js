// The Report page (`thinker report`, the page's View Report tab; the Find Savings tab is `save`, the tab ids stay): what a prompt costs here
// (since 2026-10-24, the owner's ask: a prompt is one call to the model, the unit the context is read again at; a session was the unit before), week by week, as the average
// over the prompts of each week, by the type of token (fresh input, cache writes, cache reads, output), by the part of
// the context the tokens went to and by the model that read them, the three tables adding up to the same whole session,
// with a cost view at list prices (prices.js). Read from the agents' own transcripts over the last REPORT_WEEKS
// weeks (Monday to Sunday, the current week so far last): each session's model and reported usage
// (tool-outputs.js:sessionUsage, from transcripts.js:Stats), and the parts the Context view estimates for it (the
// instruction files it read: instruction-value.js; the skills, MCP servers, plugins and built-in tools loaded:
// harness.js; its tool outputs read again by every call after them: tool-outputs.js), scaled down to the session's
// measured input where their sum overshoots it; and, from the transcript itself, what the conversation costs
// (transcripts.js:parseClaude `carried`: the system prompt, the agent's tool calls, its thinking kept in the context,
// the prompts and replies), the rest of the input being Claude Code's own notes and the listings ("other").
// Under the tables: the cache's four numbers (usage.js:summarize) with
// its saving priced at the models it was made on. A session whose agent reports no usage (Cursor) is counted in no
// column. Measurement only; nothing is served or written.
import { findRepoSessions, instructionValue } from './instruction-value.js';
import { harnessUsage } from './harness.js';
import { sessionUsage, toolOutputs } from './tool-outputs.js';
import { changeHistory } from './context-suggest.js';
import { summarize, readLog } from './usage.js';
import { dietConfig, dietTimeline } from './diet.js';
import { listPrice, providerOf, costOf, costOfInputSavings, writeCost, formatDollars, PRICED_ON } from './prices.js';
import { formatTokens } from './model-usage.js';
import { REWRITE_CAUSES } from './transcripts.js';
import { deliveryReport } from './delivery.js';
import { repoId } from './store.js';
import { compressionRecords } from './compression.js';
import { proxyLogFile } from './proxy-service.js';
import { weeklySavings, mergeSavings, savingsValue } from './report-savings.js';

export const REPORT_WEEKS = 6;
// What every row of the parts table should cost a prompt at list prices, in dollars (the owner's ask, 2026-10-26: bounds for
// cost on each line item): the cost view, the default on both doors since then (the page's Cost, the command without
// --tokens), shows these in the Good and Bad columns and colours each row by its cost a priced prompt against them, the four
// parts, the rest of the input and each of its kinds, the output and the whole session alike (flat colours, the owner's ask
// of 2026-10-24). The token view has no bounds: models count the same text so differently that one figure in tokens cannot
// say good or bad across them (the owner's call, 2026-10-26; THRESHOLDS, tokens a prompt on the four parts, until then).
// The four parts are the token figures they had then (12k/30k, 4k/15k, 22k/36k, 30k/72k) at about $0.8 a million input tokens, what a cached Opus 5.5 call's input cost here (cache reads at $0.40 with the writes
// at $5–8; 35 and 45 priced sessions of this machine's last two weeks, 2026-10-26: $0.57–0.90). The other rows were set on
// the same weeks, a prompt costing: the rest of the input $0.008 (9–14k tokens), the output $0.008–0.012 (400–600 tokens at
// $20 a million), the whole session $0.082; good about where those weeks ran, bad two to three times that. The whole session's
// figures are the sums of the rows' above it. A first cut on one machine, not calibrated across repositories.
export const COST_THRESHOLDS = {
  instructions: { good: 0.01, bad: 0.025 },
  custom: { good: 0.003, bad: 0.012 },
  builtin: { good: 0.018, bad: 0.03 },
  outputs: { good: 0.025, bad: 0.06 },
  otherInput: { good: 0.01, bad: 0.03 },
  system: { good: 0.003, bad: 0.008 },
  agentCalls: { good: 0.003, bad: 0.01 },
  thinking: { good: 0.002, bad: 0.006 },
  prompts: { good: 0.002, bad: 0.006 },
  notes: { good: 0.003, bad: 0.008 },
  other: { good: 0.002, bad: 0.008 },
  output: { good: 0.01, bad: 0.025 },
  total: { good: 0.076, bad: 0.182 },
};
// Calibration of the estimated parts (2026-10-25). Every reader counts text at four characters a token (instruction-value.js,
// harness.js, tool-outputs.js, transcripts.js `carried`), and the Save page shows that unit. The model counts more: on the 79
// sessions whose first request was fully recorded (research/context-breakdown-2026-10-22.md) an Anthropic model reported
// 1.44 tokens for every four characters (1.41–1.46), and at chars/4 the parts covered 74% of a long session's input, the
// residual being the unit and not a missing part. So the Report, which puts the parts beside the input the model reported,
// scales each session's estimated parts by its provider's factor before the overshoot check; what is left is
// `other`, unattributed. Measured for Anthropic alone; OpenAI's and Google's tokenizers are not measured here and count one
// for one until they are (a `calibration` block in .thinker/config.json overrides a provider's factor). The thinking kept is
// not scaled: the usage reports it exactly (thinking_tokens, reasoning_output_tokens).
export const CALIBRATION = { Anthropic: 1.44 };
export const calibrationFor = (provider, config) => { const own = config?.calibration && typeof config.calibration === 'object' ? config.calibration[provider] : null; return Number.isFinite(own) && own > 0 ? own : CALIBRATION[provider] || 1; };
export const calibrationOf = (model, client, config) => calibrationFor(providerOf(model, client), config);
// the factors in force, for the page and the command's caption: the measured ones and any the config sets
export const calibrations = config => Object.fromEntries([...new Set([...Object.keys(CALIBRATION), ...Object.keys(config?.calibration && typeof config.calibration === 'object' ? config.calibration : {})])].map(p => [p, calibrationFor(p, config)]));
// 'good' | 'mid' | 'bad' for a row's dollars a priced prompt; null for a row without a bound or a cell without a figure
export const verdict = (key, perPrompt) => { const t = COST_THRESHOLDS[key]; return !t || !perPrompt ? null : perPrompt <= t.good ? 'good' : perPrompt >= t.bad ? 'bad' : 'mid'; };
// a cost bound as the columns show it, to the tenth of a cent it is set to: $0.025, $0.01
export const formatCostThreshold = d => `$${Number(d.toFixed(3))}`;
// the parts of a session's input: the four the Save page measures (instruction-value.js, harness.js, tool-outputs.js),
// then what the conversation itself costs, read from the transcript (transcripts.js:parseClaude `carried`): the system
// prompt, the agent's own tool calls (the edits and commands it wrote, read again by every call after), its thinking
// kept in the context, the prompts with their reminders and the agent's text, Claude Code's own notes between turns
// (environment updates, reminders, tool schemas loaded on demand, listings); `other` is what is left of the measured
// input (estimation slack, mostly the four characters a token the text parts are counted at); `output` is what the
// model wrote. The instruction files are the larger of the transcript's payload (the root file with the person's global
// file and memory, where the transcript carries it from the first call) and the Save page's estimate of the root file.
// The whole breakdown is computed and kept in the view (`breakdown`, `thinker report --json`); the tables show the four
// parts the Save page measures and controls (PARTS), under them the rest of the input as one row and the output (OTHERS,
// since 2026-10-24, so the table adds up to the whole session), and the whole session's tokens (`sessionTotals`) under
// every table. The other kinds are written up in research/context-breakdown-2026-10-22.md, for the
// work on cutting them (the owner's decision, 2026-10-22).
export const BREAKDOWN = [
  ['instructions', 'Instruction files'], ['system', 'System prompt'], ['custom', 'Custom tools'], ['builtin', 'Built-in tools'], ['outputs', 'Tool outputs'],
  ['agentCalls', "Agent's tool calls"], ['thinking', 'Thinking kept'], ['prompts', 'Prompts and replies'], ['notes', 'Harness notes'],
  ['other', 'Unattributed input'], ['output', 'Model output'],
];
export const PARTS = BREAKDOWN.filter(([k]) => ['instructions', 'custom', 'builtin', 'outputs'].includes(k));
// the rest of the session under the four parts, so the parts table adds up to the whole session (2026-10-24, the owner's
// ask): the other input as one row (the conversation: REST_INPUT, the breakdown's other input kinds), and the output
export const REST_INPUT = BREAKDOWN.map(([k]) => k).filter(k => !PARTS.some(([p]) => p === k) && k !== 'output');
// Since 2026-10-25 the rest of the input is shown by kind (the owner's ask: "Other input" was more than the four parts
// together and said nothing), each a BREAKDOWN row: the system prompt, the agent's tool calls, its thinking kept, the
// prompts and replies, the harness's notes, and what no reader attributed (`other`, the estimation slack left after the
// calibration), then the output. The names are the breakdown's, so OTHERS is built from it.
export const OTHERS = [...REST_INPUT, 'output'].map(k => BREAKDOWN.find(([key]) => key === k));
// The prompt-cache rewrites, by cause (transcripts.js:cacheRewrites, REWRITE_CAUSES): the calls whose context the cache
// mostly did not serve, and the tokens they wrote again (Anthropic: cache writes at twice the input rate; OpenAI and Google:
// the fresh input). A fourth table under the three (2026-10-25), with a total; its tokens are a part of the token types'
// fresh and written input, not a fourth total, and the caption says so.
export const REWRITES = REWRITE_CAUSES;
// the tokens by type, as the model reported them for each call and the transcript sums them (transcripts.js:Stats,
// model-usage.js): fresh input, at the input rate; input written to the prompt cache and input read from it, each at its
// rate; and output. The four add up to the whole session, as the parts and the models do: three tables, one total.
export const TOKEN_TYPES = [['fresh', 'Input, fresh'], ['cacheWrite', 'Input, written to cache'], ['cacheRead', 'Input, read from cache'], ['output', 'Model output']];
const DAY = 86400_000;
// the Monday that starts the week of t, local time
export function weekStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
const nextWeek = t => { const d = new Date(t); d.setDate(d.getDate() + 7); return d.getTime(); };
export function weekColumns(now, weeks) {
  const cols = []; let t = weekStart(now);
  for (let i = 0; i < weeks; i++) { cols.unshift(t); t = weekStart(t - DAY); }
  return cols.map(start => ({ t: start, end: nextWeek(start) }));
}

// a cell: the week's tokens and cost, with the sessions and the prompts (model calls) behind them, so the average per
// prompt is the ratio of the sums (a long session weighs by its prompts, not as one)
const cell = () => ({ tokens: 0, cost: 0, sessions: 0, priced: 0, prompts: 0, pricedPrompts: 0, n: 0 });
const add = (c, tokens, cost, n = 0, p = 0, prompts = 0, pricedPrompts = 0) => { c.tokens += tokens; c.cost += cost || 0; c.sessions += n; c.priced += p; c.prompts += prompts; c.pricedPrompts += pricedPrompts; };

export function reportView(store, { weeks = REPORT_WEEKS, now = Date.now(), sessions } = {}) {
  const cols = weekColumns(now, weeks), from = cols[0].t, days = Math.ceil((now - from) / DAY) + 1;
  sessions ??= findRepoSessions(store.repo, days);
  sessions = sessions.filter(s => s.mtime >= from);
  const config = (() => { try { return store.config(); } catch { return {}; } })();
  // the settings timeline of the tool outputs (diet.js:dietTimeline): the usage reader and the outputs reader share one
  // record a session (tool-outputs.js:sessionRecords), so both bring it
  const timeline = (() => { try { return dietTimeline(dietConfig(store), readLog(store)); } catch { return { levelAt: null, key: '' }; } })();
  // the parts each session's context went to, by session id (the readers keep their own caches)
  const parts = new Map(), part = id => { if (!parts.has(id)) parts.set(id, {}); return parts.get(id); };
  // and, for the actions' attribution (actionEffect), the things each session cost: the instruction files it read with its
  // model calls, each source it loaded (tokens a call times the calls, by the history's key), each tool's outputs
  const items = new Map(), item = id => { if (!items.has(id)) items.set(id, { calls: 0, files: [], sources: {}, outputs: {} }); return items.get(id); };
  for (const r of instructionValue(store, { days, sessions }).timeline) if (r.session) { part(r.session).instructions = r.tokens * r.calls; Object.assign(item(r.session), { calls: r.calls, files: r.files || [] }); }
  for (const r of harnessUsage(store.repo, { days, sessions }).timeline || []) if (r.session) { const c = Math.max(1, r.calls), p = r.parts; Object.assign(part(r.session), { custom: ((p.skills || 0) + (p.mcp || 0) + (p.plugins || 0)) * c, builtin: (p.builtin || 0) * c }); for (const [k, t] of Object.entries(r.loaded || {})) item(r.session).sources[`${r.client}:${k}`] = t * c; }
  const rows = sessionUsage(store, sessions, timeline);
  for (const r of rows) { part(r.session).outputs = r.outputs; item(r.session).outputs = r.by || {}; }
  const week = t => cols.findIndex(c => t >= c.t && t < c.end);
  const columns = cols.map(c => ({ t: c.t, sessions: 0, priced: 0, unmeasured: 0, prompts: 0, pricedPrompts: 0 }));
  const byPart = Object.fromEntries(BREAKDOWN.map(([k]) => [k, cols.map(cell)]));
  const byType = Object.fromEntries(TOKEN_TYPES.map(([k]) => [k, cols.map(cell)]));
  const byCause = Object.fromEntries(REWRITES.map(([k]) => [k, cols.map(cell)]));
  // the sessions whose agent reports no usage (Cursor): their estimated parts, in a table of their own (`estimated`), since
  // without a measured input they cannot sit in the three tables that add up to one whole (2026-10-25)
  const estCols = cols.map(() => ({ sessions: 0, prompts: 0 })), byEst = Object.fromEntries(PARTS.map(([k]) => [k, cols.map(cell)]));
  const models = new Map(), unpriced = new Set();
  // one row a measured session (sessionRows): its input, the four parts as estimated, and the things it cost (above), so
  // each action can be measured as tokens a prompt before and since it (actionEffect), live over a kept report
  const sessionRows = [];
  for (const r of rows) {
    const w = week(r.t); if (w < 0) continue;
    const col = columns[w], cal = calibrationOf(r.model, r.client, config);
    if (!r.usage) {
      col.unmeasured++;
      const p = parts.get(r.session) || {}, sum = PARTS.reduce((a, [k]) => a + (p[k] || 0), 0);
      if (sum > 0) { estCols[w].sessions++; estCols[w].prompts += Math.max(1, r.turns || 0); for (const [k] of PARTS) add(byEst[k][w], (p[k] || 0) * cal, 0); }
      continue;
    }
    const u = r.usage, price = listPrice(r.model, { config }), cost = costOf(u, price);
    const input = u.input, output = u.output || 0, prompts = Math.max(1, u.turns || 0);
    col.sessions++; col.prompts += prompts; if (cost != null) { col.priced++; col.pricedPrompts += prompts; } else unpriced.add(r.model || 'unknown');
    // the parts as estimated, scaled to the measured input where they overshoot it; what is left is the conversation
    // the estimated parts in the model's tokens (calibrationOf); the thinking kept is reported exactly and not scaled
    const p = parts.get(r.session) || {}, c = u.carried || {}, est = { instructions: Math.max(c.instructions || 0, p.instructions || 0) * cal, system: (c.system || 0) * cal, custom: (p.custom || 0) * cal, builtin: (p.builtin || 0) * cal, outputs: (p.outputs || 0) * cal, agentCalls: (c.agentCalls || 0) * cal, thinking: c.thinking || 0, prompts: ((c.prompts || 0) + (c.agentText || 0)) * cal, notes: (c.notes || 0) * cal };
    const sum = Object.values(est).reduce((a, b) => a + b, 0), scale = sum > input && sum > 0 ? input / sum : 1;
    const inCost = cost == null ? null : (cost - (price ? output * price.output / 1e6 : 0)) / Math.max(1, input);
    for (const k of Object.keys(est)) { const tk = est[k] * scale; add(byPart[k][w], tk, inCost == null ? 0 : tk * inCost); }
    sessionRows.push({ t: r.t, input, prompts, parts: Object.fromEntries(PARTS.map(([k]) => [k, Math.round(est[k] * scale)])), ...(items.get(r.session) || { calls: 0, files: [], sources: {}, outputs: {} }) });
    const other = Math.max(0, input - sum * scale);
    add(byPart.other[w], other, inCost == null ? 0 : other * inCost);
    add(byPart.output[w], output, price ? output * price.output / 1e6 : 0);
    // by type: the input is the reads and writes included (model-usage.js), the fresh part what is left; a record whose
    // reads and writes exceed its input (none should) is clamped so the four still add up to the session
    const write = Math.min(u.cacheWrite || 0, input), read = Math.min(u.cacheRead || 0, input - write), fresh = input - read - write;
    add(byType.fresh[w], fresh, price ? fresh * price.input / 1e6 : 0);
    add(byType.cacheWrite[w], write, price ? writeCost(write, u.cacheWrite1h, price) / 1e6 : 0); // the one-hour writes at twice the input (prices.js)
    add(byType.cacheRead[w], read, price ? read * price.cacheRead / 1e6 : 0);
    add(byType.output[w], output, price ? output * price.output / 1e6 : 0);
    // the prompt-cache rewrites by cause: the tokens written again, each at its rate
    for (const [k, x] of Object.entries(u.rewrites?.causes || {})) if (byCause[k]) { const c2 = byCause[k][w]; add(c2, (x.fresh || 0) + (x.write || 0), price ? ((x.fresh || 0) * price.input + writeCost(x.write || 0, x.write1h, price)) / 1e6 : 0); c2.n += x.n || 0; }
    const key = r.model || 'unknown';
    if (!models.has(key)) models.set(key, { model: key, provider: providerOf(r.model, r.client), priced: Boolean(price), cells: cols.map(cell) });
    add(models.get(key).cells[w], input + output, cost, 1, cost == null ? 0 : 1, prompts, cost == null ? 0 : prompts);
  }
  // a total row carries the week's prompts, so a merged report (mergeReports) averages over every repository's
  const totalOf = keys => cols.map((_, w) => { const c = cell(); for (const k of keys) add(c, byPart[k][w].tokens, byPart[k][w].cost); c.prompts = columns[w].prompts; c.pricedPrompts = columns[w].pricedPrompts; return c; });
  const totals = totalOf(PARTS.map(([k]) => k)), sessionTotals = totalOf(BREAKDOWN.map(([k]) => k));
  const others = OTHERS.map(([key, name]) => ({ key, name, cells: byPart[key] }));
  // the rest of the input as one row (`otherInput`), the kinds under it folded by default on the page and indented in the
  // print (the owner's ask, 2026-10-25: not all of it needs attention at once; a kind may move out later)
  const otherInput = totalOf(REST_INPUT);
  const rewriteTotals = cols.map((_, w) => { const c = cell(); for (const k of Object.keys(byCause)) { add(c, byCause[k][w].tokens, byCause[k][w].cost); c.n += byCause[k][w].n; } c.prompts = columns[w].prompts; c.pricedPrompts = columns[w].pricedPrompts; return c; });
  const estimated = { columns: estCols, parts: PARTS.map(([key, name]) => ({ key, name, cells: byEst[key] })), totals: cols.map((_, w) => { const c = cell(); for (const [k] of PARTS) add(c, byEst[k][w].tokens, 0); c.prompts = estCols[w].prompts; return c; }) };
  const tokenTypes = TOKEN_TYPES.map(([key, name]) => ({ key, name, cells: byType[key] }));
  // the models by provider, the biggest provider first and the biggest model within it
  const windowOf = m => m.cells.reduce((a, c) => a + c.tokens, 0);
  const modelRows = [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || windowOf(b) - windowOf(a));
  const providers = [...new Set(modelRows.map(m => m.provider))].map(name => ({ name, cells: cols.map((_, w) => { const c = cell(); for (const m of modelRows.filter(x => x.provider === name)) add(c, m.cells[w].tokens, m.cells[w].cost, m.cells[w].sessions, m.cells[w].priced, m.cells[w].prompts, m.cells[w].pricedPrompts); return c; }) }))
    .sort((a, b) => b.cells.reduce((x, c) => x + c.tokens, 0) - a.cells.reduce((x, c) => x + c.tokens, 0));
  modelRows.sort((a, b) => providers.findIndex(p => p.name === a.provider) - providers.findIndex(p => p.name === b.provider) || windowOf(b) - windowOf(a));
  // the output rows under each compression setting (tool-outputs.js:aggregateOutputs), kept in the view for
  // `thinker report --json` and outputComparison
  const outRows = (() => { try { return toolOutputs(store, sessions, timeline).tools; } catch { return []; } })();
  const actions = reportActions(store, from, sessionRows, now);
  const cacheReadings = [];
  const usage = summarize(store, { days, now, onSaving: r => cacheReadings.push(r) });
  const proxyRows = process.env.THINKER_TEST === '1' && !process.env.THINKER_HOME && !process.env.THINKER_PROXY_LOG ? [] : compressionRecords(proxyLogFile());
  const savings = weeklySavings({ columns, now, config, cache: cacheReadings, events: readLog(store), compression: proxyRows, sessions, origin: repoId(store.repo), ownership: readLog(store, { all: true }) });
  return {
    weeks, days, from, to: now, pricedOn: PRICED_ON, columns, sessionRows, costThresholds: COST_THRESHOLDS,
    tokenTypes,
    parts: PARTS.map(([key, name]) => ({ key, name, cells: byPart[key] })), others, otherInput, totals, sessionTotals,
    breakdown: BREAKDOWN.map(([key, name]) => ({ key, name, cells: byPart[key] })),
    rewrites: REWRITES.map(([key, name]) => ({ key, name, cells: byCause[key] })), rewriteTotals, estimated,
    calibration: calibrations(config),
    providers, models: modelRows, unpriced: [...unpriced],
    actions, outputRows: outRows, savings, cache: cacheMetrics(store, { days, config, usage }),
    prs: prSavings(store, { days, now }),
  };
}

// How much of what was shipped here thinker paid for: the merged pull requests the sessions of this window
// worked on, and what was saved on each (delivery.js:deliveryReport, the same figures as `thinker prs`).
//
// **In tokens, under Cost as much as under Tokens, and that is deliberate.** The two savings are context, not
// dollars, and only one of them converts. *Reading avoided* is fresh input nobody paid for, so it would price
// at the input rate. *Cleared* would not: what the proxy takes out of a prompt was mostly being read from the
// prompt cache at a fortieth of the input price, and the clear writes that cache again at twice it. Priced at
// the input rate this window's 202M cleared tokens would read as thousands of dollars, where `thinker proxy
// replay` over 264 real sessions put the whole clearing at +7.3% of session cost. A dollar figure here would
// contradict this project's own measurement, so there is none: the saving is tokens that never sat in a
// prompt, and `thinker proxy replay` is what prices a clear.
export function prSavings(store, { days, now = Date.now(), delivery } = {}) {
  let r;
  try { r = delivery || deliveryReport(store, { days, now }); } catch { return null; }
  const s = r.summary, merged = r.prs.filter(p => p.mergedAt && p.sessions.length);
  merged.sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
  return {
    days, merged: s.merged, mergedSeen: s.mergedSeen, mergedAssisted: s.mergedAssisted, worked: s.worked, open: s.open,
    saved: { cleared: s.saved.cleared, reading: s.saved.reading, total: s.saved.total },
    agent: s.tokens.agent, complete: s.tokens.complete,
    medianSaved: s.medianSavedPerMergedPr, medianAgent: s.medianTokensPerMergedPr, medianHours: s.medianHoursToMerge,
    // The share of what those pull requests cost that never had to sit in a prompt. Both sides are the same
    // shape -- every prompt and every answer of their sessions, added up -- so the ratio means something.
    share: s.tokens.agent ? s.saved.total / s.tokens.agent : null,
    sessions: s.sessions,
    rows: merged.map(p => ({
      number: p.number, title: p.title || null, url: p.url || null, mergedAt: p.mergedAt,
      sessions: p.sessions.length, prompts: p.tokens.prompts, complete: p.tokens.complete,
      agent: p.tokens.agent, cleared: p.saved.cleared, reading: p.saved.reading.tokens, saved: p.saved.total,
      share: p.tokens.agent ? p.saved.total / p.tokens.agent : null,
    })),
  };
}

// What compressing a tool's output measured: the tool's row under the compression against its row from before
// (tool-outputs.js:aggregateOutputs, one row a setting, each over the sessions that ran under it), the compressed row
// the latest one with a level. `perCall` is what compression acts on, the size of a result; `perPrompt` is what the
// person pays on an average prompt, the results times the calls that read them again, and moves with how the sessions
// since used the tool as well. A delta is before minus since, positive a saving; `window` is the prompt delta over the
// prompts since. null until both periods have a session in the window.
export function outputComparison(rows, name) {
  const mine = rows.filter(r => r.name === name), before = mine.find(r => !r.level), after = mine.filter(r => r.level).sort((a, b) => (b.from || 0) - (a.from || 0))[0];
  if (!before || !after || !before.sessions || !after.sessions) return null;
  const pick = r => ({ level: r.level || null, sessions: r.sessions, prompts: r.prompts ?? null, from: r.from ?? null, to: r.to ?? null, calls: r.calls, perCall: r.perCall, perPrompt: r.perPrompt, wasted: r.wasted ?? null });
  const d = k => ({ before: before[k], after: after[k], delta: before[k] - after[k], share: before[k] ? (before[k] - after[k]) / before[k] : null });
  return { name, before: pick(before), after: pick(after), perCall: d('perCall'), perPrompt: d('perPrompt'), window: (before.perPrompt - after.perPrompt) * (after.prompts || 0), few: after.sessions < 5 };
}

// From when an action is in effect, and until when: a dismissal and a pull request not merged never were, nor a section's
// change still running in the background or failed (context-suggest.js:startSectionJob); a merged one from its merge; a
// change written when its job was done from then; anything else from the decision, until it was reverted.
export const effectSpan = (e, now) => e.decision === 'dismissed' || (e.job && e.job.state !== 'done') ? null
  : e.pr ? (e.pr.state === 'merged' && e.pr.at ? { from: Date.parse(e.pr.at), to: now } : null)
  : { from: Date.parse(e.job?.finishedAt || e.at), to: e.revertedAt ? Date.parse(e.revertedAt) : now };
// What the one thing an action changed costs in a session (sessionRows, reportView), on one side of it: a section its
// tokens on that side times the session's model calls where the session read its file (the entry's `tokens`, recorded
// from the edit: 0 after a removal); a skill, MCP server, plugin or built-in tool its tokens a call times the calls where
// the session loaded it (harness.js `loaded`); a tool's outputs what that tool's results cost the session (tool-outputs.js
// `by`). null where the row cannot say (a section decided before the tokens were recorded).
export function itemCost(e, r, side) {
  if (e.kind === 'section') { const t = e.tokens?.[side]; if (t == null) return null; const file = e.file || e.key.replace(/^section:/, '').split(':')[0]; return (r.files || []).includes(file) ? t * (r.calls || 0) : 0; }
  if (e.kind === 'output') { const name = e.key.replace(/^output:/, ''); return Object.entries(r.outputs || {}).reduce((a, [k, t]) => a + (k === name || k.startsWith(`${name}@`) ? t : 0), 0); } // a compressed tool's key carries its level (tool-outputs.js:splitKey)
  return (r.sources || {})[e.key] || 0;
}
// What an action saved, attributed to it alone: the cost of the thing it changed (itemCost) per prompt over the window's
// sessions before the decision (`before`) and over those since it was in effect (`after`, until its revert), each side the
// sum over its sessions divided by their prompts, with its sessions, prompts and dates; `delta` before minus since a prompt,
// positive a saving, `share` of what a whole prompt cost before; `window` the delta over the prompts since (`since`: the thing over those prompts at
// the before rate against as it was); `few` under five sessions a side. null
// while a side has no session, the action is not in effect, or the thing cannot be costed. Independent of every other
// action: a tool switched off is measured on that tool's tokens, not on what the prompts cost in all.
export function actionEffect(e, sessionRows = [], now = Date.now(), { until = null } = {}) {
  const span = effectSpan(e, now); if (!span) return null;
  if (until != null && until < span.to) span.to = until; // a later decision on the same thing takes over from there
  const before = sessionRows.filter(r => r.t < span.from), after = sessionRows.filter(r => r.t >= span.from && r.t < span.to);
  if (!before.length || !after.length) return null;
  const side = (xs, k) => { const cs = xs.map(r => itemCost(e, r, k)); if (cs.some(c => c == null)) return null; const prompts = xs.reduce((a, r) => a + Math.max(1, r.prompts || 0), 0); const total = cs.reduce((a, c) => a + c, 0); return { sessions: xs.length, prompts, from: Math.min(...xs.map(r => r.t)), to: Math.max(...xs.map(r => r.t)), total, perPrompt: Math.round(total / prompts) }; };
  const b = side(before, 'before'), a = side(after, 'after');
  if (!b || !a) return null;
  const delta = b.perPrompt - a.perPrompt;
  // `share`: the saving against what a whole prompt cost before the decision (`whole.before`, the sessions' input over
  // their prompts), not against the thing's own size, so a small cut of a large part counts for what it is (the owner's
  // ask, 2026-10-24); the same share in the Total view, the window being the delta over the prompts since
  const whole = { before: Math.round(before.reduce((x, r) => x + r.input, 0) / b.prompts), after: Math.round(after.reduce((x, r) => x + r.input, 0) / a.prompts) };
  // `since`: the thing over the prompts since the decision, at the before rate (`atBefore`, what it would have cost) and as
  // it was (`total`, after.total); `window` is exactly their gap (the Total view's Saved is its Before minus its After)
  return { from: span.from, to: e.revertedAt ? span.to : null, before: b, after: a, delta, share: whole.before ? delta / whole.before : null, whole, since: { prompts: a.prompts, atBefore: Math.round(b.total / b.prompts * a.prompts), total: a.total }, window: Math.round(b.total / b.prompts * a.prompts) - a.total, few: b.sessions < 5 || a.sessions < 5 };
}
// What a prompt costs on average over the view's measured sessions (`sessionRows`): their input over their prompts. Shown
// over the Saved column of Recent activity, the size the savings are read against.
export function promptAverage(sessionRows = []) {
  const prompts = sessionRows.reduce((a, r) => a + Math.max(1, r.prompts || 0), 0), tokens = sessionRows.reduce((a, r) => a + r.input, 0);
  return prompts ? { sessions: sessionRows.length, prompts, tokens, perPrompt: Math.round(tokens / prompts) } : null;
}
// Several repositories' averages as one (All repositories): the tokens and prompts add.
export function mergePromptAverages(list) {
  list = list.filter(Boolean); if (!list.length) return null;
  const sum = k => list.reduce((a, x) => a + x[k], 0), prompts = sum('prompts');
  return { sessions: sum('sessions'), prompts, tokens: sum('tokens'), perPrompt: prompts ? Math.round(sum('tokens') / prompts) : 0 };
}
// The history with what each decision saved (actionEffect over the view's session rows), as both doors list it. A decision
// on a thing decided again later (sed compressed on Tuesday, then again on Thursday) is measured until the later one is in
// effect, so the two rows share no session.
export function withEffects(history, sessionRows = [], now = Date.now()) {
  const later = e => history.filter(o => o !== e && o.key === e.key && Date.parse(o.at) > Date.parse(e.at)).map(o => effectSpan(o, now)?.from).filter(t => t != null);
  return history.map(e => { const ts = later(e); return { ...e, effect: actionEffect(e, sessionRows, now, { until: ts.length ? Math.min(...ts) : null }) }; });
}
// The decisions taken on the Find Savings page since `from`, newest first, each with what it saved (`effect`): the view's
// `actions`, for `thinker report --json`.
export function reportActions(store, from, sessionRows = [], now = Date.now()) {
  return withEffects(changeHistory(store).filter(e => Date.parse(e.at) >= from), sessionRows, now).map(e => ({ ...e, repo: null }));
}
// The four numbers the Cache page showed (usage.js:summarize), over the report's window: what the notes saved in
// dollars (lifetime net input at each request's observed input mix, or the holdout's per-model
// input-price estimate where measured), the same in tokens, the cache hits, and the share of
// judged servings the sessions acted on.
export function cacheMetrics(store, { days, config, all = false, usage } = {}) {
  const u = usage || summarize(store, { days, all });
  const as = u.assessed || {}, judged = (as.confirmed || 0) + (as.contradicted || 0) + (as.unused || 0);
  const ho = u.holdout, measured = Boolean(ho?.enough && ho.saved?.inputTokens != null);
  const lifetime = measured ? null : u.saved?.input;
  const priceIn = m => listPrice(m, { config })?.input;
  let dollars = 0, unpricedTokens = 0;
  if (measured) {
    for (const [m, g] of Object.entries(ho.byModel || {})) {
      const a = g.served?.perPrompt?.inputTokens, b = g.heldOut?.perPrompt?.inputTokens, n = g.served?.measured?.inputTokens;
      if (a == null || b == null || !n) continue;
      const t = (b - a) * n, p = priceIn(m); if (p == null) unpricedTokens += t; else dollars += t * p / 1e6;
    }
  } else if (lifetime?.byModel) {
    for (const [m, counts] of Object.entries(lifetime.byModel)) {
      const cost = costOfInputSavings(counts, listPrice(m, { config }));
      if (cost == null) unpricedTokens += counts.tokens; else dollars += cost;
    }
  } else for (const [m, x] of Object.entries(u.saved?.byModel || {})) { const p = priceIn(m); if (p == null) unpricedTokens += x.tokens; else dollars += x.tokens * p / 1e6; }
  return {
    dollarsLabel: 'Estimated $ saved',
    dollarsSaved: dollars, unpricedTokens: Math.round(unpricedTokens), measured,
    tokensSaved: measured ? ho.saved.inputTokens : lifetime?.tokens ?? u.saved?.tokens ?? 0,
    tokenLabel: measured ? 'Tokens saved' : 'Estimated input tokens saved',
    tokenDescription: measured ? 'versus prompts with the notes withheld' : lifetime?.covered
      ? 'Avoided reading and subsequent re-reads, minus cached-note context.'
      : lifetime ? 'One-read estimate minus note context; lifetime data unavailable.' : 'tokens of code the agents did not read',
    coverage: lifetime ? { hits: lifetime.covered, fallback: lifetime.fallback, sessions: lifetime.sessions, requests: lifetime.requests } : null,
    dollarsDescription: !measured && lifetime?.byModel ? 'Total from cache hits, including repeated reads and subtracting note context, at estimated model input costs.' : null,
    hits: Object.values(u.servings || {}).reduce((a, b) => a + b, 0), requests: u.requests || 0, answered: u.answered || 0,
    // the hit rate is quoted over the requests the cache was asked, not every prompt (usage.js:NOT_ATTEMPTED)
    attempted: u.attempted || 0,
    acted: judged ? (as.confirmed || 0) / judged : null, judged,
  };
}

// Every repository's report as one (the page's All repositories): the sums and the session counts add, so the
// averages are over every session of the machine; the actions keep their repository's name.
export function mergeReports(list) {
  list = list.filter(x => x.view);
  if (!list.length) return null;
  const first = list[0].view, n = first.columns.length;
  const sumCells = xs => Array.from({ length: n }, (_, w) => { const c = cell(); for (const cs of xs) if (cs[w]) { add(c, cs[w].tokens, cs[w].cost, cs[w].sessions, cs[w].priced, cs[w].prompts || 0, cs[w].pricedPrompts || 0); c.n += cs[w].n || 0; } return c; });
  const views = list.map(x => x.view);
  const models = new Map();
  for (const v of views) for (const m of v.models) { if (!models.has(m.model)) models.set(m.model, { ...m, cells: [] , _cells: [] }); models.get(m.model)._cells.push(m.cells); }
  const modelRows = [...models.values()].map(m => ({ model: m.model, provider: m.provider, priced: m.priced, cells: sumCells(m._cells) }));
  const windowOf = m => m.cells.reduce((a, c) => a + c.tokens, 0);
  const providers = [...new Set(modelRows.map(m => m.provider))].map(name => ({ name, cells: sumCells(modelRows.filter(m => m.provider === name).map(m => m.cells)) })).sort((a, b) => b.cells.reduce((x, c) => x + c.tokens, 0) - a.cells.reduce((x, c) => x + c.tokens, 0));
  modelRows.sort((a, b) => providers.findIndex(p => p.name === a.provider) - providers.findIndex(p => p.name === b.provider) || windowOf(b) - windowOf(a));
  const cache = views.map(v => v.cache), sum = k => cache.reduce((a, c) => a + (c[k] || 0), 0), judged = sum('judged');
  const confirmed = cache.reduce((a, c) => a + (c.acted == null ? 0 : c.acted * c.judged), 0);
  return {
    all: true, weeks: first.weeks, days: first.days, from: first.from, to: first.to, pricedOn: first.pricedOn, costThresholds: COST_THRESHOLDS,
    columns: Array.from({ length: n }, (_, w) => ({ t: first.columns[w].t, prompts: views.reduce((a, v) => a + (v.columns[w].prompts || 0), 0), pricedPrompts: views.reduce((a, v) => a + (v.columns[w].pricedPrompts || 0), 0), sessions: views.reduce((a, v) => a + v.columns[w].sessions, 0), priced: views.reduce((a, v) => a + v.columns[w].priced, 0), unmeasured: views.reduce((a, v) => a + v.columns[w].unmeasured, 0) })),
    tokenTypes: TOKEN_TYPES.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.tokenTypes || []).find(p => p.key === key)?.cells || [])) })),
    parts: PARTS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => v.parts.find(p => p.key === key)?.cells || [])) })),
    others: OTHERS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.others || []).find(p => p.key === key)?.cells || [])) })),
    otherInput: sumCells(views.map(v => v.otherInput || [])),
    rewrites: REWRITES.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.rewrites || []).find(p => p.key === key)?.cells || [])) })),
    rewriteTotals: sumCells(views.map(v => v.rewriteTotals || [])),
    estimated: { columns: Array.from({ length: n }, (_, w) => ({ sessions: views.reduce((a, v) => a + (v.estimated?.columns?.[w]?.sessions || 0), 0), prompts: views.reduce((a, v) => a + (v.estimated?.columns?.[w]?.prompts || 0), 0) })), parts: PARTS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.estimated?.parts || []).find(p => p.key === key)?.cells || [])) })), totals: sumCells(views.map(v => v.estimated?.totals || [])) },
    calibration: views.find(v => v.calibration)?.calibration || CALIBRATION,
    breakdown: BREAKDOWN.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.breakdown || []).find(p => p.key === key)?.cells || [])) })),
    totals: sumCells(views.map(v => v.totals)), sessionTotals: sumCells(views.map(v => v.sessionTotals)),
    providers, models: modelRows, unpriced: [...new Set(views.flatMap(v => v.unpriced))],
    actions: list.flatMap(x => x.view.actions.map(a => ({ ...a, repo: x.repo, repoName: x.name }))).sort((a, b) => b.at.localeCompare(a.at)),
    cache: { dollarsLabel: 'Estimated $ saved', dollarsSaved: sum('dollarsSaved'), unpricedTokens: sum('unpricedTokens'), measured: cache.every(c => c.measured), tokensSaved: sum('tokensSaved'), hits: sum('hits'), requests: sum('requests'), answered: sum('answered'), attempted: sum('attempted'), acted: judged ? confirmed / judged : null, judged,
      tokenLabel: cache.every(c => c.measured) ? 'Tokens saved' : 'Estimated input tokens saved',
      tokenDescription: cache.every(c => c.measured) ? 'versus prompts with the notes withheld' : 'Avoided reading and observed re-reads, minus note context; holdout comparisons where available.',
      coverage: cache.some(c => c.coverage) ? Object.fromEntries(['hits', 'fallback', 'sessions', 'requests'].map(k => [k, cache.reduce((n, c) => n + (c.coverage?.[k] || 0), 0)])) : null,
      dollarsDescription: cache.some(c => !c.measured) ? 'Total from cache hits, including repeated reads and subtracting note context; holdout comparisons where available.' : null },
    savings: mergeSavings(views, n),
    prs: mergePrSavings(list),
    repos: list.map(x => ({ repo: x.repo, name: x.name })),
  };
}

// All repositories: the counts and the tokens add, since a pull request belongs to one repository and a
// session to one pull request, so nothing is counted twice. The medians do not add and are not averaged into
// a median of medians: they are recomputed over every merged pull request of every repository. Each row
// carries the repository it came from, because two repositories number their pull requests from 1.
function mergePrSavings(list) {
  const parts = list.map(x => ({ p: x.view.prs, repo: x.repo, name: x.name })).filter(x => x.p);
  if (!parts.length) return null;
  const sum = f => parts.reduce((a, x) => a + (f(x.p) || 0), 0);
  const rows = parts.flatMap(x => x.p.rows.map(r => ({ ...r, repo: x.repo, repoName: x.name })));
  rows.sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
  const saved = { cleared: sum(p => p.saved.cleared), reading: sum(p => p.saved.reading), total: sum(p => p.saved.total) };
  const agent = sum(p => p.agent);
  return {
    days: parts[0].p.days, merged: sum(p => p.merged), mergedSeen: sum(p => p.mergedSeen), mergedAssisted: sum(p => p.mergedAssisted),
    worked: sum(p => p.worked), open: sum(p => p.open), saved, agent, complete: sum(p => p.complete),
    medianSaved: median(rows.map(r => r.saved)), medianAgent: median(rows.filter(r => r.complete).map(r => r.agent)),
    medianHours: median(parts.map(x => x.p.medianHours).filter(h => h != null)),
    share: agent ? saved.total / agent : null,
    sessions: { linked: sum(p => p.sessions.linked), unlinked: sum(p => p.sessions.unlinked) },
    rows,
  };
}

const median = xs => { const v = xs.filter(x => Number.isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };

// The report as the command prints it: the three tables with their totals, the cache's numbers. The decisions are not here
// (2026-10-24, the owner's call: in the Total view they compared spans of different lengths): Recent activity and `thinker
// context --history` carry them with what each saved (actionEffect, over the view's `sessionRows`).
// `total`: the week's sum over its sessions instead of the average per prompt (the page's Total toggle)
// `share` (the page's Share, 2026-10-24, the owner's ask): every row but the whole-session total as its share of that total in
// the week, a percentage, so the relative contributions and their trend can be read; the total rows keep their values.
// a share of the whole session as a percentage: whole above 10%, one decimal under it, two under 1%, and under 0.01% said so
export function formatShare(x) { const p = 100 * x; return p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1)}%` : p >= 0.01 ? `${p.toFixed(2)}%` : '<0.01%'; }

export function renderReport(v, { cost = true, total = false, share = false } = {}) {
  const L = [], label = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // the average per prompt is the week's sum over its prompts (the priced sessions' prompts in the cost view)
  const avg = (c, w) => { const col = v.columns[w]; return total ? (cost ? c.cost : c.tokens) : cost ? (col.pricedPrompts ? c.cost / col.pricedPrompts : null) : (col.prompts ? c.tokens / col.prompts : null); };
  // what a cell shows: its value, or under share its value over the whole session's (the base), the total rows their value
  const val = (cells, w, base) => { const a = avg(cells[w], w); if (!a || !base) return a; const t = avg(base[w], w); return t ? a / t : null; };
  const fmtv = (x, base) => x == null ? '–' : base ? formatShare(x) : cost ? formatDollars(x) : formatTokens(x);
  // in the cost view a row of the parts table is marked by its dollars a priced prompt against COST_THRESHOLDS (the page's
  // colours): ✓ at or under Good, ✗ at or over Bad, · between; the token view has no bounds, no columns and no marks
  const MARK = { good: '✓', mid: '·', bad: '✗' };
  const mark = (key, cells, w) => { const col = v.columns[w], vd = cost && key && col.pricedPrompts ? verdict(key, cells[w].cost / col.pricedPrompts) : null; return vd ? MARK[vd] : ' '; };
  const W = 11, T = 8, thr = key => { const t = key && COST_THRESHOLDS[key]; return `${(t ? `≤${formatCostThreshold(t.good)}` : '–').padStart(T)}${(t ? `≥${formatCostThreshold(t.bad)}` : '–').padStart(T)}`; };
  // `key`: the row's key for the mark and the two bound columns; `thresholds`: the row sits in the table that has them (the
  // parts table, in the cost view)
  const line = (name, cells, bold, base, { key = null, thresholds = false } = {}) => `  ${(bold ? name.toUpperCase() : name).slice(0, 30).padEnd(30)}${thresholds && cost ? thr(key) : ''}${cells.map((c, w) => (val(cells, w, base) ? `${fmtv(val(cells, w, base), base)}${mark(key, cells, w)}` : '').padStart(W)).join('')}`;
  const weeks = v.columns.map(c => `wk ${label(c.t)}`.padStart(W)).join('');
  const head = `  ${''.padEnd(30)}${weeks}`, headThr = `  ${''.padEnd(30)}${'good'.padStart(T)}${'bad'.padStart(T)}${weeks}`;
  const base = share ? v.sessionTotals : null;
  L.push(`${total ? 'Total' : 'Average'} ${cost ? 'cost' : 'tokens'} ${total ? 'over the week\'s sessions' : 'per prompt (one call to the model)'}, by week (${v.columns.map(c => c.sessions).join(', ')} sessions, ${v.columns.map(c => c.prompts || 0).join(', ')} prompts)${cost ? `, at list prices of ${v.pricedOn}` : ''}${share ? '; each row as its share of the whole session, the totals as they are' : ''}`);
  const calNote = Object.entries(v.calibration || CALIBRATION).map(([k, f]) => `${k} ×${f}`).join(', ');
  L.push('', `By part of the context (the four the Find Savings page measures and controls, then the conversation by kind; the estimated parts in the model's own tokens: ${calNote}, the others one for one)`, cost ? headThr : head);
  for (const p of v.parts) L.push(line(p.name, p.cells, false, base, { key: p.key, thresholds: true }));
  // the rest of the input as one line, its kinds indented under it; the output after
  const rest = (v.others || []).filter(p => p.key !== 'output'), output = (v.others || []).find(p => p.key === 'output');
  if (v.otherInput) L.push(line('Other input', v.otherInput, false, base, { key: 'otherInput', thresholds: true }));
  for (const p of rest) L.push(line(`  ${p.name}`, p.cells, false, base, { key: p.key, thresholds: true }));
  if (output) L.push(line(output.name, output.cells, false, base, { key: 'output', thresholds: true }));
  L.push(line('Total (the whole session)', v.sessionTotals, true, null, { key: 'total', thresholds: true }));
  L.push('', 'By model', head);
  for (const p of v.providers) { L.push(line(p.name, p.cells, true, base)); for (const m of v.models.filter(x => x.provider === p.name)) L.push(line(`  ${m.model}${m.priced ? '' : ' (unpriced)'}`, m.cells, false, base)); }
  L.push(line('Total (the whole session)', v.sessionTotals, true));
  // the token types last (the owner's order, 2026-10-24)
  L.push('', 'By token type (as the model reported them: fresh input, input written to and read from the prompt cache, output)', head);
  for (const p of v.tokenTypes || []) L.push(line(p.name, p.cells, false, base));
  L.push(line('Total (the whole session)', v.sessionTotals, true));
  // the rewrites by cause and the estimated sessions stay in the view (--json) and off the print: not actionable (2026-10-25)
  L.push(`  ${cost ? '✓ · ✗: a row of the parts table at or under its good figure, between the two, at or over its bad figure, in dollars a priced prompt whatever the table shows; the models and the token types take no mark; ' : ''}a zero is left blank. A model row is its share of the ${total ? 'week' : 'average prompt'}; its sessions:` + ` ${v.models.map(m => `${m.model} ${m.cells.map(c => c.sessions).join('/')}`).join(', ')}.`);
  if (v.unpriced.length) L.push(`  No list price for ${v.unpriced.join(', ')}: their sessions are left out of the cost average.`);
  L.push('', 'Cache/compression effectiveness', ' '.repeat(32) + weeks);
  for (const s of v.savings || []) L.push(`  ${s.name.padEnd(30)}${s.cells.map((c, w) => fmtv(savingsValue(c, v.columns[w], v.sessionTotals[w], { cost, total, share }), share).padStart(W)).join('')}`);
  L.push('  Cache: estimated avoided reading minus note context. Compression: gross avoided cache reads; cache rewrites not deducted. Missing observations: –.');
  const c = v.cache;
  L.push('', 'The cache', `  ${(c.dollarsLabel || '$ saved').padEnd(16)} ${formatDollars(c.dollarsSaved)}${c.unpricedTokens ? ` (+${formatTokens(c.unpricedTokens)} tokens on unpriced models)` : ''}`, `  tokens saved     ${formatTokens(c.tokensSaved)} ${c.tokenDescription || (c.measured ? 'input tokens, against prompts with the notes withheld' : 'tokens of code the agents did not read')}`, `  cache hits       ${formatTokens(c.hits)} notes served, for ${formatTokens(c.answered)} of ${formatTokens(c.attempted)} requests the cache was asked${c.requests > c.attempted ? ` (${formatTokens(c.requests - c.attempted)} not asked: too few notes, or held out)` : ''}`, `  acted on         ${c.acted == null ? '–' : `${Math.round(100 * c.acted)}%`} of ${formatTokens(c.judged)} servings the sessions were judged on`);
  if (c.dollarsDescription) L.push(`  dollar basis     ${c.dollarsDescription}`);
  // What was shipped here and how much of it thinker paid for, the same figures as the page's band and as
  // `thinker prs` (prSavings). Tokens under --tokens and without it alike: see prSavings for why there is no
  // dollar figure on a cleared token.
  const pr = v.prs;
  if (pr?.merged) {
    const share = x => x == null ? '–' : `${(100 * x).toFixed(x < 0.01 ? 2 : 1)}%`;
    L.push('', 'Pull requests (tokens spent and saved on merged work)',
      `  merged with work here  ${pr.merged} of ${pr.mergedSeen} merged in the repositor${pr.mergedSeen === 1 ? 'y' : 'ies'}${pr.open ? `, ${pr.open} still open` : ''}`,
      `  saved on them          ${formatTokens(pr.saved.total)} that never sat in a prompt: ${formatTokens(pr.saved.cleared)} cleared (measured), ${formatTokens(pr.saved.reading)} reading avoided (estimate)`,
      `  share of their cost    ${share(pr.share)} of ${formatTokens(pr.agent)} agent tokens; ${pr.mergedAssisted} of ${pr.merged} saved something`,
      `  on the median one      ${formatTokens(pr.medianSaved || 0)} saved, ${pr.medianAgent == null ? '–' : formatTokens(pr.medianAgent)} spent${pr.medianHours == null ? '' : `, ${pr.medianHours < 10 ? pr.medianHours.toFixed(1) : Math.round(pr.medianHours)}h open to merged`}`,
      `  sessions               ${pr.sessions.linked} on a pull request, ${pr.sessions.unlinked} on none`);
    const n = Math.min(pr.rows.length, PR_LINES);
    if (n) {
      L.push('', `  ${'Merged, newest first'.padEnd(34)}${'sessions'.padStart(9)}${'its cost'.padStart(11)}${'cleared'.padStart(11)}${'reading'.padStart(11)}${'saved'.padStart(11)}${'share'.padStart(8)}`);
      for (const r of pr.rows.slice(0, n)) {
        const name = `${r.repoName ? `${r.repoName} ` : ''}#${r.number}${r.title ? ` ${r.title}` : ''}`;
        L.push(`  ${name.slice(0, 34).padEnd(34)}${String(r.sessions).padStart(9)}${`${formatTokens(r.agent)}${r.complete ? '' : '*'}`.padStart(11)}${(r.cleared ? formatTokens(r.cleared) : '–').padStart(11)}${(r.reading ? formatTokens(r.reading) : '–').padStart(11)}${(r.saved ? formatTokens(r.saved) : '–').padStart(11)}${share(r.share).padStart(8)}`);
      }
      if (pr.rows.length > n) L.push(`  ${pr.rows.length - n} more; thinker prs lists them all, --detail with their sessions.`);
      if (pr.rows.slice(0, n).some(r => !r.complete)) L.push('  * a session of that pull request reported no counters, so its cost is partial.');
    }
  }
  return L;
}

// Merged pull requests the command prints before telling the reader to run `thinker prs` for the rest.
const PR_LINES = 10;
