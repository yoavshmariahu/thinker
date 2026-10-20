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
import { readLog } from './usage.js';

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
  const skills = rows.filter(r => r.kind === 'skill').map(r => ({ ...r, outcome: outcomes[r.name] || null }));
  // skills of a plugin are one row in the harness report (one switch): their outcomes are summed onto it
  const tools = rows.filter(r => r.kind !== 'skill').map(r => ({ ...r, group: toolGroup(r) })).map(r => {
    const members = usage.sources.find(s => s.key === r.key && (s.client || 'claude') === r.client)?.skills || [];
    const os = members.map(m => outcomes[m]).filter(Boolean);
    if (!os.length) return r;
    const sum = k => os.reduce((a, o) => a + o[k], 0), read = sum('read');
    return { ...r, skills: members, outcome: { checked: sum('checked'), read, brokenAfterRead: sum('brokenAfterRead'), missed: sum('missed'), success: read ? (read - Math.min(read, sum('brokenAfterRead'))) / read : null } };
  });
  const iv = instructionValue(store, { days, sessions });
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
      // the tools by kind, as the Context tab's bar and tables split them
      ...Object.fromEntries(Object.keys(TOOL_GROUPS).map(g => { const xs = tools.filter(r => toolGroup(r) === g); return [g, { tokens: sum(xs, 'tokens'), perSession: sum(xs, 'perSession'), count: xs.filter(x => !x.off).length }]; })),
    },
    instructions, skills, tools,
    // one row per session, for the trend: its input tokens by part (tokens a call × its model calls); the instruction
    // file and the loaded tools come from different readers, so a session may have one side only
    timeline: [
      ...iv.timeline.map(r => ({ t: r.t, instructions: r.tokens * r.calls })),
      ...(usage.timeline || []).map(r => ({ t: r.t, ...Object.fromEntries(Object.entries(r.parts).map(([k, n]) => [k, n * Math.max(1, r.calls)])) })),
    ].sort((a, b) => a.t - b.t),
  };
}
