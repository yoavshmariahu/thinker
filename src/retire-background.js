// After an update (`thinker rewire`, which the new copy runs for every checkout it is wired into): the background
// work an older version started and the new defaults no longer do, stopped. Since 2026-11-08 background learning is
// the session's read into the profile alone (profile.js); the mining, the verification and the notes themselves went
// with the knowledge notes (notes-retired.js removes what a checkout kept of them).
//   - a mining batch still running from before the update is stopped (activity.js:cancelActivity);
//   - an unmined-commits question waiting for the next prompt is dropped (commits-offer.js state);
//   - a queued job that is not a distillation, a catch-up, a maintenance run or an explanation is dropped
//     (session-work.js queue).
//   - the focus-area list the warm-up scoped itself by is dropped from the config (areas.js);
//   - the behavior drafts its last step wrote are dropped, with `thinker system propose` (2026-10-30).
import fs from 'node:fs';
import path from 'node:path';
import { activity, cancelActivity } from './activity.js';
import { pendingJobs } from './session-work.js';

// `explain` is kept because it is the only way the words under the Save page's cards are ever written in a desktop
// app (part-explain.js, commands/explain.js): the hooks there have no agent CLI to call, so a person asking for a
// card queues this job and waits for the session's own model. Dropping it at the next update made that path dead.
const KEPT_JOBS = new Set(['distill', 'learn', 'maintain', 'explain']);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function retireBackground(store, { dry = false } = {}) {
  const done = [];
  if (!store.exists()) return done;
  const a = activity(store.dir);
  if (a?.kind === 'mining') { if (!dry) cancelActivity(store.dir, a.pid); done.push(`stopped a mining batch (${a.completed}/${a.total})`); }
  const commits = path.join(store.dir, 'state', 'commits.json'), st = readJson(commits);
  if (st?.pending) { if (!dry) { delete st.pending; fs.writeFileSync(commits, JSON.stringify(st)); } done.push('dropped the unmined-commits question'); }
  // The focus areas of the removed warm-up (areas.js): nothing has refreshed or walked them since
  // 2026-10-21, and the saved list was read as a live setting - a user reported theirs as out of date
  // in October 2026, listing a directory that no longer existed.
  const cfgFile = path.join(store.dir, 'config.json');
  const raw = readJson(cfgFile);
  if (raw && raw.areas) {
    if (!dry) { delete raw.areas; fs.writeFileSync(cfgFile, JSON.stringify(raw, null, 2) + '\n'); }
    done.push('dropped the focus-area list of the removed warm-up');
  }
  // the build's behavior drafts, with `thinker system propose` (2026-10-30): nothing lists them now
  const drafts = path.join(store.localDir || path.join(store.dir, 'local'), 'behavior-proposals.json');
  if (fs.existsSync(drafts)) {
    if (!dry) fs.rmSync(drafts, { force: true });
    done.push('dropped the unreviewed behavior drafts of the removed cache build');
  }
  for (const j of pendingJobs(store)) {
    if (j.running || KEPT_JOBS.has(j.args?.[0])) continue;
    if (!dry) fs.rmSync(j.file, { force: true });
    done.push(`dropped a queued ${j.args?.[0] || 'job'}`);
  }
  if (done.length && !dry) store.log({ op: 'retire-background', done });
  return done;
}
