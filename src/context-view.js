// Where an agent's context goes here, part by part, with what each part is worth: the sections of the
// instruction file (instruction-value.js), the skills (listed in every session, read in some, and whether a
// session that read one kept its rules: the sampled outcome check, skill-outcome.js), and the other tools loaded
// into every session (MCP servers, plugins, built-in tools: harness.js). One report behind `thinker context` and
// the page's Context tab, so both show the same rows and the same controls: a section is kept or left out of the
// team's file by a pull request (instruction-edit.js), a tool is switched off for the
// repository (`thinker harness --off`), where the harness is on.
import { harnessUsage, harnessAdvice, harnessOn, labelOf, canSwitchOff, MIN_TOKENS, median, setHarnessSettings, switchOffNow, undoHarness } from './harness.js';
import { dietConfig, compressible, COMPRESSIBLE, setDietLevel, levelOf, dietTimeline } from './diet.js';
import { instructionValue, findRepoSessions } from './instruction-value.js';
import { wasteLevel } from './instruction-value.js';
import fs from 'node:fs';
import path from 'node:path';
import { readLog } from './usage.js';
import { toolOutputs, linkRows } from './tool-outputs.js';
import { topChanges } from './context-suggest.js';

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
  // The unit is a prompt, one call to the model, as the Report counts it (report.js): a part sitting in the context is
  // read again by every call, so what it cost over the window is its tokens times the calls of the sessions that
  // carried it (`window`), and `perPrompt` is that over every prompt of the window — what it adds to an average
  // prompt here. A part carried by half the window's calls shows half its size, not its size.
  const promptsOf = s => Math.max(0, s.prompts ?? s.loaded * Math.max(1, calls(s.client)));
  // never fewer than the calls that carried any one part (a report read without the window's own count), so nothing
  // adds more to an average prompt than its own size
  const viewPrompts = Math.max(1, usage.prompts || usage.sessions * Math.max(1, calls('claude')) || 1, ...(usage.sources || []).map(promptsOf));
  log ||= readLog(store);
  const outcomes = skillOutcomes(store, { days, log });
  const src = s => ({
    key: s.key, name: s.name, kind: s.kind, client: s.client || 'claude', scope: s.scope || null, tokens: s.tokens,
    prompts: promptsOf(s), window: s.tokens * promptsOf(s), perPrompt: Math.round(s.tokens * promptsOf(s) / viewPrompts),
    // `usedShare`: of the prompts that carried it, the share that called it (the harness readers' `usedPrompts`); by
    // prompts since 2026-10-25, the owner's ask. `used` of `loaded` sessions stays for the detail
    loaded: s.loaded, used: s.used, usedPrompts: s.usedPrompts ?? s.used, usedShare: promptsOf(s) ? Math.min(1, (s.usedPrompts ?? s.used) / promptsOf(s)) : null, off: Boolean(s.off),
    // what switches it off here (harness.js:switchOffNow with `any` takes the label); `switchSources` turns the
    // harness on for it when it is not
    label: canSwitchOff(s) ? labelOf(s) : null,
    suggested: advice.has(`${s.client || 'claude'}:${s.key}`),
  });
  const rows = usage.sources.filter(s => s.tokens >= MIN_TOKENS || s.kind === 'skill').map(src);
  // a skill as the Context tab shows it: its own text beside its cost, how often sessions read it, its outcome, and
  // the waste flag the instruction sections get (its listing's cost in the sessions that did not read it)
  const skillText = s => { const src = usage.sources.find(x => x.key === s.key && (x.client || 'claude') === s.client); try { return fs.readFileSync(path.join(src?.dir || '', 'SKILL.md'), 'utf8'); } catch { return Object.values(src?.texts || {})[0] || ''; } };
  const unused = r => 1 - (r.usedShare ?? 0);
  let skills = rows.filter(r => r.kind === 'skill').map(r => ({ ...r, outcome: outcomes[r.name] || null, text: skillText(r).slice(0, 4000), wasted: r.off ? 0 : Math.round(r.perPrompt * unused(r)), wastedWindow: r.off ? 0 : Math.round(r.window * unused(r)) }));
  const skillCost = skills.reduce((a, r) => a + (r.off ? 0 : r.perPrompt), 0);
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
    const xs = tools.filter(r => r.group === g), cost = xs.reduce((a, r) => a + (r.off ? 0 : r.perPrompt), 0);
    for (const r of xs) Object.assign(r, { text: Object.values(sourceOf(r)?.texts || {}).join('\n\n').slice(0, 2400), wasted: r.off ? 0 : Math.round(r.perPrompt * unused(r)), wastedWindow: r.off ? 0 : Math.round(r.window * unused(r)) }, wasteLevel({ usedShare: r.usedShare, wasted: r.off ? null : Math.round(r.perPrompt * unused(r)) }, g === 'builtin' ? cost : xs.concat(skills).reduce((a, x) => a + (x.off ? 0 : x.perPrompt), 0)));
  }
  const iv = instructionValue(store, { days, sessions, prompts: viewPrompts });
  // each tool's output measured under each compression setting it ran with (tool-outputs.js:aggregateOutputs, the
  // settings' times from the log: diet.js:dietTimeline), with the level set now (`compression`) and whether thinker can
  // compress it at all; a row measured under another setting than now's is `past`: kept for the comparison, offered
  // no action, and ranked after the current rows
  const diet = dietConfig(store), timeline = dietTimeline(diet, log);
  const outputs = toolOutputs(store, sessions, { levelAt: timeline.levelAt, key: timeline.key });
  outputs.tools = outputs.tools.map(t => { const compression = levelOf(diet, t.name); return { ...t, compressible: compressible(t.name), compression, past: (t.level || null) !== (compression || null), since: t.level ? timeline.since(t.name, t.level) : null }; });
  const instructions = { ...iv };
  const sum = (xs, k) => xs.reduce((a, x) => a + (x.off ? 0 : x[k] || 0), 0);
  const view = {
    days, sessions: usage.sessions, prompts: viewPrompts, harnessOn: on,
    totals: {
      instructions: { tokens: iv.tokens || 0, perPrompt: (iv.sections || []).reduce((a, r) => a + r.perPrompt, 0), window: (iv.sections || []).reduce((a, r) => a + r.window, 0) },
      skills: { tokens: sum(skills, 'tokens'), perPrompt: sum(skills, 'perPrompt'), window: sum(skills, 'window') },
      tools: { tokens: sum(tools, 'tokens'), perPrompt: sum(tools, 'perPrompt'), window: sum(tools, 'window') },
      outputs: { tokens: outputs.tokens, perPrompt: outputs.perPrompt, window: outputs.window, wasted: outputs.wasted, wastedWindow: outputs.wastedWindow },
      // what the person added to the agent, one part: skills, MCP servers, plugins
      custom: (() => { const xs = [...skills, ...tools.filter(r => r.group !== 'builtin')]; return { tokens: sum(xs, 'tokens'), perPrompt: sum(xs, 'perPrompt'), window: sum(xs, 'window'), count: xs.filter(x => !x.off).length }; })(),
      // the tools by kind, as the Context tab's bar and tables split them
      ...Object.fromEntries(Object.keys(TOOL_GROUPS).map(g => { const xs = tools.filter(r => toolGroup(r) === g); return [g, { tokens: sum(xs, 'tokens'), perPrompt: sum(xs, 'perPrompt'), window: sum(xs, 'window'), count: xs.filter(x => !x.off).length }]; })),
    },
    instructions, skills, tools, outputs: { sessions: outputs.sessions, prompts: outputs.prompts, tools: outputs.tools },
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
  // the highest-leverage changes, ranked; the person's decisions take some out (context-suggest.js:currentChanges)
  view.suggestions = topChanges(view, { max: 20 });
  return view;
}

