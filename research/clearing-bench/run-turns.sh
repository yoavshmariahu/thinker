#!/bin/bash
# One arm of a paired MULTI-TURN clearing measurement: a proxy of its own, its own log, one resumed
# Claude Code session per rep. The multi-turn shape is what reaches the deep path of the policy:
# `clearable` counts what sits before the current turn, so a single-turn session can never ask deep.
#   THINKER_SRC=<checkout> OUT=<dir> ./run-turns.sh <arm> <holdout 0|1> <reps> <turns dir> [extra proxy flags...]
set -eo pipefail
: "${THINKER_SRC:?set THINKER_SRC to a thinker checkout}"; : "${OUT:?set OUT to an output directory}"
ARM="$1"; HOLDOUT="$2"; REPS="$3"; TURNS="$4"; shift 4; EXTRA=("$@")
MODEL="${MODEL:-claude-opus-5-5}"
P="${PORT:-$(~/.claude/bin/claude-port reserve thinker clearbench)}"
mkdir -p "$OUT"   # an arm creates its own output dir: without it line 11 failed after reserving a port
LOG="$OUT/log-$ARM.jsonl"; : > "$LOG"
export THINKER_HOME="$OUT/home-$ARM"; mkdir -p "$THINKER_HOME/state"; export THINKER_PROXY_LOG="$LOG"
node "$THINKER_SRC/src/cli.js" proxy --port "$P" --holdout "$HOLDOUT" ${EXTRA[@]+"${EXTRA[@]}"} > "$OUT/proxy-$ARM.out" 2>&1 &
PROXY=$!; sleep 2
for r in $(seq 1 "$REPS"); do
  SID=$(uuidgen | tr 'A-Z' 'a-z')
  OUTF="$OUT/out-$ARM-$r.txt"; : > "$OUTF"
  first=1
  for t in "$TURNS"/turn-*.txt; do
    if [ "$first" = 1 ]; then SESS=(--session-id "$SID"); first=0; else SESS=(--resume "$SID"); fi
    ANTHROPIC_BASE_URL="http://127.0.0.1:$P" THINKER_TEST=1 \
      claude -p "$(cat "$t")" "${SESS[@]}" --model "$MODEL" --allowedTools Read Bash --setting-sources '' \
      >> "$OUTF" 2>&1 </dev/null || true
    echo "" >> "$OUTF"
    echo "  [$ARM rep$r $(basename "$t")] $(tail -2 "$OUTF" | tr -d '\n' | tail -c 70)"
  done
  echo "[$ARM rep$r] session $SID, $(grep -c '"op":"proxy"' "$LOG" || echo 0) rows so far"
done
kill $PROXY 2>/dev/null || true; wait $PROXY 2>/dev/null || true
echo "[$ARM] $(grep -c '"op":"proxy"' "$LOG" || echo 0) request rows, $(grep -c '"cleared":[1-9]' "$LOG" || echo 0) with a clear"
