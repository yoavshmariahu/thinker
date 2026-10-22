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
      views.push({ repo: r.id, name: r.name, view });
      onRepo?.(repos[repos.length - 1]);
    } catch (e) { skipped.push({ name: r.name, checkout: r.checkout, error: String(e?.message || e).split('\n')[0] }); }
  }
  // the page's repository list, so it opens on these without looking again (ui/server.js:keptCheckouts)
  try { if (repos.length) refreshCheckouts(store, { home: th, transcriptsHome: home, now }); } catch {}
  const view = views.length ? mergeViews(views) : null;
  return { days, repos, skipped, more: Math.max(0, active.length - limit), view };
}

// What to cut first: the parts of the context the sessions did not use, costliest first. The same flag the
// Context tab shows on each row (instruction-value.js:wasteLevel): a section, skill or tool whose cost in the
// sessions that did not use it is a share of its kind's (5% high, 2% medium). `wasted` is that cost,
// tokens a session, and the saving at most. Sections carry the free signal only (applied by their triggers, or
// judged where sessions were); a section naming no file or command is unknown and not listed.
export function recommendations(view, { top = MACHINE_TOP } = {}) {
  if (!view) return { items: [], flagged: 0, potential: 0 };
  const items = [];
  for (const s of view.instructions?.sections || []) {
    if (s.waste !== 'high' && s.waste !== 'medium') continue;
    // the share is the judge's (followed of judged) once enough sessions are judged, else the triggers' (applied of all)
    const judge = s.usedBy === 'judge';
    items.push({ kind: 'section', id: s.id, title: `${s.parent ? `${s.parent}: ` : ''}${s.title}`, file: s.file, repo: s.repoName || null, perSession: s.perSession, wasted: s.wasted, usedShare: s.usedShare, used: judge ? s.followed : s.applied, of: judge ? s.judged : s.sessions, by: judge ? 'judge' : 'triggers' });
  }
  // skills and tools: in a merged view `usedShare` is the sum over repositories and `wasted` the first one's, so
  // both are made again here, against the kind's cost as contextView does (skills; built-in tools; the custom
  // tools together)
  const rows = (xs, kind) => {
    const cost = xs.reduce((a, r) => a + (r.off ? 0 : r.perSession), 0);
    for (const r of xs) {
      if (r.off || r.usedShare == null) continue;
      const wasted = Math.round(r.perSession * (1 - r.usedShare));
      const { waste } = wasteLevel({ usedShare: r.usedShare, wasted }, cost);
      if (waste !== 'high' && waste !== 'medium') continue;
      items.push({ kind, group: r.group || null, key: r.key, title: r.name, client: r.client, repo: r.repoName || null, repos: r.repos || null, label: r.label || null, perSession: r.perSession, wasted, usedShare: r.usedShare, used: r.used, of: r.loaded, by: kind === 'skill' ? 'read' : 'called' });
    }
  };
  const skills = view.skills || [], tools = view.tools || [];
  rows(skills, 'skill');
  rows(tools.filter(t => t.group === 'builtin'), 'tool');
  const custom = tools.filter(t => t.group !== 'builtin');
  if (custom.length) {
    // against what every custom tool costs, skills included, as the tab does
    const cost = [...custom, ...skills].reduce((a, r) => a + (r.off ? 0 : r.perSession), 0);
    for (const r of custom) {
      if (r.off || r.usedShare == null) continue;
      const wasted = Math.round(r.perSession * (1 - r.usedShare));
      const { waste } = wasteLevel({ usedShare: r.usedShare, wasted }, cost);
      if (waste === 'high' || waste === 'medium') items.push({ kind: 'tool', group: r.group, key: r.key, title: r.name, client: r.client, repo: r.repoName || null, repos: r.repos || null, label: r.label || null, perSession: r.perSession, wasted, usedShare: r.usedShare, used: r.used, of: r.loaded, by: 'called' });
    }
  }
  items.sort((a, b) => b.wasted - a.wasted || b.perSession - a.perSession);
  return { items: items.slice(0, top), flagged: items.length, potential: items.reduce((a, x) => a + x.wasted, 0) };
}

const what = { section: 'section', skill: 'skill', tool: 'tool' };
const groupName = { mcp: 'MCP server', plugins: 'plugin', builtin: 'built-in tool' };
// one suggestion as a line: what it is, where, what it costs a session, how often it was used
export function recommendationLine(x) {
  const where = x.repo ? ` (${x.repo})` : x.repos > 1 ? ` (${x.repos} repositories)` : '';
  const kind = x.kind === 'section' ? `${x.file || 'AGENTS.md'} section` : x.kind === 'tool' ? groupName[x.group] || 'tool' : what[x.kind];
  const client = x.client && x.client !== 'claude' ? `${x.client} ` : '';
  const use = x.of ? `${x.by === 'triggers' ? 'applied' : x.by === 'judge' ? 'followed' : x.by} in ${x.used} of ${x.of} sessions` : 'use unknown';
  return `${client}${kind} "${x.title}"${where}: ~${formatTokens(x.wasted)} tokens a session spent where it was not used (${use})`;
}

// The report as the installer and `thinker context --machine` print it: the parts of the context per model
// call and per session, then the suggestions, then where to review and apply them.
export function renderMachineReport({ days, repos, skipped = [], more = 0, view }, recs) {
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
  lines.push(`  a session, read again by each of its model calls: instruction files ~${formatTokens(t.instructions.perSession)}, skills and MCP servers ~${formatTokens(t.custom.perSession)}, built-in tools ~${formatTokens(t.builtin?.perSession || 0)}, tool outputs ~${formatTokens(t.outputs.perSession)} (an estimate)`);
  for (const s of skipped) lines.push(`  ${s.name}: could not be read (${s.error})`);
  if (!recs.items.length) {
    lines.push('Nothing to cut yet: every section, skill and tool whose use can be told was used in most sessions, or there are too few sessions to say.');
  } else {
    lines.push(`Cut first (what the sessions did not use, costliest first; the saving is at most the figure shown):`);
    recs.items.forEach((x, i) => lines.push(`  ${i + 1}. ${recommendationLine(x)}`));
    const shown = recs.items.reduce((a, x) => a + x.wasted, 0);
    lines.push(`  about ~${formatTokens(shown)} tokens a session in these ${recs.items.length}${recs.flagged > recs.items.length ? `, ~${formatTokens(recs.potential)} over all ${recs.flagged} flagged` : ''}.`);
  }
  lines.push(`Review and apply in the browser: thinker ui (Context${view.all ? ', All repositories' : ''}). By hand: thinker instructions --remove|--compress <section>${view.all ? ' in the repository' : ''}; thinker harness --off "<skill or tool>".`);
  return lines;
}
