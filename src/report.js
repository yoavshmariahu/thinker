// The Report page (`thinker report`, the page's Report tab): what a session costs here, week by week, as the average
// over the sessions of each week, by the part of the context the tokens went to and by the model that read them,
// with a cost view at list prices (prices.js). Read from the agents' own transcripts over the last REPORT_WEEKS
// weeks (Monday to Sunday, the current week so far last): each session's model and reported usage
// (tool-outputs.js:sessionUsage, from transcripts.js:Stats), and the parts the Context view estimates for it (the
// instruction files it read: instruction-value.js; the skills, MCP servers, plugins and built-in tools loaded:
// harness.js; its tool outputs read again by every call after them: tool-outputs.js), scaled down to the session's
// measured input where their sum overshoots it, the rest of the input being the conversation itself ("other").
// Under the tables: the decisions taken on the Context view in the window (context-suggest.js:changeHistory), so a
// week's change can be read against what was cut that week, and the cache's four numbers (usage.js:summarize) with
// its saving priced at the models it was made on. A session whose agent reports no usage (Cursor) is counted in no
// column. Measurement only; nothing is served or written.
import { findRepoSessions, instructionValue } from './instruction-value.js';
import { harnessUsage } from './harness.js';
import { sessionUsage } from './tool-outputs.js';
import { changeHistory } from './context-suggest.js';
import { summarize } from './usage.js';
import { listPrice, providerOf, costOf, formatDollars, PRICED_ON } from './prices.js';
import { formatTokens } from './model-usage.js';

export const REPORT_WEEKS = 6;
// a cell is trending when it moved this much against the first week of the window (the page colours it: red up, green down)
export const TREND_MIN = 0.05;
export const PARTS = [
  ['instructions', 'Instruction files'], ['custom', 'Custom tools'], ['builtin', 'Built-in tools'], ['outputs', 'Tool outputs'],
  ['other', 'Other input'], ['output', 'Output'],
];
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
  // the parts each session's context went to, by session id (the readers keep their own caches)
  const parts = new Map(), part = id => { if (!parts.has(id)) parts.set(id, {}); return parts.get(id); };
  for (const r of instructionValue(store, { days, sessions }).timeline) if (r.session) part(r.session).instructions = r.tokens * r.calls;
  for (const r of harnessUsage(store.repo, { days, sessions }).timeline || []) if (r.session) { const c = Math.max(1, r.calls), p = r.parts; Object.assign(part(r.session), { custom: ((p.skills || 0) + (p.mcp || 0) + (p.plugins || 0)) * c, builtin: (p.builtin || 0) * c }); }
  const rows = sessionUsage(store, sessions);
  for (const r of rows) part(r.session).outputs = r.outputs;
  const week = t => cols.findIndex(c => t >= c.t && t < c.end);
  const columns = cols.map(c => ({ t: c.t, sessions: 0, priced: 0, unmeasured: 0 }));
  const byPart = Object.fromEntries(PARTS.map(([k]) => [k, cols.map(cell)]));
  const models = new Map(), unpriced = new Set();
  for (const r of rows) {
    const w = week(r.t); if (w < 0) continue;
    const col = columns[w];
    if (!r.usage) { col.unmeasured++; continue; }
    const u = r.usage, price = listPrice(r.model, { config }), cost = costOf(u, price);
    const input = u.input, output = u.output || 0;
    col.sessions++; if (cost != null) col.priced++; else unpriced.add(r.model || 'unknown');
    // the parts as estimated, scaled to the measured input where they overshoot it; what is left is the conversation
    const p = parts.get(r.session) || {}, est = { instructions: p.instructions || 0, custom: p.custom || 0, builtin: p.builtin || 0, outputs: p.outputs || 0 };
    const sum = Object.values(est).reduce((a, b) => a + b, 0), scale = sum > input && sum > 0 ? input / sum : 1;
    const inCost = cost == null ? null : (cost - (price ? output * price.output / 1e6 : 0)) / Math.max(1, input);
    for (const k of Object.keys(est)) { const tk = est[k] * scale; add(byPart[k][w], tk, inCost == null ? 0 : tk * inCost); }
    const other = Math.max(0, input - sum * scale);
    add(byPart.other[w], other, inCost == null ? 0 : other * inCost);
    add(byPart.output[w], output, price ? output * price.output / 1e6 : 0);
    const key = r.model || 'unknown';
    if (!models.has(key)) models.set(key, { model: key, provider: providerOf(r.model, r.client), priced: Boolean(price), cells: cols.map(cell) });
    add(models.get(key).cells[w], input + output, cost, 1, cost == null ? 0 : 1);
  }
  const totals = cols.map((_, w) => { const c = cell(); for (const [k] of PARTS) add(c, byPart[k][w].tokens, byPart[k][w].cost); return c; });
  // the models by provider, the biggest provider first and the biggest model within it
  const windowOf = m => m.cells.reduce((a, c) => a + c.tokens, 0);
  const modelRows = [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || windowOf(b) - windowOf(a));
  const providers = [...new Set(modelRows.map(m => m.provider))].map(name => ({ name, cells: cols.map((_, w) => { const c = cell(); for (const m of modelRows.filter(x => x.provider === name)) add(c, m.cells[w].tokens, m.cells[w].cost, m.cells[w].sessions, m.cells[w].priced); return c; }) }))
    .sort((a, b) => b.cells.reduce((x, c) => x + c.tokens, 0) - a.cells.reduce((x, c) => x + c.tokens, 0));
  modelRows.sort((a, b) => providers.findIndex(p => p.name === a.provider) - providers.findIndex(p => p.name === b.provider) || windowOf(b) - windowOf(a));
  // the decisions taken on the Save page in the window, newest first, as History lists them (the page shows the same table)
  const actions = changeHistory(store).filter(e => Date.parse(e.at) >= from).map(e => ({ ...e, repo: null }));
  return {
    weeks, days, from, to: now, pricedOn: PRICED_ON, columns,
    parts: PARTS.map(([key, name]) => ({ key, name, cells: byPart[key] })), totals,
    providers, models: modelRows, unpriced: [...unpriced],
    actions, cache: cacheMetrics(store, { days, config }),
  };
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
    parts: PARTS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => v.parts.find(p => p.key === key)?.cells || [])) })),
    totals: sumCells(views.map(v => v.totals)),
    providers, models: modelRows, unpriced: [...new Set(views.flatMap(v => v.unpriced))],
    actions: list.flatMap(x => x.view.actions.map(a => ({ ...a, repo: x.repo, repoName: x.name }))).sort((a, b) => b.at.localeCompare(a.at)),
    cache: { dollarsSaved: sum('dollarsSaved'), unpricedTokens: sum('unpricedTokens'), measured: cache.some(c => c.measured), tokensSaved: sum('tokensSaved'), hits: sum('hits'), requests: sum('requests'), answered: sum('answered'), acted: judged ? confirmed / judged : null, judged },
    repos: list.map(x => ({ repo: x.repo, name: x.name })),
  };
}

