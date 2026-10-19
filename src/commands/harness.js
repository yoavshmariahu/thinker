// `thinker harness`: what the agent loads into every session here against what the sessions use,
// and the sources worth switching off (harness.js). The report reads transcripts and settings and changes
// nothing; --suggest queues the question for the next prompt, --answer takes its reply, --undo reverses them.
import { harnessUsage, harnessAdvice, harnessSavings, MIN_TOKENS, scheduleHarnessSuggestion, answerHarness, undoHarness, switchOffNow, setHarnessSettings } from '../harness.js';
import { formatTokens } from '../model-usage.js';

const KIND = { plugin: 'plugin', mcp: 'MCP server', connector: 'claude.ai connector', skill: 'skill' };

async function harnessCommand({ store, repo, flags, out }) {
  if (flags.answer !== undefined) { out(answerHarness(store, String(flags.answer === true ? '' : flags.answer), { client: flags.client ? String(flags.client) : undefined, via: flags.via === 'text' ? 'text' : 'picker' })); return; }
  if (flags.undo) { out(undoHarness(store, { names: flags.undo === true ? null : String(flags.undo).split(',') })); return; }
  if (flags.off) { out(switchOffNow(store, String(flags.off), { via: 'cli' })); return; }
  const onOff = v => v === undefined ? undefined : /^(on|true|1|yes)$/i.test(String(v));
  if (['weekly', 'recall', 'suggestions'].some(k => flags[k] !== undefined)) {
    const s = setHarnessSettings(store, { weekly: onOff(flags.weekly), recall: onOff(flags.recall), suggestions: onOff(flags.suggestions) });
    out(`weekly question: ${s.weekly ? 'on' : 'off'} · switched-off hints: ${s.recall ? 'on' : 'off'} · suggestions on this machine: ${s.suggestions ? 'on' : 'off'}`);
    return;
  }
  const days = Number(flags.days) || 30;
  const usage = harnessUsage(repo, { days });
  if (flags.suggest) {
    const picks = scheduleHarnessSuggestion(store, { force: true, usage });
    out(picks?.length ? `Queued: your next prompt in Claude Code or Codex here asks which of ${picks.length} source${picks.length === 1 ? '' : 's'} to switch off (${picks.map(p => p.name).join(', ')}).` : 'Nothing here is worth switching off; no question queued.');
    return;
  }
  const advice = harnessAdvice(usage), saved = harnessSavings(store);
  if (flags.json) { out(JSON.stringify({ ...usage, advice, saved }, null, 2)); return; }
  if (saved.sources.length) {
    out(`Switched off here by thinker, measured in the ${saved.sessions} Claude Code or Codex session${saved.sessions === 1 ? '' : 's'} started since:`);
    for (const s of saved.sources) out(`- ${s.client === 'codex' ? 'Codex: ' : ''}${s.name} (${KIND[s.kind] || s.kind}), off since ${s.at.slice(0, 10)}: absent from ${s.absent} of ${s.sessions} sessions, ~${formatTokens(s.tokens)} tokens of context saved (~${formatTokens(s.inputTokens)} input tokens over their model calls)${s.stillLoaded ? `; still loaded in ${s.stillLoaded}, where the switch did not take effect` : ''}`);
    out(`In all: ~${formatTokens(saved.tokens)} tokens of context, ~${formatTokens(saved.inputTokens)} input tokens. \`thinker harness --undo\` turns them back on.\n`);
  }
  if (!usage.sessions) { out(`No Claude Code or Codex session here in the last ${days} days records what it loaded.`); return; }
  out(`What Claude Code or Codex loaded into ${usage.sessions} sessions here over ${days} days, and how many used it:\n`);
  out(`  ${'source'.padEnd(34)} ${'kind'.padEnd(20)} ${'used'.padStart(9)}  tokens each`);
  for (const s of usage.sources.filter(s => s.tokens >= MIN_TOKENS).slice(0, flags.verbose ? undefined : 15)) {
    out(`  ${((s.client === 'codex' ? 'Codex: ' : '') + s.name).slice(0, 34).padEnd(34)} ${(KIND[s.kind] + (s.scope && s.kind !== 'connector' ? ` (${s.scope})` : '')).padEnd(20)} ${`${s.used}/${s.loaded}`.padStart(9)}  ~${formatTokens(s.tokens)}`);
  }
  if (!advice.length) { out('\nEverything recorded here is used, too small to suggest, or has no supported local switch.'); return; }
  const total = advice.reduce((n, s) => n + s.tokens, 0);
  out(`\nWorth switching off here, ~${formatTokens(total)} tokens across these source listings (varies by agent):`);
  for (const s of advice) {
    out(`- ${s.client === 'codex' ? 'Codex: ' : ''}${s.name} (${KIND[s.kind]}): ${s.unused ? 'no session here used it' : `${s.used} of ${s.loaded} sessions used it`}, ~${formatTokens(s.tokens)} tokens each.`);
    out(`  ${s.action}`);
  }
  out('\nNothing was changed. `thinker harness --suggest` asks you in your next Claude Code or Codex prompt here, all of them in one question.');
}

export const commands = { harness: harnessCommand };
