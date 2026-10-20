// Where an agent's context goes here, part by part, with what each part is worth: the sections of the
// instruction file (instruction-value.js), the skills (listed in every session, read in some, and whether a
// session that read one kept its rules: the sampled outcome check, skill-outcome.js), and the other tools loaded
// into every session (MCP servers, plugins, built-in tools: harness.js). One report behind `thinker context` and
// the page's Context tab, so both show the same rows and the same controls: a section is kept or left out of the
// checkout's trimmed copy (`thinker instructions --core`, instructions-core.js), a tool is switched off for the
// repository (`thinker harness --off`), where the harness is on.
import { harnessUsage, harnessAdvice, harnessOn, labelOf, switchable, MIN_TOKENS, median } from './harness.js';
import { instructionValue, findRepoSessions } from './instruction-value.js';
import { coreConfig } from './instructions-core.js';
import { wasteLevel } from './instruction-value.js';
import fs from 'node:fs';
import path from 'node:path';
import { readLog } from './usage.js';
import { toolOutputs } from './tool-outputs.js';

// The skills' outcome checks over the window, per skill: sessions checked where it applied, read in, broken after
// being read, and broken without being read (missed).
export function skillOutcomes(store, { days = 30, now = Date.now(), log } = {}) {
  const since = now - days * 86400_000, out = new Map();
  const row = n => { if (!out.has(n)) out.set(n, { checked: 0, read: 0, brokenAfterRead: 0, missed: 0 }); return out.get(n); };
  for (const e of log || readLog(store)) {
    if (e.op !== 'skill-outcome' || !Array.isArray(e.skills) || Date.parse(e.t) < since) continue;
    const read = new Set(e.read || []);
    for (const n of e.skills) { const r = row(n); r.checked++; if (read.has(n)) r.read++; }
    for (const c of e.credited || []) { const r = row(c.skill); if (c.verdict === 'broken-after-read') r.brokenAfterRead++; else if (c.verdict === 'missed') r.missed++; }
  }
  // success: of the checked sessions that read the skill, the share that kept its rules; null with `read` missing
  // from the log lines (written before it was recorded) or none read
  return Object.fromEntries([...out].map(([n, r]) => [n, { ...r, success: r.read ? (r.read - Math.min(r.read, r.brokenAfterRead)) / r.read : null }]));
}

// The kinds of tool a session loads, in the order the report shows them.
// The desktop app's own entries (starting other sessions, sending files) are the agent's tools too: built-in.
export const TOOL_GROUPS = { mcp: 'MCP servers', plugins: 'Plugins', builtin: 'Built-in tools' };
export const toolGroup = s => s.kind === 'mcp' || s.kind === 'connector' ? 'mcp' : s.kind === 'plugin' ? 'plugins' : 'builtin';

