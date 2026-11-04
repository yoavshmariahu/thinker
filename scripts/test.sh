#!/usr/bin/env bash
# Run the suite inside one temporary directory and remove it at exit. The tests make
# thousands of scratch checkouts and homes under os.tmpdir() and do not clean up each one;
# left in the system temp directory they filled it (121G, 65535 entries by 2026-10-17).
# The tests share the machine's models directory: a fake home would otherwise download its
# own ~88MB copy of the cross-encoder model.
set -uo pipefail
cd "$(dirname "$0")/.."
# Which files run: named files as given; `--all` the whole suite; otherwise the test files the
# change against main reaches (scripts/select-tests.mjs: the import graph plus the paths the tests
# spawn or read), which is the whole suite when package.json, the lockfile or this script changed.
# TEST_BASE names another base than origin/main (TEST_BASE=HEAD: the working tree alone).
files=("$@")
if [ "${1:-}" = "--all" ]; then
  files=(test/*.test.js)
elif [ ${#files[@]} -eq 0 ]; then
  selected="$(node scripts/select-tests.mjs ${TEST_BASE:+--base "$TEST_BASE"})" || exit 1
  if [ -z "$selected" ]; then echo "thinker tests: no test file reaches the change; npm test -- --all runs the whole suite" >&2; exit 0; fi
  files=(); while IFS= read -r f; do files+=("$f"); done <<<"$selected"
fi
run="$(mktemp -d "${TMPDIR:-/tmp}/thinker-test-run.XXXXXX")"
trap 'rm -rf "$run"' EXIT
trap 'exit 130' INT TERM
export THINKER_MODELS_DIR="${THINKER_MODELS_DIR:-$HOME/.thinker/models}"
# Run from a desktop app's agent (Claude Desktop, Cursor), the shell carries the app's marker: every test
# then took itself for an app session (2026-10-17: two failures on main, only when run from Claude Desktop).
unset CLAUDE_CODE_ENTRYPOINT CURSOR_AGENT
# --test-force-exit: node --test has no timeout and gives each file its own process, so a file that
# leaves a handle open (an http server closed on the test's last line, which a failing assertion never
# reaches) never exits, the runner waits for it for ever, and its buffered diagnostics are never
# printed. Three stale proxy assertions sat on main exactly that way: every run hung with no failure
# named, and `bash scripts/release.sh` hung with it, since it runs the whole suite in its temp worktree.
TMPDIR="$run" THINKER_TEST=1 node --test --test-force-exit "${files[@]}"
