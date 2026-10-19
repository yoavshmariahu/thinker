// `thinker commits`: how many direct commits (naming no pull request) the cache has not mined
// (commits-offer.js), or, with --answer, the reply to the unmined-commits question the hooks put to the agent.
import { answerCommits, unminedCommits, COMMITS } from '../commits-offer.js';

async function commitsCommand(ctx) {
  const { flags, store, out } = ctx;
  if (flags.answer !== undefined) {
    out(await answerCommits(store, String(flags.answer === true ? '' : flags.answer), { client: flags.client ? String(flags.client) : undefined, via: flags.via === 'text' ? 'text' : 'picker' }));
    return;
  }
  const { count, scanned } = unminedCommits(store);
  out(`${count} of the last ${scanned} commits on the default branch name no pull request and are not mined${count ? ` (thinker mine-prs --direct --limit ${Math.min(count, COMMITS.limit)} mines them)` : ''}`);
}

export const commands = { commits: commitsCommand };
