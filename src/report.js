// The Report page (`thinker report`, the page's View Report tab; the Find Savings tab is `save`, the tab ids stay): what a session costs here, week by week, as the average
// over the sessions of each week, by the type of token (fresh input, cache writes, cache reads, output), by the part of
// the context the tokens went to and by the model that read them, the three tables adding up to the same whole session,
// with a cost view at list prices (prices.js). Read from the agents' own transcripts over the last REPORT_WEEKS
// weeks (Monday to Sunday, the current week so far last): each session's model and reported usage
// (tool-outputs.js:sessionUsage, from transcripts.js:Stats), and the parts the Context view estimates for it (the
// instruction files it read: instruction-value.js; the skills, MCP servers, plugins and built-in tools loaded:
// harness.js; its tool outputs read again by every call after them: tool-outputs.js), scaled down to the session's
// measured input where their sum overshoots it; and, from the transcript itself, what the conversation costs
// (transcripts.js:parseClaude `carried`: the system prompt, the agent's tool calls, its thinking kept in the context,
// the prompts and replies), the rest of the input being Claude Code's own notes and the listings ("other").
// Under the tables: the decisions taken on the Context view in the window (context-suggest.js:changeHistory), so a
// week's change can be read against what was cut that week, and the cache's four numbers (usage.js:summarize) with
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

export const REPORT_WEEKS = 6;
// a cell is trending when it moved this much against the first week of the window (the page colours it: red up, green down)
export const TREND_MIN = 0.05;
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
  ['agentCalls', "Agent's tool calls"], ['thinking', 'Thinking kept'], ['prompts', 'Prompts and replies'], ['notes', "Claude Code's notes"],
  ['other', 'Other input'], ['output', 'Output'],
];
export const PARTS = BREAKDOWN.filter(([k]) => ['instructions', 'custom', 'builtin', 'outputs'].includes(k));
// the rest of the session under the four parts, so the parts table adds up to the whole session (2026-10-24, the owner's
// ask): the other input as one row (the conversation: REST_INPUT, the breakdown's other input kinds), and the output
export const REST_INPUT = BREAKDOWN.map(([k]) => k).filter(k => !PARTS.some(([p]) => p === k) && k !== 'output');
export const OTHERS = [['otherInput', 'Other input'], ['output', 'Output']];
// the tokens by type, as the model reported them for each call and the transcript sums them (transcripts.js:Stats,
// model-usage.js): fresh input, at the input rate; input written to the prompt cache and input read from it, each at its
// rate; and output. The four add up to the whole session, as the parts and the models do: three tables, one total.
export const TOKEN_TYPES = [['fresh', 'Input, fresh'], ['cacheWrite', 'Input, written to cache'], ['cacheRead', 'Input, read from cache'], ['output', 'Output']];
const DAY = 86400_000;
// the Monday that starts the week of t, local time
export function weekStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }
const nextWeek = t => { const d = new Date(t); d.setDate(d.getDate() + 7); return d.getTime(); };
export function weekColumns(now, weeks) {
  const cols = []; let t = weekStart(now);
  for (let i = 0; i < weeks; i++) { cols.unshift(t); t = weekStart(t - DAY); }
  return cols.map(start => ({ t: start, end: nextWeek(start) }));
}
export const trend = (prev, cur) => prev == null || cur == null || !prev ? null : cur > prev * (1 + TREND_MIN) ? 'up' : cur < prev * (1 - TREND_MIN) ? 'down' : null;
// the change against the first week as a ratio (0.5: half as much again), null where either side is missing or zero;
// the page shades a cell by it (darker red the larger the rise, darker green the larger the fall), the command marks
// a change past TREND_BIG with a double arrow
export const TREND_BIG = 0.5;
export const change = (prev, cur) => prev == null || cur == null || !prev ? null : (cur - prev) / prev;

