// `thinker context`: where the agents' context goes here, part by part, and what each part is worth
// (context-view.js): the instruction file's sections, the skills, the other tools loaded into every session.
// The report changes nothing; --judge n spends model calls on the newest sessions not judged yet, so the
// sections' verdicts fill in without waiting for the sampled check. The controls are the commands they name:
// `thinker instructions --core` for the sections, `thinker harness --off` for skills and tools.
import { contextView, switchSources, setOutputCompression } from '../context-view.js';
import { judgeRecent, findRepoSessions } from '../instruction-value.js';
import { formatTokens } from '../model-usage.js';

const pct = x => x == null ? '   -' : `${String(Math.round(100 * x)).padStart(3)}%`;
const pad = (s, n) => String(s).padStart(n);

async function contextCommand({ store, flags, out }) {
  const days = Number(flags.days) || 30;
  // the tab's actions: switch tools off or back on, set a tool's output compression
  const list = v => String(v).split(',').map(x => x.trim()).filter(Boolean);
  if (typeof flags['switch-off'] === 'string') { out(switchSources(store, { labels: list(flags['switch-off']), builtin: !!flags.builtin })); return; }
  if (typeof flags['switch-on'] === 'string') { out(switchSources(store, { keys: list(flags['switch-on']), on: true })); return; }
  if (typeof flags['output-compression'] === 'string') { out(setOutputCompression(store, list(flags['output-compression']), ['high', 'moderate'].includes(flags.level) ? flags.level : 'off')); return; }
  if (flags.judge !== undefined) {
    const n = flags.judge === true ? 5 : Math.max(1, Number(flags.judge) || 5);
    out(`Judging up to ${n} session${n === 1 ? '' : 's'}, sampled over the last ${days} days, against the instruction file's sections (one model call each)…`);
    const r = await judgeRecent(store, { n, days, onEach: (s, x) => out(`  ${s.session.slice(0, 8)} ${s.client}: ${Object.keys(x.verdicts).length} section(s) relevant`) });
    out(r.skipped === 'no-file' ? 'No AGENTS.md or CLAUDE.md here.' : `Judged ${r.judged} session${r.judged === 1 ? '' : 's'}${r.tokens ? `, ~${formatTokens(r.tokens)} tokens` : ''}.${r.skipped === 'daily-cap' ? ' Stopped at the daily token cap.' : ''}`);
    return;
  }
  const v = contextView(store, { days, sessions: findRepoSessions(store.repo, days) });
  if (flags.json) { out(JSON.stringify(v, null, 2)); return; }
  const iv = v.instructions, t = v.totals;
  out(`Context per session here, over ${days} days (${v.sessions} sessions; tokens are read again by every model call):`);
  out(`  instruction files ~${formatTokens(t.instructions.perSession)} a session (~${formatTokens(t.instructions.tokens)} tokens in every model call)`);
  out(`  custom tools      ~${formatTokens(t.custom.perSession)} a session (skills, MCP servers, plugins: ~${formatTokens(t.custom.tokens)} in every call)`);
  out(`  built-in tools    ~${formatTokens(t.builtin.perSession)} a session (~${formatTokens(t.builtin.tokens)} in every call)`);
  out(`  tool outputs      ~${formatTokens(t.outputs.perSession)} a session (each result read again by the calls after it; an estimate)\n`);
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
    out('Tool outputs: input tokens a session, calls a session, tokens a call.');
    for (const o of v.outputs.tools.slice(0, flags.verbose ? undefined : 12)) out(`  ${pad(formatTokens(o.perSession), 9)} ${pad(o.calls.toFixed(1), 6)} calls ${pad(formatTokens(o.perCall), 6)}  ${o.name}`);
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
