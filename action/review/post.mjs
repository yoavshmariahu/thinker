#!/usr/bin/env node
// Posts a `thinker review --json` report to the pull request as one review: findings on changed
// lines as inline comments, the rest and the desired behaviors in play in the review body. Runs in
// GitHub Actions after the review step of action/review/action.yml; nothing but Node is needed.
//
//   argv[2]                      the report file (`thinker review --json > report.json`)
//   GITHUB_TOKEN                 to read and write pull request reviews (pull-requests: write)
//   GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL, GITHUB_STEP_SUMMARY   set by Actions
//   THINKER_REVIEW_FAIL_ON       error (default) | warning | none: when the step fails
//   THINKER_REVIEW_POST          false: print the review, post nothing
//   THINKER_REVIEW_QUIET         false: post a review even when every behavior is upheld and there is nothing to report
//
// A review requesting changes that an earlier run posted is dismissed when a newer run posts, so a
// push that fixes the violation clears the request; a plain comment review is left where it is.
import fs from 'node:fs';

export const MARKER = '<!-- thinker-review -->';
const ICON = { violated: '❌', upheld: '✅', revised: '✏️', unrelated: '➖', consulted: '👀' };
const SEV = { error: 0, warning: 1, info: 2 };
const esc = s => String(s || '').replace(/</g, '&lt;');
const code = s => '`' + String(s || '').replace(/`/g, 'ˋ') + '`';

// The review as GitHub takes it: {post, event, body, comments: [{path, line, side, body}], fail, summary}.
export function buildReview(report, { failOn = 'error', quiet = true } = {}) {
  const r = report || {};
  const counts = r.counts || { error: 0, warning: 0, info: 0 };
  const titles = new Map([...(r.behaviors || []), ...(r.toAssess || [])].map(n => [n.id, n.title]));
  const label = f => { const ids = f.notes?.length ? f.notes : f.note ? [f.note] : []; return ids.length ? ids.map(id => titles.has(id) ? `${titles.get(id)} (${id})` : id).join(', ') : f.basis || 'from the code'; };
  const findings = [...(r.findings || [])].sort((a, b) => (SEV[a.severity] ?? 1) - (SEV[b.severity] ?? 1) || (b.confidence || 0) - (a.confidence || 0));
  const inline = [], rest = [];
  for (const f of findings) (f.file && f.line > 0 && f.inChange ? inline : rest).push(f);
  const one = f => `**${f.severity}** ${esc(f.message)}${f.evidence ? `\n\n> ${esc(f.evidence).split('\n').map(s => s.trim()).filter(Boolean).join('\n> ')}` : ''}\n\n<sub>${esc(label(f))}${f.confidence ? `, ${Math.round(f.confidence * 100)}%` : ''}</sub>`;
  const comments = inline.map(f => ({ path: f.file, line: f.line, side: 'RIGHT', body: `${MARKER}\n${one(f)}` }));
  const behaviors = r.behaviors || [];
  const violated = behaviors.filter(b => b.outcome === 'violated');
  const L = [MARKER, `### thinker review${r.scope ? ` · ${esc(r.scope)}` : ''}`, ''];
  if (r.error) L.push(`The review could not run: ${esc(r.error)}`, '');
  else if (r.noCache) L.push('This repository has no `.thinker/` cache, so there is nothing to review against. Run `thinker setup` and commit a few desired behaviors (`thinker system add`).', '');
  else if (r.empty) L.push('Nothing to review: the change holds no code the notes could speak to.', '');
  else {
    L.push(`${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}, ${counts.info} info · ${r.notes?.consulted ?? 0} ${r.kinds?.length === 1 && r.kinds[0] === 'behavior' ? 'desired behavior' : 'note'}${(r.notes?.consulted ?? 0) === 1 ? '' : 's'} consulted${r.notes?.assessed ? `, ${r.notes.assessed} assessed with ${esc(r.model)}` : ''}${r.cost ? ` ($${Number(r.cost).toFixed(2)})` : ''}`, '');
    if (behaviors.length) {
      L.push('#### Desired behaviors in play', '', '| | behavior | outcome |', '|---|---|---|');
      for (const b of behaviors) L.push(`| ${ICON[b.outcome] || ''} | ${esc(b.title)} <sub>${b.mutability}, ${code(b.id)}</sub> | ${b.outcome}${b.outcome === 'violated' && b.reason ? `: ${esc(b.reason).slice(0, 200)}` : b.outcome === 'revised' ? ' (this change edits the behavior note)' : ''}${b.before ? ` <sub>${esc(b.before)}</sub>` : ''} |`);
      L.push('');
    }
    if (rest.length) {
      L.push(`#### Findings${inline.length ? ' not on a changed line' : ''}`, '');
      for (const f of rest) L.push(`- **${f.severity}** ${f.file ? code(`${f.file}${f.line ? ':' + f.line : ''}`) + ' ' : ''}${esc(f.message)} <sub>${esc(label(f))}${f.confidence ? `, ${Math.round(f.confidence * 100)}%` : ''}</sub>`);
      L.push('');
    }
    if (inline.length) L.push(`${inline.length} finding${inline.length === 1 ? '' : 's'} on changed lines ${inline.length === 1 ? 'is' : 'are'} commented inline.`, '');
    const cache = [];
    const n = r.notes || {};
    if (n.staleBefore?.length) cache.push(`${n.staleBefore.length} consulted note${n.staleBefore.length === 1 ? ' was' : 's were'} already stale before this change: ${n.staleBefore.map(s => code(s.id)).join(', ')}`);
    if (n.outdated?.length) cache.push(`${n.outdated.length} note${n.outdated.length === 1 ? '' : 's'} the review found outdated: ${n.outdated.map(o => `${code(o.id)} (${esc(o.reason)})`).join('; ')}`);
    if (n.uncovered?.length) cache.push(`no ${r.kinds?.length ? 'desired behavior' : 'cached knowledge'} rests on ${n.uncovered.slice(0, 8).map(code).join(', ')}${n.uncovered.length > 8 ? ` (+${n.uncovered.length - 8} more)` : ''}`);
    if (r.errors?.length) cache.push(`${r.errors.length} note${r.errors.length === 1 ? '' : 's'} could not be assessed: ${r.errors.map(e => `${code(e.id)} (${esc(e.error)})`).join('; ')}`);
    if (cache.length) { L.push('<details><summary>Cache state</summary>', ''); for (const c of cache) L.push(`- ${c}`); L.push('', '</details>', ''); }
  }
  L.push('<sub>Posted by thinker: the change checked against the desired behaviors of the system and the notes resting on the changed code.</sub>');
  const body = L.join('\n');
  const fail = failOn === 'error' ? counts.error > 0 : failOn === 'warning' ? counts.error + counts.warning > 0 : false;
  const event = counts.error > 0 ? 'REQUEST_CHANGES' : 'COMMENT';
  const something = !!(r.error || findings.length || violated.length);
  const post = something || !quiet && !r.empty && !r.noCache && (behaviors.length > 0 || (r.notes?.consulted ?? 0) > 0);
  const summary = r.error ? `review failed: ${r.error}` : r.noCache ? 'no cache in this repository' : r.empty ? 'nothing to review' : `${counts.error} errors, ${counts.warning} warnings; ${violated.length} of ${behaviors.length} behaviors violated`;
  return { post, event, body, comments, fail, summary };
}

// Dismiss the earlier run's request for changes and post the new review; `fetch` is injectable.
export async function publish({ review, slug, number, sha, token, api = 'https://api.github.com', fetch: f = globalThis.fetch, log = console.log }) {
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'thinker-action', 'x-github-api-version': '2022-11-28' };
  const call = async (method, p, body) => {
    const res = await f(`${api}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text().catch(() => '');
    let json = {}; try { json = text ? JSON.parse(text) : {}; } catch {}
    return { ok: res.ok, status: res.status, json, text };
  };
  const prior = await call('GET', `/repos/${slug}/pulls/${number}/reviews?per_page=100`);
  const dismissed = [];
  if (prior.ok && Array.isArray(prior.json)) {
    for (const r of prior.json) {
      if (!String(r.body || '').includes(MARKER) || r.state !== 'CHANGES_REQUESTED') continue;
      const d = await call('PUT', `/repos/${slug}/pulls/${number}/reviews/${r.id}/dismissals`, { message: 'Superseded by a newer thinker review.', event: 'DISMISS' });
      if (d.ok) dismissed.push(r.id); else log(`thinker: could not dismiss review ${r.id}: ${d.status} ${d.json.message || ''}`);
    }
  }
  if (!review.post) return { posted: false, dismissed };
  const payload = { commit_id: sha, event: review.event, body: review.body, comments: review.comments };
  let res = await call('POST', `/repos/${slug}/pulls/${number}/reviews`, payload);
  if (!res.ok && res.status === 422 && review.comments.length) {
    // a line GitHub will not take a comment on (outside the diff as it sees it): everything into the body
    const folded = review.comments.map(c => `- ${code(`${c.path}:${c.line}`)} ${c.body.replace(MARKER, '').trim().replace(/\n+/g, ' ')}`).join('\n');
    res = await call('POST', `/repos/${slug}/pulls/${number}/reviews`, { ...payload, comments: [], body: review.body.replace(/\n<sub>Posted by thinker/, `\n#### Findings on changed lines\n\n${folded}\n\n<sub>Posted by thinker`) });
  }
  if (!res.ok) {
    if (res.status === 403) log('thinker: the token may not write reviews (a pull request from a fork gets a read-only GITHUB_TOKEN); the review is in the log and the step summary only');
    else log(`thinker: posting the review failed: ${res.status} ${res.json.message || res.text.slice(0, 200)}`);
    return { posted: false, dismissed, status: res.status };
  }
  return { posted: true, dismissed, id: res.json.id, status: res.status };
}

async function main() {
  const env = process.env;
  let report = {};
  try { report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch (e) { report = { error: `no report (${e.message})` }; }
  const review = buildReview(report, { failOn: (env.THINKER_REVIEW_FAIL_ON || 'error').toLowerCase(), quiet: env.THINKER_REVIEW_QUIET !== 'false' });
  console.log(review.body.replace(MARKER + '\n', ''));
  if (env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, review.body.replace(MARKER + '\n', '') + '\n'); } catch {} }
  if (env.THINKER_REVIEW_POST !== 'false') {
    let event = {}; try { event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch {}
    const pr = event.pull_request;
    if (!pr) console.log('thinker: no pull request in the event; nothing posted');
    else if (!env.GITHUB_TOKEN) console.log('thinker: GITHUB_TOKEN is not set; nothing posted');
    else {
      const r = await publish({ review, slug: env.GITHUB_REPOSITORY, number: pr.number, sha: pr.head?.sha, token: env.GITHUB_TOKEN, api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '') });
      console.log(`thinker: ${r.posted ? `posted a ${review.event} review` : review.post ? 'review not posted' : 'nothing to post'}${r.dismissed.length ? `; dismissed ${r.dismissed.length} earlier request${r.dismissed.length === 1 ? '' : 's'} for changes` : ''} (${review.summary})`);
    }
  }
  if (review.fail) { console.error(`thinker: failing the check (${review.summary})`); process.exit(1); }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main().catch(e => { console.error(`thinker: ${e.message}`); process.exit(1); });
