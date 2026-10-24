// The Report page (`thinker report`, the page's View Report tab; the Find Savings tab is `save`, the tab ids stay): what a prompt costs here
// (since 2026-10-24, the owner's ask: a prompt is one call to the model, the unit the context is read again at; a session was the unit before), week by week, as the average
// over the sessions of each week, by the part of the context the tokens went to and by the model that read them,
// with a cost view at list prices (prices.js). Read from the agents' own transcripts over the last REPORT_WEEKS
// weeks (Monday to Sunday, the current week so far last): each session's model and reported usage
// (tool-outputs.js:sessionUsage, from transcripts.js:Stats), and the parts the Context view estimates for it (the
// instruction files it read: instruction-value.js; the skills, MCP servers, plugins and built-in tools loaded:
// harness.js; its tool outputs read again by every call after them: tool-outputs.js), scaled down to the session's
// measured input where their sum overshoots it; and, from the transcript itself, what the conversation costs
// (transcripts.js:parseClaude `carried`: the system prompt, the agent's tool calls, its thinking kept in the context,
// the prompts and replies), the rest of the input being Claude Code's own notes and the listings ("other").
// Under the tables: Recent improvements (`top`, reportTop): the five actions in effect that saved most, each with what it
// alone saved (actionEffect: the thing it changed costed a prompt before the decision against since, from the view's
// `sessionRows`) and its pull request; and the cache's four numbers (usage.js:summarize) with
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
// parts the Save page measures and controls (PARTS), their total under them, and the whole session's tokens under the
// model table (`sessionTotals`). The other kinds are written up in research/context-breakdown-2026-10-22.md, for the
// work on cutting them (the owner's decision, 2026-10-22).
export const BREAKDOWN = [
  ['instructions', 'Instruction files'], ['system', 'System prompt'], ['custom', 'Custom tools'], ['builtin', 'Built-in tools'], ['outputs', 'Tool outputs'],
  ['agentCalls', "Agent's tool calls"], ['thinking', 'Thinking kept'], ['prompts', 'Prompts and replies'], ['notes', "Claude Code's notes"],
  ['other', 'Other input'], ['output', 'Output'],
];
export const PARTS = BREAKDOWN.filter(([k]) => ['instructions', 'custom', 'builtin', 'outputs'].includes(k));
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

