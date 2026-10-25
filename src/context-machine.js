// The machine's Context report, for the installer and `thinker context --machine`: where the agents' context goes
// across the repositories they worked in lately, and what to cut first. No cache and no model call: the report
// is read from the agents' own transcripts (context-view.js:contextView), so it is there the minute thinker is
// installed, from the sessions that ran before it. Each repository's report is kept as the page's snapshot
// (context-snapshot.js) and the checkouts as the page's list, so `thinker ui` opens on the same figures at once.
import { discoverRepos } from './machine.js';
import { Store } from './store.js';
import { contextView, mergeViews } from './context-view.js';
import { writeSnapshot, SNAPSHOT_DAYS } from './context-snapshot.js';
import { refreshCheckouts } from './ui/server.js';
import { wasteLevel } from './instruction-value.js';
import { formatTokens } from './model-usage.js';
import { thinkerHome } from './update.js';
import { allChanges, approveChanges, ACTS } from './context-suggest.js';

// the most active repositories read on an install: each one takes a second or four
export const MACHINE_REPOS = 5;
// suggestions printed
export const MACHINE_TOP = 5;

// The repositories the agents worked in over the window, the most active first (by transcripts), each one's
// report made and kept, and all of them merged as the page's "All repositories". A repository without a cache
// gets one (every git repository has one from its first session anyway; it is kept out of git status). One that
// fails to read is named in `skipped`. `home`: where the agents' transcripts are (tests name one).
export function machineContext(store, { home, days = 30, limit = MACHINE_REPOS, now = Date.now(), onRepo, thinkerHome: th = thinkerHome() } = {}) {
  let found = []; try { found = discoverRepos(store, { home, now }); } catch {}
  const active = found.filter(r => !r.disabled && r.sessions > 0).sort((a, b) => b.sessions - a.sessions || (Date.parse(b.lastUsed) || 0) - (Date.parse(a.lastUsed) || 0));
  const repos = [], views = [], skipped = [];
  for (const r of active.slice(0, limit)) {
    try {
      const st = new Store(r.checkout);
      if (!st.exists()) st.init();
      let view = null;
      for (const d of new Set([...SNAPSHOT_DAYS, days])) { const v = contextView(st, { days: d }); writeSnapshot(st, d, v, { now }); if (d === days) view = v; }
      // the sessions read: the harness reader counts those with a tool listing, the instruction reader every transcript
      repos.push({ id: r.id, name: r.name, checkout: r.checkout, sessions: Math.max(view.sessions || 0, view.instructions?.sessions || 0), transcripts: r.sessions });
      views.push({ repo: r.id, name: r.name, checkout: r.checkout, view });
      onRepo?.(repos[repos.length - 1]);
    } catch (e) { skipped.push({ name: r.name, checkout: r.checkout, error: String(e?.message || e).split('\n')[0] }); }
  }
  // the page's repository list, so it opens on these without looking again (ui/server.js:keptCheckouts)
  try { if (repos.length) refreshCheckouts(store, { home: th, transcriptsHome: home, now }); } catch {}
  const view = views.length ? mergeViews(views) : null;
  // `views`: each repository's own report beside the merged one, for the picker (machineChanges): a change is made
  // in its repository, and a merged row has lost the label the switch-off needs
  return { days, repos, skipped, more: Math.max(0, active.length - limit), view, views };
}

// What to cut first: the parts of the context the sessions did not use, costliest first. The same flag the
// Context tab shows on each row (instruction-value.js:wasteLevel): a section, skill or tool whose cost in the
// sessions that did not use it is a share of its kind's (5% high, 2% medium). `wasted` is that cost,
// tokens a prompt (one model call), and the saving at most. Sections carry the free signal only (applied by their triggers, or
// judged where sessions were); a section naming no file or command is unknown and not listed.
export function recommendations(view, { top = MACHINE_TOP } = {}) {
  if (!view) return { items: [], flagged: 0, potential: 0 };
  const items = [];
  for (const s of view.instructions?.sections || []) {
    if (s.waste !== 'high' && s.waste !== 'medium') continue;
    // the share is the judge's (followed of judged) once enough sessions are judged, else the triggers' (applied of all)
    const judge = s.usedBy === 'judge';
    items.push({ kind: 'section', id: s.id, title: `${s.parent ? `${s.parent}: ` : ''}${s.title}`, file: s.file, repo: s.repoName || null, repoId: s.repo || null, perPrompt: s.perPrompt, wasted: s.wasted, usedShare: s.usedShare, used: judge ? s.followed : s.applied, of: judge ? s.judged : s.sessions, by: judge ? 'judge' : 'triggers' });
  }
  // skills and tools: in a merged view `usedShare` is the sum over repositories and `wasted` the first one's, so
  // both are made again here, against the kind's cost as contextView does (skills; built-in tools; the custom
  // tools together)
  const rows = (xs, kind) => {
    const cost = xs.reduce((a, r) => a + (r.off ? 0 : r.perPrompt), 0);
    for (const r of xs) {
      if (r.off || r.usedShare == null) continue;
      const wasted = Math.round(r.perPrompt * (1 - r.usedShare));
      const { waste } = wasteLevel({ usedShare: r.usedShare, wasted }, cost);
      if (waste !== 'high' && waste !== 'medium') continue;
      items.push({ kind, group: r.group || null, key: r.key, title: r.name, client: r.client, repo: r.repoName || null, repos: r.repos || null, label: r.label || null, perPrompt: r.perPrompt, wasted, usedShare: r.usedShare, used: r.used, of: r.loaded, by: kind === 'skill' ? 'read' : 'called' });
    }
  };
  const skills = view.skills || [], tools = view.tools || [];
  rows(skills, 'skill');
  rows(tools.filter(t => t.group === 'builtin'), 'tool');
  const custom = tools.filter(t => t.group !== 'builtin');
  if (custom.length) {
    // against what every custom tool costs, skills included, as the tab does
    const cost = [...custom, ...skills].reduce((a, r) => a + (r.off ? 0 : r.perPrompt), 0);
    for (const r of custom) {
      if (r.off || r.usedShare == null) continue;
      const wasted = Math.round(r.perPrompt * (1 - r.usedShare));
      const { waste } = wasteLevel({ usedShare: r.usedShare, wasted }, cost);
      if (waste === 'high' || waste === 'medium') items.push({ kind: 'tool', group: r.group, key: r.key, title: r.name, client: r.client, repo: r.repoName || null, repos: r.repos || null, label: r.label || null, perPrompt: r.perPrompt, wasted, usedShare: r.usedShare, used: r.used, of: r.loaded, by: 'called' });
    }
  }
  items.sort((a, b) => b.wasted - a.wasted || b.perPrompt - a.perPrompt);
  return { items: items.slice(0, top), flagged: items.length, potential: items.reduce((a, x) => a + x.wasted, 0) };
}

