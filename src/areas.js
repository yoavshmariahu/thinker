// Focus areas: the directories a user's own commits touch. A cache build and maintenance warm
// those areas (their history first, then new merges there) instead of the newest pull requests
// repository-wide, which left the cache cold for most of what a user then asks about
// (research/bench-history/serving/README.md, 2026-10-11). The areas live in .thinker/config.json under `areas`:
//   { directories, source: 'activity' | 'prs' | 'manual' | 'all', walk, walkedBy, found, refreshedAt }
// 'all' is the generic build: no focus, the whole repository. Areas found from activity follow the
// person: maintenance finds them again once a day (`refreshAreas`), from half a year of their
// changes with the recent ones counting most, since where someone works moves (2026-10-15, the
// user's call). A cache nobody built gets its first areas the same way. A chosen list ('manual',
// 'all') and a hand-edited one (directories that differ from `found`) stick.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const AREAS_DEFAULTS = {
  since: 180,  // days of the user's history read
  top: 5,      // directories kept
  depth: 2,    // path components an area has (mlflow/gateway, src/commands)
  walk: 100,   // older changes per area that maintenance mines from history, after which the area is warm
  halfLife: 30, // days after which a change counts half toward ranking the areas
};
export const REFRESH_MS = 24 * 60 * 60_000;

// Directories that hold no code of the user's, and files that are data rather than code.
const SKIP_DIR = /^(\.[^/]*|node_modules|vendor|third_party|dist|build|out|target|coverage|__pycache__|fixtures?|testdata|snapshots?|__snapshots__|assets?|static|public)(\/|$)/i;
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb', 'php', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm', 'swift', 'sh', 'bash', 'zsh', 'sql', 'proto', 'vue', 'svelte', 'html', 'css', 'scss', 'less', 'yaml', 'yml', 'toml', 'tf', 'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'lua', 'r', 'jl', 'dart']);

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 26 });

export function userEmail(repo) {
  try { return git(repo, ['config', 'user.email']).trim() || null; } catch { return null; }
}

// The area a changed file belongs to: its first `depth` path components, when the file is code
// and the directory is one a user works in. A file at the root belongs to no area.
export function areaOf(file, depth = AREAS_DEFAULTS.depth) {
  const parts = String(file || '').split('/');
  if (parts.length < 2 || SKIP_DIR.test(file)) return null;
  const ext = parts[parts.length - 1].split('.').pop().toLowerCase();
  if (!CODE_EXT.has(ext)) return null;
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}

// Commits by the user since `since` days ago, each as the set of areas it touched and its time.
function commitAreas(repo, { email, since, depth, now = new Date() }) {
  const after = new Date(now.getTime() - since * 86_400_000).toISOString().slice(0, 10);
  let log = '';
  try { log = git(repo, ['log', `--author=${email}`, `--since=${after}`, '--name-only', '--format=%x00%H %ct', '--no-merges']); } catch { return []; }
  const commits = [];
  for (const block of log.split('\x00').slice(1)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const areas = new Set(lines.slice(1).map(f => areaOf(f, depth)).filter(Boolean));
    commits.push({ areas, t: Number(lines[0]?.split(' ')[1]) * 1000 || now.getTime() });
  }
  return commits;
}

// Merged pull requests of the signed-in GitHub user, for a checkout whose commits carry another
// identity (squash merges under a bot, a work e-mail): each as the set of areas it touched.
function prAreas(repo, { depth, limit = 50, now = new Date() }) {
  let out = '';
  try { out = execFileSync('gh', ['pr', 'list', '--author', '@me', '--state', 'merged', '--limit', String(limit), '--json', 'files,mergedAt'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }); } catch { return []; }
  let prs = []; try { prs = JSON.parse(out); } catch { return []; }
  return prs.map(p => ({ areas: new Set((p.files || []).map(f => areaOf(f.path, depth)).filter(Boolean)), t: Date.parse(p.mergedAt) || now.getTime() }));
}

