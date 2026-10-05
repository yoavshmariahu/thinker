import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const digest = value => 'sha256:' + crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export function git(repo, args, options = {}) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options, env: { ...process.env, THINKER_TEST: '1', ...options.env } }).trim();
}
export function readAt(repo, ref, file) {
  try { return git(repo, ['show', `${ref}:${file}`]); } catch { return null; }
}

// A private index leaves the user's index untouched. Git's filters run as in a normal add.
// Ignored files are excluded; tracked files remain included, including shared behaviors.
export function snapshotTree(repo, { ref, staged = false } = {}) {
  if (ref) return git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`]);
  if (staged) return git(repo, ['write-tree']);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-index-'));
  const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
  try {
    const files = [...new Set(git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))]
      .filter(f => !/^\.thinker\/(?:local\/|state\/|log\.jsonl$)/.test(f))
      .filter(f => { try { fs.lstatSync(path.join(repo, f)); return true; } catch { return false; } });
    git(repo, ['read-tree', '--empty'], { env });
    if (files.length) git(repo, ['add', '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { env: { ...env, GIT_LITERAL_PATHSPECS: '1' }, input: files.join('\0') + '\0', stdio: ['pipe', 'pipe', 'pipe'] });
    return git(repo, ['write-tree'], { env });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export function createSnapshot(repo, options = {}) {
  const target = git(repo, ['rev-parse', '--verify', '--end-of-options', `${options.base || 'HEAD'}^{commit}`]);
  const head = git(repo, ['rev-parse', '--verify', '--end-of-options', `${options.ref || 'HEAD'}^{commit}`]);
  const base = git(repo, ['merge-base', target, head]);
  const tree = snapshotTree(repo, options);
  const commit = git(repo, ['commit-tree', tree, '-p', head, '-m', 'Thinker verification snapshot'], { env: {
    GIT_AUTHOR_NAME: 'Thinker', GIT_AUTHOR_EMAIL: 'verification@localhost', GIT_COMMITTER_NAME: 'Thinker', GIT_COMMITTER_EMAIL: 'verification@localhost',
  } });
  return { tree, commit, base, target, targetRef: options.base || 'HEAD', head, scope: options.ref ? 'commit' : options.staged ? 'index' : 'worktree', candidate: 'branch', excludesIgnoredFiles: true };
}

// The checkout the container receives carries its own history: a repository of one
// shallow commit, the snapshot, with no remote, hook, reflog or path of the host, so a
// check that asks Git for the revision (scripts/pack.sh records `git rev-parse HEAD`)
// gets the snapshot commit. The host's .git is never mounted or pointed at.
export function standaloneGit(repo, runId, destination) {
  const template = fs.mkdtempSync(path.join(os.tmpdir(), 'thinker-git-template-'));
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  try {
    git(destination, ['init', '-q', `--template=${template}`], { env });
    git(destination, ['config', 'core.logAllRefUpdates', 'false'], { env });
    git(destination, ['fetch', '-q', '--depth', '1', '--no-tags', repo, `refs/thinker/reviews/${runId}`], { env });
    const commit = git(destination, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'], { env });
    git(destination, ['update-ref', '--no-deref', 'HEAD', commit], { env });
    git(destination, ['read-tree', 'HEAD'], { env });
    fs.rmSync(path.join(destination, '.git', 'FETCH_HEAD'), { force: true }); // names the host path
    return commit;
  } finally { fs.rmSync(template, { recursive: true, force: true }); }
}

// Materialize blobs directly: checkout/smudge filters and export attributes must not
// execute candidate code on the host or change the bytes named by the tree identity.
export function materializeSnapshot(repo, tree, destination) {
  for (const entry of git(repo, ['ls-tree', '-rz', tree]).split('\0').filter(Boolean)) {
    const split = entry.indexOf('\t'), [mode, type, oid] = entry.slice(0, split).split(' '), file = entry.slice(split + 1);
    if (type !== 'blob') throw new Error(`Unsupported snapshot entry ${file}: submodules require a separate execution contract`);
    if (file.split('/').some(p => !p || p === '..' || p.toLowerCase() === '.git') || path.isAbsolute(file)) throw new Error('Unsafe snapshot path');
    const dest = path.join(destination, file);
    for (let p = path.dirname(dest); p !== destination; p = path.dirname(p)) if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('Snapshot contains a symlink parent');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const content = execFileSync('git', ['cat-file', 'blob', oid], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
    if (mode === '120000') fs.symlinkSync(content.toString(), dest);
    else fs.writeFileSync(dest, content, { mode: mode === '100755' ? 0o755 : 0o644 });
  }
}
