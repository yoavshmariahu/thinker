#!/usr/bin/env bash
# Build the release files: dist/thinker.tgz, dist/version.json (version, commit, sha256 of the
# archive) and dist/install.sh, plus dist/npm, the @zerotimedev/thinker package that carries the
# installer. scripts/release.sh runs it, attaches the three files to the GitHub release of the
# tag and publishes the package. To self-host instead, pass the base URL the three will be served from:
#   scripts/pack.sh https://your.host/thinker
# and the built install.sh downloads from there instead of the GitHub releases.
set -euo pipefail
cd "$(dirname "$0")/.."
base="${1:-}"
export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1
tar_pack=(tar)
if tar --no-xattrs --version >/dev/null 2>&1; then
  tar_pack+=(--no-xattrs)
fi
dist="${THINKER_DIST_DIR:-dist}"
mkdir -p "$dist"
# The archive is the public tool: src without the tests and without the team server (src/server,
# the thinker-server bin), which is not offered publicly; it stays in the repository and runs from
# a checkout (node src/server/cli.js).
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/src"
"${tar_pack[@]}" -c --exclude='*.test.js' --exclude='*.test.tsx' --exclude='src/server' src package-lock.json README.md LICENSE | tar -x -C "$stage"
node --input-type=module - "$stage/package.json" <<'JS'
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
delete pkg.bin['thinker-server'];
fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + '\n');
JS
(cd "$stage" && "${tar_pack[@]}" -czf - src package.json package-lock.json README.md LICENSE) > "$dist/thinker.tgz"
node --input-type=module - "$dist/thinker.tgz" "$dist/version.json" <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const [archive, manifest] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw new Error('package.json must use semantic versioning');
const release = {
  schemaVersion: 1,
  version: pkg.version,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
};
fs.writeFileSync(manifest, JSON.stringify(release, null, 2) + '\n');
JS
if [ -n "$base" ]; then
  # self-hosted copy: install from the tarball next to it instead of the GitHub release
  sed -e "s#^  local dist=\"\${THINKER_DIST_URL:-}\"#  local dist=\"\${THINKER_DIST_URL:-${base%/}/thinker.tgz}\"#" install.sh > "$dist/install.sh"
  grep -q "${base%/}/thinker.tgz" "$dist/install.sh" || { echo "pack.sh: could not point install.sh at $base (its dist line changed?)" >&2; exit 1; }
else
  cp install.sh "$dist/install.sh"
fi
chmod +x "$dist/install.sh"
# The npm package (npx @zerotimedev/thinker): the same installer with a launcher, at the release's
# version. scripts/release.sh publishes the directory.
rm -rf "$dist/npm" && mkdir -p "$dist/npm"
cp npm/install.mjs npm/README.md LICENSE "$dist/npm/"
cp "$dist/install.sh" "$dist/npm/install.sh"
node --input-type=module - "$dist/npm/package.json" <<'JS'
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('npm/package.json', 'utf8'));
pkg.version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
fs.writeFileSync(process.argv[2], JSON.stringify(pkg, null, 2) + '\n');
JS
echo "built $dist/thinker.tgz, $dist/version.json ($(du -h "$dist/thinker.tgz" | cut -f1)) and $dist/install.sh"
if [ -n "$base" ]; then echo "upload all three files to ${base%/}/ ; users run: curl -fsSL ${base%/}/install.sh | bash -s -- --no-build"; fi
