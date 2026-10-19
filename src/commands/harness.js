// `thinker harness`: what the agent loads into every session here against what the sessions use,
// and the sources worth switching off (harness.js). The report reads transcripts and settings and changes
// nothing; --suggest queues the question for the next prompt, --answer takes its reply, --undo reverses them.
import { harnessUsage, harnessAdvice, MIN_TOKENS, scheduleHarnessSuggestion, answerHarness, undoHarness } from '../harness.js';
import { formatTokens } from '../model-usage.js';

const KIND = { plugin: 'plugin', mcp: 'MCP server', connector: 'claude.ai connector', skill: 'skill' };

async function harnessCommand({ store, repo, flags, out }) {
  if (flags.answer !== undefined) { out(answerHarness(store, String(flags.answer === true ? '' : flags.answer), { client: flags.client ? String(flags.client) : undefined, via: flags.via === 'text' ? 'text' : 'picker' })); return; }
  if (flags.undo) { out(undoHarness(store)); return; }
  const days = Number(flags.days) || 30;
  const usage = harnessUsage(repo, { days });
  if (flags.suggest) {
    const picks = scheduleHarnessSuggestion(store, { force: true, usage });
    out(picks?.length ? `Queued: your next prompt in Claude Code here asks which of ${picks.length} source${picks.length === 1 ? '' : 's'} to switch off (${picks.map(p => p.name).join(', ')}).` : 'Nothing here is worth switching off; no question queued.');
    return;
  }
  const advice = harnessAdvice(usage);
  if (flags.json) { out(JSON.stringify({ ...usage, advice }, null, 2)); return; }
  if (!usage.sessions) { out(`No Claude Code session here in the last ${days} days records what it loaded.`); return; }
  out(`What Claude Code loaded into ${usage.sessions} sessions here over ${days} days, and how many used it:\n`);
  out(`  ${'source'.padEnd(34)} ${'kind'.padEnd(20)} ${'used'.padStart(9)}  tokens each`);
  for (const s of usage.sources.filter(s => s.tokens >= MIN_TOKENS).slice(0, flags.verbose ? undefined : 15)) {
    out(`  ${s.name.slice(0, 34).padEnd(34)} ${(KIND[s.kind] + (s.scope && s.kind !== 'connector' ? ` (${s.scope})` : '')).padEnd(20)} ${`${s.used}/${s.loaded}`.padStart(9)}  ~${formatTokens(s.tokens)}`);
  }
  if (!advice.length) { out('\nEverything loaded here is used, or Claude Code builds it in.'); return; }
  const total = advice.reduce((n, s) => n + s.tokens, 0);
  out(`\nWorth switching off here, ~${formatTokens(total)} tokens in every session:`);
  for (const s of advice) {
    out(`- ${s.name} (${KIND[s.kind]}): ${s.unused ? 'no session here used it' : `${s.used} of ${s.loaded} sessions used it`}, ~${formatTokens(s.tokens)} tokens each.`);
    out(`  ${s.action}`);
  }
  out('\nNothing was changed. `thinker harness --suggest` asks you in your next Claude Code prompt here, all of them in one question.');
}

export const commands = { harness: harnessCommand };
