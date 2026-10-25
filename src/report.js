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
import { listPrice, providerOf, costOf, formatDollars, PRICED_ON } from './prices.js';
import { formatTokens } from './model-usage.js';
import { REWRITE_CAUSES } from './transcripts.js';

export const REPORT_WEEKS = 6;
// What a part should cost a prompt (one call to the model), in tokens: at or under `good` the cell is green, at or over
// `bad` red, between the two yellow (flat colours, the owner's ask of 2026-10-24: a scale showed where a row moved, not
// what needs attention). Only the four parts the Find Savings page controls are judged; the rest of the input, the output,
// a model and a token type take no colour, since no setting changes them. The unit is tokens a prompt whatever the cell
// shows (cost, a week's total, a share): a part's size a call is what the person controls, and an instruction file is read
// on every call however long the session. Set on this machine's 336 sessions of six weeks (2026-10-24): the instruction
// files ran 38k a prompt here (this AGENTS.md) and 7k on a repository with a short one; the custom tools (skills listed,
// MCP servers, plugins) 5–9k, one server being 1–5k; Claude Code's built-in tools 25–30k with every tool loaded against
// 10–15k for the core set; the tool outputs 23k a prompt at the first quartile of the long sessions and 55k at the third,
// 88% of their cost being reads after the agent last used them (the proxy's clearing is the cut).
// Since 2026-10-25 the Report counts the estimated parts in the model's own tokens (CALIBRATION below), so the figures set
// on 2026-10-24 at four characters a token (8k/20k, 3k/10k, 15k/25k, 20k/50k) are scaled by the same factor and rounded,
// and every verdict given then stands.
export const THRESHOLDS = {
  instructions: { good: 12_000, bad: 30_000 },
  custom: { good: 4_000, bad: 15_000 },
  builtin: { good: 22_000, bad: 36_000 },
  outputs: { good: 30_000, bad: 72_000 },
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
// 'good' | 'mid' | 'bad' for a part's tokens a prompt; null for a row without a threshold or a cell without a figure
export const verdict = (key, perPrompt) => { const t = THRESHOLDS[key]; return !t || !perPrompt ? null : perPrompt <= t.good ? 'good' : perPrompt >= t.bad ? 'bad' : 'mid'; };
// a threshold as the columns show it: 8k, 20k
export const formatThreshold = n => n % 1000 ? formatTokens(n) : `${n / 1000}k`;
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
    add(byType.cacheWrite[w], write, price ? write * price.cacheWrite / 1e6 : 0);
    add(byType.cacheRead[w], read, price ? read * price.cacheRead / 1e6 : 0);
    add(byType.output[w], output, price ? output * price.output / 1e6 : 0);
    // the prompt-cache rewrites by cause: the tokens written again, each at its rate
    for (const [k, x] of Object.entries(u.rewrites?.causes || {})) if (byCause[k]) { const c2 = byCause[k][w]; add(c2, (x.fresh || 0) + (x.write || 0), price ? ((x.fresh || 0) * price.input + (x.write || 0) * price.cacheWrite) / 1e6 : 0); c2.n += x.n || 0; }
    const key = r.model || 'unknown';
    if (!models.has(key)) models.set(key, { model: key, provider: providerOf(r.model, r.client), priced: Boolean(price), cells: cols.map(cell) });
    add(models.get(key).cells[w], input + output, cost, 1, cost == null ? 0 : 1, prompts, cost == null ? 0 : prompts);
  }
  // a total row carries the week's prompts, so a merged report (mergeReports) averages over every repository's
  const totalOf = keys => cols.map((_, w) => { const c = cell(); for (const k of keys) add(c, byPart[k][w].tokens, byPart[k][w].cost); c.prompts = columns[w].prompts; c.pricedPrompts = columns[w].pricedPrompts; return c; });
  const totals = totalOf(PARTS.map(([k]) => k)), sessionTotals = totalOf(BREAKDOWN.map(([k]) => k));
  const others = OTHERS.map(([key, name]) => ({ key, name, cells: byPart[key] }));
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
  return {
    weeks, days, from, to: now, pricedOn: PRICED_ON, columns, sessionRows, thresholds: THRESHOLDS,
    tokenTypes,
    parts: PARTS.map(([key, name]) => ({ key, name, cells: byPart[key] })), others, totals, sessionTotals,
    breakdown: BREAKDOWN.map(([key, name]) => ({ key, name, cells: byPart[key] })),
    rewrites: REWRITES.map(([key, name]) => ({ key, name, cells: byCause[key] })), rewriteTotals, estimated,
    calibration: calibrations(config),
    providers, models: modelRows, unpriced: [...unpriced],
    actions, outputRows: outRows, cache: cacheMetrics(store, { days, config }),
  };
}

