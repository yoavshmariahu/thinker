// `thinker context`: where the agents' context goes here, part by part, and what each part is worth
// (context-view.js): the instruction file's sections, the skills, the other tools loaded into every session.
// The report changes nothing; --judge n spends model calls on the newest sessions not judged yet, so the
// sections' verdicts fill in without waiting for the sampled check. The controls are the commands they name:
// `thinker instructions --core` for the sections, `thinker harness --off` for skills and tools. --refresh keeps
// the report for the page (context-snapshot.js), which starts it in the background. --machine is the report over
// the repositories the agents worked in lately, merged, with what to cut first (context-machine.js): what the
// installer runs, from the sessions that ran before thinker was installed; it needs no repository. --ask is the
// installer's question: browser or terminal, and in the terminal the suggestions to pick from (setup/context-ask.js).
import { contextView, switchSources, setOutputCompression } from '../context-view.js';
import { judgeRecent, findRepoSessions } from '../instruction-value.js';
import { formatTokens } from '../model-usage.js';
import { refreshSnapshots, writeSnapshot } from '../context-snapshot.js';
import { machineContext, recommendations, renderMachineReport, MACHINE_REPOS, MACHINE_TOP } from '../context-machine.js';
import { approveChanges, dismissChanges, revertDecision, pickChanges, currentChanges, changeHistory } from '../context-suggest.js';

const pct = x => x == null ? '   -' : `${String(Math.round(100 * x)).padStart(3)}%`;
const pad = (s, n) => String(s).padStart(n);

