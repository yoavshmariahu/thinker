// Repository topology and subsystem discovery.
// Decomposes repositories into meaningful architectural areas using
// workspace manifests, directory hierarchy, and git churn history.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { directoryPathspecs, includesPath } from './project.js';

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

// Per-session working-set heuristics, not a limit on repository coverage. About
// 32k source tokens leaves room for dependency reads and the exploration trace.
// File count also bounds the inventory for repositories with many tiny files.
export const AREA_SOURCE_BYTES = 128 * 1024;
export const AREA_SOURCE_FILES = 80;

export function parseAreaLimit(value) {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (typeof value === 'boolean' || String(value).trim() === '' || !Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('the area limit must be a non-negative integer');
  }
  return limit;
}

export function discoverAreas(repo, options = {}) {
  return planAreas(repo, options).areas;
}

// Partition all selected source files, then rank sessions by size and churn.
// Only an explicit limit leaves areas out; the same plan drives preview and build.
export function planAreas(repo, { limit, churnLimit = 200, directories = null } = {}) {
  limit = parseAreaLimit(limit);
  let rawFiles = [];
  try {
    rawFiles = execFileSync('git', ['ls-files', '-z', '--', ...directoryPathspecs(directories)], { cwd: repo, maxBuffer: 1 << 26 })
      .toString().split('\0').filter(Boolean);
  } catch {
    return { areas: [], omitted: [] };
  }
  const codeFiles = rawFiles.filter(f => CODE_EXTS.test(f) && !IGNORE_PATHS.test(f));
  const primaryFiles = codeFiles.filter(f => !IGNORE_TESTS.test(f));
  const files = (primaryFiles.length ? primaryFiles : codeFiles).flatMap(file => {
    try {
      const stat = fs.lstatSync(path.join(repo, file));
      return stat.isFile() ? [{ file, size: stat.size }] : [];
    } catch { return []; }
  }).sort((a, b) => a.file.localeCompare(b.file, 'en'));

  const clusters = [];
  const sizeOf = entries => entries.reduce((sum, entry) => sum + entry.size, 0);
  const fits = entries => entries.length <= AREA_SOURCE_FILES && sizeOf(entries) <= AREA_SOURCE_BYTES;
  const add = (dir, entries) => {
    if (!entries.length) return;
    const isFile = entries.length === 1;
    clusters.push({ dir: isFile ? entries[0].file : dir, isFile, n: entries.length,
      size: sizeOf(entries), files: entries.map(entry => entry.file) });
  };
  const partition = (dir, entries) => {
    if (entries.length === 1 || fits(entries)) { add(dir, entries); return; }
    const children = new Map();
    const prefix = dir === '.' ? '' : dir + '/';
    for (const entry of entries) {
      const relative = entry.file.slice(prefix.length);
      const child = prefix + relative.split('/')[0];
      if (!children.has(child)) children.set(child, []);
      children.get(child).push(entry);
    }
    let batch = [];
    for (const [child, group] of children) {
      if (!fits(group)) {
        add(dir, batch); batch = [];
        // A single oversized file stays intact; directories keep splitting.
        if (group.length === 1) add(dir, group);
        else partition(child, group);
      } else {
        if (!fits([...batch, ...group])) { add(dir, batch); batch = []; }
        batch.push(...group);
      }
    }
    add(dir, batch);
  };
  // Keep selected roots separate and never widen them to a parent. Normalize
  // overlapping roots here as well as in the project-file reader.
  const roots = (directories?.length ? directories : ['.'])
    .filter((dir, i, all) => all.indexOf(dir) === i && !all.some(other => other !== dir && includesPath([other], dir)));
  for (const root of roots) partition(root, files.filter(entry => includesPath([root], entry.file)));

  const byFile = new Map(clusters.flatMap(area => area.files.map(file => [file, area])));
  for (const area of clusters) area.churn = 0;
  try {
    const log = execFileSync('git', ['log', '--name-only', '--pretty=format:', '-n', String(churnLimit), '--', ...directoryPathspecs(directories)], {
      cwd: repo, maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().split('\n');
    for (const file of log) {
      const area = byFile.get(file);
      if (area) area.churn++;
    }
  } catch {}
  const totals = new Map(), ordinals = new Map();
  for (const area of clusters) totals.set(area.dir, (totals.get(area.dir) || 0) + 1);
  for (const area of clusters) {
    const ordinal = (ordinals.get(area.dir) || 0) + 1;
    ordinals.set(area.dir, ordinal);
    area.label = totals.get(area.dir) > 1 ? `${area.dir} (part ${ordinal}/${totals.get(area.dir)})` : area.dir;
    area.score = Math.log(area.size + 1) * (1 + Math.log(area.churn + 1));
  }
  clusters.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label, 'en'));
  return { areas: clusters.slice(0, limit), omitted: limit === undefined ? [] : clusters.slice(limit) };
}