// The action a suggestion proposes, and the key of the Context tab's row it acts on (context-suggest.js:allChanges):
// a section is removed when its triggers fired in none of the sessions (nothing touched its files, commands or code)
// and compressed otherwise, the judge's verdicts included: a rule followed in few of the sessions it bore on is still
// a rule; a skill or tool is switched off. Shared by the installer's picker (machineChanges) and the page the
// installer opens, which comes with these rows checked (suggestedPicks; ui/server.js /api/context `suggested`).
export const suggestedAct = x => x.kind === 'section' ? (x.by === 'triggers' && x.used === 0 && x.of > 0 ? 'remove' : 'compress') : 'off';
export const suggestedKey = x => x.kind === 'section' ? `section:${x.file}:${x.id}` : `${x.client}:${x.key}`;
// the suggestions as the rows to pre-check on the page opened by the installer (page.html:preselectRows): the row's
// key, its repository (a section's; a skill or tool is a merged row in All) and the action to pick
export function suggestedPicks(view, { top = MACHINE_TOP } = {}) {
  return recommendations(view, { top }).items.map(x => ({ kind: x.kind, key: suggestedKey(x), repo: x.repoId || null, act: suggestedAct(x) }));
}

const what = { section: 'section', skill: 'skill', tool: 'tool' };
const groupName = { mcp: 'MCP server', plugins: 'plugin', builtin: 'built-in tool' };
// one suggestion as a line: what it is, where, what it costs a prompt, how often it was used
export function recommendationLine(x) {
  const where = x.repo ? ` (${x.repo})` : x.repos > 1 ? ` (${x.repos} repositories)` : '';
  const kind = x.kind === 'section' ? `${x.file || 'AGENTS.md'} section` : x.kind === 'tool' ? groupName[x.group] || 'tool' : what[x.kind];
  const client = x.client && x.client !== 'claude' ? `${x.client} ` : '';
  const share = x.usedShare ?? (x.of ? x.used / x.of : null), use = share != null ? `needed in ${Math.round(100 * share)}% of prompts` : 'use unknown';
  return `${client}${kind} "${x.title}"${where}: ~${formatTokens(x.wasted)} tokens a prompt spent where it was not used (${use})`;
}

