// A previewed change to the instruction file (instruction-edit.js:previewEdit) made into a pull request, so a
// decision on the Find Savings page is locked in by something a person can merge or close: the edit applied to the
// repository's default branch as one commit on a branch of its own, pushed to the origin, and a pull request opened
// with `gh`. Nothing in the working tree changes, whatever branch it is on and whatever is uncommitted there.
// History (context-suggest.js) keeps the pull request's number and follows its state: open is pending, merged is done,
// closed without merging is rejected and the sections are suggested again.
//
//   prAvailable      whether a pull request can be opened here: a GitHub origin, `gh` logged in, a default branch
//   openEditPr       the commit, the branch, the push and the pull request, from a preview's key
//   prState          what GitHub says of a pull request now (open / merged / closed)
//   closePr          a pending pull request closed with its branch deleted (History's Close PR)
//
// Without a GitHub origin or `gh`, the page says so and offers what was there before: the file written to the working
// tree, uncommitted. The commit is built with a temporary index (read-tree, update-index, write-tree, commit-tree), so
// it never touches the checkout's index or files. The preview is made from the base branch's own text (baseTexts, since
// 2026-10-25: a blank line the last merged pull request had collapsed was enough to refuse every later change until the
// person pulled), so the checkout's branch, its uncommitted edits and how far behind the origin it is play no part in
// the diff; a preview made from the working tree (a kept one) is still carried over: a file that differs on the base branch from the working tree the
// preview was made from gets the section replacements applied to the base's text (editRecord's `edits`), refused
// where a section's text is not found there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { repoId } from './store.js';
import { editRecord, dropEdit } from './instruction-edit.js';
import { formatTokens } from './model-usage.js';

const NET_MS = 60_000; // a fetch or a push over the network
const git = (repo, args, opts = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).replace(/\n$/, '');
const tryGit = (repo, args, opts) => { try { return git(repo, args, opts); } catch { return null; } };
// a file's text at a commit, exactly (`git` above drops the last newline, which a file's hash must keep); null when absent
const fileAt = (repo, commit, file) => { try { return execFileSync('git', ['show', `${commit}:${file}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const netGit = (repo, args) => { const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: NET_MS }); return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.error?.message || `git ${args[0]} failed`).trim().split('\n').pop() }; };
// the GitHub CLI, with the person's own login; a test gives another
export const ghCli = {
  run: (args, { cwd } = {}) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: NET_MS }).replace(/\n$/, ''),
};
const sha = s => createHash('sha256').update(String(s)).digest('hex').slice(0, 16); // as instruction-edit.js hashes a file
const firstLine = e => String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).pop() || 'failed';

// owner/repo of the origin when it is on GitHub (store.js:repoId: github.com/owner/repo), else null
export function githubSlug(repo) {
  const m = repoId(repo).match(/^github\.com\/([^/]+\/[^/]+)$/);
  return m ? m[1] : null;
}
// the branch pull requests go to: origin's HEAD, else main or master where one of them exists
export function defaultBranch(repo) {
  const head = tryGit(repo, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (tryGit(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${b}`]) || tryGit(repo, ['rev-parse', '-q', '--verify', `refs/heads/${b}`])) return b;
  return null;
}
// the commit the pull request's branch starts from: origin's branch after a fetch (the local copy when the network is
// away), else the local branch
function baseCommit(repo, branch) {
  netGit(repo, ['fetch', '-q', 'origin', branch]);
  return tryGit(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${branch}^{commit}`]) || tryGit(repo, ['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`]);
}

// The files' text on the base branch, for a preview made from what the pull request changes (instruction-edit.js:
// previewEdit's `texts` and `base`): origin's branch after a fetch, read once per file. {commit, branch, textOf} or {error}.
export function baseTexts(repo, { branch = defaultBranch(repo) } = {}) {
  if (!branch) return { error: 'no default branch (main or master) to open the pull request against' };
  const commit = baseCommit(repo, branch);
  if (!commit) return { error: `no commit for ${branch} here` };
  const texts = new Map();
  return { commit, branch, textOf: file => { if (!texts.has(file)) texts.set(file, fileAt(repo, commit, file)); return texts.get(file); } };
}

