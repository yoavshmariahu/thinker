#!/usr/bin/env node
// Posts a `thinker review --json` report to the pull request as one review (src/review-post.js):
// findings on changed lines as inline comments, the rest and the desired behaviors in play in the
// review body. Runs in GitHub Actions after the review step of action/review/action.yml when the
// review ran on the runner; with a server (`url`), send.mjs is used instead and the server posts.
//
//   argv[2]                      the report file (`thinker review --json > report.json`)
//   GITHUB_TOKEN                 to read and write pull request reviews (pull-requests: write)
//   GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL, GITHUB_STEP_SUMMARY   set by Actions
//   THINKER_REVIEW_FAIL_ON       error (default) | warning | none: when the step fails
//   THINKER_REVIEW_POST          false: print the review, post nothing
//   THINKER_REVIEW_QUIET         false: post a review even when every behavior is upheld and there is nothing to report
//
import fs from 'node:fs';
import { buildReview, publish, MARKER } from '../../src/review-post.js';
export { buildReview, publish, MARKER };

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
