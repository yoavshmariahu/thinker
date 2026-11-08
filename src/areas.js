// The two-level directory key a path is grouped by (`src/commands`, `mlflow/gateway`): the profile stamps each
// observation with the areas a session's tool calls touched (profile.js:sessionDirs). The focus areas, their
// finders and the mining scope they set went with the notes (2026-10-21 and 2026-11-08).
export const AREAS_DEFAULTS = {
  depth: 2,    // path components an area has
};

// Directories that hold no code of the user's, and files that are data rather than code.
const SKIP_DIR = /^(\.[^/]*|node_modules|vendor|third_party|dist|build|out|target|coverage|__pycache__|fixtures?|testdata|snapshots?|__snapshots__|assets?|static|public)(\/|$)/i;
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'rb', 'php', 'cs', 'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm', 'swift', 'sh', 'bash', 'zsh', 'sql', 'proto', 'vue', 'svelte', 'html', 'css', 'scss', 'less', 'yaml', 'yml', 'toml', 'tf', 'ex', 'exs', 'erl', 'clj', 'hs', 'ml', 'lua', 'r', 'jl', 'dart']);

// The area a file belongs to: its first `depth` path components, when the file is code and the directory is
// one a user works in. A file at the root belongs to no area.
export function areaOf(file, depth = AREAS_DEFAULTS.depth) {
  const parts = String(file || '').split('/');
  if (parts.length < 2 || SKIP_DIR.test(file)) return null;
  const ext = parts[parts.length - 1].split('.').pop().toLowerCase();
  if (!CODE_EXT.has(ext)) return null;
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
}
