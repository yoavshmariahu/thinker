// Pre-flight estimate of what building the cache will take: time, and the tokens of the agent's
// usage it will run through. No dollar figure: the agent's login is a subscription as often as a
// metered key, and a price from the API list told most people what they would not pay.
import path from 'node:path';
import { directoryPathspecs } from '../project.js';
import { execFileSync } from 'node:child_process';
import { planAreas } from '../topology.js';
import { formatDuration, formatBytes } from './ui.js';
import { hasBin } from './agents.js';

// --- Pre-flight Cache Estimation ---------------------------------------------

// Tokens per unit of work, from this machine's log of earlier builds (`thinker usage --json`):
// one exploration session and its distillation about 400k (most of them prompt-cache reads of
// the same context, turn after turn), one pull request about 14k.
export const TOKENS_PER_AREA = 400_000;
export const TOKENS_PER_PR = 14_000;

export function estimateCacheBuild(repo, { areas, prs = 60, noSeed = false, noPrs = false, slug = null, agent = null, directories = null } = {}) {
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

  const { areas: candidateAreas, omitted: omittedAreas } = planAreas(repo, { limit: areas, directories });

  const canMineGh = Boolean(slug && !noPrs && hasBin('gh') && prs > 0);
  const canMineGit = Boolean(!noPrs && commitCount > 5 && prs > 0);
  const canMine = canMineGh || canMineGit;
  const mineSource = canMineGh ? 'github' : (canMineGit ? 'git' : null);
  const canSeed = Boolean(!noSeed && agent && candidateAreas.length > 0);

  // PR mining timing estimate (~8.5s per PR for diff fetch + LLM distillation)
  const prsCount = canMine ? Math.min(prs, 50) : 0;
  const prsSec = canMine ? Math.round(prsCount * 8.5) : 0;

  // Area exploration timing estimate (~55s per area for multi-turn agent exploration)
  const areasCount = canSeed ? candidateAreas.length : 0;
  const areasSec = canSeed ? Math.round(areasCount * 55) : 0;

  // Indexing, linking, and note phrasing timing estimate
  const indexingSec = Math.max(8, Math.round((areasCount * 2.5 + prsCount * 1.5) * 0.25));
  const totalSec = prsSec + areasSec + indexingSec;

  // Size estimates
  const estPrNotes = canMine ? Math.round(prsCount * 0.7) : 0;
  const estAreaNotes = canSeed ? Math.round(areasCount * 2.5) : 0;
  const minNotes = Math.max(5, estPrNotes + estAreaNotes + 5);
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
    candidateAreasCount: candidateAreas.length,
    omittedAreas: omittedAreas.map(area => area.label),
    canMine,
    mineSource,
    canSeed,
    timing: {
      totalSeconds: totalSec,
      formatted: formatDuration(totalSec),
      breakdown: {
        prs: canMine ? formatDuration(prsSec) : 'skipped',
        exploration: canSeed ? formatDuration(areasSec) : 'skipped',
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
    tokenEstimate: (canSeed ? areasCount * TOKENS_PER_AREA : 0) + (canMine ? prsCount * TOKENS_PER_PR : 0),
  };
}
