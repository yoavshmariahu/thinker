#!/usr/bin/env node
// Repository-local fallback until GitHub server-side protection is available.
// Preserve the existing pre-push hook and replay its stdin after checking destinations.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MARKER = '# thinker: require pull requests for main';
export function guardScript(previous) {
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
${MARKER}
input=$(cat)
printf '%s\\n' "$input" | while read -r local_ref local_sha remote_ref remote_sha; do
  if [ "$remote_ref" = refs/heads/main ]; then
    echo 'Direct pushes to main are blocked. Push a task branch and merge a GitHub pull request.' >&2
    exit 1
  fi
done || exit 1
${previous ? `printf '%s\\n' "$input" | ${quote(previous)} "$@"` : 'exit 0'}
`;
}
export function install(repo = process.cwd()) {
  const hook = path.resolve(repo, execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: repo, encoding: 'utf8' }).trim());
  const before = fs.existsSync(hook) ? fs.readFileSync(hook, 'utf8') : '';
  if (before.includes(MARKER)) return { installed: true, existing: true, hook };
  const previous = `${hook}.before-pr-policy`;
  if (before && fs.existsSync(previous)) throw new Error('Previous hook backup exists; refusing to overwrite it');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  if (before) fs.renameSync(hook, previous);
  try { fs.writeFileSync(hook, guardScript(before ? previous : null), { mode: 0o755 }); }
  catch (error) { if (before) fs.renameSync(previous, hook); throw error; }
  return { installed: true, existing: false, hook };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(install()));