const cell = () => ({ tokens: 0, cost: 0, sessions: 0, priced: 0 });
const add = (c, tokens, cost, n = 0, p = 0) => { c.tokens += tokens; c.cost += cost || 0; c.sessions += n; c.priced += p; };

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
  for (const r of instructionValue(store, { days, sessions }).timeline) if (r.session) part(r.session).instructions = r.tokens * r.calls;
  for (const r of harnessUsage(store.repo, { days, sessions }).timeline || []) if (r.session) { const c = Math.max(1, r.calls), p = r.parts; Object.assign(part(r.session), { custom: ((p.skills || 0) + (p.mcp || 0) + (p.plugins || 0)) * c, builtin: (p.builtin || 0) * c }); }
  const rows = sessionUsage(store, sessions, timeline);
  for (const r of rows) part(r.session).outputs = r.outputs;
  const week = t => cols.findIndex(c => t >= c.t && t < c.end);
  const columns = cols.map(c => ({ t: c.t, sessions: 0, priced: 0, unmeasured: 0 }));
  const byPart = Object.fromEntries(BREAKDOWN.map(([k]) => [k, cols.map(cell)]));
  const byType = Object.fromEntries(TOKEN_TYPES.map(([k]) => [k, cols.map(cell)]));
  const models = new Map(), unpriced = new Set();
  for (const r of rows) {
    const w = week(r.t); if (w < 0) continue;
    const col = columns[w];
    if (!r.usage) { col.unmeasured++; continue; }
    const u = r.usage, price = listPrice(r.model, { config }), cost = costOf(u, price);
    const input = u.input, output = u.output || 0;
    col.sessions++; if (cost != null) col.priced++; else unpriced.add(r.model || 'unknown');
    // the parts as estimated, scaled to the measured input where they overshoot it; what is left is the conversation
    const p = parts.get(r.session) || {}, c = u.carried || {}, est = { instructions: Math.max(c.instructions || 0, p.instructions || 0), system: c.system || 0, custom: p.custom || 0, builtin: p.builtin || 0, outputs: p.outputs || 0, agentCalls: c.agentCalls || 0, thinking: c.thinking || 0, prompts: (c.prompts || 0) + (c.agentText || 0), notes: c.notes || 0 };
    const sum = Object.values(est).reduce((a, b) => a + b, 0), scale = sum > input && sum > 0 ? input / sum : 1;
    const inCost = cost == null ? null : (cost - (price ? output * price.output / 1e6 : 0)) / Math.max(1, input);
    for (const k of Object.keys(est)) { const tk = est[k] * scale; add(byPart[k][w], tk, inCost == null ? 0 : tk * inCost); }
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
    const key = r.model || 'unknown';
    if (!models.has(key)) models.set(key, { model: key, provider: providerOf(r.model, r.client), priced: Boolean(price), cells: cols.map(cell) });
    add(models.get(key).cells[w], input + output, cost, 1, cost == null ? 0 : 1);
  }
  const totalOf = keys => cols.map((_, w) => { const c = cell(); for (const k of keys) add(c, byPart[k][w].tokens, byPart[k][w].cost); return c; });
  const totals = totalOf(PARTS.map(([k]) => k)), sessionTotals = totalOf(BREAKDOWN.map(([k]) => k));
  const others = OTHERS.map(([key, name]) => ({ key, name, cells: key === 'output' ? byPart.output : totalOf(REST_INPUT) }));
  const tokenTypes = TOKEN_TYPES.map(([key, name]) => ({ key, name, cells: byType[key] }));
  // the models by provider, the biggest provider first and the biggest model within it
  const windowOf = m => m.cells.reduce((a, c) => a + c.tokens, 0);
  const modelRows = [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || windowOf(b) - windowOf(a));
  const providers = [...new Set(modelRows.map(m => m.provider))].map(name => ({ name, cells: cols.map((_, w) => { const c = cell(); for (const m of modelRows.filter(x => x.provider === name)) add(c, m.cells[w].tokens, m.cells[w].cost, m.cells[w].sessions, m.cells[w].priced); return c; }) }))
    .sort((a, b) => b.cells.reduce((x, c) => x + c.tokens, 0) - a.cells.reduce((x, c) => x + c.tokens, 0));
  modelRows.sort((a, b) => providers.findIndex(p => p.name === a.provider) - providers.findIndex(p => p.name === b.provider) || windowOf(b) - windowOf(a));
  // the output rows under each compression setting (tool-outputs.js:aggregateOutputs), kept in the view so the page's live
  // read of the actions (reportActions over a kept report) can say what a compression measured
  const outRows = (() => { try { return toolOutputs(store, sessions, timeline).tools; } catch { return []; } })();
  const actions = reportActions(store, from, outRows);
  return {
    weeks, days, from, to: now, pricedOn: PRICED_ON, columns,
    tokenTypes,
    parts: PARTS.map(([key, name]) => ({ key, name, cells: byPart[key] })), others, totals, sessionTotals,
    breakdown: BREAKDOWN.map(([key, name]) => ({ key, name, cells: byPart[key] })),
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

// The decisions taken on the Find Savings page since `from`, newest first, as History lists them (the page shows the same
// table). Read apart from the view: the page serves a kept report (report-snapshot.js) and reads these live over it, so a
// decision taken a moment ago is in the window at once.
// `rows`: the view's `outputRows`; an output's compression among the decisions then carries what it measured since
// (outputComparison), null with no rows or nothing measured yet.
export function reportActions(store, from, rows = []) {
  return changeHistory(store).filter(e => Date.parse(e.at) >= from).map(e => ({ ...e, repo: null, measured: e.kind === 'output' && e.decision !== 'dismissed' && rows.length ? outputComparison(rows, e.key.replace(/^output:/, '')) : null }));
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
  const sumCells = xs => Array.from({ length: n }, (_, w) => { const c = cell(); for (const cs of xs) if (cs[w]) add(c, cs[w].tokens, cs[w].cost, cs[w].sessions, cs[w].priced); return c; });
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
    all: true, weeks: first.weeks, days: first.days, from: first.from, to: first.to, pricedOn: first.pricedOn,
    columns: Array.from({ length: n }, (_, w) => ({ t: first.columns[w].t, sessions: views.reduce((a, v) => a + v.columns[w].sessions, 0), priced: views.reduce((a, v) => a + v.columns[w].priced, 0), unmeasured: views.reduce((a, v) => a + v.columns[w].unmeasured, 0) })),
    tokenTypes: TOKEN_TYPES.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.tokenTypes || []).find(p => p.key === key)?.cells || [])) })),
    parts: PARTS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => v.parts.find(p => p.key === key)?.cells || [])) })),
    others: OTHERS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.others || []).find(p => p.key === key)?.cells || [])) })),
    breakdown: BREAKDOWN.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.breakdown || []).find(p => p.key === key)?.cells || [])) })),
    totals: sumCells(views.map(v => v.totals)), sessionTotals: sumCells(views.map(v => v.sessionTotals)),
    providers, models: modelRows, unpriced: [...new Set(views.flatMap(v => v.unpriced))],
    actions: list.flatMap(x => x.view.actions.map(a => ({ ...a, repo: x.repo, repoName: x.name }))).sort((a, b) => b.at.localeCompare(a.at)),
    cache: { dollarsSaved: sum('dollarsSaved'), unpricedTokens: sum('unpricedTokens'), measured: cache.some(c => c.measured), tokensSaved: sum('tokensSaved'), hits: sum('hits'), requests: sum('requests'), answered: sum('answered'), acted: judged ? confirmed / judged : null, judged },
    repos: list.map(x => ({ repo: x.repo, name: x.name })),
  };
}