// The report as the command prints it: the two tables with their totals, the actions, the cache's numbers.
// `total`: the week's sum over its sessions instead of the average per session (the page's Total toggle)
export function renderReport(v, { cost = false, total = false } = {}) {
  const L = [], label = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const avg = (c, w) => { const col = v.columns[w]; return total ? (cost ? c.cost : c.tokens) : cost ? (col.priced ? c.cost / col.priced : null) : (col.sessions ? c.tokens / col.sessions : null); };
  const fmtv = x => x == null ? '–' : cost ? formatDollars(x) : formatTokens(x);
  const mark = (cells, w) => { const d = w ? change(avg(cells[0], 0), avg(cells[w], w)) : null; return d == null || Math.abs(d) < TREND_MIN ? ' ' : d >= TREND_BIG ? '▲▲' : d > 0 ? '▲' : d <= -TREND_BIG ? '▼▼' : '▼'; };
  const W = 11, line = (name, cells, bold) => `  ${(bold ? name.toUpperCase() : name).slice(0, 30).padEnd(30)}${cells.map((c, w) => (avg(c, w) ? `${fmtv(avg(c, w))}${mark(cells, w)}` : '').padStart(W)).join('')}`;
  const head = `  ${''.padEnd(30)}${v.columns.map(c => `wk ${label(c.t)}`.padStart(W)).join('')}`;
  L.push(`${total ? 'Total' : 'Average'} ${cost ? 'cost' : 'tokens'} ${total ? 'over the week\'s sessions' : 'per session'}, by week (${v.columns.map(c => c.sessions).join(', ')} sessions)${cost ? `, at list prices of ${v.pricedOn}` : ''}`);
  L.push('', 'By part of the context', head);
  for (const p of v.parts) L.push(line(p.name, p.cells));
  L.push(line('Total', v.totals, true));
  L.push('', 'By model', head);
  for (const p of v.providers) { L.push(line(p.name, p.cells, true)); for (const m of v.models.filter(x => x.provider === p.name)) L.push(line(`  ${m.model}${m.priced ? '' : ' (unpriced)'}`, m.cells)); }
  L.push(line('Total', v.totals, true));
  L.push(`  ▲ ▼: up or down by 5% or more against the first week, doubled past 50%; a zero is left blank. A model row is its share of the ${total ? 'week' : 'average session'}; its sessions:` + ` ${v.models.map(m => `${m.model} ${m.cells.map(c => c.sessions).join('/')}`).join(', ')}.`);
  if (v.unpriced.length) L.push(`  No list price for ${v.unpriced.join(', ')}: their sessions are left out of the cost average.`);
  L.push('', 'Actions in the window');
  if (!v.actions.length) L.push('  none: what you apply on the Save page is listed here with its date');
  for (const a of v.actions) L.push(`  ${a.at.slice(0, 10)}  ${(a.revertedAt ? 'reverted' : a.decision).padEnd(22)} ${a.title}${a.repoName ? ` (${a.repoName})` : ''}`);
  const c = v.cache;
  L.push('', 'The cache', `  $ saved          ${formatDollars(c.dollarsSaved)}${c.unpricedTokens ? ` (+${formatTokens(c.unpricedTokens)} tokens on unpriced models)` : ''}`, `  tokens saved     ${formatTokens(Math.max(0, c.tokensSaved))} ${c.measured ? 'input tokens, against prompts with the notes withheld' : 'tokens of code the agents did not read'}`, `  cache hits       ${formatTokens(c.hits)} notes served, for ${formatTokens(c.answered)} of ${formatTokens(c.requests)} requests`, `  acted on         ${c.acted == null ? '–' : `${Math.round(100 * c.acted)}%`} of ${formatTokens(c.judged)} servings the sessions were judged on`);
  return L;
}
