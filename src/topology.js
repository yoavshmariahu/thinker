// Repository topology and subsystem discovery.
// Decomposes repositories into meaningful architectural areas using
// workspace manifests, directory hierarchy, and git churn history.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CODE_EXTS = /\.(py|ts|tsx|js|jsx|go|rs|rb|java|kt|cs|php|swift|scala|ex|exs|c|cpp|h|hpp)$/i;
const IGNORE_PATHS = /(^|\/)(node_modules|vendor|third_party|dist|build|__snapshots__|migrations|\.git)\//;
const IGNORE_TESTS = /(^|\/)(tests?|__tests__|spec|fixtures?|mocks?|examples?|demos?|docs?)\/|\.(test|spec|stories)\.\w+$/i;

// Parse workspace packages if defined (e.g. package.json, pnpm-workspace.yaml, lerna.json)
export function findWorkspaces(repo) {
  const workspaces = [];
  try {
    const pkgJsonPath = path.join(repo, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const ws = pkg.workspaces;
      const patterns = Array.isArray(ws) ? ws : Array.isArray(ws?.packages) ? ws.packages : [];
      for (const pat of patterns) {
        const cleanPat = pat.replace(/\/\*$/, '');
        const absDir = path.join(repo, cleanPat);
        if (fs.existsSync(absDir) && fs.statSync(absDir).isDirectory()) {
          for (const sub of fs.readdirSync(absDir)) {
            const subDir = path.join(cleanPat, sub);
            if (fs.existsSync(path.join(repo, subDir, 'package.json'))) {
              workspaces.push(subDir);
            }
          }
        }
      }
    }
  } catch {}
  return [...new Set(workspaces)];
}

// Maps a file path to its canonical subsystem/module area.
export function subsystemForFile(repo, filePath) {
  const p = filePath.replace(/\\/g, '/');
  // Check known workspaces or top directories
  const parts = p.split('/');
  if (parts.length <= 1) return '.';
  if (parts.length === 2) return parts[0];
  // Subsystem depth 2 or 3 depending on common conventions
  const top2 = parts.slice(0, 2).join('/');
  if (['pkg/services', 'packages', 'apps', 'products', 'services', 'plugins'].includes(top2) && parts.length > 2) {
    return parts.slice(0, 3).join('/');
  }
  return top2;
}

// Discover architectural areas in the repository, combining file structure,
// adaptive directory depth, and git churn over recent commits.
export function discoverAreas(repo, { limit = 12, churnLimit = 200 } = {}) {
  let rawFiles = [];
  try {
    rawFiles = execFileSync('git', ['ls-files'], { cwd: repo, maxBuffer: 1 << 26 })
      .toString()
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }

  const codeFiles = rawFiles.filter(f => CODE_EXTS.test(f) && !IGNORE_PATHS.test(f));
  const primaryFiles = codeFiles.filter(f => !IGNORE_TESTS.test(f));
  const files = primaryFiles.length >= 5 ? primaryFiles : codeFiles;

  if (!files.length) return [];

  // Count files by 2-segment directory
  const depth2 = {};
  for (const f of files) {
    const parts = f.split('/');
    const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '.';
    depth2[key] = (depth2[key] || 0) + 1;
  }

  const topDirs = Object.keys(depth2);

  // Compact repo case: if <= 3 top directories and < 60 total source files (e.g. click),
  // partition by key individual source files rather than collapsing into 1 directory.
  if (topDirs.length <= 3 && files.length <= 60) {
    const scoredFiles = files
      .filter(f => !/__init__|py\.typed|index\.[jt]s$/i.test(f))
      .map(f => {
        let size = 0;
        try { size = fs.statSync(path.join(repo, f)).size; } catch {}
        const isPrivate = path.basename(f).startsWith('_');
        return { dir: f, n: 1, isFile: true, size, isPrivate };
      });
    scoredFiles.sort((a, b) => (a.isPrivate ? 1 : 0) - (b.isPrivate ? 1 : 0) || b.size - a.size);
    return scoredFiles.slice(0, limit);
  }

  // Adaptive directory clustering
  const clusters = {};
  for (const f of files) {
    const parts = f.split('/');
    let key;
    const p2 = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '.';
    // If a 2-segment directory has > 80 files, split into depth 3 (e.g. pkg/services/auth, posthog/api)
    if (depth2[p2] > 80 && parts.length > 3) {
      key = parts.slice(0, 3).join('/');
    } else {
      key = p2;
    }
    clusters[key] = (clusters[key] || 0) + 1;
  }

  // Count git churn over the last N commits
  const churn = {};
  try {
    const log = execFileSync('git', ['log', '--name-only', '--pretty=format:', '-n', String(churnLimit)], {
      cwd: repo,
      maxBuffer: 1 << 24,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().split('\n');

    for (const line of log) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const k of Object.keys(clusters)) {
        if (trimmed.startsWith(k)) {
          churn[k] = (churn[k] || 0) + 1;
          break;
        }
      }
    }
  } catch {}

  // Score each area: combine file count (mass) with churn (activity)
  const scored = Object.entries(clusters).map(([dir, n]) => {
    const ch = churn[dir] || 0;
    const score = Math.log(n + 1) * (1 + Math.log(ch + 1));
    return { dir, n, churn: ch, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Diversity cap: ensure no single root (e.g. "packages/") takes more than 40% of slots
  // if other roots exist
  const result = [];
  const rootCount = {};
  const maxPerRoot = Math.max(2, Math.floor(limit * 0.45));

  for (const item of scored) {
    const root = item.dir.split('/')[0];
    if (topDirs.length > 2 && (rootCount[root] || 0) >= maxPerRoot) continue;
    result.push(item);
    rootCount[root] = (rootCount[root] || 0) + 1;
    if (result.length >= limit) break;
  }

  // If diversity cap left slots empty, fill from remaining
  if (result.length < limit) {
    for (const item of scored) {
      if (!result.includes(item)) {
        result.push(item);
        if (result.length >= limit) break;
      }
    }
  }

  return result.slice(0, limit);
}
