// Pre-flight estimate of what building the cache will cost and how long it will take.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverAreas } from '../topology.js';
import { formatDuration, formatBytes } from './ui.js';
import { hasBin } from './agents.js';

// --- Pre-flight Cache Estimation ---------------------------------------------

export function estimateCacheBuild(repo, { areas = 12, prs = 60, noSeed = false, noPrs = false, slug = null, agent = null } = {}) {
  let commitCount = 0;
  try {
    const raw = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    commitCount = parseInt(raw, 10) || 0;
  } catch {}

  let fileCount = 0;
  try {
    const raw = execFileSync('git', ['ls-files'], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    fileCount = raw ? raw.split('\n').filter(Boolean).length : 0;
  } catch {}

  let candidateAreas = [];
  try {
    candidateAreas = discoverAreas(repo, { limit: areas });
  } catch {}

  const canMineGh = Boolean(slug && !noPrs && hasBin('gh') && prs > 0);
  const canMineGit = Boolean(!noPrs && commitCount > 5 && prs > 0);
  const canMine = canMineGh || canMineGit;
  const mineSource = canMineGh ? 'github' : (canMineGit ? 'git' : null);
  const canSeed = Boolean(!noSeed && agent && areas > 0 && candidateAreas.length > 0);

  // Co-change mining timing estimate (~2-15s based on commit history)
  const cochangeSec = commitCount > 2000 ? 15 : (commitCount > 500 ? 10 : (commitCount > 50 ? 5 : 2));

  // PR mining timing estimate (~8.5s per PR for diff fetch + LLM distillation)
  const prsCount = canMine ? Math.min(prs, 50) : 0;
  const prsSec = canMine ? Math.round(prsCount * 8.5) : 0;

  // Area exploration timing estimate (~55s per area for multi-turn agent exploration)
  const areasCount = canSeed ? Math.min(areas, candidateAreas.length) : 0;
  const areasSec = canSeed ? Math.round(areasCount * 55) : 0;

  // Indexing, linking, and note phrasing timing estimate
  const indexingSec = Math.max(8, Math.round((areasCount * 2.5 + prsCount * 1.5) * 0.25));
  const totalSec = cochangeSec + prsSec + areasSec + indexingSec;

  // Size estimates
  const estPrNotes = canMine ? Math.round(prsCount * 0.7) : 0;
  const estAreaNotes = canSeed ? Math.round(areasCount * 2.5) : 0;
  const minNotes = Math.max(5, estPrNotes + estAreaNotes + 5);
  const maxNotes = Math.max(minNotes + 8, Math.round(minNotes * 1.4));

  const cochangeBytes = Math.min(Math.max(12 * 1024, fileCount * 100), 75 * 1024);
  const prsMetaBytes = 6 * 1024;
  const minBytes = (minNotes * 2000) + cochangeBytes + prsMetaBytes;
  const maxBytes = (maxNotes * 2600) + cochangeBytes + prsMetaBytes;

  const storeDir = path.join(repo, '.thinker');

  return {
    repo,
    repoName: path.basename(repo),
    commitCount,
    fileCount,
    candidateAreasCount: candidateAreas.length,
    canMine,
    mineSource,
    canSeed,
    timing: {
      totalSeconds: totalSec,
      formatted: formatDuration(totalSec),
      breakdown: {
        cochange: formatDuration(cochangeSec),
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
      cochangeFile: path.relative(process.cwd(), path.join(storeDir, 'cochange.json')) || '.thinker/cochange.json',
      prsFile: path.relative(process.cwd(), path.join(storeDir, 'prs.json')) || '.thinker/prs.json',
      stateDir: path.relative(process.cwd(), path.join(storeDir, 'state')) || '.thinker/state/',
    },
    costEstimate: (canSeed ? areasCount * 0.45 : 0) + (canMine ? prsCount * 0.06 : 0),
  };
}
