// Explicit, model-free publishing of the local PR report. Ordinary sync never posts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoId } from './store.js';
import { thinkerHome } from './update.js';
import { deliveryFile, digest, positiveInteger } from './delivery-journal.js';
import { deliveryReport, githubReader, syncPrs, WINDOW_DAYS } from './delivery.js';
import { grossSavingsCost, formatDollars } from './prices.js';
import { formatTokens } from './model-usage.js';

// Same author on two machines must not replace one machine's figures with the other's.
export const commentMarker = (home = thinkerHome()) => `<!-- thinker-pr-savings:v1:${digest([os.hostname(), path.resolve(home)])} -->`;

export function renderSavingsComment(report, pr, marker, { config } = {}) {
  const cost = grossSavingsCost(pr.sessions, { config });
  const estimate = cost.total === null
    ? 'Cost estimate unavailable: model prices unknown.'
    : `**~${formatDollars(cost.total)} USD estimated gross API value avoided${cost.unpricedTokens ? ' (partial)' : ''}.**`;
  const savings = [
    ...(pr.saved.cleared ? [`**${formatTokens(pr.saved.cleared)} tokens cleared** (measured)`] : []),
    ...(pr.saved.reading.tokens ? [`**${formatTokens(pr.saved.reading.tokens)} tokens of reading avoided** (estimated)`] : []),
  ];
  return [
    marker,
    '### 🧠 thinker saved you some tokens!',
    '',
    savings.join(' · '),
    '',
    estimate,
    ...(cost.unpricedTokens ? [`${formatTokens(cost.unpricedTokens)} tokens excluded from pricing (unknown rates).`] : []),
    '',
    `From ${pr.sessions.length} linked ${pr.sessions.length === 1 ? 'session' : 'sessions'} on this machine · ${report.since.slice(0, 10)}–${report.generatedAt.slice(0, 10)} UTC.`,
    '',
    '*Session totals, not PR-only savings. Cost excludes rewrite and learning overhead; not a measured bill reduction.*',
  ].join('\n');
}

export const githubWriter = repo => (endpoint, { method, body }) =>
  JSON.parse(execFileSync('gh', ['api', '--method', method, endpoint, '--input', '-'], {
    cwd: repo, input: JSON.stringify({ body }), encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
  }));

export async function commentOnPr(store, {
  pr, days = WINDOW_DAYS, dry = false, home = thinkerHome(), now = Date.now(),
  request = githubReader(store.repo), write = githubWriter(store.repo),
} = {}) {
  if (pr === undefined) throw new Error('Posting savings requires --pr <number>');
  pr = positiveInteger(pr, 'PR');
  days = positiveInteger(days, 'days');
  const origin = repoId(store.repo);
  if (!/^github\.com\/[^/]+\/[^/]+$/.test(origin)) throw new Error('Posting savings needs a github.com origin');
  const root = `repos/${origin.slice('github.com/'.length)}`;
  const file = deliveryFile(store);
  if (!file) throw new Error('Posting savings needs local delivery records; THINKER_LOG=off disables them');

  // Serialize scheduled/manual runs across worktrees sharing this journal. Never steal a live lock.
  const lock = `${file}.comment-${pr}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`A savings comment run holds ${lock}. If it stopped unexpectedly, remove that lock before retrying.`);
    throw e;
  }
  try {
    fs.writeFileSync(fd, String(process.pid));
    // Refresh competing PRs too: syncing only the target can misassign a reused branch.
    await syncPrs(store, { days, request, now, home });
    await syncPrs(store, { pr, days, request, now, home });
    const report = deliveryReport(store, { pr, days, now, home });
    const target = report.prs.find(p => p.number === pr);
    if (target?.state !== 'MERGED' || !target.mergedAt) throw new Error(`PR #${pr} is not merged; nothing was posted`);
    if (report.warnings.length) throw new Error(`Cannot publish incomplete delivery records: ${report.warnings.join('; ')}`);
    if (!target.sessions.length) throw new Error(`No recorded sessions linked to PR #${pr} in the last ${days} days; use thinker prs link or a wider --days window`);
    if (!(target.saved.total > 0)) throw new Error(`No savings recorded for PR #${pr}; nothing was posted`);
    const marker = commentMarker(home);
    const body = renderSavingsComment(report, target, marker, { config: store.config() });
    if (dry) return { action: 'preview', pr, body };

    const user = await request('user');
    if (!Number.isSafeInteger(user.id)) throw new Error('GitHub did not identify the authenticated user; nothing was posted');
    const comments = (await request(`${root}/issues/${pr}/comments?per_page=100`, { paginate: true })).flat();
    const previous = comments.find(c => c.user?.id === user.id && c.body?.startsWith(marker + '\n'));
    if (previous?.body === body) return { action: 'unchanged', pr, url: previous.html_url, body };
    const result = await write(previous ? `${root}/issues/comments/${previous.id}` : `${root}/issues/${pr}/comments`, {
      method: previous ? 'PATCH' : 'POST', body,
    });
    return { action: previous ? 'updated' : 'posted', pr, url: result.html_url, body };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
