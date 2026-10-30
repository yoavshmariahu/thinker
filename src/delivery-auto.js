// Model-free PR comments piggyback on the existing update job, not on a prompt's work.
import fs from 'node:fs';
import path from 'node:path';
import { Store, isGitCheckout, logFile, repoId } from './store.js';
import { readLog } from './usage.js';
import { deliveryCheckouts } from './delivery-journal.js';
import { deliveryReport, syncPrs, ghAvailable, WINDOW_DAYS } from './delivery.js';
import { commentOnPr } from './delivery-comment.js';
import { isDisabledRepo } from './repo-switch.js';
import { thinkerHome, UPDATE_EVERY_MS } from './update.js';
import { isTestMode } from './test-mode.js';
import { withCommentLock } from './delivery-lock.js';

export const PR_COMMENT_IDLE_MS = 20 * 60_000;
export const PR_COMMENT_LIMIT = 10;
export const AUTO_PR_COMMENTS = true;
const DAY = 86400_000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${file}: ${e.message}`); }
}

export function commentRepos(store, { home = thinkerHome() } = {}) {
  const paths = new Set([store.repo]);
  for (const event of readLog(store, { all: true })) if (event.repo) paths.add(event.repo);
  for (const checkout of deliveryCheckouts(store)) paths.add(checkout);
  const repos = new Map(), excluded = new Set();
  for (const checkout of paths) {
    if (typeof checkout !== 'string' || !isGitCheckout(checkout)) continue;
    const s = new Store(checkout, { readonly: true }), id = repoId(checkout);
    if (!/^github\.com\/[^/]+\/[^/]+$/.test(id)) continue;
    try {
      const cfg = readJson(path.join(s.dir, 'config.json'), {});
      if (cfg.prComments === false || isDisabledRepo(checkout, { home })) { excluded.add(id); continue; }
    } catch { excluded.add(id); continue; }
    if (!repos.has(id)) repos.set(id, s);
  }
  return [...repos].filter(([id]) => !excluded.has(id)).map(([, s]) => s);
}

export async function runAutomaticPrComments(store, {
  home = thinkerHome(), now = Date.now(), dry = false, fns = {},
} = {}) {
  // Tests must supply all network boundaries. Never let a test's normal CLI update publish anything.
  if (isTestMode() && !(fns.sync && fns.comment && fns.available)) return { skipped: 'test' };
  if (!logFile(store)) return { skipped: 'logging-off' };
  const cfg = readJson(path.join(home, 'config.json'), {});
  if ((cfg.prComments ?? AUTO_PR_COMMENTS) === false) return { skipped: 'disabled' };
  const dir = path.join(home, 'state'), file = path.join(dir, 'pr-comments.json');
  const run = async () => {
    const state = readJson(file, null);
    const save = value => {
      fs.mkdirSync(dir, { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, file);
    };
    // Establish a start date before looking at GitHub: installing never backfills old PRs.
    if (!state) {
      if (!dry) save({ schema: 1, startedAt: new Date(now).toISOString(), repos: {} });
      return { initialized: !dry, candidates: [], posted: 0, errors: [] };
    }
    if (state.schema !== 1 || !Number.isFinite(Date.parse(state.startedAt)) || !state.repos || typeof state.repos !== 'object') throw new Error('Invalid automatic PR comment state; nothing posted');
    const result = { candidates: [], posted: 0, errors: [] };
    let attempts = 0;
    const repos = (fns.repos || commentRepos)(store, { home }).sort((a, b) =>
      (Date.parse(state.repos[repoId(a.repo)]?.checkedAt || '') || 0) - (Date.parse(state.repos[repoId(b.repo)]?.checkedAt || '') || 0));
    for (const s of repos) {
      const id = repoId(s.repo), previous = state.repos[id];
      if (!dry && now - Date.parse(previous?.checkedAt || '') < UPDATE_EVERY_MS) continue;
      const record = previous || { posted: {} };
      if (!record.posted || typeof record.posted !== 'object') throw new Error('Invalid automatic PR comment receipts; nothing posted');
      try {
        if (!dry && !(await (fns.available || ghAvailable)(s.repo))) continue;
        if (!dry) {
          const last = Date.parse(record.checkedAt || state.startedAt);
          const days = Math.min(WINDOW_DAYS, Math.max(2, Math.ceil((now - last) / DAY) + 1));
          await (fns.sync || syncPrs)(s, { days, now, home });
        }
        const report = (fns.report || deliveryReport)(s, { days: WINDOW_DAYS, now, home });
        if (report.warnings.length) throw new Error(report.warnings.join('; '));
        const candidates = report.prs.filter(p => p.state === 'MERGED' && Date.parse(p.mergedAt) > Date.parse(state.startedAt)
          && Date.parse(p.mergedAt) <= now - PR_COMMENT_IDLE_MS && p.sessions.length && p.saved.total > 0
          && p.sessions.every(x => Date.parse(x.lastAt) <= now - PR_COMMENT_IDLE_MS) && !record.posted[p.number])
          .sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
        for (const p of candidates) {
          result.candidates.push({ repo: id, pr: p.number });
          if (dry) continue;
          if (attempts >= PR_COMMENT_LIMIT) break;
          attempts++;
          try {
            const posted = await (fns.comment || commentOnPr)(s, { pr: p.number, home, now, syncWindow: false });
            if (!['posted', 'updated', 'unchanged'].includes(posted.action)) throw new Error('Comment was not published');
            record.posted[p.number] = { at: new Date(now).toISOString(), url: posted.url };
            state.repos[id] = record;
            save(state); // durable after each post; GitHub's marker handles a crash before the receipt
            result.posted++;
          } catch (e) { result.errors.push({ repo: id, pr: p.number, error: e.message }); }
        }
        if (!dry) { record.checkedAt = new Date(now).toISOString(); state.repos[id] = record; save(state); }
      } catch (e) { result.errors.push({ repo: id, error: e.message }); }
      if (!dry && attempts >= PR_COMMENT_LIMIT) break;
    }
    return result;
  };
  return dry ? run() : withCommentLock(path.join(dir, 'pr-comments.lock'), run);
}
