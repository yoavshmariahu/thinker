import fs from 'node:fs';
import { readLog } from '../usage.js';
import { repoId } from '../store.js';
import { impactReport, renderImpact, linkSession, decideFinding, syncImpact, positiveInteger } from '../impact.js';
import { readImpact, appendImpact, digest } from '../impact-journal.js';

async function impactCommand({ store, pos, flags, out }) {
  const pr = flags.pr === undefined ? undefined : positiveInteger(flags.pr, 'PR');
  const days = flags.days === undefined ? 30 : positiveInteger(flags.days, 'days');
  let result;
  if (pos[0] === 'export') {
    const events = readImpact(store).events;
    for (const e of readLog(store)) if (['orient', 'lookup', 'late', 'attest'].includes(e.op) && e.session) {
      events.push({ schema: 1, eventId: `usage-${digest(e)}`, t: e.t, origin: repoId(store.repo), op: e.op, session: e.session, served: e.served, applied: e.applied?.map(a => ({ id: a.id, verdict: a.verdict })) });
    }
    out(JSON.stringify({ schema: 1, origin: repoId(store.repo), events }, null, 2)); return;
  } else if (pos[0] === 'import') {
    if (!pos[1]) throw new Error('usage: thinker impact import <export-or-review.json>');
    const data = JSON.parse(fs.readFileSync(pos[1], 'utf8'));
    const events = data.impact?.events || data.events;
    if (!Array.isArray(events)) throw new Error('Expected an impact export or thinker review JSON report');
    const allowed = new Set(['session', 'model', 'impact-pr', 'impact-link', 'impact-review', 'impact-decision', 'impact-observation', 'orient', 'lookup', 'late', 'attest']);
    // Validate the entire import before appending anything. Reimport is idempotent.
    for (const e of events) {
      if (e.schema !== 1 || typeof e.eventId !== 'string' || typeof e.t !== 'string' || !Number.isFinite(Date.parse(e.t)) || e.origin !== repoId(store.repo) || !allowed.has(e.op)) throw new Error('Invalid impact event or repository mismatch');
      if (e.op === 'impact-pr') positiveInteger(e.pr?.number, 'PR');
      if (e.op === 'impact-review' && (!e.runId || !Array.isArray(e.findings))) throw new Error('Invalid review event');
      if (e.op === 'impact-link' && (!e.session || !Array.isArray(e.allocations) || e.allocations.some(a => !Number.isInteger(a.pr) || a.pr <= 0 || !Number.isFinite(a.share) || a.share <= 0) || Math.abs(e.allocations.reduce((n, a) => n + a.share, 0) - 1) > 1e-9 || new Set(e.allocations.map(a => a.pr)).size !== e.allocations.length)) throw new Error('Invalid session allocations');
    }
    const seen = new Set(readImpact(store).events.map(e => e.eventId));
    let imported = 0;
    for (const e of events) if (!seen.has(e.eventId)) { appendImpact(store, e); seen.add(e.eventId); imported++; }
    result = { imported };
  } else if (pos[0] === 'sync') result = await syncImpact(store, { pr, days });
  else if (pos[0] === 'link') {
    const allocations = typeof flags.split === 'string' ? flags.split.split(',').map(s => { const [n, share] = s.split(':'); return { pr: n, share: Number(share) }; }) : [{ pr, share: 1 }];
    result = linkSession(store, flags.session, allocations);
  } else if (pos[0] === 'finding') result = decideFinding(store, { pr, finding: pos[1], validity: flags.validity, resolution: flags.resolution, evidence: flags.evidence, fixCommit: flags.fix, duplicateOf: flags['duplicate-of'] });
  else if (pos[0] === 'link-review') {
    if (!pr || !pos[1]) throw new Error('usage: thinker impact link-review <run-id> --pr <number>');
    const review = readImpact(store).events.filter(e => e.op === 'impact-review' && e.runId === pos[1]).at(-1);
    if (!review) throw new Error('Unknown review run ID');
    result = appendImpact(store, { ...review, completedAt: review.completedAt || review.t, eventId: undefined, t: undefined, pr });
  } else if (pos.length) throw new Error(`Unknown impact subcommand: ${pos[0]}`);
  else { const r = impactReport(store, { pr, days }); out(flags.json ? JSON.stringify(r, null, 2) : renderImpact(r, { detail: pr !== undefined })); return; }
  out(flags.json ? JSON.stringify(result, null, 2) : pos[0] === 'sync' ? `Synced ${result.synced} PRs. Run thinker impact to see delivery outcomes.` : pos[0] === 'import' ? `Imported ${result.imported} events.` : 'Impact evidence recorded.');
}
export const commands = { impact: impactCommand };