export function contextView(store, { days = 30, sessions, usage, log } = {}) {
  sessions ??= findRepoSessions(store.repo, days);
  usage ??= harnessUsage(store.repo, { days, sessions });
  const on = harnessOn(store);
  const advice = new Set(harnessAdvice(usage).map(s => `${s.client || 'claude'}:${s.key}`));
  const calls = c => usage.calls?.[c || 'claude'] || median(Object.values(usage.calls || {})) || 1;
  const outcomes = skillOutcomes(store, { days, log });
  const src = s => ({
    key: s.key, name: s.name, kind: s.kind, client: s.client || 'claude', scope: s.scope || null, tokens: s.tokens, perSession: s.tokens * Math.max(1, calls(s.client)),
    loaded: s.loaded, used: s.used, usedShare: s.loaded ? s.used / s.loaded : null, off: Boolean(s.off),
    // what switches it off here, when the harness may (harness.js:switchOffNow with `any` takes the label)
    label: on && switchable(s, usage) ? labelOf(s) : null,
    suggested: advice.has(`${s.client || 'claude'}:${s.key}`),
  });
  const rows = usage.sources.filter(s => s.tokens >= MIN_TOKENS || s.kind === 'skill').map(src);
  // a skill as the Context tab shows it: its own text beside its cost, how often sessions read it, its outcome, and
  // the waste flag the instruction sections get (its listing's cost in the sessions that did not read it)
  const skillText = s => { const src = usage.sources.find(x => x.key === s.key && (x.client || 'claude') === s.client); try { return fs.readFileSync(path.join(src?.dir || '', 'SKILL.md'), 'utf8'); } catch { return Object.values(src?.texts || {})[0] || ''; } };
  let skills = rows.filter(r => r.kind === 'skill').map(r => ({ ...r, outcome: outcomes[r.name] || null, text: skillText(r).slice(0, 4000), wasted: r.off ? 0 : Math.round(r.perSession * (1 - (r.usedShare ?? 0))) }));
  const skillCost = skills.reduce((a, r) => a + (r.off ? 0 : r.perSession), 0);
  skills = skills.map(r => ({ ...r, ...wasteLevel(r, skillCost) }));
  // skills of a plugin are one row in the harness report (one switch): their outcomes are summed onto it
  const tools = rows.filter(r => r.kind !== 'skill').map(r => ({ ...r, group: toolGroup(r) })).map(r => {
    const members = usage.sources.find(s => s.key === r.key && (s.client || 'claude') === r.client)?.skills || [];
    const os = members.map(m => outcomes[m]).filter(Boolean);
    if (!os.length) return r;
    const sum = k => os.reduce((a, o) => a + o[k], 0), read = sum('read');
    return { ...r, skills: members, outcome: { checked: sum('checked'), read, brokenAfterRead: sum('brokenAfterRead'), missed: sum('missed'), success: read ? (read - Math.min(read, sum('brokenAfterRead'))) / read : null } };
  });
  // each tool's description (what its listing or definition said) and its waste within its kind, for its card
  const sourceOf = r => usage.sources.find(x => x.key === r.key && (x.client || 'claude') === r.client);
  for (const g of ['mcp', 'plugins', 'builtin']) {
    const xs = tools.filter(r => r.group === g), cost = xs.reduce((a, r) => a + (r.off ? 0 : r.perSession), 0);
    for (const r of xs) Object.assign(r, { text: Object.values(sourceOf(r)?.texts || {}).join('\n\n').slice(0, 2400), wasted: r.off ? 0 : Math.round(r.perSession * (1 - (r.usedShare ?? 0))) }, wasteLevel({ usedShare: r.usedShare, wasted: r.off ? null : Math.round(r.perSession * (1 - (r.usedShare ?? 0))) }, g === 'builtin' ? cost : xs.concat(skills).reduce((a, x) => a + (x.off ? 0 : x.perSession), 0)));
  }
  const iv = instructionValue(store, { days, sessions });
  const outputs = toolOutputs(store, sessions);
  const core = coreConfig(store), kept = new Set(core.keep.map(k => k.toLowerCase()));
  const instructions = {
    ...iv, coreOn: core.enabled,
    sections: iv.sections.map(s => ({ ...s, kept: kept.has(s.title.toLowerCase()) || (s.parent && kept.has(`${s.parent}: ${s.title}`.toLowerCase())) })),
  };
  const sum = (xs, k) => xs.reduce((a, x) => a + (x.off ? 0 : x[k] || 0), 0);
  return {
    days, sessions: usage.sessions, harnessOn: on,
    totals: {
      instructions: { tokens: iv.tokens || 0, perSession: (iv.tokens || 0) * Math.max(1, iv.calls || 1) },
      skills: { tokens: sum(skills, 'tokens'), perSession: sum(skills, 'perSession') },
      tools: { tokens: sum(tools, 'tokens'), perSession: sum(tools, 'perSession') },
      outputs: { tokens: outputs.tokens, perSession: outputs.perSession },
      // what the person added to the agent, one part: skills, MCP servers, plugins
      custom: (() => { const xs = [...skills, ...tools.filter(r => r.group !== 'builtin')]; return { tokens: sum(xs, 'tokens'), perSession: sum(xs, 'perSession'), count: xs.filter(x => !x.off).length }; })(),
      // the tools by kind, as the Context tab's bar and tables split them
      ...Object.fromEntries(Object.keys(TOOL_GROUPS).map(g => { const xs = tools.filter(r => toolGroup(r) === g); return [g, { tokens: sum(xs, 'tokens'), perSession: sum(xs, 'perSession'), count: xs.filter(x => !x.off).length }]; })),
    },
    instructions, skills, tools, outputs: { sessions: outputs.sessions, tools: outputs.tools },
    // one row per session, for the trend: its input tokens by part (tokens a call × its model calls); the instruction
    // file and the loaded tools come from different readers, so a session may have one side only
    timeline: [
      ...iv.timeline.map(r => ({ t: r.t, instructions: r.tokens * r.calls })),
      ...outputs.timeline,
      ...(usage.timeline || []).map(r => {
        const c = Math.max(1, r.calls), p = r.parts;
        return { t: r.t, custom: ((p.skills || 0) + (p.mcp || 0) + (p.plugins || 0)) * c, builtin: (p.builtin || 0) * c };
      }),
    ].sort((a, b) => a.t - b.t),
  };
}

