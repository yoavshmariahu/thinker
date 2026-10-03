#!/usr/bin/env node
// Sends one merged pull request to the team's thinker cache, where it is distilled into notes.
// Runs in GitHub Actions (see action.yml) on `pull_request: closed`; nothing but Node is needed.
//
//   THINKER_SYNC_URL      https://sync.example.com
//   THINKER_SYNC_TOKEN    a token with write scope for this repository
//   THINKER_REPO          repository id (default github.com/<GITHUB_REPOSITORY>)
//   THINKER_PR_NUMBER     a pull request to send by number, instead of the event's
//   GITHUB_TOKEN          to read the pull request's files, diff and review comments
//   GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_API_URL   set by Actions
import fs from 'node:fs';

const env = process.env;
const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const slug = env.GITHUB_REPOSITORY;
const url = String(env.THINKER_SYNC_URL || '').replace(/\/+$/, '');
const token = env.THINKER_SYNC_TOKEN;
const repoId = (env.THINKER_REPO || `github.com/${slug}`).toLowerCase();
const fail = msg => { console.error(`thinker: ${msg}`); process.exit(1); };
if (!url || !token) fail('THINKER_SYNC_URL and THINKER_SYNC_TOKEN are required');
if (!slug) fail('GITHUB_REPOSITORY is not set');

async function github(p, { accept = 'application/vnd.github+json', text = false } = {}) {
  const headers = { accept, 'user-agent': 'thinker-action', 'x-github-api-version': '2022-11-28' };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await fetch(`${api}${p}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GitHub ${p}: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  return text ? res.text() : res.json();
}

async function main() {
  let pr;
  if (env.THINKER_PR_NUMBER) pr = await github(`/repos/${slug}/pulls/${Number(env.THINKER_PR_NUMBER)}`);
  else {
    let event = {}; try { event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')); } catch { fail('no event payload; set THINKER_PR_NUMBER to send a pull request by number'); }
    pr = event.pull_request;
    if (!pr) fail('the event carries no pull request; run this on pull_request: closed');
  }
  if (!pr.merged && !pr.merged_at) { console.log(`thinker: PR #${pr.number} was closed without merging; nothing to send`); return; }
  const n = pr.number;
  const files = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await github(`/repos/${slug}/pulls/${n}/files?per_page=100&page=${page}`);
    files.push(...batch.map(f => f.filename));
    if (batch.length < 100) break;
  }
  const diff = (await github(`/repos/${slug}/pulls/${n}`, { accept: 'application/vnd.github.v3.diff', text: true })).slice(0, 60000);
  let comments = [];
  try {
    const cs = await github(`/repos/${slug}/pulls/${n}/comments?per_page=50`);
    comments = cs.filter(c => c.body && c.body.length > 40 && !/\[bot\]$/.test(c.user?.login || '')).slice(0, 12).map(c => `${c.path}: ${c.body.replace(/\s+/g, ' ').slice(0, 400)}`);
  } catch (e) { console.log(`thinker: review comments unavailable (${e.message})`); }
  const payload = { number: n, title: pr.title, body: pr.body || '', mergedAt: pr.merged_at, mergeCommit: pr.merge_commit_sha, additions: pr.additions, files, diff, comments };
  if (!diff.trim()) { console.log(`thinker: PR #${n} has an empty diff; nothing to send`); return; }
  const res = await fetch(`${url}/v1/repos/${encodeURIComponent(repoId)}/prs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'thinker-action' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${url}: ${res.status} ${body.error || res.statusText}`);
  console.log(`thinker: PR #${n} "${pr.title}" ${body.done ? 'was already distilled' : 'queued for distillation'} at ${url} (${repoId}${body.distills ? '' : '; the server has no checkout or model for this repository yet'})`);
}
main().catch(e => fail(e.message));
