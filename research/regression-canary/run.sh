#!/usr/bin/env bash
set -euo pipefail
# Run from the root of an isolated Thinker worktree. REPO is a separate fixed
# mitmproxy worktree at the commit recorded in cases.json.
: "${REPO:?Set REPO to an isolated mitmproxy worktree}"
export THINKER_TEST=1 THINKER_TELEMETRY=off THINKER_LOG=local THINKER_NO_LEARN=1
export THINKER_LLM=codex THINKER_LLM_MODEL=gpt-6.1-sol THINKER_CODEX_REASONING_EFFORT=high
TASK_DIR=research/regression-canary
# This patch only adds the explicit reasoning-effort argument used in the
# prior Autoscaler cohort. It must be applied once in this isolated checkout.
git apply --check "$TASK_DIR/model-effort.patch"
git apply "$TASK_DIR/model-effort.patch"
node "$TASK_DIR/build-notes.mjs" "$REPO" "$TASK_DIR/cases.json" "$TASK_DIR/notes.json"
node "$TASK_DIR/run-pairs.mjs" "$REPO" "$TASK_DIR/cases.json" "$REPO/.thinker/local/notes" "$TASK_DIR/results"
