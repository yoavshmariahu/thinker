// After an update (`thinker rewire`, which the new copy runs for every checkout it is wired into): the background
// work an older version started and the new defaults no longer do, stopped. Since 2026-10-21 background learning is
// the session's distillation and the verification batch alone (maintain.js); mining pull requests and commits, the
// focus-area walk and the unmined-commits question are off unless `maintain: { prs: true }` (`maintain.prs`).
//   - a mining batch still running from before the update is stopped (activity.js:cancelActivity);
//   - an unmined-commits question waiting for the next prompt is dropped (commits-offer.js state);
//   - a queued job that is not a distillation, a catch-up, a maintenance run or an explanation is dropped
//     (session-work.js queue).
// A repository whose config turns mining on keeps all of it.
import fs from 'node:fs';
import path from 'node:path';
import { activity, cancelActivity } from './activity.js';
import { maintainConfig } from './maintain.js';
import { pendingJobs } from './session-work.js';

// `explain` is kept because it is the only way the words under the Save page's cards are ever written in a desktop
// app (part-explain.js, commands/explain.js): the hooks there have no agent CLI to call, so a person asking for a
// card queues this job and waits for the session's own model. Dropping it at the next update made that path dead.
const KEPT_JOBS = new Set(['distill', 'learn', 'maintain', 'explain']);
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function retireBackground(store, { dry = false } = {}) {
  const done = [];
  if (!store.exists()) return done;
  let cfg; try { cfg = maintainConfig(store); } catch { return done; }
  if (cfg.prs) return done;
  const a = activity(store.dir);
  if (a?.kind === 'mining') { if (!dry) cancelActivity(store.dir, a.pid); done.push(`stopped a mining batch (${a.completed}/${a.total})`); }
  const commits = path.join(store.dir, 'state', 'commits.json'), st = readJson(commits);
  if (st?.pending) { if (!dry) { delete st.pending; fs.writeFileSync(commits, JSON.stringify(st)); } done.push('dropped the unmined-commits question'); }
  for (const j of pendingJobs(store)) {
    if (j.running || KEPT_JOBS.has(j.args?.[0])) continue;
    if (!dry) fs.rmSync(j.file, { force: true });
    done.push(`dropped a queued ${j.args?.[0] || 'job'}`);
  }
  if (done.length && !dry) store.log({ op: 'retire-background', done });
  return done;
}