// Every repository's report as one (the Context tab's "All repositories"): the timeline and the instruction
// sections side by side (each section names its repository), the tools merged by name across repositories (counts
// summed, sizes and costs weighted by the sessions behind them), averages weighted by sessions. No switches: those
// belong to one repository.
export function mergeViews(list) {
  list = list.filter(x => x.view && x.view.sessions + (x.view.instructions?.sessions || 0) > 0);
  const w = (xs, k, by) => { const n = xs.reduce((a, x) => a + (x[by] || 0), 0); return n ? xs.reduce((a, x) => a + (x[k] || 0) * (x[by] || 0), 0) / n : 0; };
  const merge = (rows, key, by, sums, avgs) => {
    const m = new Map();
    for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.values()].map(g => ({ ...g[0], ...Object.fromEntries(sums.map(k => [k, g.reduce((a, x) => a + (x[k] || 0), 0)])), ...Object.fromEntries(avgs.map(k => [k, Math.round(w(g, k, by))])), label: null, repos: g.length }));
  };
  const views = list.map(x => x.view), sessions = views.reduce((a, v) => a + v.sessions, 0);
  const tag = x => r => ({ ...r, repo: x.repo, repoName: x.name });
  const tools = merge(views.flatMap(v => v.tools), r => `${r.client}:${r.key}`, 'loaded', ['loaded', 'used'], ['tokens', 'perSession']).map(r => ({ ...r, usedShare: r.loaded ? r.used / r.loaded : null })).sort((a, b) => b.perSession - a.perSession);
  const skills = merge(views.flatMap(v => v.skills), r => `${r.client}:${r.key}`, 'loaded', ['loaded', 'used'], ['tokens', 'perSession']);
  const outs = merge(views.flatMap(v => v.outputs.tools.map(t => ({ ...t, n: v.outputs.sessions }))), r => r.name, 'n', ['usedIn', 'n'], ['tokens', 'perSession', 'perCall']).map(t => ({ ...t, calls: w(views.flatMap(v => v.outputs.tools.filter(x => x.name === t.name).map(x => ({ ...x, n: v.outputs.sessions }))), 'calls', 'n') })).sort((a, b) => b.perSession - a.perSession);
  const ivs = list.map(x => ({ x, iv: x.view.instructions })).filter(({ iv }) => iv.file);
  const ivSessions = ivs.reduce((a, { iv }) => a + iv.sessions, 0);
  const window = ivs.reduce((a, { iv }) => a + (iv.savings?.window || 0), 0);
  const fileWindow = ivs.reduce((a, { iv }) => a + iv.sections.reduce((s, r) => s + r.perSession, 0) * iv.sessions, 0);
  const total = k => ({ tokens: Math.round(w(views.map(v => ({ ...v.totals[k], s: v.sessions })), 'tokens', 's')), perSession: Math.round(w(views.map(v => ({ ...v.totals[k], s: v.sessions })), 'perSession', 's')), count: Math.max(0, ...views.map(v => v.totals[k]?.count || 0)) });
  return {
    all: true, days: views[0]?.days || 30, sessions, harnessOn: false, repos: list.map(x => ({ repo: x.repo, name: x.name, sessions: x.view.sessions })),
    totals: Object.fromEntries(Object.keys(views[0]?.totals || {}).map(k => [k, total(k)])),
    instructions: {
      all: true, file: ivs.length ? `${ivs.length} instruction file${ivs.length === 1 ? '' : 's'}` : null, sessions: ivSessions,
      judged: ivs.reduce((a, { iv }) => a + iv.judged, 0), calls: Math.round(w(ivs.map(({ iv }) => iv), 'calls', 'sessions')), judge: ivs[0]?.iv.judge || { judge: false, share: 0 }, coreOn: false,
      sections: ivs.flatMap(({ x, iv }) => iv.sections.map(tag(x))),
      savings: { window, perSession: ivSessions ? Math.round(window / ivSessions) : 0, share: fileWindow ? window / fileWindow : 0, sections: ivs.reduce((a, { iv }) => a + (iv.savings?.sections || 0), 0) },
    },
    skills, tools, outputs: { sessions: views.reduce((a, v) => a + v.outputs.sessions, 0), tools: outs },
    timeline: views.flatMap(v => v.timeline).sort((a, b) => a.t - b.t),
  };
}