// Every repository's report as one (the Context tab's "All repositories"): the timeline and the instruction
// sections side by side (each section names its repository), the tools merged by name across repositories (counts
// summed, sizes and costs weighted by the sessions behind them), averages weighted by sessions. A merged skill or tool
// names the repositories it came from (`repoIds`) and keeps a switch label where any of them has one, so the page's All
// can switch it off in each of those repositories as the installer's terminal picker does (context-machine.js:
// machineChanges); the switch itself is made per repository, by the row's key in that repository's own report.
export function mergeViews(list) {
  list = list.filter(x => x.view && x.view.sessions + (x.view.instructions?.sessions || 0) > 0);
  const w = (xs, k, by) => { const n = xs.reduce((a, x) => a + (x[by] || 0), 0); return n ? xs.reduce((a, x) => a + (x[k] || 0) * (x[by] || 0), 0) / n : 0; };
  const merge = (rows, key, by, sums, avgs) => {
    const m = new Map();
    for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.values()].map(g => ({
      ...g[0], ...Object.fromEntries(sums.map(k => [k, g.reduce((a, x) => a + (x[k] || 0), 0)])), ...Object.fromEntries(avgs.map(k => [k, Math.round(w(g, k, by))])),
      // one repository's row keeps its repository; a merged row names them all and belongs to none
      repo: g.length === 1 ? g[0].repo ?? null : null, repoName: g.length === 1 ? g[0].repoName ?? null : null, repoIds: g.map(x => x.repo).filter(Boolean),
      label: g.find(x => x.label)?.label || null, repos: g.length,
    }));
  };
  const views = list.map(x => x.view), sessions = views.reduce((a, v) => a + v.sessions, 0);
  // every repository's prompts together: a merged row's cost over the window is the sum of its repositories' and what
  // it adds to an average prompt is that over all of them, so no figure is a repository's own weighted by another's
  const prompts = Math.max(1, views.reduce((a, v) => a + (v.prompts || 0), 0));
  const tag = x => r => ({ ...r, repo: x.repo, repoName: x.name });
  // a merged skill's or tool's use, waste and pill are made again from the merged figures: kept from the first
  // repository's row (as `...g[0]` leaves them). The costs are sums now (the calls that carried it, and its tokens in
  // each), so nothing is one repository's figure weighted by another's, as it was until 2026-10-25.
  const reuse = r => { const share = r.prompts ? Math.min(1, (r.usedPrompts || 0) / r.prompts) : null, perPrompt = Math.round(r.window / prompts);
    return { ...r, usedShare: share, perPrompt, wasted: r.off ? 0 : Math.round(perPrompt * (1 - (share || 0))), wastedWindow: r.off ? 0 : Math.round(r.window * (1 - (share || 0))) }; };
  const graded = (xs, cost) => xs.map(r => ({ ...r, ...wasteLevel({ usedShare: r.usedShare, wasted: r.off ? null : r.wasted }, cost) }));
  const liveCost = xs => xs.reduce((a, x) => a + (x.off ? 0 : x.perPrompt), 0);
  const tools0 = merge(list.flatMap(x => x.view.tools.map(tag(x))), r => `${r.client}:${r.key}`, 'loaded', ['loaded', 'used', 'usedPrompts', 'prompts', 'window'], ['tokens']).map(reuse).sort((a, b) => b.window - a.window);
  const skills0 = merge(list.flatMap(x => x.view.skills.map(tag(x))), r => `${r.client}:${r.key}`, 'loaded', ['loaded', 'used', 'usedPrompts', 'prompts', 'window'], ['tokens']).map(reuse);
  const skills = graded(skills0, liveCost(skills0));
  // as contextView grades them: built-in tools against their own cost, the custom tools against every custom tool's and skill's
  const tools = tools0.map(r => ({ ...r, ...wasteLevel({ usedShare: r.usedShare, wasted: r.off ? null : r.wasted }, r.group === 'builtin' ? liveCost(tools0.filter(x => x.group === 'builtin')) : liveCost(tools0.filter(x => x.group !== 'builtin').concat(skills))) }));
  // A tool's rows merged by tool, setting, and whether that setting is the one the repository has now: a row measured
  // under an earlier setting is a dead period, what it cost unrecoverable and no action left on it, so it is never
  // merged with a repository where the same setting is live. Grouping on the name and level alone (and taking the row
  // as past only where every repository called it past, until 2026-10-26) put the month before `mcp:artemis` was
  // compressed here in with the months of repositories that never compressed it: the merged row came out live, and the
  // machine's top output suggestion was 33M of savings on a tool already compressed, the action offered being to
  // uncompress it. The rows of one tool are linked again over the merged figures.
  const allOuts = views.flatMap(v => v.outputs.tools), span = (xs, f) => { const ts = xs.filter(Number.isFinite); return ts.length ? f(...ts) : null; };
  const outKey = r => `${r.key || `${r.name}@${r.level || ''}`}|${r.past ? 'past' : 'live'}`;
  const outs = linkRows(merge(allOuts, outKey, 'sessions', ['usedIn', 'sessions', 'prompts', 'window', 'wastedWindow', 'saveModerateWindow'], ['tokens', 'perCall'])
    .map(t => { const g = allOuts.filter(x => outKey(x) === outKey(t)), pr = Math.max(1, t.prompts);
      // the merged row's unit is its own prompts (the setting's period in each repository), as one repository's row is
      return { ...t, perPrompt: Math.round(t.window / pr), wasted: Math.round(t.wastedWindow / pr), needed: t.window ? Math.max(0, t.window - t.wastedWindow) / t.window : null, saveModerate: Math.round(t.saveModerateWindow / pr),
        // every row of the group agrees on this by construction (outKey), and a live row's setting is its own level,
        // so the action offered and the saving beside it are the same thing in every repository the row covers
        calls: w(g, 'calls', 'sessions'), past: Boolean(t.past), compression: t.past ? (t.compression ?? null) : (t.level || null),
        from: span(g.map(x => x.from), Math.min), to: span(g.map(x => x.to), Math.max) }; }))
    .sort((a, b) => b.window - a.window);
  const ivs = list.map(x => ({ x, iv: x.view.instructions })).filter(({ iv }) => iv.file);
  const ivSessions = ivs.reduce((a, { iv }) => a + iv.sessions, 0);
  const window = ivs.reduce((a, { iv }) => a + (iv.savings?.window || 0), 0);
  // each section over the calls that read its present text (a section changed inside the window counts from then)
  const fileWindow = ivs.reduce((a, { iv }) => a + iv.sections.reduce((s, r) => s + (r.window || 0), 0), 0);
  const total = k => { const win = views.reduce((a, v) => a + (v.totals[k]?.window || 0), 0);
    return { tokens: Math.round(w(views.map(v => ({ ...v.totals[k], s: v.sessions })), 'tokens', 's')), window: win, perPrompt: Math.round(win / prompts), count: Math.max(0, ...views.map(v => v.totals[k]?.count || 0)) }; };
  return {
    all: true, days: views[0]?.days || 30, sessions, prompts, harnessOn: false, repos: list.map(x => ({ repo: x.repo, name: x.name, sessions: x.view.sessions })),
    totals: Object.fromEntries(Object.keys(views[0]?.totals || {}).map(k => [k, total(k)])),
    instructions: {
      all: true, file: ivs.length ? `${ivs.length} instruction file${ivs.length === 1 ? '' : 's'}` : null, sessions: ivSessions,
      judged: ivs.reduce((a, { iv }) => a + iv.judged, 0), calls: Math.round(w(ivs.map(({ iv }) => iv), 'calls', 'sessions')), judge: ivs[0]?.iv.judge || { judge: false, share: 0 },
      // a section's cost over the window is its own; what it adds to an average prompt is read against every
      // repository's prompts here, not its own repository's, so the rows of all of them compare
      sections: ivs.flatMap(({ x, iv }) => iv.sections.map(tag(x))).map(r => { const perPrompt = Math.round((r.window || 0) / prompts);
        return { ...r, perPrompt, wasted: r.usedShare == null ? null : Math.round(perPrompt * (1 - r.usedShare)) }; }),
      savings: { window, perPrompt: Math.round(window / prompts), share: fileWindow ? window / fileWindow : 0, sections: ivs.reduce((a, { iv }) => a + (iv.savings?.sections || 0), 0) },
    },
    skills, tools, outputs: { sessions: views.reduce((a, v) => a + v.outputs.sessions, 0), prompts: views.reduce((a, v) => a + (v.outputs?.prompts || 0), 0), tools: outs },
    timeline: views.flatMap(v => v.timeline).sort((a, b) => a.t - b.t),
    // each repository's own, ranked together (a change is made in its repository)
    suggestions: list.flatMap(x => (x.view.suggestions || []).map(c => ({ ...c, repo: x.repo, repoName: x.name }))).sort((a, b) => b.saving - a.saving),
  };
}