// Whether a pull request can be opened from this checkout, with the reason when not; kept a minute, since the page asks
// at every preview and `gh auth status` is a process.
const avail = new Map();
export function prAvailable(repo, { gh = ghCli, now = Date.now() } = {}) {
  const hit = avail.get(repo);
  if (hit && now - hit.at < 60_000) return hit.r;
  const r = (() => {
    const slug = githubSlug(repo);
    if (!slug) return { ok: false, reason: 'the origin is not on GitHub' };
    try { gh.run(['--version']); } catch { return { ok: false, reason: '`gh` (the GitHub CLI) is not installed' }; }
    try { gh.run(['auth', 'status', '-h', 'github.com']); } catch { return { ok: false, reason: '`gh` is not logged in (gh auth login)' }; }
    const base = defaultBranch(repo);
    if (!base) return { ok: false, reason: 'no default branch (main or master) to open it against' };
    return { ok: true, slug, base };
  })();
  avail.set(repo, { at: now, r });
  return r;
}
export const forgetPrAvailable = () => avail.clear();

// The previewed text of a file as it should be on the base: the preview's own text where the base's file is what the
// preview was made from, else each section's replacement applied to the base's text.
export function textOnBase(baseText, x) {
  if (x.from && baseText != null && sha(baseText) === x.from) return { text: x.text };
  if (x.text == null && baseText == null) return { text: null };
  if (!x.edits?.length) return { error: baseText == null ? 'is not on the base branch' : 'differs on the base branch from your working tree; commit or push your change to it first' };
  if (baseText == null) return { error: 'is not on the base branch' };
  // blank lines are not a difference: the text written collapses runs of them, and a preview from the working tree
  // must still apply after a merged change did
  const blank = s => String(s).replace(/\n{3,}/g, '\n\n');
  let text = blank(baseText);
  for (const e of x.edits.map(e => ({ ...e, old: blank(e.old) }))) {
    const at = text.indexOf(e.old);
    if (at < 0 || text.indexOf(e.old, at + 1) >= 0) return { error: `differs on the base branch around "${e.title}"; commit or push your change to it first` };
    text = text.slice(0, at) + (e.next ? `${e.next}\n` : '') + text.slice(at + e.old.length).replace(/^\n+/, e.next ? '\n' : '');
  }
  return { text: text.replace(/\n{3,}/g, '\n\n') };
}

