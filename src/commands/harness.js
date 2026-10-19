// `thinker harness`: what the agent loads into every session here against what the sessions use,
// and the sources worth switching off (harness.js). It reads transcripts and settings; it changes nothing.
import { harnessUsage, harnessAdvice, MIN_TOKENS } from '../harness.js';
import { formatTokens } from '../model-usage.js';

const KIND = { plugin: 'plugin', mcp: 'MCP server', connector: 'claude.ai connector', skill: 'skill' };

async function harnessCommand({ repo, flags, out }) {
  const days = Number(flags.days) || 30;
  const usage = harnessUsage(repo, { days });
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
  out('\nNothing was changed. Sources Claude Code builds in have no setting and are not listed.');
}

export const commands = { harness: harnessCommand };
