// `thinker instructions`: what this repository's instruction files cost the sessions here, a slim core for
// them (instructions.js), and the budget check for CI. The slim is a model call: through the agent CLI the
// person signed in with, or queued for the next desktop-app session when none is (session-work.js).
import { instructionCost, renderInstructionCost, slimInstructions, renderSlim, checkInstructions } from '../instructions.js';
import { enqueueJob, recentAppSession } from '../session-work.js';

async function instructionsCommand(ctx) {
  const { pos, flags, store, repo, out } = ctx;
  const sub = pos[0] || 'cost';
  if (sub === 'cost' || sub === 'report') {
    const c = instructionCost(store, { days: Number(flags.days) || undefined });
    if (flags.json) return out(JSON.stringify({ ...c, slim: c.slim || null }, null, 2));
    return out(renderInstructionCost(c));
  }
  if (sub === 'check') {
    const r = checkInstructions(store, { budget: Number(flags.budget) || undefined });
    out(flags.json ? JSON.stringify(r) : r.line);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (sub === 'slim') {
    const opts = { budget: Number(flags.budget) || undefined, model: flags.model || 'sonnet', write: !!flags.write, dry: !!flags.dry };
    try {
      const r = await slimInstructions(store, opts);
      return out(renderSlim(r));
    } catch (e) {
      // no model here (a desktop app with no CLI signed in): the next app session does it through itself
      if (/no model available|not available here/.test(String(e.message)) && recentAppSession(store)) {
        enqueueJob(store, 'instructions-slim', ['instructions', 'slim', '--repo', repo, ...(opts.budget ? ['--budget', String(opts.budget)] : []), ...(opts.write ? ['--write'] : [])]);
        return out('No agent CLI is signed in here, so the core will be written through your next session in the desktop app (thinker queues it; the session starts the work). Run `thinker instructions` afterwards to see it.');
      }
      throw e;
    }
  }
  throw new Error('usage: thinker instructions [cost|slim [--budget n] [--model m] [--write] [--dry]|check [--budget n]]');
}

export const commands = { instructions: instructionsCommand };
