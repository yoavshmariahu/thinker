// `thinker errors`: what thinker has failed at on this machine, and whether to send it.
//
// The list prints the records exactly as they would be sent, which is the only honest way to ask for
// consent: a person can read what leaves their machine before agreeing to it (error-report.js).
import { errorsReport, answerErrorOffer, sendErrors, errorConsent, readErrors } from '../error-report.js';

async function errorsCommand({ flags, store, out }) {
  if (flags.answer != null && flags.answer !== true) {
    out(await answerErrorOffer(String(flags.answer), { store, client: flags.client || null }));
    return;
  }
  if (flags.send) {
    if (errorConsent() !== 'yes') { out('Error reports are not turned on. `thinker errors --answer yes` turns them on.'); return; }
    const r = await sendErrors({ store });
    out(r.sent ? `Sent ${r.count} report${r.count === 1 ? '' : 's'}.` : `Nothing sent: ${r.reason || r.error || 'unknown'}.`);
    return;
  }
  if (flags.json) { out(JSON.stringify({ consent: errorConsent(), errors: readErrors() }, null, 2)); return; }
  out(errorsReport());
}

export const commands = { errors: errorsCommand };