// The pull request: `key` names the preview (instruction-edit.js:previewEdit); `changes` are the page's rows it came
// from, for the body (what each saves). Returns {number, url, branch, commit, base, said} or {error}; the preview is
// dropped once the pull request is open, kept on an error so it can be written to the working tree instead.
export async function openEditPr(store, key, { changes = [], gh = ghCli, slug: slugGiven, base: baseGiven, now = Date.now() } = {}) {
  const repo = store.repo, e = editRecord(store, key);
  if (!e) return { error: 'preview the change first' };
  const slug = slugGiven || githubSlug(repo);
  if (!slug) return { error: 'the origin is not on GitHub; written to the working tree instead' };
  const baseName = baseGiven || e.base?.branch || defaultBranch(repo);
  if (!baseName) return { error: 'no default branch (main or master) to open the pull request against' };
  // the commit the preview was made from, when it was made from the base (baseTexts): the diff is then exactly the
  // preview's; else origin's branch now
  const base = (!baseGiven && e.base?.commit && tryGit(repo, ['rev-parse', '-q', '--verify', `${e.base.commit}^{commit}`])) || baseCommit(repo, baseName);
  if (!base) return { error: `no commit for ${baseName} here` };
  // the files as they should be on the base
  const files = [];
  for (const x of e.files) {
    const baseText = fileAt(repo, base, x.file);
    const t = textOnBase(baseText, x);
    if (t.error) return { error: `${x.file} ${t.error}` };
    if (t.text === baseText) return { error: `${x.file} is already so on ${baseName}` };
    files.push({ file: x.file, text: t.text });
  }
  // the commit, through a temporary index: the checkout's index and files are not touched
  const index = path.join(os.tmpdir(), `thinker-index-${process.pid}-${randomBytes(4).toString('hex')}`), env = { ...process.env, GIT_INDEX_FILE: index };
  let tree;
  try {
    git(repo, ['read-tree', base], { env });
    for (const f of files) {
      if (f.text == null) { git(repo, ['update-index', '--force-remove', f.file], { env }); continue; }
      const blob = git(repo, ['hash-object', '-w', '--stdin'], { input: f.text, stdio: ['pipe', 'pipe', 'pipe'] });
      git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${f.file}`], { env });
    }
    tree = git(repo, ['write-tree'], { env });
  } catch (err) { return { error: `could not build the commit: ${firstLine(err)}` }; }
  finally { try { fs.rmSync(index, { force: true }); } catch {} }
  const titles = (e.sections || []).map(s => s.title), names = [...new Set(files.map(f => f.file))];
  const verb = e.action === 'remove' ? 'remove' : 'compress';
  const title = `${names.join(', ')}: ${verb} ${titles.length <= 3 ? titles.join(', ') : `${titles.length} sections`}`.slice(0, 120);
  const body = prBody(e, changes, baseName);
  const branch = `thinker/context-${new Date(now).toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(3).toString('hex')}`;
  let commit;
  try {
    commit = git(repo, ['commit-tree', tree, '-p', base, '-m', `${title}\n\n${body}`]);
    git(repo, ['update-ref', `refs/heads/${branch}`, commit]);
  } catch (err) { return { error: `could not make the commit: ${firstLine(err)}` }; }
  const push = netGit(repo, ['push', '-q', '-u', 'origin', `${branch}:${branch}`]);
  if (!push.ok) { tryGit(repo, ['update-ref', '-d', `refs/heads/${branch}`]); return { error: `could not push ${branch}: ${push.error}` }; }
  let url;
  try { url = gh.run(['pr', 'create', '--repo', slug, '--head', branch, '--base', baseName, '--title', title, '--body', body], { cwd: repo }).split('\n').filter(Boolean).pop() || ''; }
  catch (err) { return { error: `pushed ${branch} but could not open the pull request: ${firstLine(err)}` }; }
  const number = Number((url.match(/\/pull\/(\d+)/) || [])[1]) || null;
  if (!number) return { error: `pushed ${branch}; gh gave no pull request address (${url || 'nothing'})` };
  dropEdit(store, key);
  store.log({ op: 'instruction-pr', files: names, sections: e.ids || [key], action: e.action, pr: number });
  return { number, url, branch, commit, base: baseName, slug, title, said: `Pull request #${number} opened: ${url}` };
}
function prBody(e, changes, baseName) {
  const rows = (e.sections || []).map(s => `| ${s.title.replace(/\|/g, '\\|')} | ~${formatTokens(s.tokensBefore)} → ~${formatTokens(s.tokensAfter)} |`);
  const saving = changes.reduce((a, c) => a + (c.saving || 0), 0), total = changes.reduce((a, c) => a + (c.total || 0), 0), days = changes[0]?.days;
  return [
    `${e.action === 'remove' ? 'Removes' : 'Compresses'} ${rows.length === 1 ? 'a section' : `${rows.length} sections`} of the instruction file the coding agents read on every model call. Opened from thinker's Find Savings page (\`thinker ui\`).`,
    '', '| section | tokens in every model call |', '|---|---|', ...rows,
    saving ? `\nSaves ~${formatTokens(saving)} input tokens a session${total && days ? `, ~${formatTokens(total)} over the ${days} days before it was decided` : ''}.` : '',
    `\nMerging makes the change on ${baseName}. Closing it without merging leaves the file as it is, and thinker suggests the sections again.`,
  ].filter(l => l != null).join('\n');
}

// What GitHub says of a pull request now: {state: 'open' | 'merged' | 'closed', at, url}, or null when it cannot be asked.
export function prState(repo, number, { gh = ghCli, slug = githubSlug(repo) } = {}) {
  if (!slug || !number) return null;
  try {
    const j = JSON.parse(gh.run(['pr', 'view', String(number), '--repo', slug, '--json', 'state,mergedAt,closedAt,url,mergeCommit'], { cwd: repo }));
    const state = j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : 'open';
    // the merge commit is what tells whether a checkout has the change (context-suggest.js:changeHistory `unpulled`)
    return { state, at: state === 'merged' ? j.mergedAt : state === 'closed' ? j.closedAt : null, url: j.url, ...(state === 'merged' && j.mergeCommit?.oid ? { commit: j.mergeCommit.oid } : {}) };
  } catch { return null; }
}
// A pending pull request closed, its branch deleted on the origin and here.
export function closePr(repo, number, { gh = ghCli, slug = githubSlug(repo), branch, reason = 'Closed from thinker: the change is taken back.' } = {}) {
  if (!slug || !number) return { error: 'no pull request to close' };
  try { gh.run(['pr', 'close', String(number), '--repo', slug, '--delete-branch', '--comment', reason], { cwd: repo }); }
  catch (err) { return { error: `could not close #${number}: ${firstLine(err)}` }; }
  if (branch) tryGit(repo, ['update-ref', '-d', `refs/heads/${branch}`]);
  return { ok: true };
}
