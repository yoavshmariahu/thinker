// `thinker context`: where the agents' context goes here, part by part, and what each part is worth
// (context-view.js): the instruction file's sections, the skills, the other tools loaded into every session.
// The report changes nothing; --judge n spends model calls on the newest sessions not judged yet, so the
// sections' verdicts fill in without waiting for the sampled check. The controls are the commands they name:
// `thinker instructions --compress|--remove` for the sections, `thinker harness --off` for skills and tools. --refresh keeps
// the report for the page (context-snapshot.js), which starts it in the background. --machine is the report over
// the repositories the agents worked in lately, merged, with what to cut first (context-machine.js): what the
// installer runs, from the sessions that ran before thinker was installed; it needs no repository. --ask is the
// installer's question: browser or terminal, and in the terminal the suggestions to pick from (setup/context-ask.js).
// --cards is the Save page's card view here: what each part is, why you would change it and what you would lose
// (part-explain.js), the same parts in the same order as the table, with the words `thinker explain` wrote.
import { historyEffects, promptAverageHere, keptRows } from '../report-snapshot.js';
import { contextView, switchSources, setOutputCompression } from '../context-view.js';
import { judgeRecent, findRepoSessions } from '../instruction-value.js';
import { formatTokens } from '../model-usage.js';
import { refreshSnapshots, writeSnapshot } from '../context-snapshot.js';
import { machineContext, recommendations, renderMachineReport, MACHINE_REPOS, MACHINE_TOP } from '../context-machine.js';
import { approveChanges, dismissChanges, revertDecision, retryJob, pickChanges, currentChanges, changeHistory, refreshPrStates, offeredChanges } from '../context-suggest.js';

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
  // --via names where the decision came from (context-suggest.js:VIA): the weekly suggestion's own command says
  // `session`, so a suggestion that converted in the conversation is not counted as someone typing the command.
  const via = typeof flags.via === 'string' ? flags.via : 'command';
  // and it says which list the numbers belong to. `session`: the person is answering the weekly summary, so they are
  // the lines that summary showed (offeredChanges), whatever the ranking is now. Anything else: the five this command
  // just printed, which is what someone typing it has in front of them. A key names a change either way (pickChanges).
  const basis = (via === 'session' && offeredChanges(store)) || top;
  for (const [flag, fn] of [['approve', approveChanges], ['dismiss', dismissChanges]]) {
    if (flags[flag] === undefined) continue;
    const picked = pickChanges(basis, flags[flag] === true ? '' : flags[flag]);
    if (!picked.length) { out(`Name the top changes to ${flag}: their numbers (1-${basis.length}) or all. \`thinker context\` lists them.`); return; }
    for (const l of await fn(store, picked, { via })) out(l);
    return;
  }
  // what a decision saved, attributed to it alone (report.js:actionEffect): the changed thing a prompt (one call to the model) before against since
  const effectLine = e => { const f = e.effect; if (!f) return ''; const pct = f.share == null || !Math.round(100 * Math.abs(f.share)) ? '' : ` (${Math.round(100 * Math.abs(f.share))}% of a prompt before)`; return `\n       a prompt ${formatTokens(f.before.perPrompt)} → ${formatTokens(f.after.perPrompt)}: ${f.delta >= 0 ? 'saved' : 'cost'} ${formatTokens(Math.abs(f.delta))}${pct} a prompt, ~${formatTokens(Math.abs(f.window))} over the ${f.after.prompts} prompt${f.after.prompts === 1 ? '' : 's'} of the ${f.after.sessions} session${f.after.sessions === 1 ? '' : 's'} since${f.few ? ' (few sessions yet)' : ''}`; };
  if (flags.history) {
    // a pending pull request is asked after on GitHub first (context-suggest.js:refreshPrStates)
    await refreshPrStates(store);
    // numbered over every decision, as --revert and --retry read them; a reverted one is listed only with --reverted
    const h = historyEffects(store, changeHistory(store)), hidden = flags.reverted ? 0 : h.filter(e => e.revertedAt).length;
    // what a prompt costs on average here, the size each decision's saving is read against (report-snapshot.js:promptAverageHere)
    const avg = promptAverageHere(store);
    // a job under way or failed (context-suggest.js:startSectionJob) is said so; --retry runs a failed one again
    const state = e => e.running ? `${e.job.action === 'compress' ? 'compressing' : 'removing'}…` : e.failed ? 'failed' : e.pr ? `PR #${e.pr.number} ${e.pr.state === 'open' ? 'pending' : e.pr.state === 'merged' ? `merged${e.revertPr ? `, revert #${e.revertPr.number}` : e.unpulled ? ', pull to apply' : ''}` : 'rejected'}` : e.revertedAt ? `${e.decision}, reverted` : e.decision;
    const needs = h.filter(e => e.attention).length;
    // merged changes this checkout has not pulled (context-suggest.js:changeHistory `unpulled`): say which branch to pull
    const waiting = h.filter(e => e.unpulled), pullLine = waiting.length ? [...new Set(waiting.map(e => e.pullFrom || 'main'))].map(br => { const n = waiting.filter(e => (e.pullFrom || 'main') === br).length; return `${n} merged change${n === 1 ? '' : 's'} take${n === 1 ? 's' : ''} effect here once you pull ${br} (git pull origin ${br}); not offered on Find Savings meanwhile.\n`; }).join('') : '';
    // without a report of this code's kept here, nothing is measured: say what makes one
    const unmeasured = keptRows(store).stale && !avg ? 'Before and after are not measured yet: `thinker report --refresh` makes the report they are read from.\n' : '';
    out(h.length ? (needs ? `${needs} need${needs === 1 ? 's' : ''} you: a pull request to merge, or a failed change to retry.\n` : '') + pullLine + (avg ? `A prompt here costs ${formatTokens(avg.perPrompt)} tokens on average (${avg.prompts} prompts in ${avg.sessions} sessions).\n` : unmeasured) + h.map((e, i) => [e, i]).filter(([e]) => flags.reverted || !e.revertedAt).map(([e, i]) => `${String(i + 1).padStart(3)}. ${e.at.slice(0, 10)}  ${state(e).padEnd(22)} ${e.title}${e.what ? `  [${e.what}${e.about ? `: ${e.about}` : ''}]` : ''}${e.failed ? `: ${e.job.error}` : e.result ? `: ${e.result}` : ''}${e.pr?.url ? `  ${e.pr.url}` : ''}${effectLine(e)}`).join('\n') + (hidden ? `${hidden < h.length ? '\n' : ''}${hidden} reverted decision${hidden === 1 ? '' : 's'} not listed: --reverted lists ${hidden === 1 ? 'it' : 'them'}.` : '') + (h.some(e => e.revertible) ? '\n`thinker context --revert <n>` takes a decision back (a pending pull request is closed; a merged one gets a pull request that reverts it).' : '') + (h.some(e => e.retryable) ? '\n`thinker context --retry <n>` runs a failed change again.' : '') : 'No decisions on the suggested changes here yet.');
    return;
  }
  if (flags.retry !== undefined) {
    const h = changeHistory(store), e = h[Number(flags.retry) - 1] || h.find(x => x.id === String(flags.retry));
    const r = e ? retryJob(store, e.id) : { error: `no decision ${flags.retry}; \`thinker context --history\` lists them` };
    out(r.error || r.said);
    return;
  }
  if (flags.revert !== undefined) {
    const h = changeHistory(store), e = h[Number(flags.revert) - 1] || h.find(x => x.id === String(flags.revert));
    const r = e ? await revertDecision(store, e.id) : { error: `no decision ${flags.revert}; \`thinker context --history\` lists them` };
    out(r.error || r.said);
    return;
  }
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  // --cards: the page's own cards in the terminal (part-explain.js). The page shows these words under every row and
  // the table here showed none of them, so the two doors answered differently about the same part. One source for
  // both: `viewParts` is the page's list in the page's order (most wasted first), and the explanations are the ones
  // kept for the machine -- this prints what is there and names the command for what is not, never spending itself.
  if (flags.cards) {
    const { viewParts, readExplains } = await import('../part-explain.js');
    const have = readExplains(), all = viewParts(v);
    // as many as the tables print, and --verbose for the rest: the page pages through them, a terminal would scroll
    const parts = flags.verbose ? all : all.slice(0, 12);
    const KINDS = { section: 'instruction section', skill: 'skill', output: 'tool output', tool: 'tool' };
    const wrap = (label, text, w = 94) => {
      const lines = []; let line = `      ${label}${label ? ' ' : ''}`;
      for (const word of String(text).split(' ')) {
        if (line.length + word.length > w && line.trim()) { lines.push(line); line = '        '; }
        line += `${word} `;
      }
      return [...lines, line].map(l => l.replace(/\s+$/, ''));
    };
    out(`What each part of the context here is, and why you would change it (${parts.length === all.length ? `${all.length} part${all.length === 1 ? '' : 's'}` : `the ${parts.length} most wasted of ${all.length}, --verbose for the rest`}, over ${days} days):\n`);
    let missing = 0;
    parts.forEach((x, i) => {
      const e = have[x.key];
      if (!e) missing++;
      out(`${pad(i + 1, 3)}. ${x.name} — ${KINDS[x.kind] || KINDS.tool}, ~${formatTokens(x.tokens)} ${x.kind === 'output' ? 'a result' : 'a prompt'}${x.wastedWindow ? `, ~${formatTokens(x.wastedWindow)} wasted over ${days} days` : ''}`);
      if (x.about) for (const l of wrap('', x.about)) out(l);
      if (e) {
        for (const l of wrap('What this is:', e.what)) out(l);
        for (const l of wrap('Why you would change it:', e.why)) out(l);
        if (e.keep) for (const l of wrap('What you would lose:', e.keep)) out(l);
      }
      out('');
    });
    if (missing) out(`${missing} of these ${missing === 1 ? 'has' : 'have'} no explanation yet: \`thinker explain\` writes them, six parts to a model call, kept for this machine (in a desktop app it is queued for the session's own model).`);
    else out('Every part here is explained.');
    out('`thinker context` is the same parts as a table, with the figures; `thinker ui` is the same cards on the page.');
    return;
  }
  const iv = v.instructions, t = v.totals;
  // the unit is a prompt, one call to the model, as the Report counts it (report.js): a part's tokens in the calls
  // that carried it, over every prompt of the window
  out(`Context per prompt here, over ${days} days (${v.sessions} sessions, ${v.prompts || 0} prompts; a prompt is one call to the model, and every call reads these again):`);
  out(`  instruction files ~${formatTokens(t.instructions.perPrompt)} a prompt (~${formatTokens(t.instructions.tokens)} tokens in every model call that reads them)`);
  out(`  custom tools      ~${formatTokens(t.custom.perPrompt)} a prompt (skills, MCP servers, plugins: ~${formatTokens(t.custom.tokens)} in every call that loads them)`);
  out(`  built-in tools    ~${formatTokens(t.builtin.perPrompt)} a prompt (~${formatTokens(t.builtin.tokens)} in every call that loads them)`);
  out(`  tool outputs      ~${formatTokens(t.outputs.perPrompt)} a prompt (each result read again by the calls after it${t.outputs.wasted != null ? `; ~${formatTokens(t.outputs.wasted)} of it after the agent last used the result` : ''}; an estimate)\n`);
  // the five highest-leverage changes, as the page's Top changes view and the weekly summary in a session give them
  if (top.length) {
    out(`Top changes (up to ~${formatTokens(top.reduce((a, c) => a + c.total, 0))} input tokens over the last ${days} days together):`);
    top.forEach((c, i) => out(`  ${i + 1}. ${c.title}: ~${formatTokens(c.total)} over ${days} days; ${c.why}\n     suggested: ${c.default ? c.default.text : 'dismiss it, or change it by hand'}${c.options.length > 1 ? ` (or: ${c.options.slice(1).map(o => o.act).join(', ')})` : ''}`));
    out('  Approve the suggested actions with `thinker context --approve 1,3` (or all; 3:remove picks another action), --dismiss the ones to leave, or use `thinker ui` (Context, All); --history lists the decisions.\n');
  }
  if (iv.file) {
    if ((iv.files || []).length > 1) out(`Instruction files: ${iv.files.map(f => `${f.file} (${f.kind === 'root' ? 'every session' : `${f.loadedIn} sessions`})`).join(', ')}.`);
    out(`${iv.file}: ${iv.sessions} sessions read it, ${iv.judged} judged${iv.judge.judge ? ` (a ${Math.round(100 * iv.judge.share)}% sample is judged at session end)` : ' (judging is off: instructions.value.judge in .thinker/config.json)'}.`);
    out(`  ${pad('prompt', 6)} ${pad('needed', 7)} ${pad(`${days}d`, 7)} ${pad('wasted', 7)} ${pad('relevant', 8)} ${pad('followed', 8)}  value        section`);
    for (const s of [...iv.sections].sort((a, b) => b.window - a.window)) {
      // a section changed inside the window is measured over the sessions since the change, as on the page
      out(`  ${pad(s.tokens, 6)} ${pad(pct(s.usedShare), 7)} ${pad(formatTokens(s.window), 7)} ${pad(s.wastedWindow == null ? '-' : formatTokens(s.wastedWindow), 7)} ${pad(s.judged ? `${s.bore}/${s.judged}` : '-', 8)} ${pad(pct(s.success), 8)}  ${s.value.padEnd(12)} ${s.fileKind && s.fileKind !== 'root' ? `${s.file} · ` : ''}${s.parent ? `${s.parent}: ` : ''}${s.title}${s.recent ? ` (changed ${s.changedAt.slice(0, 10)}: ${s.sessions} session${s.sessions === 1 ? '' : 's'} since)` : ''}`);
    }
    out(`  prompt: its tokens in every prompt that carries it; needed: % of those prompts that touched its files, commands or code; ${days}d: prompt × every prompt that carried it; wasted: ${days}d × the prompts that did not need it. relevant: judged sessions where it mattered; followed: % of judged sessions that followed it. A section changed inside the window counts from its change.\n`);
  }
  if (v.skills.length) {
    out(`Skills: prompt, needed (% of prompts that invoked it), ${days}d, wasted; kept: checked sessions that read it and kept its rules.`);
    for (const s of [...v.skills].sort((a, b) => b.window - a.window).slice(0, flags.verbose ? undefined : 20)) {
      const o = s.outcome;
      out(`  ${pad(s.tokens, 6)} ${pad(pct(s.usedShare), 7)} ${pad(formatTokens(s.window), 7)} ${pad(formatTokens(s.wastedWindow || 0), 7)} ${o?.read ? `kept ${pct(o.success)} of ${o.read}` : '            '}${o?.missed ? ` missed ${o.missed}` : ''}  ${s.client === 'claude' ? '' : `${s.client}: `}${s.name}${s.off ? ' (off)' : ''}`);
    }
    out('');
  }
  if (v.outputs.tools.length) {
    // a tool compressed since a date is measured over the sessions since, as its own row; its row from before (`past`) is
    // listed after every current row, marked, for the comparison (tool-outputs.js:aggregateOutputs)
    const day = t => new Date(t).toISOString().slice(0, 10), level = l => l ? `${l} compression` : 'no compression';
    const note = o => o.past ? `  (measured with ${level(o.level)}, ${o.sessions} sessions${o.from ? ` ${day(o.from)} to ${day(o.to)}` : ''}; the setting has changed since)` : o.level ? `  (${level(o.level)} since ${day(o.since || o.from)}, ${o.sessions} sessions)` : (o.others || []).length ? `  (before compression, ${o.sessions} sessions)` : '';
    out(`Tool outputs: tokens per result, needed (% of the re-reads before the agent last used it), ${days}d (every re-read), wasted (the re-reads after), calls a session.`);
    const rows = [...v.outputs.tools.filter(o => !o.past), ...v.outputs.tools.filter(o => o.past)];
    for (const o of rows.slice(0, flags.verbose ? undefined : 12)) out(`  ${pad(formatTokens(o.perCall), 6)} ${pad(pct(o.needed), 7)} ${pad(formatTokens(o.window), 7)} ${pad(o.wastedWindow == null ? '-' : formatTokens(o.wastedWindow), 7)} ${pad(o.calls.toFixed(1), 6)} calls  ${o.name}${note(o)}`);
    out('');
  }
  if (v.tools.length) {
    out(`Other tools loaded into every session: prompt, needed (% of prompts that called it), ${days}d, wasted.`);
    for (const s of v.tools.slice(0, flags.verbose ? undefined : 20)) out(`  ${pad(s.tokens, 6)} ${pad(pct(s.usedShare), 7)} ${pad(formatTokens(s.window), 7)} ${pad(formatTokens(s.wastedWindow || 0), 7)}  ${s.client === 'claude' ? '' : `${s.client}: `}${s.name} ${s.kind}${s.off ? ' (off)' : s.suggested ? ' (rarely used)' : ''}`);
    out('');
  }
  out('`thinker context --cards` says what each part is and why you would change it, as the page does.');
  out(`Change a section as a pull request: thinker instructions --compress <id> --pr (or --remove).${v.harnessOn ? ' Switch a skill or tool off here: thinker harness --off "<label>".' : ' Switching skills and tools off needs the harness (thinker harness --enabled on).'}`);
}

export const commands = { context: contextCommand };
