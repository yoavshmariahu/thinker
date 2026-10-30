import { deliveryReport, renderDelivery, linkSession, syncPrs, ghAvailable, WINDOW_DAYS } from '../delivery.js';
import { positiveInteger } from '../delivery-journal.js';
import { commentOnPr } from '../delivery-comment.js';
import { runAutomaticPrComments } from '../delivery-auto.js';

async function prsCommand({ store, pos, flags, out }) {
  const pr = flags.pr === undefined ? undefined : positiveInteger(flags.pr, 'PR');
  const days = flags.days === undefined ? WINDOW_DAYS : positiveInteger(flags.days, 'days');
  if (pos[0] === 'auto') {
    if (pos.length !== 1 || pr !== undefined || flags.days !== undefined) throw new Error('Usage: thinker prs auto [--dry] [--json]');
    const r = await runAutomaticPrComments(store, { dry: !!flags.dry });
    if (flags.json) out(JSON.stringify(r, null, 2));
    else if (!flags.quiet) out(r.skipped ? `PR comments skipped: ${r.skipped}` : r.initialized ? 'Automatic PR comments initialized; only future merges will be posted.' : `${flags.dry ? r.candidates.length + ' eligible' : r.posted + ' posted'} PR savings comments${r.errors.length ? `; ${r.errors.length} errors (see --json)` : ''}.`);
    if (r.errors?.length) process.exitCode = 1;
    return;
  }
  if (pos[0] === 'comment') {
    if (pos.length !== 1) throw new Error('Usage: thinker prs comment --pr <number> [--days n] [--dry]');
    const r = await commentOnPr(store, { pr, days, dry: !!flags.dry });
    out(flags.json ? JSON.stringify(r, null, 2) : r.action === 'preview' ? r.body : `Savings comment ${r.action}: ${r.url}`);
    return;
  }
  if (pos[0] === 'sync') {
    if (!ghAvailable(store.repo)) throw new Error('Reading pull requests needs the GitHub CLI, logged in: gh auth login');
    const r = await syncPrs(store, { pr, days });
    out(flags.json ? JSON.stringify(r, null, 2) : `Read ${r.synced} pull ${r.synced === 1 ? 'request' : 'requests'} from GitHub. Run thinker prs to see what they cost and what was saved.`);
    return;
  }
  if (pos[0] === 'link') {
    const allocations = typeof flags.split === 'string'
      ? flags.split.split(',').map(s => { const [n, share] = s.split(':'); return { pr: n, share: Number(share) }; })
      : [{ pr, share: 1 }];
    const r = linkSession(store, flags.session, allocations);
    out(flags.json ? JSON.stringify(r, null, 2) : `Session ${r.session} belongs to ${r.allocations.map(a => `#${a.pr}`).join(', ')}.`);
    return;
  }
  if (pos.length) throw new Error(`Unknown prs subcommand: ${pos[0]}`);
  const r = deliveryReport(store, { pr, days });
  out(flags.json ? JSON.stringify(r, null, 2) : renderDelivery(r, { detail: pr !== undefined || !!flags.detail }));
}

export const commands = { prs: prsCommand };
