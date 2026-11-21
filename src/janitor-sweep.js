// The janitor's sweep: worktrees and local branches whose work is already merged (janitor.js runs it).
// Coding agents leave these behind by the dozen -- a worktree a task, a branch a worktree -- and nobody goes back
// for them once the pull request is in. Finding them is free: git, and the merged pull requests thinker already
// reads once a day for `thinker prs` (delivery.js:syncPrs), so no call to GitHub is made from here.
//
// Merged means one of two things, and nothing softer:
//   - the branch's tip is an ancestor of the default branch (a merge commit, a fast-forward), or
//   - a merged pull request for that branch has this exact commit as its head. That is what catches a squash
//     merge, which git ancestry cannot see: the commits are on main under another hash.
// A branch with one commit the merged pull request does not have is not merged.
//
// What is never touched, each kept with its reason so the person can see why: the main checkout, the worktree a
// process is sitting in (this one included), a worktree with uncommitted or untracked files, one holding files git
// ignores that nothing regenerates (a `.env`, bench runs -- node_modules and build output do not count), a detached
// or locked worktree, anything changed in the last day, and the default branch and its usual relatives.
//
// Removing is `git worktree remove` without --force, so git itself refuses a worktree that turned dirty since it
// was found, and a branch is deleted only while it still points at the commit that was checked (`update-ref -d
// <ref> <sha>`). Nothing is lost that is not on the default branch: the undo is the branch name and its commit.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { defaultBranch } from './instruction-pr.js';
import { readDelivery } from './delivery-journal.js';

export const SWEEP = {
  minAgeMs: 24 * 3600_000, // nothing changed more recently than this is called abandoned
  duMs: 15_000,            // how long a worktree's size may take to measure; unknown past it
  listed: 12,              // lines of one kind the inbox shows before "and n more"
};
// Ignored files a build or an install writes again: a worktree holding only these loses nothing by going.
export const REGENERABLE = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.gradle', 'coverage', '.nyc_output', '.DS_Store', '.thinker', '.eslintcache', '.tsbuildinfo', 'tsconfig.tsbuildinfo']);
const PROTECTED = /^(main|master|develop|dev|trunk|staging|production|release([-/].*)?)$/;

const run = (repo, args, opts = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, ...opts }).replace(/\n$/, '');
const tryGit = (repo, args, opts) => { try { return run(repo, args, opts); } catch { return null; } };
const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (dir, p) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// `git worktree list --porcelain`: the main checkout first, then every linked worktree.
export function listWorktrees(repo) {
  const out = [];
  let cur = null;
  for (const line of (tryGit(repo, ['worktree', 'list', '--porcelain']) || '').split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9), sha: null, branch: null, detached: false, locked: false, bare: false }; out.push(cur); }
    else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.sha = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
  }
  return out.map((w, i) => ({ ...w, main: i === 0 }));
}

// The merged pull requests thinker has read, by branch: the newest record of each number, kept when it merged.
export function mergedPrs(store) {
  const byNumber = new Map();
  let events = []; try { events = readDelivery(store).events; } catch {}
  for (const e of events) if (e.op === 'pr' && e.pr?.number) byNumber.set(e.pr.number, e.pr);
  const out = new Map();
  for (const p of byNumber.values()) {
    if (p.state !== 'MERGED' || !p.branch || !p.head) continue;
    if (!out.has(p.branch)) out.set(p.branch, []);
    out.get(p.branch).push({ number: p.number, head: p.head });
  }
  return out;
}