// a cell: the week's tokens and cost, with the sessions and the prompts (model calls) behind them, so the average per
// prompt is the ratio of the sums (a long session weighs by its prompts, not as one)
const cell = () => ({ tokens: 0, cost: 0, sessions: 0, priced: 0, prompts: 0, pricedPrompts: 0 });
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
  const models = new Map(), unpriced = new Set();
  // one row a measured session (sessionRows): its input, the four parts as estimated, and the things it cost (above), so
  // each action can be measured as tokens a prompt before and since it (actionEffect), live over a kept report
  const sessionRows = [];
  for (const r of rows) {
    const w = week(r.t); if (w < 0) continue;
    const col = columns[w];
    if (!r.usage) { col.unmeasured++; continue; }
    const u = r.usage, price = listPrice(r.model, { config }), cost = costOf(u, price);
    const input = u.input, output = u.output || 0, prompts = Math.max(1, u.turns || 0);
    col.sessions++; col.prompts += prompts; if (cost != null) { col.priced++; col.pricedPrompts += prompts; } else unpriced.add(r.model || 'unknown');
    // the parts as estimated, scaled to the measured input where they overshoot it; what is left is the conversation
    const p = parts.get(r.session) || {}, c = u.carried || {}, est = { instructions: Math.max(c.instructions || 0, p.instructions || 0), system: c.system || 0, custom: p.custom || 0, builtin: p.builtin || 0, outputs: p.outputs || 0, agentCalls: c.agentCalls || 0, thinking: c.thinking || 0, prompts: (c.prompts || 0) + (c.agentText || 0), notes: c.notes || 0 };
    const sum = Object.values(est).reduce((a, b) => a + b, 0), scale = sum > input && sum > 0 ? input / sum : 1;
    const inCost = cost == null ? null : (cost - (price ? output * price.output / 1e6 : 0)) / Math.max(1, input);
    for (const k of Object.keys(est)) { const tk = est[k] * scale; add(byPart[k][w], tk, inCost == null ? 0 : tk * inCost); }
    sessionRows.push({ t: r.t, input, prompts, parts: Object.fromEntries(PARTS.map(([k]) => [k, Math.round(est[k] * scale)])), ...(items.get(r.session) || { calls: 0, files: [], sources: {}, outputs: {} }) });
    const other = Math.max(0, input - sum * scale);
    add(byPart.other[w], other, inCost == null ? 0 : other * inCost);
    add(byPart.output[w], output, price ? output * price.output / 1e6 : 0);
    const key = r.model || 'unknown';
    if (!models.has(key)) models.set(key, { model: key, provider: providerOf(r.model, r.client), priced: Boolean(price), cells: cols.map(cell) });
    add(models.get(key).cells[w], input + output, cost, 1, cost == null ? 0 : 1, prompts, cost == null ? 0 : prompts);
  }
  // a total row carries the week's prompts, so a merged report (mergeReports) averages over every repository's
  const totalOf = keys => cols.map((_, w) => { const c = cell(); for (const k of keys) add(c, byPart[k][w].tokens, byPart[k][w].cost); c.prompts = columns[w].prompts; c.pricedPrompts = columns[w].pricedPrompts; return c; });
  const totals = totalOf(PARTS.map(([k]) => k)), sessionTotals = totalOf(BREAKDOWN.map(([k]) => k));
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
    weeks, days, from, to: now, pricedOn: PRICED_ON, columns, sessionRows,
    parts: PARTS.map(([key, name]) => ({ key, name, cells: byPart[key] })), totals, sessionTotals,
    breakdown: BREAKDOWN.map(([key, name]) => ({ key, name, cells: byPart[key] })),
    providers, models: modelRows, unpriced: [...unpriced],
    actions, top: reportTop(actions, { now }), outputRows: outRows, cache: cacheMetrics(store, { days, config }),
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
const diff = (before, after) => ({ before, after, delta: before - after, share: before ? (before - after) / before : null });
// What an action saved, attributed to it alone: the cost of the thing it changed (itemCost) per prompt over the window's
// sessions before the decision (`before`) and over those since it was in effect (`after`, until its revert), each side the
// sum over its sessions divided by their prompts, with its sessions, prompts and dates; `delta` before minus since a prompt,
// positive a saving, `share` of before; `window` the delta over the prompts since (`since`: the thing over those prompts at
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
  const d = diff(b.perPrompt, a.perPrompt);
  // `since`: the thing over the prompts since the decision, at the before rate (`atBefore`, what it would have cost) and as
  // it was (`total`, after.total); `window` is exactly their gap (the Total view's Saved is its Before minus its After)
  return { from: span.from, to: e.revertedAt ? span.to : null, before: b, after: a, delta: d.delta, share: d.share, since: { prompts: a.prompts, atBefore: Math.round(b.total / b.prompts * a.prompts), total: a.total }, window: Math.round(b.total / b.prompts * a.prompts) - a.total, few: b.sessions < 5 || a.sessions < 5 };
}
// The history with what each decision saved (actionEffect over the view's session rows), as both doors list it. A decision
// on a thing decided again later (sed compressed on Tuesday, then again on Thursday) is measured until the later one is in
// effect, so the two rows share no session.
export function withEffects(history, sessionRows = [], now = Date.now()) {
  const later = e => history.filter(o => o !== e && o.key === e.key && Date.parse(o.at) > Date.parse(e.at)).map(o => effectSpan(o, now)?.from).filter(t => t != null);
  return history.map(e => { const ts = later(e); return { ...e, effect: actionEffect(e, sessionRows, now, { until: ts.length ? Math.min(...ts) : null }) }; });
}
// The decisions taken on the Find Savings page since `from`, newest first, as Recent activity lists them, each with what it
// saved (`effect`). Read apart from the view: the page serves a kept report (report-snapshot.js) and reads these live over
// it, so a decision taken a moment ago is in the window at once.
export function reportActions(store, from, sessionRows = [], now = Date.now()) {
  return withEffects(changeHistory(store).filter(e => Date.parse(e.at) >= from), sessionRows, now).map(e => ({ ...e, repo: null }));
}
// Recent improvements (the Report's table, `TOP_ACTIONS`): the actions in effect (effectSpan; never a reverted, dismissed,
// failed or still pending one), the ones that saved most first by what they saved over the prompts since (`window`), then
// the unmeasured by their estimate when decided (`total`); the newest first among equals.
export const TOP_ACTIONS = 5;
export function reportTop(actions, { now = Date.now(), max = TOP_ACTIONS } = {}) {
  const value = e => e.effect ? e.effect.window : -Infinity;
  return actions.filter(e => effectSpan(e, now) && !e.revertedAt).sort((a, b) => (value(b) - value(a)) || ((b.effect ? 0 : b.total || b.saving || 0) - (a.effect ? 0 : a.total || a.saving || 0)) || b.at.localeCompare(a.at)).slice(0, max);
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
  const sumCells = xs => Array.from({ length: n }, (_, w) => { const c = cell(); for (const cs of xs) if (cs[w]) add(c, cs[w].tokens, cs[w].cost, cs[w].sessions, cs[w].priced, cs[w].prompts || 0, cs[w].pricedPrompts || 0); return c; });
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
    columns: Array.from({ length: n }, (_, w) => ({ t: first.columns[w].t, prompts: views.reduce((a, v) => a + (v.columns[w].prompts || 0), 0), pricedPrompts: views.reduce((a, v) => a + (v.columns[w].pricedPrompts || 0), 0), sessions: views.reduce((a, v) => a + v.columns[w].sessions, 0), priced: views.reduce((a, v) => a + v.columns[w].priced, 0), unmeasured: views.reduce((a, v) => a + v.columns[w].unmeasured, 0) })),
    parts: PARTS.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => v.parts.find(p => p.key === key)?.cells || [])) })),
    breakdown: BREAKDOWN.map(([key, name]) => ({ key, name, cells: sumCells(views.map(v => (v.breakdown || []).find(p => p.key === key)?.cells || [])) })),
    totals: sumCells(views.map(v => v.totals)), sessionTotals: sumCells(views.map(v => v.sessionTotals)),
    providers, models: modelRows, unpriced: [...new Set(views.flatMap(v => v.unpriced))],
    actions: list.flatMap(x => x.view.actions.map(a => ({ ...a, repo: x.repo, repoName: x.name }))).sort((a, b) => b.at.localeCompare(a.at)),
    top: reportTop(list.flatMap(x => x.view.actions.map(a => ({ ...a, repo: x.repo, repoName: x.name })))),
    cache: { dollarsSaved: sum('dollarsSaved'), unpricedTokens: sum('unpricedTokens'), measured: cache.some(c => c.measured), tokensSaved: sum('tokensSaved'), hits: sum('hits'), requests: sum('requests'), answered: sum('answered'), acted: judged ? confirmed / judged : null, judged },
    repos: list.map(x => ({ repo: x.repo, name: x.name })),
  };
}

