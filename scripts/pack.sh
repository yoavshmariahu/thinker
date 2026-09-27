#!/usr/bin/env bash
# Optional: build files to self-host outside GitHub: dist/thinker.tgz and dist/install.sh.
#   scripts/pack.sh https://your.host/thinker
# The base URL is where you will upload both files.
set -euo pipefail
cd "$(dirname "$0")/.."
base="${1:-}"
mkdir -p dist
tar -czf dist/thinker.tgz --exclude='*.test.js' src package.json package-lock.json README.md
if [ -n "$base" ]; then
  # self-hosted copy: install from the tarball next to it instead of GitHub
  sed -e "s#^  local dist=\"\${THINKER_DIST_URL:-}\"#  local dist=\"\${THINKER_DIST_URL:-${base%/}/thinker.tgz}\"#" install.sh > dist/install.sh
else
  cp install.sh dist/install.sh
fi
chmod +x dist/install.sh
echo "built dist/thinker.tgz ($(du -h dist/thinker.tgz | cut -f1)) and dist/install.sh"
if [ -n "$base" ]; then echo "upload both to ${base%/}/ ; users run: curl -fsSL ${base%/}/install.sh | bash -s -- --cache <cache-url>"; fi
