// `thinker coverage`: the directories this repository's sessions work in and how much of each the cache
// covers (coverage.js), or, with --answer, the reply to a coverage suggestion the hooks put to the agent.
import { answerCoverage, renderCoverage } from '../coverage.js';

async function coverageCommand(ctx) {
  const { flags, store, out } = ctx;
  if (flags.answer !== undefined) {
    out(await answerCoverage(store, String(flags.answer === true ? '' : flags.answer), { client: flags.client ? String(flags.client) : undefined, via: flags.via === 'text' ? 'text' : 'picker' }));
    return;
  }
  out(renderCoverage(store));
}

export const commands = { coverage: coverageCommand };
