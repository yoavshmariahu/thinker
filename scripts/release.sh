#!/usr/bin/env bash
# Manual, resumable release runner. See docs/releases.md.
set -euo pipefail
exec node "$(dirname "$0")/release.mjs" "$@"
