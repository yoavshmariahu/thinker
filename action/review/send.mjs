#!/usr/bin/env node
// Asks the team's thinker server to review a pull request and post the review on it, then waits for
// the result so the check can fail on a violated behavior. Runs in GitHub Actions (action/review,
// with `url`) on `pull_request`; nothing but Node is needed, and no model key: the server reviews
// with its own model and posts with its own GitHub token.
//
//   THINKER_SYNC_URL        https://sync.example.com
//   THINKER_SYNC_TOKEN      a token with write scope for this repository
//   THINKER_REPO            repository id (default github.com/<GITHUB_REPOSITORY>)
//   THINKER_REVIEW_KINDS    note kinds to consult, comma-separated (default behavior; empty: every note)
//   THINKER_REVIEW_FAIL_ON  error (default) | warning | none
//   THINKER_REVIEW_QUIET    false: post a review even when there is nothing to report
//   THINKER_REVIEW_WAIT     seconds to wait for the result (default 600; 0: send and leave)
//   GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_STEP_SUMMARY   set by Actions
import fs from 'node:fs';

const env = process.env;
const url = String(env.THINKER_SYNC_URL || '').replace(/\/+$/, '');
const token = env.THINKER_SYNC_TOKEN;
const slug = env.GITHUB_REPOSITORY;
const repoId = (env.THINKER_REPO || `github.com/${slug}`).toLowerCase();
const fail = msg => { console.error(`thinker: ${msg}`); process.exit(1); };
if (!url) fail('THINKER_SYNC_URL is required');
if (!token) { console.log('thinker: no THINKER_SYNC_TOKEN (the repository secret is not set); nothing sent'); process.exit(0); }
if (!slug) fail('GITHUB_REPOSITORY is not set');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function server(method, p, body) {
  const res = await fetch(`${url}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'thinker-action' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url}${p}: ${res.status} ${json.error || res.statusText}`);
  return json;
}

async function main() {
  let event = {}; try { event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch { fail('no event payload; run this on pull_request'); }
  const pr = event.pull_request;
  if (!pr) fail('the event carries no pull request; run this on pull_request');
  const kinds = env.THINKER_REVIEW_KINDS === undefined ? ['behavior'] : env.THINKER_REVIEW_KINDS.split(',').map(s => s.trim()).filter(Boolean);
  const failOn = (env.THINKER_REVIEW_FAIL_ON || 'error').toLowerCase();
  const req = { number: pr.number, title: pr.title, headSha: pr.head?.sha, headRef: pr.head?.ref, baseRef: pr.base?.ref, baseSha: pr.base?.sha, apiUrl: env.GITHUB_API_URL || undefined, kinds, failOn, quiet: env.THINKER_REVIEW_QUIET !== 'false' };
  const q = await server('POST', `/v1/repos/${encodeURIComponent(repoId)}/reviews`, req);
  if (!q.reviews) console.log(`thinker: the server has no checkout or model for ${repoId} yet; the review waits there`);
  if (!q.posts) console.log('thinker: the server has no GitHub token (THINKER_SERVER_GITHUB_TOKEN); it will review but not post');
  console.log(`thinker: PR #${pr.number} at ${String(req.headSha || req.headRef).slice(0, 10)} ${q.queued ? 'queued for review' : q.status === 'done' ? 'was already reviewed' : `is ${q.status}`} at ${url}`);
  const wait = Number(env.THINKER_REVIEW_WAIT ?? 600);
  let rec = q.queued ? null : q;
  const until = Date.now() + wait * 1000;
  while (!(rec && (rec.status === 'done' || rec.status === 'failed'))) {
    if (!q.reviews || wait <= 0 || Date.now() > until) { console.log(`thinker: not waiting ${wait > 0 && q.reviews ? 'any longer' : ''}for the result; the server posts the review when it is done`); return; }
    await sleep(Number(env.THINKER_REVIEW_POLL_MS) || 10_000);
    rec = (await server('GET', `/v1/repos/${encodeURIComponent(repoId)}/reviews/${pr.number}`)).review;
    if (rec && rec.headSha && req.headSha && rec.headSha !== req.headSha && rec.status !== 'queued') { console.log(`thinker: the server reviewed a newer head (${rec.headSha.slice(0, 10)}); this run stands down`); return; }
  }
  if (rec.status === 'failed') fail(`the review failed on the server: ${rec.error}`);
  if (rec.body) {
    console.log(rec.body.replace(/^<!--.*-->\n/, ''));
    if (env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, rec.body.replace(/^<!--.*-->\n/, '') + '\n'); } catch {} }
  }
  console.log(`thinker: ${rec.posted ? `posted a ${rec.event} review` : rec.wouldPost ? `the review was not posted${rec.postStatus ? ` (${rec.postStatus})` : ''}` : 'nothing to post'} (${rec.summary}${rec.cost ? `, $${Number(rec.cost).toFixed(2)}` : ''})`);
  if (rec.fail) fail(`failing the check (${rec.summary})`);
}
main().catch(e => fail(e.message));