// The report as the installer and `thinker context --machine` print it: the parts of the context per model
// call and per session (the summary), then the suggestions, then where to review and apply them. `actions: false`
// leaves that last line out: the installer's picker (setup/context-ask.js) offers the actions itself and names the
// page instead of commands.
export function renderMachineReport(r, recs, { actions = true } = {}) {
  return [...renderMachineSummary(r), ...renderMachineCuts(r, recs, { actions })];
}
export function renderMachineSummary({ days, repos, skipped = [], more = 0, view }) {
  const lines = [];
  if (!view) {
    lines.push(`No agent sessions on this machine in the last ${days} days to read; the Context report fills in as you work (thinker ui).`);
    for (const s of skipped) lines.push(`  ${s.name}: could not be read (${s.error})`);
    return lines;
  }
  const t = view.totals, sessions = repos.reduce((a, r) => a + r.sessions, 0);
  const names = repos.map(r => `${r.name} (${r.sessions})`).join(', ');
  lines.push(`Where your agents' context goes, from ${sessions} session${sessions === 1 ? '' : 's'} of the last ${days} days in ${names}${more ? ` and ${more} more repositor${more === 1 ? 'y' : 'ies'} not read` : ''}:`);
  lines.push(`  in every model call: instruction files ~${formatTokens(t.instructions.tokens)} tokens, skills and MCP servers ~${formatTokens(t.custom.tokens)}, built-in tools ~${formatTokens(t.builtin?.tokens || 0)}`);
  lines.push(`  a prompt, one call to the model: instruction files ~${formatTokens(t.instructions.perPrompt)}, skills and MCP servers ~${formatTokens(t.custom.perPrompt)}, built-in tools ~${formatTokens(t.builtin?.perPrompt || 0)}, tool outputs ~${formatTokens(t.outputs.perPrompt)} (an estimate)`);
  for (const s of skipped) lines.push(`  ${s.name}: could not be read (${s.error})`);
  return lines;
}
export function renderMachineCuts({ view }, recs, { actions = true } = {}) {
  if (!view) return [];
  const lines = [];
  if (!recs.items.length) {
    lines.push('Nothing to cut yet: every section, skill and tool whose use can be told was used in most sessions, or there are too few sessions to say.');
  } else {
    lines.push(`Cut first (what the sessions did not use, costliest first; the saving is at most the figure shown):`);
    recs.items.forEach((x, i) => lines.push(`  ${i + 1}. ${recommendationLine(x)}`));
    const shown = recs.items.reduce((a, x) => a + x.wasted, 0);
    lines.push(`  about ~${formatTokens(shown)} tokens a prompt in these ${recs.items.length}${recs.flagged > recs.items.length ? `, ~${formatTokens(recs.potential)} over all ${recs.flagged} flagged` : ''}.`);
  }
  if (actions) lines.push(`Review and apply in the browser: thinker ui (Context${view.all ? ', All repositories' : ''}). By hand: thinker instructions --remove|--compress <section>${view.all ? ' in the repository' : ''}; thinker harness --off "<skill or tool>".`);
  return lines;
}

// The suggestions as the installer's picker offers them (setup/context-ask.js): each one resolved to the change the
// Context tab's row would make (context-suggest.js:allChanges) in the repository it belongs to, with the action
// proposed (suggestedAct, suggestedKey above). A merged row applies to every repository read, as the page's All does. A suggestion nothing can act on (a tool no setting switches off) comes back with no `targets`: the
// picker shows it, disabled, so the list matches the report.
export function machineChanges({ views = [] }, recs) {
  const repos = views.map(x => ({ ...x, changes: allChanges(x.view) }));
  const picks = [];
  for (const x of recs.items || []) {
    const act = suggestedAct(x), key = suggestedKey(x);
    const targets = [];
    for (const v of repos) {
      if (x.kind === 'section' && x.repoId && v.repo !== x.repoId) continue;
      const change = v.changes.find(c => c.key === key && c.options?.some(o => o.act === act));
      if (change) targets.push({ repo: v.repo, name: v.name, checkout: v.checkout, change: { ...change, chosen: act } });
      if (x.kind === 'section' && targets.length) break;
    }
    picks.push({ ...x, act, targets });
  }
  return picks;
}
// one pick as the picker's row: the action and what it acts on, where
export function pickLine(p) {
  const kind = p.kind === 'section' ? `${p.file || 'AGENTS.md'} section` : p.kind === 'tool' ? groupName[p.group] || 'tool' : what[p.kind];
  const client = p.client && p.client !== 'claude' ? `${p.client} ` : '';
  const where = p.targets.length > 1 ? ` in ${p.targets.length} repositories` : p.targets[0]?.name ? ` in ${p.targets[0].name}` : '';
  return `${ACTS[p.act]?.text || p.act} the ${client}${kind} "${p.title}"${where}`;
}
// what the row costs and how often it was used, beside the line
export function pickNote(p) {
  const share = p.usedShare ?? (p.of ? p.used / p.of : null), use = share != null ? `needed in ${Math.round(100 * share)}% of prompts` : 'use unknown';
  return `~${formatTokens(p.wasted)} tokens a prompt, ${use}${p.act === 'compress' ? ', a model call' : ''}`;
}
// The picks made, each in its repository, through the function behind the page's Apply and `thinker context
// --approve` (context-suggest.js:approveChanges): a section compressed by a model or removed, written to the working
// tree uncommitted, a skill or tool switched off there; every decision in that repository's History with its undo.
// Returns one line per change, named by repository when more than one was touched.
export async function applyMachinePicks(picks, { edit, approve = approveChanges } = {}) {
  const byCheckout = new Map();
  for (const p of picks) for (const t of p.targets) {
    if (!byCheckout.has(t.checkout)) byCheckout.set(t.checkout, { name: t.name, changes: [] });
    byCheckout.get(t.checkout).changes.push(t.change);
  }
  const said = [], many = byCheckout.size > 1;
  for (const [checkout, g] of byCheckout) {
    let lines;
    try { const st = new Store(checkout); if (!st.exists()) st.init(); lines = await approve(st, g.changes, { edit }); }
    catch (e) { lines = [String(e?.message || e).split('\n')[0]]; }
    for (const l of lines) said.push(many ? `${g.name}: ${l}` : l);
  }
  return said;
}