// What compressing a tool's output measured: the tool's row under the compression against its row from before
// (tool-outputs.js:aggregateOutputs, one row a setting, each over the sessions that ran under it), the compressed row
// the latest one with a level. `perCall` is what compression acts on, the size of a result; `perSession` is what the
// person pays, the results times the calls that read them again, and moves with how the sessions since used the tool
// as well. A delta is before minus since, positive a saving; `window` is the session delta over the sessions since.
// null until both periods have a session in the window.
export function outputComparison(rows, name) {
  const mine = rows.filter(r => r.name === name), before = mine.find(r => !r.level), after = mine.filter(r => r.level).sort((a, b) => (b.from || 0) - (a.from || 0))[0];
  if (!before || !after || !before.sessions || !after.sessions) return null;
  const pick = r => ({ level: r.level || null, sessions: r.sessions, from: r.from ?? null, to: r.to ?? null, calls: r.calls, perCall: r.perCall, perSession: r.perSession, wasted: r.wasted ?? null });
  const d = k => ({ before: before[k], after: after[k], delta: before[k] - after[k], share: before[k] ? (before[k] - after[k]) / before[k] : null });
  return { name, before: pick(before), after: pick(after), perCall: d('perCall'), perSession: d('perSession'), window: (before.perSession - after.perSession) * after.sessions, few: after.sessions < 5 };
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
// dollars (the tokens saved on each model at that model's input price; the holdout's figure by model where it is
// measured, else the servings acted on), the same in tokens, the cache hits, and the share of judged servings the
// sessions acted on.
export function cacheMetrics(store, { days, config, all = false, usage } = {}) {
  const u = usage || summarize(store, { days, all });
  const as = u.assessed || {}, judged = (as.confirmed || 0) + (as.contradicted || 0) + (as.unused || 0);
  const ho = u.holdout, measured = Boolean(ho?.enough && ho.saved?.inputTokens != null);
  const priceIn = m => listPrice(m, { config })?.input;
  let dollars = 0, unpricedTokens = 0;
  if (measured) {
    for (const [m, g] of Object.entries(ho.byModel || {})) {
      const a = g.served?.perPrompt?.inputTokens, b = g.heldOut?.perPrompt?.inputTokens, n = g.served?.measured?.inputTokens;
      if (a == null || b == null || !n) continue;
      const t = (b - a) * n, p = priceIn(m); if (p == null) unpricedTokens += t; else dollars += t * p / 1e6;
    }
  } else for (const [m, x] of Object.entries(u.saved?.byModel || {})) { const p = priceIn(m); if (p == null) unpricedTokens += x.tokens; else dollars += x.tokens * p / 1e6; }
  return {
    dollarsSaved: dollars, unpricedTokens: Math.round(unpricedTokens), measured,
    tokensSaved: measured ? ho.saved.inputTokens : u.saved?.tokens || 0,
    hits: Object.values(u.servings || {}).reduce((a, b) => a + b, 0), requests: u.requests || 0, answered: u.answered || 0,
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
    all: true, weeks: first.weeks, days: first.days, from: first.from, to: first.to, pricedOn: first.pricedOn, thresholds: THRESHOLDS,
    columns: Array.from({ length: n }, (_, w) => ({ t: first.columns[w].t, prompts: views.reduce((a, v) => a + (v.columns[w].prompts || 0), 0), pricedPrompts: views.reduce((a, v) => a + (v.columns[w].pricedPrompts || 0), 0), sessions: views.reduce((a, v) => a + v.columns[w].sessions, 0), priced: views.reduce((a, v) => a + v.columns[w].priced, 0), unmeasured: views.reduce((a, v) => a + v.columns[w].unmeasured, 0) })),
    tokenTypes: TOKEN_TYPES.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.tokenTypes || []).find(p => p.key === key)?.cells || [])) })),
    parts: PARTS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => v.parts.find(p => p.key === key)?.cells || [])) })),
    others: OTHERS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.others || []).find(p => p.key === key)?.cells || [])) })),
    rewrites: REWRITES.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.rewrites || []).find(p => p.key === key)?.cells || [])) })),
    rewriteTotals: sumCells(views.map(v => v.rewriteTotals || [])),
    estimated: { columns: Array.from({ length: n }, (_, w) => ({ sessions: views.reduce((a, v) => a + (v.estimated?.columns?.[w]?.sessions || 0), 0), prompts: views.reduce((a, v) => a + (v.estimated?.columns?.[w]?.prompts || 0), 0) })), parts: PARTS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.estimated?.parts || []).find(p => p.key === key)?.cells || [])) })), totals: sumCells(views.map(v => v.estimated?.totals || [])) },
    calibration: views.find(v => v.calibration)?.calibration || CALIBRATION,
    breakdown: BREAKDOWN.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.breakdown || []).find(p => p.key === key)?.cells || [])) })),
    totals: sumCells(views.map(v => v.totals)), sessionTotals: sumCells(views.map(v => v.sessionTotals)),
    providers, models: modelRows, unpriced: [...new Set(views.flatMap(v => v.unpriced))],
    actions: list.flatMap(x => x.view.actions.map(a => ({ ...a, repo: x.repo, repoName: x.name }))).sort((a, b) => b.at.localeCompare(a.at)),
    cache: { dollarsSaved: sum('dollarsSaved'), unpricedTokens: sum('unpricedTokens'), measured: cache.some(c => c.measured), tokensSaved: sum('tokensSaved'), hits: sum('hits'), requests: sum('requests'), answered: sum('answered'), acted: judged ? confirmed / judged : null, judged },
    repos: list.map(x => ({ repo: x.repo, name: x.name })),
  };
}

