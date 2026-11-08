// The commands another program drives thinker through as an installed tool: which thinker it ran (`version`).
// `mcp` and `hook` are the other two. The benchmark-facing `served`, `spent`, `guide` and `export --dir` went
// with the knowledge notes (2026-11-08): Artemis has no thinker-cache arm to build or read any more.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The version this command runs from, and the commit when it runs from a checkout
export function versionInfo(root) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let commit = null, dirty = null;
  try {
    commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'src', 'package.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== '';
  } catch {}
  return { version, commit, dirty, root };
}

async function versionCommand({ flags, out, HERE }) {
  const v = versionInfo(path.resolve(HERE, '..'));
  out(flags.json ? JSON.stringify(v) : `thinker ${v.version}${v.commit ? ` (${v.commit.slice(0, 9)}${v.dirty ? ', modified' : ''})` : ''}`);
}

export const commands = { version: versionCommand };