// The report as the command prints it: the two tables with their totals, the actions, the cache's numbers.
// `total`: the week's sum over its sessions instead of the average per session (the page's Total toggle)
// `share` (the page's Share, 2026-10-24, the owner's ask): every row but the whole-session total as its share of that total in
// the week, a percentage, so the relative contributions and their trend can be read; the total rows keep their values.
// a share of the whole session as a percentage: whole above 10%, one decimal under it, two under 1%, and under 0.01% said so
export function formatShare(x) { const p = 100 * x; return p >= 10 ? `${Math.round(p)}%` : p >= 1 ? `${p.toFixed(1)}%` : p >= 0.01 ? `${p.toFixed(2)}%` : '<0.01%'; }

export function renderReport(v, { cost = false, total = false, share = false } = {}) {
  const L = [], label = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const avg = (c, w) => { const col = v.columns[w]; return total ? (cost ? c.cost : c.tokens) : cost ? (col.priced ? c.cost / col.priced : null) : (col.sessions ? c.tokens / col.sessions : null); };
  // what a cell shows: its value, or under share its value over the whole session's (the base), the total rows their value
  const val = (cells, w, base) => { const a = avg(cells[w], w); if (!a || !base) return a; const t = avg(base[w], w); return t ? a / t : null; };
  const fmtv = (x, base) => x == null ? '–' : base ? formatShare(x) : cost ? formatDollars(x) : formatTokens(x);
  const mark = (cells, w, base) => { const d = w ? change(val(cells, 0, base), val(cells, w, base)) : null; return d == null || Math.abs(d) < TREND_MIN ? ' ' : d >= TREND_BIG ? '▲▲' : d > 0 ? '▲' : d <= -TREND_BIG ? '▼▼' : '▼'; };
  const W = 11, line = (name, cells, bold, base) => `  ${(bold ? name.toUpperCase() : name).slice(0, 30).padEnd(30)}${cells.map((c, w) => (val(cells, w, base) ? `${fmtv(val(cells, w, base), base)}${mark(cells, w, base)}` : '').padStart(W)).join('')}`;
  const head = `  ${''.padEnd(30)}${v.columns.map(c => `wk ${label(c.t)}`.padStart(W)).join('')}`;
  const base = share ? v.sessionTotals : null;
  L.push(`${total ? 'Total' : 'Average'} ${cost ? 'cost' : 'tokens'} ${total ? 'over the week\'s sessions' : 'per session'}, by week (${v.columns.map(c => c.sessions).join(', ')} sessions)${cost ? `, at list prices of ${v.pricedOn}` : ''}${share ? '; each row as its share of the whole session, the totals as they are' : ''}`);
  L.push('', 'By part of the context (the four the Find Savings page measures and controls, the rest of the input as one line; --json holds the whole breakdown)', head);
  for (const p of v.parts) L.push(line(p.name, p.cells, false, base));
  for (const p of v.others || []) L.push(line(p.name, p.cells, false, base));
  L.push(line('Total (the whole session)', v.sessionTotals, true));
  L.push('', 'By model', head);
  for (const p of v.providers) { L.push(line(p.name, p.cells, true, base)); for (const m of v.models.filter(x => x.provider === p.name)) L.push(line(`  ${m.model}${m.priced ? '' : ' (unpriced)'}`, m.cells, false, base)); }
  L.push(line('Total (the whole session)', v.sessionTotals, true));
  // the token types last (the owner's order, 2026-10-24)
  L.push('', 'By token type (as the model reported them: fresh input, input written to and read from the prompt cache, output)', head);
  for (const p of v.tokenTypes || []) L.push(line(p.name, p.cells, false, base));
  L.push(line('Total (the whole session)', v.sessionTotals, true));
  L.push(`  ▲ ▼: up or down by 5% or more against the first week, doubled past 50%; a zero is left blank. A model row is its share of the ${total ? 'week' : 'average session'}; its sessions:` + ` ${v.models.map(m => `${m.model} ${m.cells.map(c => c.sessions).join('/')}`).join(', ')}.`);
  if (v.unpriced.length) L.push(`  No list price for ${v.unpriced.join(', ')}: their sessions are left out of the cost average.`);
  L.push('', 'Actions in the window');
  if (!v.actions.length) L.push('  none: what you apply on the Find Savings page is listed here with its date');
  const pct = x => x.share == null ? '' : ` (${x.delta >= 0 ? '−' : '+'}${Math.round(100 * Math.abs(x.share))}%)`;
  for (const a of v.actions) {
    L.push(`  ${a.at.slice(0, 10)}  ${(a.revertedAt ? 'reverted' : a.decision).padEnd(22)} ${a.title}${a.repoName ? ` (${a.repoName})` : ''}`);
    // what an output's compression measured: a call and a session before and since, the saving over the sessions since
    const m = a.measured;
    if (!m) { if (a.kind === 'output' && !a.revertedAt && a.decision !== 'dismissed') L.push(`${''.padEnd(36)}measured: nothing yet, no session has called it since`); continue; }
    const day = t => t ? new Date(t).toISOString().slice(0, 10) : '?';
    L.push(`${''.padEnd(36)}measured: ${m.perSession.delta >= 0 ? 'saving' : 'costing'} ~${formatTokens(Math.abs(m.perSession.delta))} input tokens a session${pct(m.perSession)}, ${formatTokens(Math.abs(m.window))} over the ${m.after.sessions} session${m.after.sessions === 1 ? '' : 's'} since${m.few ? ' (few sessions yet)' : ''}`);
    L.push(`${''.padEnd(36)}a call ${formatTokens(m.perCall.before)} → ${formatTokens(m.perCall.after)}${pct(m.perCall)} · a session ${formatTokens(m.perSession.before)} → ${formatTokens(m.perSession.after)} · before: ${m.before.sessions} sessions ${day(m.before.from)} to ${day(m.before.to)}, since: ${m.after.sessions} ${day(m.after.from)} to ${day(m.after.to)}`);
  }
  const c = v.cache;
  L.push('', 'The cache', `  $ saved          ${formatDollars(c.dollarsSaved)}${c.unpricedTokens ? ` (+${formatTokens(c.unpricedTokens)} tokens on unpriced models)` : ''}`, `  tokens saved     ${formatTokens(Math.max(0, c.tokensSaved))} ${c.measured ? 'input tokens, against prompts with the notes withheld' : 'tokens of code the agents did not read'}`, `  cache hits       ${formatTokens(c.hits)} notes served, for ${formatTokens(c.answered)} of ${formatTokens(c.requests)} requests`, `  acted on         ${c.acted == null ? '–' : `${Math.round(100 * c.acted)}%`} of ${formatTokens(c.judged)} servings the sessions were judged on`);
  return L;
}
