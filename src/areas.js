// Where a file belongs, and the directories a cache's mining is scoped to.
//
// History. Focus areas were the directories a person's own commits touched: found from their
// activity, refreshed daily, and warmed from git history by a build and by maintenance instead of
// the newest pull requests repository-wide (research/bench-history/serving/README.md, 2026-10-11).
// The warm-up went on 2026-10-21 with the rest of the background spend, and nothing has refreshed
// or walked an area since - `activityAreas`, `refreshAreas` and `saveAreas` had no caller left in
// the product at all - while `thinker usage` went on printing the saved list as "from your commits,
// refreshed daily" with "older history read: N of M changes" under it, neither of which was true in
// any configuration. A user read that line in October 2026 and reported their areas as out of date;
// they were not out of date, they were dead. So the finders and the line are gone, and `thinker
// rewire` drops the leftover `areas` key where mining is off (retire-background.js).
//
// What is left: `areaOf`, the two-level directory key that coverage.js and the skill evidence group a
// path by, and `areasConfig`, which still scopes `mine-prs` and `understand` - the commands Artemis
// builds its benchmark caches with - for a repository that sets `areas.directories` by hand.
export const AREAS_DEFAULTS = {
  depth: 2,    // path components an area has (mlflow/gateway, src/commands)
};

// Directories that hold no code of the user's, and files that are data rather than code.
const SKIP_DIR = /^(\.[^/]*|node_modules|vendor|third_party|dist|build|out|target|coverage|__pycache__|fixtures?|testdata|snapshots?|__snapshots__|assets?|static|public)(\/|$)/i;
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb', 'php', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm', 'swift', 'sh', 'bash', 'zsh', 'sql', 'proto', 'vue', 'svelte', 'html', 'css', 'scss', 'less', 'yaml', 'yml', 'toml', 'tf', 'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'lua', 'r', 'jl', 'dart']);

// The area a changed file belongs to: its first `depth` path components, when the file is code
// and the directory is one a user works in. A file at the root belongs to no area.
export function areaOf(file, depth = AREAS_DEFAULTS.depth) {
  const parts = String(file || '').split('/');
  if (parts.length < 2 || SKIP_DIR.test(file)) return null;
  const ext = parts[parts.length - 1].split('.').pop().toLowerCase();
  if (!CODE_EXT.has(ext)) return null;
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}

// The directories mining is scoped to, from `areas` in .thinker/config.json. None (the default, and
// what `rewire` leaves behind) is the whole repository.
export function areasConfig(store) {
  const a = store.config().areas;
  if (!a || typeof a !== 'object') return { directories: [], source: 'all' };
  const directories = Array.isArray(a.directories) ? a.directories.filter(d => typeof d === 'string' && d) : [];
  return { directories, source: directories.length ? a.source || 'manual' : 'all' };
}