// The directories some process on the machine is sitting in (one lsof call); null where that cannot be asked, and
// then nothing is known to be free.
export function busyDirs() {
  const r = spawnSync('lsof', ['-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 10_000 });
  if (r.error || !r.stdout) return null;
  return [...new Set(r.stdout.split('\n').filter(l => l.startsWith('n/')).map(l => l.slice(1)))];
}
function sizeKb(dir) {
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8', timeout: SWEEP.duMs });
  const n = Number(String(r.stdout || '').split(/\s/)[0]);
  return r.status === 0 && Number.isFinite(n) ? n : null;
}
// when the worktree's own git state last moved: a checkout, a commit, a staged file
function lastTouched(worktree) {
  const dir = tryGit(worktree, ['rev-parse', '--absolute-git-dir']);
  let t = 0;
  for (const f of ['HEAD', 'index', 'logs/HEAD', 'ORIG_HEAD']) { try { t = Math.max(t, fs.statSync(path.join(dir || worktree, f)).mtimeMs); } catch {} }
  return t;
}
// the ignored files of a worktree that nothing writes again, by name
function keptIgnored(worktree) {
  const out = [];
  for (const l of (tryGit(worktree, ['status', '--porcelain', '--ignored']) || '').split('\n')) {
    if (!l.startsWith('!! ')) continue;
    const p = l.slice(3).replace(/^"|"$/g, '').replace(/\/$/, '');
    if (!REGENERABLE.has(path.basename(p)) && !/\.(log|pyc|tsbuildinfo)$/.test(p)) out.push(p);
  }
  return out;
}
const dirty = worktree => {
  const s = tryGit(worktree, ['status', '--porcelain']);
  return s == null ? true : s.split('\n').some(l => l && !l.startsWith('!! '));
};

// What can go, and what stays with its reason. `cwds` (the directories in use) and `sizeOf` are passed in by tests.
export function findMess(store, { now = Date.now(), here = store.repo, cwds = busyDirs(), sizeOf = sizeKb, minAgeMs = SWEEP.minAgeMs } = {}) {
  const repo = store.home || store.repo;
  const trees = listWorktrees(repo);
  const out = { worktrees: [], branches: [], kept: [] };
  if (!trees.length) return out;
  const base = defaultBranch(repo);
  const baseRef = base && (tryGit(repo, ['rev-parse', '-q', '--verify', `refs/remotes/origin/${base}^{commit}`]) || tryGit(repo, ['rev-parse', '-q', '--verify', `refs/heads/${base}^{commit}`]));
  if (!baseRef) return out; // no default branch to be merged into: nothing can be called merged
  const prs = mergedPrs(store);
  const ancestor = sha => spawnSync('git', ['merge-base', '--is-ancestor', sha, baseRef], { cwd: repo, timeout: 30_000 }).status === 0;
  const why = (branch, sha) => {
    const pr = (prs.get(branch) || []).find(p => p.head === sha);
    if (pr) return `PR #${pr.number} merged`;
    return ancestor(sha) ? `on ${base}` : null;
  };
  const hereReal = real(here), busy = cwds ? cwds.map(real) : null;
  const checkedOut = new Set(trees.map(t => t.branch).filter(Boolean));
  const fresh = t => now - t < minAgeMs;
  for (const t of trees) {
    if (t.main || t.bare) continue;
    const keep = reason => out.kept.push({ path: t.path, branch: t.branch, why: reason });
    if (!fs.existsSync(t.path)) continue; // `git worktree prune` is git's own to run
    const p = real(t.path);
    if (inside(p, hereReal)) { keep('you are in it'); continue; }
    if (t.detached || !t.branch) { keep('no branch (detached)'); continue; }
    if (t.locked) { keep('locked'); continue; }
    if (t.branch === base || PROTECTED.test(t.branch)) { keep(`holds ${t.branch}`); continue; }
    const merged = why(t.branch, t.sha);
    if (!merged) { keep('not merged'); continue; }
    if (!busy) { keep('cannot tell whether a process is using it'); continue; }
    if (busy.some(d => inside(p, d))) { keep('a process is running in it'); continue; }
    if (fresh(lastTouched(t.path))) { keep('changed in the last day'); continue; }
    if (dirty(t.path)) { keep('has uncommitted work'); continue; }
    const ignored = keptIgnored(t.path);
    if (ignored.length) { keep(`holds files git ignores (${ignored.slice(0, 2).join(', ')}${ignored.length > 2 ? '…' : ''})`); continue; }
    out.worktrees.push({ path: t.path, branch: t.branch, sha: t.sha, kb: sizeOf(t.path), why: merged });
  }
  // every other local branch: no worktree holds it, so only the name is in the way
  const refs = (tryGit(repo, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(objectname)']) || '').split('\n').filter(Boolean).map(l => l.split('\t'));
  for (const [name, sha] of refs) {
    if (checkedOut.has(name) || name === base || PROTECTED.test(name)) continue;
    const merged = why(name, sha);
    if (!merged) continue;
    // a branch made a minute ago off main is an ancestor of main too: its reflog says when it last moved
    const moved = Number(tryGit(repo, ['reflog', 'show', '-1', '--format=%ct', `refs/heads/${name}`]) || 0) * 1000;
    if (moved && fresh(moved)) { out.kept.push({ branch: name, why: 'changed in the last day' }); continue; }
    out.branches.push({ name, sha, why: merged });
  }
  return out;
}

const refIs = (repo, branch, sha) => tryGit(repo, ['rev-parse', '-q', '--verify', `refs/heads/${branch}^{commit}`]) === sha;
const firstLine = e => String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean).pop() || 'failed';

// Remove what findMess listed, each one checked again as it goes: found again by the same rules a moment before, the
// worktree removed without --force, the branch deleted only where it still names the commit that was merged.
export function sweep(store, mess, opts = {}) {
  const repo = store.home || store.repo;
  const now = findMess(store, { ...opts, sizeOf: () => null });
  const still = new Map(now.worktrees.map(w => [w.path, w])), stillB = new Map(now.branches.map(b => [b.name, b]));
  const done = { worktrees: [], branches: [], skipped: [], kb: 0 };
  for (const w of mess.worktrees || []) {
    const cur = still.get(w.path);
    if (!cur || cur.sha !== w.sha) { done.skipped.push({ path: w.path, why: 'changed since it was found' }); continue; }
    try { run(repo, ['worktree', 'remove', w.path]); } catch (e) { done.skipped.push({ path: w.path, why: firstLine(e) }); continue; }
    done.worktrees.push({ path: w.path, branch: w.branch, sha: w.sha });
    done.kb += w.kb || 0;
    if (refIs(repo, w.branch, w.sha)) { try { run(repo, ['update-ref', '-d', `refs/heads/${w.branch}`, w.sha]); done.branches.push({ name: w.branch, sha: w.sha }); } catch (e) { done.skipped.push({ branch: w.branch, why: firstLine(e) }); } }
  }
  for (const b of mess.branches || []) {
    const cur = stillB.get(b.name);
    if (!cur || cur.sha !== b.sha) { done.skipped.push({ branch: b.name, why: 'changed since it was found' }); continue; }
    try { run(repo, ['update-ref', '-d', `refs/heads/${b.name}`, b.sha]); done.branches.push({ name: b.name, sha: b.sha }); } catch (e) { done.skipped.push({ branch: b.name, why: firstLine(e) }); }
  }
  return done;
}

// Put back what a sweep took: every branch at its commit, and the worktrees on them. A commit git has since
// collected, a name taken again and a path in use are said, not forced.
export function unsweep(store, undo) {
  const repo = store.home || store.repo;
  const back = { branches: [], worktrees: [], failed: [] };
  for (const b of undo?.branches || []) {
    if (tryGit(repo, ['rev-parse', '-q', '--verify', `refs/heads/${b.name}`])) { back.failed.push({ branch: b.name, why: 'a branch of that name exists again' }); continue; }
    if (tryGit(repo, ['cat-file', '-e', `${b.sha}^{commit}`]) == null) { back.failed.push({ branch: b.name, why: 'git no longer has its commit' }); continue; }
    try { run(repo, ['branch', b.name, b.sha]); back.branches.push(b.name); } catch (e) { back.failed.push({ branch: b.name, why: firstLine(e) }); }
  }
  for (const w of undo?.worktrees || []) {
    if (fs.existsSync(w.path)) { back.failed.push({ path: w.path, why: 'something is at that path again' }); continue; }
    try { run(repo, ['worktree', 'add', w.path, w.branch]); back.worktrees.push(w.path); } catch (e) { back.failed.push({ path: w.path, why: firstLine(e) }); }
  }
  return back;
}