async function contextCommand({ store, flags, out }) {
  const days = Number(flags.days) || 30;
  if (flags.machine) {
    const limit = Math.max(1, Number(flags.repos) || MACHINE_REPOS), top = Math.max(1, Number(flags.top) || MACHINE_TOP);
    const quiet = flags.quiet || flags.json;
    if (!quiet) out(`Reading the agents' sessions of the last ${days} days, the ${limit} most active repositories first…`);
    const r = machineContext(store, { days, limit, onRepo: x => { if (!quiet) out(`  ${x.name}: ${x.sessions} session${x.sessions === 1 ? '' : 's'}`); } });
    const recs = recommendations(r.view, { top });
    if (flags.json) { out(JSON.stringify({ ...r, views: undefined, recommendations: recs }, null, 2)); return; }
    if (!quiet) out('');
    // --ask (the installer, on a terminal): where to see what to cut first, and in the terminal the suggestions as a
    // list to pick from and apply at once (setup/context-ask.js); without a terminal the report is printed
    if (flags.ask && !quiet) {
      const { askMachineReport, canOpenBrowser } = await import('../setup/context-ask.js');
      await askMachineReport({ r, recs, store, out, browser: !flags['no-browser'] && canOpenBrowser() });
      return;
    }
    for (const l of renderMachineReport(r, recs)) out(l);
    return;
  }
  // the tab's actions: switch tools off or back on, set a tool's output compression
  const list = v => String(v).split(',').map(x => x.trim()).filter(Boolean);
  if (typeof flags['switch-off'] === 'string') { out(switchSources(store, { labels: list(flags['switch-off']), builtin: !!flags.builtin })); return; }
  if (typeof flags['switch-on'] === 'string') { out(switchSources(store, { keys: list(flags['switch-on']), on: true })); return; }
  if (typeof flags['output-compression'] === 'string') { out(setOutputCompression(store, list(flags['output-compression']), ['high', 'moderate'].includes(flags.level) ? flags.level : 'off')); return; }
  // the Context tab's snapshot (context-snapshot.js), made again in the background by the page and maintenance
  if (flags.refresh) { const r = refreshSnapshots(store); if (!flags.quiet) out(r.skipped ? 'A refresh is already running here.' : `Context report kept for the last ${r.written.join(' and ')} days.`); return; }
  if (flags.judge !== undefined) {
    const n = flags.judge === true ? 5 : Math.max(1, Number(flags.judge) || 5);
    out(`Judging up to ${n} session${n === 1 ? '' : 's'}, sampled over the last ${days} days, against the instruction file's sections (one model call each)…`);
    const r = await judgeRecent(store, { n, days, onEach: (s, x) => out(`  ${s.session.slice(0, 8)} ${s.client}: ${Object.keys(x.verdicts).length} section(s) relevant`) });
    out(r.skipped === 'no-file' ? 'No AGENTS.md or CLAUDE.md here.' : `Judged ${r.judged} session${r.judged === 1 ? '' : 's'}${r.tokens ? `, ~${formatTokens(r.tokens)} tokens` : ''}.${r.skipped === 'daily-cap' ? ' Stopped at the daily token cap.' : ''}`);
    return;
  }
  const v = contextView(store, { days, sessions: findRepoSessions(store.repo, days) });
  writeSnapshot(store, days, v); // what the page shows next
  // the top changes (context-suggest.js): approve their suggested actions, dismiss them, or read the decisions so far,
  // as the Context tab's rows and History do
  const top = currentChanges(store, v);
  for (const [flag, fn] of [['approve', approveChanges], ['dismiss', dismissChanges]]) {
    if (flags[flag] === undefined) continue;
    const picked = pickChanges(top, flags[flag] === true ? '' : flags[flag]);
    if (!picked.length) { out(`Name the top changes to ${flag}: their numbers (1-${top.length}) or all. \`thinker context\` lists them.`); return; }
    for (const l of await fn(store, picked)) out(l);
    return;
  }
  if (flags.history) {
    const h = changeHistory(store);
    out(h.length ? h.map((e, i) => `${String(i + 1).padStart(3)}. ${e.at.slice(0, 10)}  ${(e.revertedAt ? `${e.decision}, reverted` : e.decision).padEnd(22)} ${e.title}${e.result ? `: ${e.result}` : ''}`).join('\n') + (h.some(e => e.revertible) ? '\n`thinker context --revert <n>` takes a decision back.' : '') : 'No decisions on the suggested changes here yet.');
    return;
  }
  if (flags.revert !== undefined) {
    const h = changeHistory(store), e = h[Number(flags.revert) - 1] || h.find(x => x.id === String(flags.revert));
    const r = e ? await revertDecision(store, e.id) : { error: `no decision ${flags.revert}; \`thinker context --history\` lists them` };
    out(r.error || r.said);
    return;
  }
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  const iv = v.instructions, t = v.totals;
  out(`Context per session here, over ${days} days (${v.sessions} sessions; tokens are read again by every model call):`);
  out(`  instruction files ~${formatTokens(t.instructions.perSession)} a session (~${formatTokens(t.instructions.tokens)} tokens in every model call)`);
  out(`  custom tools      ~${formatTokens(t.custom.perSession)} a session (skills, MCP servers, plugins: ~${formatTokens(t.custom.tokens)} in every call)`);
  out(`  built-in tools    ~${formatTokens(t.builtin.perSession)} a session (~${formatTokens(t.builtin.tokens)} in every call)`);
  out(`  tool outputs      ~${formatTokens(t.outputs.perSession)} a session (each result read again by the calls after it${t.outputs.wasted != null ? `; ~${formatTokens(t.outputs.wasted)} of it after the agent last used the result` : ''}; an estimate)\n`);
  // the five highest-leverage changes, as the page's Top changes view and the weekly summary in a session give them
  if (top.length) {
    out(`Top changes (up to ~${formatTokens(top.reduce((a, c) => a + c.total, 0))} input tokens over the last ${days} days together):`);
    top.forEach((c, i) => out(`  ${i + 1}. ${c.title}: ~${formatTokens(c.total)} over ${days} days; ${c.why}\n     suggested: ${c.default ? c.default.text : 'dismiss it, or change it by hand'}${c.options.length > 1 ? ` (or: ${c.options.slice(1).map(o => o.act).join(', ')})` : ''}`));
    out('  Approve the suggested actions with `thinker context --approve 1,3` (or all; 3:remove picks another action), --dismiss the ones to leave, or use `thinker ui` (Context, All); --history lists the decisions.\n');
  }
  if (iv.file) {
    if ((iv.files || []).length > 1) out(`Instruction files: ${iv.files.map(f => `${f.file} (${f.kind === 'root' ? 'every session' : `${f.loadedIn} sessions`})`).join(', ')}.`);
    out(`${iv.file}: ${iv.sessions} sessions read it, ${iv.judged} judged${iv.judge.judge ? ` (a ${Math.round(100 * iv.judge.share)}% sample is judged at session end)` : ' (`thinker context --judge n` judges recent ones)'}.`);
    out(`  ${pad('tokens', 6)} ${pad('a session', 9)} ${pad('applied', 8)} ${pad('relevant', 8)} ${pad('followed', 8)}  value        section`);
    for (const s of [...iv.sections].sort((a, b) => b.perSession - a.perSession)) {
      out(`  ${pad(s.tokens, 6)} ${pad(formatTokens(s.perSession), 9)} ${pad(s.triggered ? `${s.applied}/${s.sessions}` : '-', 8)} ${pad(s.judged ? `${s.bore}/${s.judged}` : '-', 8)} ${pad(pct(s.success), 8)}  ${s.value.padEnd(12)} ${s.kept ? '* ' : ''}${s.fileKind && s.fileKind !== 'root' ? `${s.file} · ` : ''}${s.parent ? `${s.parent}: ` : ''}${s.title}`);
    }
    out(`  applied: the session touched the section's files, commands or code; relevant: judged sessions where it mattered to the work; followed: % of judged sessions that followed rather than broke it${iv.coreOn ? '; * kept in the trimmed copy' : ''}.\n`);
  }
  if (v.skills.length) {
    out('Skills: listed in every session, read in some; kept: checked sessions that read it and kept its rules.');
    for (const s of [...v.skills].sort((a, b) => b.perSession - a.perSession).slice(0, flags.verbose ? undefined : 20)) {
      const o = s.outcome;
      out(`  ${pad(s.tokens, 6)} ${pad(formatTokens(s.perSession), 9)} read ${pad(`${s.used}/${s.loaded}`, 7)} ${o?.read ? `kept ${pct(o.success)} of ${o.read}` : '            '}${o?.missed ? ` missed ${o.missed}` : ''}  ${s.client === 'claude' ? '' : `${s.client}: `}${s.name}${s.off ? ' (off)' : ''}`);
    }
    out('');
  }
  if (v.outputs.tools.length) {
    out('Tool outputs: input tokens a session, of it read after the agent last used the result (wasted), calls a session, tokens per call.');
    for (const o of v.outputs.tools.slice(0, flags.verbose ? undefined : 12)) out(`  ${pad(formatTokens(o.perSession), 9)} ${pad(o.wasted == null ? '-' : formatTokens(o.wasted), 9)} ${pad(o.calls.toFixed(1), 6)} calls ${pad(formatTokens(o.perCall), 6)}  ${o.name}`);
    out('');
  }
  if (v.tools.length) {
    out('Other tools loaded into every session:');
    for (const s of v.tools.slice(0, flags.verbose ? undefined : 20)) out(`  ${pad(s.tokens, 6)} ${pad(formatTokens(s.perSession), 9)} used ${pad(`${s.used}/${s.loaded}`, 7)}  ${s.client === 'claude' ? '' : `${s.client}: `}${s.name} ${s.kind}${s.off ? ' (off)' : s.suggested ? ' (rarely used)' : ''}`);
    out('');
  }
  out(`Keep sections in this checkout's trimmed copy: thinker instructions --core "Title, Title".${v.harnessOn ? ' Switch a skill or tool off here: thinker harness --off "<label>".' : ' Switching skills and tools off needs the harness (thinker harness --enabled on).'}`);
}

export const commands = { context: contextCommand };
