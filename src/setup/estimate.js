// Pre-flight estimate of what building the cache will take: time, and the tokens of the agent's
// usage it will run through. No dollar figure: the agent's login is a subscription as often as a
// metered key, and a price from the API list told most people what they would not pay.
import path from 'node:path';
import { directoryPathspecs } from '../project.js';
import { execFileSync } from 'node:child_process';
import { formatDuration, formatBytes } from './ui.js';
import { hasBin } from './agents.js';

// --- Pre-flight Cache Estimation ---------------------------------------------

// Tokens per pull request, from this machine's log of earlier builds (`thinker usage --json`).
export const TOKENS_PER_PR = 14_000;

// Build depth. `full` is the default count of merged pull requests; `shallow` is 30% of it, taken
// from the front of the same order (newest and fixes first), so a shallow build is the most
// valuable third of a full one, not a different build.
export const SHALLOW_SHARE = 0.3;
export const DEPTHS = ['full', 'shallow'];
export function depthLimits({ depth = 'full', prs = 60 } = {}) {
  if (depth !== 'shallow') return { prs };
  return { prs: prs > 0 ? Math.max(1, Math.ceil(prs * SHALLOW_SHARE)) : prs };
}

// A build reads merged changes and nothing else, so that is all there is to estimate.
export function estimateCacheBuild(repo, { prs = 60, noPrs = false, slug = null, directories = null } = {}) {
  let commitCount = 0;
  try {
    const raw = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    commitCount = parseInt(raw, 10) || 0;
  } catch {}

  let fileCount = 0;
  try {
    const raw = execFileSync('git', ['ls-files', '-z', '--', ...directoryPathspecs(directories)], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    fileCount = raw ? raw.split('\0').filter(Boolean).length : 0;
  } catch {}

  const canMineGh = Boolean(slug && !noPrs && hasBin('gh') && prs > 0);
  const canMineGit = Boolean(!noPrs && commitCount > 5 && prs > 0);
  const canMine = canMineGh || canMineGit;
  const mineSource = canMineGh ? 'github' : (canMineGit ? 'git' : null);

  // PR mining timing estimate (~8.5s per PR for diff fetch + LLM distillation)
  const prsCount = canMine ? Math.min(prs, 50) : 0;
  const prsSec = canMine ? Math.round(prsCount * 8.5) : 0;

  // Indexing, linking, and note phrasing timing estimate
  const indexingSec = Math.max(8, Math.round(prsCount * 1.5 * 0.25));
  const totalSec = prsSec + indexingSec;

  // Size estimates
  const estPrNotes = canMine ? Math.round(prsCount * 0.7) : 0;
  const minNotes = Math.max(5, estPrNotes + 5);
  const maxNotes = Math.max(minNotes + 8, Math.round(minNotes * 1.4));

  const prsMetaBytes = 6 * 1024;
  const minBytes = (minNotes * 2000) + prsMetaBytes;
  const maxBytes = (maxNotes * 2600) + prsMetaBytes;

  const storeDir = path.join(repo, '.thinker');

  return {
    repo,
    repoName: path.basename(repo),
    commitCount,
    fileCount,
    canMine,
    mineSource,
    timing: {
      totalSeconds: totalSec,
      formatted: formatDuration(totalSec),
      breakdown: {
        prs: canMine ? formatDuration(prsSec) : 'skipped',
        indexing: formatDuration(indexingSec),
      },
    },
    size: {
      minNotes,
      maxNotes,
      notesRange: `~${minNotes}–${maxNotes} notes`,
      minBytes,
      maxBytes,
      bytesRange: `${formatBytes(minBytes)} – ${formatBytes(maxBytes)}`,
    },
    storage: {
      rootDir: path.relative(process.cwd(), storeDir) || '.thinker/',
      notesDir: path.relative(process.cwd(), path.join(storeDir, 'local', 'notes')) || '.thinker/local/notes/',
      prsFile: path.relative(process.cwd(), path.join(storeDir, 'prs.json')) || '.thinker/prs.json',
      stateDir: path.relative(process.cwd(), path.join(storeDir, 'state')) || '.thinker/state/',
    },
    tokenEstimate: canMine ? prsCount * TOKENS_PER_PR : 0,
  };
}