// The Context tab's actions on tools, as the command line takes them (`thinker context --switch-off|--switch-on`,
// `--output-compression <tools> --level high|moderate|off`). Switching off is the person's choice made there, so
// it turns on what it needs in this repository: the harness, and built-in tool switching for a built-in tool.
export function switchSources(store, { labels = [], keys = [], on = false, builtin = false, global = false } = {}) {
  if (on) return undoHarness(store, { names: keys });
  if (!labels.length) return 'nothing chosen';
  setHarnessSettings(store, { enabled: true, ...(builtin ? { builtinTools: true } : {}) });
  return switchOffNow(store, labels.join(','), { via: 'context', any: true, global });
}
export function setOutputCompression(store, tools, level) {
  const can = tools.filter(compressible), cannot = tools.filter(t => !compressible(t));
  const now = setDietLevel(store, can, level === 'off' ? null : level);
  const mcpAtHigh = level === 'high' ? can.filter(t => t.startsWith('mcp:')) : [];
  return `${can.length ? `${level === 'off' ? 'Compression off' : `${level === 'high' ? 'High' : 'Moderate'} compression`} for ${can.join(', ')} in Claude Code sessions from the next tool call.` : ''}${mcpAtHigh.length ? ` An MCP server takes moderate only (${mcpAtHigh.join(', ')}): a tighter cap cuts what the agent uses from its results.` : ''}${cannot.length ? ` thinker cannot compress ${cannot.join(', ')} yet (Bash commands, Read and MCP servers).` : ''}`.trim() || JSON.stringify(now);
}
