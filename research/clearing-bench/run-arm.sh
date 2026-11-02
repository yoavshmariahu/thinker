#!/bin/bash
# One arm of a paired clearing measurement: a proxy of its own, its own log, N reps of one prompt.
#   THINKER_SRC=<checkout> OUT=<dir> ./run-arm.sh <arm> <holdout 0|1> <reps> <prompt file> [extra proxy flags...]
# The proxy is reached through ANTHROPIC_BASE_URL, so nothing touches the machine's own service or log.
set -eo pipefail
: "${THINKER_SRC:?set THINKER_SRC to a thinker checkout}"; : "${OUT:?set OUT to an output directory}"
ARM="$1"; HOLDOUT="$2"; REPS="$3"; PROMPT="$4"; shift 4; EXTRA=("$@")
MODEL="${MODEL:-claude-opus-5-5}"
P="${PORT:-$(~/.claude/bin/claude-port reserve thinker clearbench)}"
LOG="$OUT/log-$ARM.jsonl"; : > "$LOG"
export THINKER_HOME="$OUT/home-$ARM"; mkdir -p "$THINKER_HOME/state"; export THINKER_PROXY_LOG="$LOG"
node "$THINKER_SRC/src/cli.js" proxy --port "$P" --holdout "$HOLDOUT" ${EXTRA[@]+"${EXTRA[@]}"} > "$OUT/proxy-$ARM.out" 2>&1 &
PROXY=$!; sleep 2
for r in $(seq 1 "$REPS"); do
  ANTHROPIC_BASE_URL="http://127.0.0.1:$P" THINKER_TEST=1 \
    claude -p "$(cat "$PROMPT")" --model "$MODEL" --allowedTools Read Bash --setting-sources '' \
    > "$OUT/out-$ARM-$r.txt" 2>&1 </dev/null || true
  echo "[$ARM rep$r] $(tail -c 60 "$OUT/out-$ARM-$r.txt" | tr -d '\n')"
done
kill $PROXY 2>/dev/null || true; wait $PROXY 2>/dev/null || true
echo "[$ARM] $(grep -c '"op":"proxy"' "$LOG" || echo 0) request rows"
