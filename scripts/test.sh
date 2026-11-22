#!/usr/bin/env bash
# Run the suite: every test file, every time. It takes a few seconds, so there is no selection;
# `npm test -- test/x.test.js` runs the named files alone.
#
# test/helpers.js, which every test file imports first, is what makes a run safe (a throwaway home, test mode,
# no telemetry), so a file run by hand with `node --test` is as safe as one run from here. This script only
# gives the run one temporary directory and removes it at exit, and forces the exit: node --test has no
# timeout, so a file that leaves a handle open would otherwise hang the run with no failure named.
set -uo pipefail
cd "$(dirname "$0")/.."
files=()
for arg in "$@"; do [ "$arg" = "--all" ] || files+=("$arg"); done
[ ${#files[@]} -eq 0 ] && files=(test/*.test.js)
run="$(mktemp -d "${TMPDIR:-/tmp}/thinker-test-run.XXXXXX")"
trap 'rm -rf "$run"' EXIT
trap 'exit 130' INT TERM
TMPDIR="$run" THINKER_TEST=1 node --test --test-force-exit "${files[@]}"
