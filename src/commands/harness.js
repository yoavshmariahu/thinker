// `thinker harness`: what the agent loads into every session here against what the sessions use,
// and the sources worth switching off (harness.js). The report reads transcripts and settings and changes
// nothing; --suggest queues the question for the next prompt, --answer takes its reply, --undo reverses them.
import { harnessUsage, harnessAdvice, harnessSavings, clientPrefix, MIN_TOKENS, scheduleHarnessSuggestion, answerHarness, undoHarness, switchOffNow, setHarnessSettings, harnessOn, OFF_MESSAGE, perSession, recallOn } from '../harness.js';
import { formatTokens } from '../model-usage.js';

const KIND = { plugin: 'plugin', mcp: 'MCP server', connector: 'claude.ai connector', skill: 'skill', desktop: 'desktop app' };
const kindOf = s => s.kind === 'connector' && s.scope === 'desktop' ? 'desktop connector' : KIND[s.kind] || s.kind;

async function harnessCommand({ store, repo, flags, out }) {
  const onOff = v => v === undefined ? undefined : /^(on|true|1|yes)$/i.test(String(v));
  if (flags.enabled !== undefined) { const s = setHarnessSettings(store, { enabled: onOff(flags.enabled) }); out(`thinker harness here: ${s.enabled ? 'on' : 'off'}`); return; }
  // --undo works with it off: it reverses what was switched off while it was on
  if (flags.undo) { out(undoHarness(store, { names: flags.undo === true ? null : String(flags.undo).split(',') })); return; }
  if (!harnessOn(store)) { out(OFF_MESSAGE); return; }
  if (flags.answer !== undefined) { out(answerHarness(store, String(flags.answer === true ? '' : flags.answer), { client: flags.client ? String(flags.client) : undefined, via: flags.via === 'text' ? 'text' : 'picker' })); return; }
  if (flags.off) { out(switchOffNow(store, String(flags.off), { via: 'cli' })); return; }
  if (['weekly', 'recall', 'suggestions'].some(k => flags[k] !== undefined)) {
    const s = setHarnessSettings(store, { weekly: onOff(flags.weekly), recall: onOff(flags.recall), suggestions: onOff(flags.suggestions) });
    out(`weekly question: ${s.weekly ? 'on' : 'off'} · switched-off hints: ${s.recall ? 'on' : 'off'} · suggestions on this machine: ${s.suggestions ? 'on' : 'off'}`);
    return;
  }
  const days = Number(flags.days) || 30;
  const usage = harnessUsage(repo, { days });
  if (flags.suggest) {
    const picks = scheduleHarnessSuggestion(store, { force: true, usage });
    out(picks?.length ? `Queued: your next prompt in Claude Code, Codex or Cursor here asks which of ${picks.length} source${picks.length === 1 ? '' : 's'} to switch off (${picks.map(p => p.name).join(', ')}).` : 'Nothing here is worth switching off; no question queued.');
    return;
  }
  const advice = harnessAdvice(usage), saved = harnessSavings(store);
  if (flags.json) { out(JSON.stringify({ ...usage, advice, saved }, null, 2)); return; }
  if (saved.sources.length) {
    out(`Switched off here by thinker, measured in the ${saved.sessions} Claude Code, Codex or Cursor session${saved.sessions === 1 ? '' : 's'} started since:`);
    for (const s of saved.sources) out(`- ${clientPrefix(s.client)}${s.name} (${kindOf(s)}), off since ${s.at.slice(0, 10)}: absent from ${s.absent} of ${s.sessions} sessions, ~${formatTokens(s.tokens)} tokens of context saved (~${formatTokens(s.inputTokens)} input tokens over their model calls)${s.stillLoaded ? `; still loaded in ${s.stillLoaded}, where the switch did not take effect` : ''}`);
    out(`In all: ~${formatTokens(saved.tokens)} tokens of context, ~${formatTokens(saved.inputTokens)} input tokens. \`thinker harness --undo\` turns them back on.\n`);
  }
  if (!usage.sessions) { out(`No Claude Code, Codex or Cursor session here in the last ${days} days records what it loaded.`); return; }
  out(`What Claude Code, Codex or Cursor loaded into ${usage.sessions} sessions here over ${days} days, and how many used it:\n`);
  out(`  ${'source'.padEnd(34)} ${'kind'.padEnd(20)} ${'used'.padStart(9)}  tokens each`);
  for (const s of usage.sources.filter(s => s.tokens >= MIN_TOKENS).slice(0, flags.verbose ? undefined : 15)) {
    out(`  ${(clientPrefix(s.client) + s.name).slice(0, 34).padEnd(34)} ${(kindOf(s) + (s.scope && !['connector', 'desktop'].includes(s.kind) ? ` (${s.scope})` : '')).padEnd(20)} ${`${s.used}/${s.loaded}`.padStart(9)}  ~${formatTokens(s.tokens)}`);
  }
  // the desktop app's own instructions: counted, switched in the app's Settings where it has a switch, never by thinker
  const app = usage.sources.filter(s => s.kind === 'desktop' && s.tokens >= MIN_TOKENS && s.used / s.loaded < 0.1);
  if (app.length) out(`\nThe Claude desktop app adds its own instructions, which only the app switches: ${app.map(s => `${s.name} (~${formatTokens(s.tokens)}, used in ${s.used} of ${s.loaded}${s.where ? `; ${s.where}` : ''})`).join(', ')}. The definitions of its built-in tools (browser pane, simulator, session tools) are not recorded and not counted.`);
  if (!advice.length) { out('\nEverything recorded here is used, too small to suggest, or has no supported local switch.'); return; }
  // every model call reads the context again, so a source costs its tokens times a typical session's calls
  const calls = s => usage.calls?.[s.client || 'claude'] || 0, input = s => perSession(s.tokens, calls(s));
  const total = advice.reduce((n, s) => n + s.tokens, 0), reread = advice.reduce((n, s) => n + input(s), 0);
  out(`\nWorth switching off here, ~${formatTokens(total)} tokens across these source listings (varies by agent)${reread > total ? `, read again by every model call: ~${formatTokens(reread)} input tokens in a typical session, mostly prompt-cache reads` : ''}:`);
  for (const s of advice) {
    out(`- ${clientPrefix(s.client)}${s.name} (${kindOf(s)}): ${s.unused ? 'no session here used it' : `${s.used} of ${s.loaded} sessions used it`}, ~${formatTokens(s.tokens)} tokens each${calls(s) > 1 ? `, ~${formatTokens(input(s))} input tokens over the ~${calls(s)} model calls of a session` : ''}.`);
    out(`  ${s.action}`);
  }
  out(`\nSwitched off, a source is not gone: ${recallOn(store) ? 'when a request looks like it needs one, thinker tells the agent it is off and how to bring it back; ' : ''}skills still run when you type /name, and \`thinker harness --undo\` turns everything back on.`);
  out('\nNothing was changed. `thinker harness --suggest` asks you in your next Claude Code, Codex or Cursor prompt here, all of them in one question.');
}

export const commands = { harness: harnessCommand };
