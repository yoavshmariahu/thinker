// The commands another program drives thinker through as an installed tool, never by its source: an
// evaluation harness wires a worktree with `mcp` and `hook`, reads the guidance an install writes with
// `guide`, what one session was served with `served`, and which thinker it ran with `version`.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cacheUsageGuide, disabledTools } from '../cache-guidance.js';

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

// What a checkout's own log (.thinker/log.jsonl) says it served: the notes the prompt hook injected, the
// file-keyed notes of the late hook, and the orient and lookup calls an agent made. A session with
// THINKER_NOTES_DIR or THINKER_LOG=local logs there (store.js:logFile).
export function servedSummary(storeDir) {
  const use = { injected: [], hookServed: 0, lateServed: 0, orientCalls: 0, lookupCalls: 0 };
  let lines = [];
  try { lines = fs.readFileSync(path.join(storeDir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch {}
  const ids = new Set();
  for (const l of lines) {
    for (const id of l.served || []) ids.add(id);
    if (l.op === 'orient' && l.session) use.hookServed += (l.served || []).length;
    else if (l.op === 'orient') use.orientCalls++;
    else if (l.op === 'lookup') use.lookupCalls++;
    else if (l.op === 'late') use.lateServed += (l.served || []).length;
  }
  use.injected = [...ids];
  return use;
}

async function versionCommand({ flags, out, HERE }) {
  const v = versionInfo(path.resolve(HERE, '..'));
  out(flags.json ? JSON.stringify(v) : `thinker ${v.version}${v.commit ? ` (${v.commit.slice(0, 9)}${v.dirty ? ', modified' : ''})` : ''}`);
}

async function servedCommand({ flags, store, out }) {
  const use = servedSummary(store.dir);
  if (flags.json) { out(JSON.stringify(use)); return; }
  out(`served ${use.injected.length} notes: ${use.hookServed} by the prompt hook, ${use.lateServed} by the file hook; ${use.orientCalls} orient and ${use.lookupCalls} lookup calls`);
}

async function guideCommand({ store, out }) {
  out(cacheUsageGuide({ disabled: disabledTools(store.config()) }));
}

export const commands = {
  version: versionCommand,
  served: servedCommand,
  guide: guideCommand,
};
