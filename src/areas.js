// Focus areas: the directories a user's own commits touch. A cache build and maintenance warm
// those areas (their history first, then new merges there) instead of the newest pull requests
// repository-wide, which left the cache cold for most of what a user then asks about
// (bench/serving/README.md, 2026-10-11). The areas live in .thinker/config.json under `areas`:
//   { directories, source: 'activity' | 'manual' | 'all', walk, walked, since }
// 'all' is the generic build: no focus, the whole repository. A hand-edited list sticks.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const AREAS_DEFAULTS = {
  since: 180,  // days of the user's history read
  top: 5,      // directories kept
  depth: 2,    // path components an area has (mlflow/gateway, src/commands)
  walk: 100,   // older changes per area that maintenance mines from history, after which the area is warm
};

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

// Commits by the user since `since` days ago, each as the set of areas it touched.
function commitAreas(repo, { email, since, depth, now = new Date() }) {
  const after = new Date(now.getTime() - since * 86_400_000).toISOString().slice(0, 10);
  let log = '';
  try { log = git(repo, ['log', `--author=${email}`, `--since=${after}`, '--name-only', '--format=%x00%H', '--no-merges']); } catch { return []; }
  const commits = [];
  for (const block of log.split('\x00').slice(1)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const areas = new Set(lines.slice(1).map(f => areaOf(f, depth)).filter(Boolean));
    commits.push(areas);
  }
  return commits;
}

// Merged pull requests of the signed-in GitHub user, for a checkout whose commits carry another
// identity (squash merges under a bot, a work e-mail): each as the set of areas it touched.
function prAreas(repo, { depth, limit = 50 }) {
  let out = '';
  try { out = execFileSync('gh', ['pr', 'list', '--author', '@me', '--state', 'merged', '--limit', String(limit), '--json', 'files'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }); } catch { return []; }
  let prs = []; try { prs = JSON.parse(out); } catch { return []; }
  return prs.map(p => new Set((p.files || []).map(f => areaOf(f.path, depth)).filter(Boolean)));
}

// The user's focus areas from their own activity: directories ranked by the number of commits
// (or merged PRs) that touched them, nested ones folded into their parent, the top few kept.
// { directories, source: 'activity' | 'prs' | null, changes, counts }
export function activityAreas(repo, opts = {}) {
  const o = { ...AREAS_DEFAULTS, ...opts };
  const email = o.email === undefined ? userEmail(repo) : o.email;
  let changes = email ? commitAreas(repo, { ...o, email }) : [];
  let source = 'activity';
  if (changes.length < 3 && !o.noGitHub) { const prs = prAreas(repo, o); if (prs.length > changes.length) { changes = prs; source = 'prs'; } }
  const counts = {};
  for (const set of changes) for (const a of set) counts[a] = (counts[a] || 0) + 1;
  const ranked = Object.entries(counts).filter(([d]) => { try { return fs.statSync(path.join(repo, d)).isDirectory(); } catch { return false; } })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([d]) => d);
  const directories = [];
  for (const d of ranked) { if (directories.length >= o.top) break; if (directories.some(p => d === p || d.startsWith(p + '/') || p.startsWith(d + '/'))) continue; directories.push(d); }
  return { directories, source: directories.length ? source : null, changes: changes.length, counts };
}

export function areasConfig(store) {
  const a = store.config().areas;
  const base = { directories: [], source: 'all', walk: AREAS_DEFAULTS.walk, walked: 0 };
  if (!a || typeof a !== 'object') return base;
  return { ...base, ...a, directories: Array.isArray(a.directories) ? a.directories.filter(d => typeof d === 'string' && d) : [] };
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