// The report as the command prints it: the two tables with their totals, the recent improvements with what each saved, the cache's numbers.
// `total`: the week's sum over its sessions instead of the average per prompt (the page's Total toggle)
export function renderReport(v, { cost = false, total = false } = {}) {
  const L = [], label = t => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  // the average per prompt is the week's sum over its prompts (the priced sessions' prompts in the cost view)
  const avg = (c, w) => { const col = v.columns[w]; return total ? (cost ? c.cost : c.tokens) : cost ? (col.pricedPrompts ? c.cost / col.pricedPrompts : null) : (col.prompts ? c.tokens / col.prompts : null); };
  const fmtv = x => x == null ? '–' : cost ? formatDollars(x) : formatTokens(x);
  const mark = (cells, w) => { const d = w ? change(avg(cells[0], 0), avg(cells[w], w)) : null; return d == null || Math.abs(d) < TREND_MIN ? ' ' : d >= TREND_BIG ? '▲▲' : d > 0 ? '▲' : d <= -TREND_BIG ? '▼▼' : '▼'; };
  const W = 11, line = (name, cells, bold) => `  ${(bold ? name.toUpperCase() : name).slice(0, 30).padEnd(30)}${cells.map((c, w) => (avg(c, w) ? `${fmtv(avg(c, w))}${mark(cells, w)}` : '').padStart(W)).join('')}`;
  const head = `  ${''.padEnd(30)}${v.columns.map(c => `wk ${label(c.t)}`.padStart(W)).join('')}`;
  L.push(`${total ? 'Total' : 'Average'} ${cost ? 'cost' : 'tokens'} ${total ? 'over the week\'s sessions' : 'per prompt (one call to the model)'}, by week (${v.columns.map(c => c.sessions).join(', ')} sessions, ${v.columns.map(c => c.prompts || 0).join(', ')} prompts)${cost ? `, at list prices of ${v.pricedOn}` : ''}`);
  L.push('', 'By part of the context (the four the Find Savings page measures and controls; --json holds the whole breakdown)', head);
  for (const p of v.parts) L.push(line(p.name, p.cells));
  L.push(line('Total of these', v.totals, true));
  L.push('', 'By model', head);
  for (const p of v.providers) { L.push(line(p.name, p.cells, true)); for (const m of v.models.filter(x => x.provider === p.name)) L.push(line(`  ${m.model}${m.priced ? '' : ' (unpriced)'}`, m.cells)); }
  L.push(line('Total (the whole session)', v.sessionTotals, true));
  L.push(`  ▲ ▼: up or down by 5% or more against the first week, doubled past 50%; a zero is left blank. A model row is its share of the ${total ? 'week' : 'average prompt'}; its sessions:` + ` ${v.models.map(m => `${m.model} ${m.cells.map(c => c.sessions).join('/')}`).join(', ')}.`);
  if (v.unpriced.length) L.push(`  No list price for ${v.unpriced.join(', ')}: their sessions are left out of the cost average.`);
  // Recent improvements: the five actions in effect that saved most, each with the cost of the thing it changed a prompt
  // before against since, attributed to it alone, and its pull request
  const pct = x => x.share == null || !Math.round(100 * Math.abs(x.share)) ? '' : ` (${x.delta >= 0 ? '−' : '+'}${Math.round(100 * Math.abs(x.share))}%)`;
  L.push('', 'Recent improvements');
  if (!v.top.length) L.push('  none in effect: what you apply on the Find Savings page is listed here once it is');
  else L.push(`  ${'decided'.padEnd(11)}${'before'.padStart(8)}${'after'.padStart(8)}  ${(total ? 'saved since' : 'saved a prompt').padEnd(22)}${'pull request'.padEnd(14)}change`);
  for (const a of v.top) {
    const f = a.effect, pr = a.pr ? `#${a.pr.number} ${a.pr.state}` : '–';
    // --total: the thing over the prompts since the decision, at the before rate against as it was, and the gap
    const [b, aft, sv] = f ? total ? [f.since.atBefore, f.since.total, f.window] : [f.before.perPrompt, f.after.perPrompt, f.delta] : [];
    const cells = f ? `${formatTokens(b).padStart(8)}${formatTokens(aft).padStart(8)}  ${`${sv >= 0 ? '−' : '+'}${formatTokens(Math.abs(sv))}${pct(f)}${f.few ? ' (few)' : ''}`.padEnd(22)}` : `${'–'.padStart(8)}${'–'.padStart(8)}  ${'measuring'.padEnd(22)}`;
    L.push(`  ${a.at.slice(0, 10).padEnd(11)}${cells}${pr.padEnd(14)}${a.title}${a.repoName ? ` (${a.repoName})` : ''}`);
  }
  if (v.top.length) L.push(total ? '  Before and after: what the changed thing alone cost over the prompts since the decision, at its rate before the decision against as it was; saved is the gap.' : '  Before and after: what the changed thing alone cost a prompt (one call to the model), over the sessions before the decision and since; --total shows it over the prompts since.');
  const c = v.cache;
  L.push('', 'The cache', `  $ saved          ${formatDollars(c.dollarsSaved)}${c.unpricedTokens ? ` (+${formatTokens(c.unpricedTokens)} tokens on unpriced models)` : ''}`, `  tokens saved     ${formatTokens(Math.max(0, c.tokensSaved))} ${c.measured ? 'input tokens, against prompts with the notes withheld' : 'tokens of code the agents did not read'}`, `  cache hits       ${formatTokens(c.hits)} notes served, for ${formatTokens(c.answered)} of ${formatTokens(c.requests)} requests`, `  acted on         ${c.acted == null ? '–' : `${Math.round(100 * c.acted)}%`} of ${formatTokens(c.judged)} servings the sessions were judged on`);
  return L;
}