// The user's focus areas from their own activity: directories ranked by the commits (or merged
// PRs) that touched them, each weighted by its age (`halfLife`), so this month's work outranks
// last spring's and the older months still count; nested ones folded into their parent, the top
// few kept. { directories, source: 'activity' | 'prs' | null, changes, counts, weights }
export function activityAreas(repo, opts = {}) {
  const o = { ...AREAS_DEFAULTS, ...opts };
  const email = o.email === undefined ? userEmail(repo) : o.email;
  let changes = email ? commitAreas(repo, { ...o, email }) : [];
  let source = 'activity';
  if (changes.length < 3 && !o.noGitHub) { const prs = prAreas(repo, o); if (prs.length > changes.length) { changes = prs; source = 'prs'; } }
  const now = (o.now || new Date()).getTime();
  const counts = {}, weights = {};
  for (const { areas, t } of changes) {
    const w = Math.pow(0.5, Math.max(0, now - t) / 86_400_000 / o.halfLife);
    for (const a of areas) { counts[a] = (counts[a] || 0) + 1; weights[a] = (weights[a] || 0) + w; }
  }
  const ranked = Object.keys(counts).filter(d => { try { return fs.statSync(path.join(repo, d)).isDirectory(); } catch { return false; } })
    .sort((a, b) => weights[b] - weights[a] || counts[b] - counts[a] || a.localeCompare(b));
  const directories = [];
  for (const d of ranked) { if (directories.length >= o.top) break; if (directories.some(p => d === p || d.startsWith(p + '/') || p.startsWith(d + '/'))) continue; directories.push(d); }
  return { directories, source: directories.length ? source : null, changes: changes.length, counts, weights };
}

// The saved areas, with how much of each one's older history has been read (`walkedBy`, by
// directory; kept for areas that drop out, so one that comes back resumes) and `walked`, their
// sum over the present areas. Caches from before 2026-10-15 kept one `walked` for all the areas:
// it is spread evenly over them.
export function areasConfig(store) {
  const a = store.config().areas;
  const base = { directories: [], source: 'all', walk: AREAS_DEFAULTS.walk, walked: 0, walkedBy: {} };
  if (!a || typeof a !== 'object') return base;
  const directories = Array.isArray(a.directories) ? a.directories.filter(d => typeof d === 'string' && d) : [];
  const walk = Number(a.walk) > 0 ? Number(a.walk) : base.walk;
  let walkedBy = a.walkedBy && typeof a.walkedBy === 'object' ? { ...a.walkedBy } : null;
  if (!walkedBy) { walkedBy = {}; const each = directories.length ? Math.min(walk, Math.floor((Number(a.walked) || 0) / directories.length)) : 0; for (const d of directories) walkedBy[d] = each; }
  const walked = directories.reduce((n, d) => n + Math.min(walk, Number(walkedBy[d]) || 0), 0);
  return { ...base, ...a, directories, walk, walkedBy, walked };
}

// Find the areas again from the person's activity when they follow it and the last look is a day
// old (or there are none yet). Nothing found keeps what is there: a quiet month moves nothing.
// Returns the saved areas when they changed, else null.
export function refreshAreas(store, repo, { now = Date.now(), find = activityAreas, findOpts = {} } = {}) {
  const saved = store.config().areas;
  if (saved && typeof saved === 'object') {
    if (!['activity', 'prs'].includes(saved.source)) return null;
    const dirs = Array.isArray(saved.directories) ? saved.directories : [];
    if (Array.isArray(saved.found) && saved.found.join('\n') !== dirs.join('\n')) return null; // edited by hand
    if (Date.parse(saved.refreshedAt) > now - REFRESH_MS) return null;
  }
  const found = find(repo, { ...findOpts, now: new Date(now) });
  if (!found?.directories?.length) return null;
  const before = areasConfig(store);
  return saveAreas(store, { directories: found.directories, found: found.directories, source: found.source, refreshedAt: new Date(now).toISOString(), walkedBy: before.walkedBy, walked: undefined });
}

export function saveAreas(store, areas) {
  const file = path.join(store.dir, 'config.json');
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  cfg.areas = { ...(cfg.areas && typeof cfg.areas === 'object' ? cfg.areas : {}), ...areas };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return cfg.areas;
}

// Notes that point into each area (a dep path under the directory), for the coverage line.
export function notesByArea(notes, directories) {
  const by = Object.fromEntries(directories.map(d => [d, 0]));
  for (const n of notes) {
    const hit = new Set();
    for (const dep of n.deps || []) for (const d of directories) if (dep.path === d || String(dep.path || '').startsWith(d + '/')) hit.add(d);
    for (const d of hit) by[d]++;
  }
  return by;
}
