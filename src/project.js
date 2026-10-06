// A project selects work for cache builds. It never filters the shared repository cache.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PROJECT_FILE = 'thinker.project.json';

export function includesPath(directories, file) {
  return !directories || directories.some(dir => dir === '.' || file === dir || file.startsWith(dir + '/'));
}

export function validateProject(repo, project) {
  if (!project || project.version !== 1 || typeof project.name !== 'string' || !project.name.trim()) {
    throw new Error('A thinker project needs version: 1 and a nonempty name.');
  }
  if (!Array.isArray(project.directories) || !project.directories.length) {
    throw new Error('Specify at least one project directory (use "." for the full repo).');
  }
  const root = fs.realpathSync(repo);
  const directories = project.directories.map(dir => {
    if (typeof dir !== 'string' || !dir.trim() || path.isAbsolute(dir) || dir.includes('\\') || dir.includes('\0')) {
      throw new Error('Project directories must be paths relative to the repository root.');
    }
    const normalized = path.posix.normalize(dir.trim()).replace(/\/$/, '') || '.';
    if (normalized === '..' || normalized.startsWith('../')) throw new Error(`Project directory escapes the repository: ${dir}`);
    const target = path.resolve(repo, normalized);
    let real;
    try {
      real = fs.realpathSync(target);
      if (!fs.statSync(target).isDirectory()) throw new Error();
    } catch { throw new Error(`Project directory does not exist or is not a directory: ${dir}`); }
    const relative = path.relative(root, real);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error(`Project directory escapes the repository through a symlink: ${dir}`);
    }
    return normalized;
  });
  const unique = [...new Set(directories)];
  return { version: 1, name: project.name.trim(), directories: unique.filter(dir => !unique.some(parent => parent !== dir && includesPath([parent], dir))) };
}

export function readProject(repo, file = PROJECT_FILE, { optional = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(path.resolve(repo, file), 'utf8'); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
  try { return validateProject(repo, JSON.parse(raw)); }
  catch (e) { throw new Error(`${file}: ${e.message}`); }
}

export function writeProject(repo, project, file = PROJECT_FILE, { overwrite = false } = {}) {
  const validated = validateProject(repo, project);
  fs.writeFileSync(path.resolve(repo, file), JSON.stringify(validated, null, 2) + '\n', { flag: overwrite ? 'w' : 'wx' });
  return validated;
}

// All CLI paths, including selected directories, are repository-relative.
export function projectFromFlags(repo, flags = {}, { save = false } = {}) {
  if (flags['full-repo']) {
    if (flags.project || flags.directories) throw new Error('--full-repo cannot be combined with --project or --directories.');
    return null;
  }
  if (flags.project !== undefined && typeof flags.project !== 'string') throw new Error('--project needs a file path.');
  const file = flags.project || PROJECT_FILE;
  if (flags.directories !== undefined) {
    if (typeof flags.directories !== 'string') throw new Error('--directories needs comma-separated repository-relative paths.');
    const project = { version: 1, name: flags.name || path.basename(repo), directories: flags.directories.split(',') };
    return save ? writeProject(repo, project, file, { overwrite: true }) : validateProject(repo, project);
  }
  return readProject(repo, file, { optional: !flags.project });
}

// A separate scan cursor means skipping another project's PRs never hides them globally.
export function projectRecordKey(slug, directories) {
  return `${slug}:project:${createHash('sha256').update(JSON.stringify([...directories].sort())).digest('hex').slice(0, 16)}`;
}

export const directoryPathspecs = directories => directories?.includes('.') ? [] : (directories || []).map(dir => `:(top,literal)${dir}`);
