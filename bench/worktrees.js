// Benchmark checkouts belong to this process, never to the next run with the same tag.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn as spawnChild } from 'node:child_process';

const owned = new Map();
const children = new Map();
let installed = false;
const git = (repo, args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });

function stopChild(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function installCleanup() {
  if (installed) return;
  installed = true;
  process.once('exit', () => {
    for (const wt of owned.keys()) {
      try { removeWorktree(wt); }
      catch (error) {
        console.error(`Benchmark worktree cleanup failed (${wt}): ${error.message}`);
        if (!process.exitCode) process.exitCode = 1;
      }
    }
  });
  process.once('SIGINT', () => process.exit(130));
  process.once('SIGTERM', () => process.exit(143));
}

export function createWorktree(repo, directory, base = 'HEAD') {
  fs.mkdirSync(path.dirname(path.resolve(directory)), { recursive: true });
  const wt = path.join(fs.realpathSync(path.dirname(path.resolve(directory))), path.basename(directory));
  if (owned.has(wt)) return wt;
  // Refuse existing paths/registrations: they can contain another run's live work.
  const registrations = git(repo, ['worktree', 'list', '--porcelain', '-z']).toString().split('\0');
  if (registrations.includes(`worktree ${wt}`)) throw new Error(`Worktree already registered: ${wt}`);
  fs.mkdirSync(wt); // Atomic reservation; EEXIST must not become a recursive delete.
  owned.set(wt, path.resolve(repo));
  installCleanup();
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', wt, base]);
    return wt;
  } catch (error) {
    try { removeWorktree(wt); } catch (cleanupError) { console.error(cleanupError.message); }
    throw error;
  }
}

export function removeWorktree(directory) {
  const wt = path.resolve(directory);
  const repo = owned.get(wt);
  if (!repo) return;
  // Stop agents and their process groups before deleting their working directory.
  for (const [child, cwd] of children) if (cwd === wt) {
    stopChild(child);
    children.delete(child);
  }
  const registrations = git(repo, ['worktree', 'list', '--porcelain', '-z']).toString().split('\0');
  if (registrations.includes(`worktree ${wt}`)) {
    // A failed checkout can leave our own registration locked "initializing".
    git(repo, ['worktree', 'remove', '--force', '--force', wt]);
  } else if (fs.existsSync(wt)) {
    fs.rmdirSync(wt); // Only an empty reservation, never unregistered user files.
  }
  owned.delete(wt);
}

export function spawn(command, args, options) {
  const cwd = path.resolve(options.cwd);
  if (!owned.has(cwd)) throw new Error(`Agent cwd is not an owned benchmark worktree: ${cwd}`);
  const child = spawnChild(command, args, { ...options, detached: process.platform !== 'win32' });
  children.set(child, cwd);
  // A timed-out/exited CLI must not leave its tools or MCP servers running.
  child.once('exit', () => stopChild(child));
  child.once('close', () => children.delete(child));
  return child;
}