// The report as the command prints it: the three tables with their totals, the cache's numbers. The decisions are not here
// (2026-10-24, the owner's call: in the Total view they compared spans of different lengths): Recent activity and `thinker
// context --history` carry them with what each saved (actionEffect, over the view's `sessionRows`).
// `total`: the week's sum over its sessions instead of the average per prompt (the page's Total toggle)
// `share` (the page's Share, 2026-10-24, the owner's ask): every row but the whole-session total as its share of that total in
// the week, a percentage, so the relative contributions and their trend can be read; the total rows keep their values.
// a share of the whole session as a percentage: whole above 10%, one decimal under it, two under 1%, and under 0.01% said so
export function formatShare(x) { const p = 100 * x; return p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1)}%` : p >= 0.01 ? `${p.toFixed(2)}%` : '<0.01%'; }

export function renderReport(v, { cost = false, total = false, share = false } = {}) {
  const L = [], label = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // the average per prompt is the week's sum over its prompts (the priced sessions' prompts in the cost view)
  const avg = (c, w) => { const col = v.columns[w]; return total ? (cost ? c.cost : c.tokens) : cost ? (col.pricedPrompts ? c.cost / col.pricedPrompts : null) : (col.prompts ? c.tokens / col.prompts : null); };
  // what a cell shows: its value, or under share its value over the whole session's (the base), the total rows their value
  const val = (cells, w, base) => { const a = avg(cells[w], w); if (!a || !base) return a; const t = avg(base[w], w); return t ? a / t : null; };
  const fmtv = (x, base) => x == null ? '–' : base ? formatShare(x) : cost ? formatDollars(x) : formatTokens(x);
  // a part's cell is marked by its tokens a prompt against THRESHOLDS (the page's colours): ✓ at or under Good, ✗ at or over
  // Bad, · between; the other rows take none
  const MARK = { good: '✓', mid: '·', bad: '✗' };
  const mark = (key, cells, w) => { const col = v.columns[w], vd = key && col.prompts ? verdict(key, cells[w].tokens / col.prompts) : null; return vd ? MARK[vd] : ' '; };
  const W = 11, T = 7, thr = key => { const t = key && THRESHOLDS[key]; return `${(t ? `≤${formatThreshold(t.good)}` : '–').padStart(T)}${(t ? `≥${formatThreshold(t.bad)}` : '–').padStart(T)}`; };
  // `key`: the part's key for the mark and the two threshold columns; `thresholds`: the row sits in the table that has them
  const line = (name, cells, bold, base, { key = null, thresholds = false } = {}) => `  ${(bold ? name.toUpperCase() : name).slice(0, 30).padEnd(30)}${thresholds ? thr(key) : ''}${cells.map((c, w) => (val(cells, w, base) ? `${fmtv(val(cells, w, base), base)}${mark(key, cells, w)}` : '').padStart(W)).join('')}`;
  const weeks = v.columns.map(c => `wk ${label(c.t)}`.padStart(W)).join('');
  const head = `  ${''.padEnd(30)}${weeks}`, headThr = `  ${''.padEnd(30)}${'good'.padStart(T)}${'bad'.padStart(T)}${weeks}`;
  const base = share ? v.sessionTotals : null;
  L.push(`${total ? 'Total' : 'Average'} ${cost ? 'cost' : 'tokens'} ${total ? 'over the week\'s sessions' : 'per prompt (one call to the model)'}, by week (${v.columns.map(c => c.sessions).join(', ')} sessions, ${v.columns.map(c => c.prompts || 0).join(', ')} prompts)${cost ? `, at list prices of ${v.pricedOn}` : ''}${share ? '; each row as its share of the whole session, the totals as they are' : ''}`);
  const calNote = Object.entries(v.calibration || CALIBRATION).map(([k, f]) => `${k} ×${f}`).join(', ');
  L.push('', `By part of the context (the four the Find Savings page measures and controls, then the conversation by kind; the estimated parts in the model's own tokens: ${calNote}, the others one for one)`, headThr);
  for (const p of v.parts) L.push(line(p.name, p.cells, false, base, { key: p.key, thresholds: true }));
  for (const p of v.others || []) L.push(line(p.name, p.cells, false, base, { thresholds: true }));
  L.push(line('Total (the whole session)', v.sessionTotals, true, null, { thresholds: true }));
  L.push('', 'By model', head);
  for (const p of v.providers) { L.push(line(p.name, p.cells, true, base)); for (const m of v.models.filter(x => x.provider === p.name)) L.push(line(`  ${m.model}${m.priced ? '' : ' (unpriced)'}`, m.cells, false, base)); }
  L.push(line('Total (the whole session)', v.sessionTotals, true));
  // the token types last (the owner's order, 2026-10-24)
  L.push('', 'By token type (as the model reported them: fresh input, input written to and read from the prompt cache, output)', head);
  for (const p of v.tokenTypes || []) L.push(line(p.name, p.cells, false, base));
  L.push(line('Total (the whole session)', v.sessionTotals, true));
  // the cache rewrites: a count a week in the Total view, else the tokens (or cost) a prompt; a part of the fresh and
  // written input above, not a fourth whole
  if (v.rewrites) {
    const counts = cells => cells.map(c => (c.n ? String(c.n) : '').padStart(W)).join('');
    L.push('', `Prompt cache rewrites (calls whose context the cache mostly did not serve, so the conversation was written again: a part of the fresh and written input above, by cause; ${total ? 'the week\'s tokens' : cost ? 'the cost a prompt' : 'the tokens a prompt'}, and the calls)`, head);
    for (const p of v.rewrites) if (p.cells.some(c => c.n)) { L.push(line(p.name, p.cells, false, base)); L.push(`  ${'  calls'.padEnd(30)}${counts(p.cells)}`); }
    L.push(line('Total of the rewrites', v.rewriteTotals || [], true, base)); L.push(`  ${'  calls'.padEnd(30)}${counts(v.rewriteTotals || [])}`);
  }
  // the sessions whose agent reports no usage (Cursor): their parts as estimated, by themselves
  const estSessions = (v.estimated?.columns || []).reduce((a, c) => a + c.sessions, 0);
  if (estSessions) {
    const ecol = v.estimated.columns, eavg = (c, w) => total ? c.tokens : (ecol[w].prompts ? c.tokens / ecol[w].prompts : null);
    const eline = (name, cells, bold) => `  ${(bold ? name.toUpperCase() : name).padEnd(30)}${cells.map((c, w) => (eavg(c, w) ? formatTokens(eavg(c, w)) : '').padStart(W)).join('')}`;
    L.push('', `Sessions whose agent reported no usage (Cursor): ${estSessions} session${estSessions === 1 ? '' : 's'}, their four parts as estimated (${ecol.map(c => c.sessions).join(', ')} sessions, ${ecol.map(c => c.prompts).join(', ')} prompts; tokens${total ? '' : ' a prompt'}, no cost)`, head);
    for (const p of v.estimated.parts) L.push(eline(p.name, p.cells, false));
    L.push(eline('Total of the four parts', v.estimated.totals, true));
  }
  L.push(`  ✓ · ✗: a part at or under its good figure, between the two, at or over its bad figure, in tokens a prompt whatever the table shows; the rest of the input, the output, the models and the token types take no mark; a zero is left blank. A model row is its share of the ${total ? 'week' : 'average prompt'}; its sessions:` + ` ${v.models.map(m => `${m.model} ${m.cells.map(c => c.sessions).join('/')}`).join(', ')}.`);
  if (v.unpriced.length) L.push(`  No list price for ${v.unpriced.join(', ')}: their sessions are left out of the cost average.`);
  const c = v.cache;
  L.push('', 'The cache', `  $ saved          ${formatDollars(c.dollarsSaved)}${c.unpricedTokens ? ` (+${formatTokens(c.unpricedTokens)} tokens on unpriced models)` : ''}`, `  tokens saved     ${formatTokens(Math.max(0, c.tokensSaved))} ${c.measured ? 'input tokens, against prompts with the notes withheld' : 'tokens of code the agents did not read'}`, `  cache hits       ${formatTokens(c.hits)} notes served, for ${formatTokens(c.answered)} of ${formatTokens(c.requests)} requests`, `  acted on         ${c.acted == null ? '–' : `${Math.round(100 * c.acted)}%`} of ${formatTokens(c.judged)} servings the sessions were judged on`);
  return L;
}
