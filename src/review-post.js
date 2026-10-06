// A review report (review.js) as a GitHub pull request review, and the posting of it: findings on
// changed lines as inline comments, the rest and the desired behaviors in play in the body. Used by
// the server's review job (server/worker.js) and by the action when it reviews on the runner
// (action/review/post.mjs). Nothing here reads the repository: the report is all it needs.
//
// A review requesting changes that an earlier run posted is dismissed when a newer run posts, so a
// push that fixes the violation clears the request; a plain comment review is left where it is.
import { execFileSync } from 'node:child_process';
import { formatTokens } from './model-usage.js';

export const MARKER = '<!-- thinker-review -->';
const ICON = { violated: '❌', upheld: '✅', revised: '✏️', unrelated: '➖', consulted: '👀' };
import { blindSpot } from './review.js';

const SEV = { error: 0, warning: 1, info: 2 };
const esc = s => String(s || '').replace(/</g, '&lt;');
const code = s => '`' + String(s || '').replace(/`/g, 'ˋ') + '`';
const sourceText = n => n?.source?.type === 'pr' && n.source.ref ? `source PR ${n.source.ref}` : n?.source?.type === 'human' ? 'human-authored' : n?.source?.type === 'doc' ? 'from documentation' : n?.source?.type === 'agent' ? 'captured from an agent session' : '';

// The review as GitHub takes it: {post, event, body, comments: [{path, line, side, body}], fail, summary}.
export function buildReview(report, { failOn = 'error', quiet = true } = {}) {
  const r = report || {};
  const counts = r.counts || { error: 0, warning: 0, info: 0 };
  const noteRefs = new Map([...(r.toAssess || []), ...(r.behaviors || [])].map(n => [n.id, n]));
  const label = f => { const ids = f.notes?.length ? f.notes : f.note ? [f.note] : []; return ids.length ? ids.map(id => { const n = noteRefs.get(id); return n ? `${n.title} (${id})${sourceText(n) ? ` · ${sourceText(n)}` : ''}` : id; }).join(', ') : f.basis || 'from the code'; };
  const findings = [...(r.findings || [])].sort((a, b) => (SEV[a.severity] ?? 1) - (SEV[b.severity] ?? 1) || (b.confidence || 0) - (a.confidence || 0));
  const onLine = x => !!(x && x.file && x.line > 0 && x.inChange);
  const inline = [], rest = [];
  for (const f of findings) (onLine(f) || (f.locations || []).some(onLine) ? inline : rest).push(f);
  const one = f => `**${f.severity}** ${esc(f.message)}${f.evidence ? `\n\n> ${esc(f.evidence).split('\n').map(s => s.trim()).filter(Boolean).join('\n> ')}` : ''}\n\n<sub>${f.id ? `${code(f.id)} · ` : ''}${esc(label(f))}${f.confidence ? `, ${Math.round(f.confidence * 100)}%` : ''}</sub>`;
  // one inline comment per place a finding was seen on a changed line: its own, and each location
  // the clustering folded into it (the same regression in the serializer, the test, the docs)
  const comments = [];
  for (const f of findings) {
    if (onLine(f)) comments.push({ path: f.file, line: f.line, side: 'RIGHT', body: `${MARKER}\n${one(f)}` });
    for (const l of f.locations || []) if (onLine(l)) comments.push({ path: l.file, line: l.line, side: 'RIGHT', body: `${MARKER}\n${one({ ...f, message: l.message, evidence: l.evidence, severity: l.severity || f.severity, confidence: l.confidence })}` });
  }
  const also = f => f.locations?.length ? ` <sub>also at ${f.locations.slice(0, 6).map(l => code(`${l.file}${l.line ? ':' + l.line : ''}`)).join(', ')}${f.locations.length > 6 ? ` (+${f.locations.length - 6} more)` : ''}</sub>` : '';
  const behaviors = r.behaviors || [];
  const integrity = r.integrity?.findings || [];
  const violated = behaviors.filter(b => b.outcome === 'violated');
  const L = [MARKER, `### thinker review${r.scope ? ` · ${esc(r.scope)}` : ''}`, ''];
  if (integrity.length) {
    L.push('#### Gate integrity — needs human review', '');
    for (const f of integrity) L.push(`- ${code(f.file + (f.line ? ':' + f.line : ''))}: ${esc(f.message)} (${esc(f.certainty)}). Before: ${code(f.before || '(none)')}; after: ${code(f.after || '(none)')}`);
    L.push('', 'These signals do not establish whether replacement coverage is equivalent.', '');
  }
  // a behavior this change stops upholding, said first and in full: what it required, what the change
  // does instead, and what merging means. A fixed behavior is the loud case.
  const fixedBroken = violated.filter(b => b.mutability === 'fixed'), mutableBroken = violated.filter(b => b.mutability !== 'fixed');
  const quote = s => String(s || '').trim().split('\n').map(l => `> ${esc(l)}`).join('\n');
  if (fixedBroken.length) {
    L.push(`## ⛔ This change breaks ${fixedBroken.length === 1 ? 'a fixed behavior' : `${fixedBroken.length} fixed behaviors`} of the system`, '');
    L.push(`A fixed behavior is a rule the system is held to. Changing it is a decision for the people who own the system, not a side effect of this change.`, '');
    for (const b of fixedBroken) {
      L.push(`**${esc(b.title)}** <sub>fixed, ${code(b.id)}${sourceText(b) ? ` · ${esc(sourceText(b))}` : ''}</sub>`, '', 'What it requires:', '', quote(b.body), '');
      if (b.reason) L.push(`What this change does instead: ${esc(b.reason)}`, '');
      if (b.before) L.push(`<sub>${esc(b.before)}</sub>`, '');
    }
    L.push(`**If this is intended**, say so in the pull request: once it is merged on the default branch the code is the truth and ${fixedBroken.length === 1 ? 'this behavior is' : 'these behaviors are'} revised to match it. **If not**, restore the enforcement before merging.`, '', '---', '');
  } else if (mutableBroken.length) {
    L.push(`#### ⚠ This change alters ${mutableBroken.length === 1 ? 'a behavior' : `${mutableBroken.length} behaviors`} of the system`, '');
    for (const b of mutableBroken) { L.push(`**${esc(b.title)}** <sub>mutable, ${code(b.id)}${sourceText(b) ? ` · ${esc(sourceText(b))}` : ''}</sub>`, '', quote(b.body), ''); if (b.reason) L.push(`What this change does instead: ${esc(b.reason)}`, ''); }
    L.push(`A mutable behavior changes with the code: once this change is merged on the default branch ${mutableBroken.length === 1 ? 'it is' : 'they are'} revised to match it. Say in the pull request that the change is meant.`, '', '---', '');
  }
  if (r.error) L.push(`The review could not run: ${esc(r.error)}`, '');
  else if (r.noCache) L.push('This repository has no `.thinker/` cache, so there is nothing to review against. Run `thinker setup` and commit a few desired behaviors (`thinker system add`).', '');
  else if (r.empty) L.push('Nothing to review: the change holds no code the notes could speak to.', '');
  else {
    L.push(`${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}, ${counts.info} info · ${r.notes?.consulted ?? 0} ${r.kinds?.length === 1 && r.kinds[0] === 'behavior' ? 'desired behavior' : 'note'}${(r.notes?.consulted ?? 0) === 1 ? '' : 's'} consulted${r.notes?.assessed ? `, ${r.notes.assessed} assessed with ${esc(r.model)}` : ''}${r.tokens ? ` (~${formatTokens(r.tokens)} tokens)` : ''}`, '');
    const blind = blindSpot(r);
    if (blind) L.push(`⚠ ${esc(blind.text)} "No findings" there means nothing was found by a reader without the team's knowledge, not that the code is right.`, '');
    if (behaviors.length) {
      L.push('#### Desired behaviors in play', '', '| | behavior | outcome |', '|---|---|---|');
      for (const b of behaviors) L.push(`| ${ICON[b.outcome] || ''} | ${esc(b.title)} <sub>${b.mutability}, ${code(b.id)}</sub> | ${b.outcome}${b.outcome === 'violated' && b.reason ? `: ${esc(b.reason).slice(0, 200)}` : b.outcome === 'revised' ? ' (this change edits the behavior note)' : ''}${b.before ? ` <sub>${esc(b.before)}</sub>` : ''} |`);
      L.push('');
    }
    if (rest.length) {
      L.push(`#### Findings${inline.length ? ' not on a changed line' : ''}`, '');
      for (const f of rest) L.push(`- **${f.severity}** ${f.file ? code(`${f.file}${f.line ? ':' + f.line : ''}`) + ' ' : ''}${esc(f.message)} <sub>${f.id ? `${code(f.id)} · ` : ''}${esc(label(f))}${f.confidence ? `, ${Math.round(f.confidence * 100)}%` : ''}</sub>${also(f)}`);
      L.push('');
    }
    if (comments.length) L.push(`${comments.length} comment${comments.length === 1 ? '' : 's'} on changed lines ${comments.length === 1 ? 'is' : 'are'} posted inline${inline.length !== comments.length ? ` (${inline.length} finding${inline.length === 1 ? '' : 's'})` : ''}.`, '');
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
  // a blind spot is said whenever a review is posted, and never the reason to post one: on a young
  // cache most pull requests would get a comment saying the cache knows nothing yet
  const something = !!(r.error || findings.length || violated.length || integrity.length);
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
    if (res.status === 403) log('thinker: the token may not write reviews (a pull request from a fork gets a read-only GITHUB_TOKEN; a server token needs pull requests: write); the review was not posted');
    else log(`thinker: posting the review failed: ${res.status} ${res.json.message || res.text.slice(0, 200)}`);
    return { posted: false, dismissed, status: res.status };
  }
  return { posted: true, dismissed, id: res.json.id, status: res.status };
}


// A conversation comment works on the user's own PR too. gh owns authentication;
// send the Markdown over stdin so neither shell quoting nor argument limits affect it.
export function postComment(report, { repo, pr, run = execFileSync, markdown } = {}) {
  if (!/^[1-9]\d*$/.test(String(pr || ''))) throw new Error('--post requires --pr <number>');
  const review = buildReview(report, { quiet: false });
  let body = markdown === undefined ? review.body : `${MARKER}\n${markdown}`;
  if (markdown === undefined && review.comments.length) {
    const findings = review.comments.map(c => `#### ${code(`${c.path}:${c.line}`)}\n\n${c.body.replace(MARKER + '\n', '')}`).join('\n\n');
    body = body.replace(/^\d+ comments? on changed lines .*\n/m, '')
      .replace('\n<sub>Posted by thinker', `\n### Findings on changed lines\n\n${findings}\n\n<sub>Posted by thinker`);
  }
  try {
    const url = run('gh', ['pr', 'comment', String(pr), '--body-file', '-'], {
      cwd: repo, input: body, encoding: 'utf8', timeout: 60_000,
      maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { posted: true, url };
  } catch (e) {
    const detail = e.code === 'ENOENT' ? 'install GitHub CLI and run gh auth login' : String(e.stderr || e.message).trim();
    throw new Error(`Could not post PR comment through gh: ${detail}`);
  }
}
