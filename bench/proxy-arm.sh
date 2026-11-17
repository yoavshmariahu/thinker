#!/bin/sh
# A bench arm that runs behind a thinker proxy of its own.
#
# The bench's rule is that no session inherits this machine's proxy (bench/README.md): every arm pins
# ANTHROPIC_BASE_URL. An arm that is ABOUT the proxy therefore has to start its own, with its own policy,
# its own log and its own port, and tear it down after -- otherwise the figures are this machine's clearing
# measured against itself.
#
# The policy arrives as arguments rather than in the arm's `env`, because the bench runs `before`/`after`
# with the parent environment, not the arm's (bench.mjs: sh(cmd[0], args, { cwd })). The arm's `env` still
# reaches the AGENT, which is what ANTHROPIC_BASE_URL is for.
#
#   start <port> <cut-inputs on|off> <cwd> [cut-thinking on|off]   start it, wait until it listens
#   stop  <port> <cut-inputs on|off> <cwd> [cut-thinking on|off]   print the session's own figures as JSON, then stop it
#
# The proxy is this checkout's own (the script's directory), so an arm tests the code it sits beside.
#
# One proxy per session: the log is the session's own worktree, so two arms can never pool their rows.
set -u
CLI=${THINKER_CLI:-$(cd "$(dirname "$0")/.." && pwd)/src/cli.js}
NODE=${THINKER_NODE:-/opt/homebrew/Cellar/node@24/24.15.0/bin/node}
ACT=$1; PORT=$2; INPUTS=$3; CWD=$4; THINKING=${5:-off}
LOG=$CWD/.thinker-bench/proxy.jsonl
OUT=$CWD/.thinker-bench/proxy.out
PID=$CWD/.thinker-bench/proxy.pid
mkdir -p "$CWD/.thinker-bench"

# The policy under test: the shipped defaults (trigger 140k, floor 8k, payback 25, keepMin 3).
export THINKER_TEST=1
export THINKER_PROXY_LOG=$LOG
export THINKER_PROXY_PORT=$PORT
export THINKER_PROXY_CUT_INPUTS=$INPUTS
export THINKER_PROXY_CUT_THINKING=$THINKING
export THINKER_PROXY_HOLDOUT=0      # every session is cut: the bench pairs arms itself

case "$ACT" in
  start)
    [ -f "$PID" ] && { kill "$(cat "$PID")" 2>/dev/null; sleep 0.3; }
    ( while true; do "$NODE" "$CLI" proxy >> "$OUT" 2>&1; echo "proxy exited $? at $(date -u +%FT%TZ), restarting" >> "$OUT"; sleep 1; done ) </dev/null >/dev/null 2>&1 &
    echo $! > "$PID"
    i=0
    while [ $i -lt 20 ]; do
      if grep -q "thinker proxy on" "$OUT" 2>/dev/null; then head -1 "$OUT"; exit 0; fi
      i=$((i+1)); sleep 0.5
    done
    echo "PROXY FAILED"; cat "$OUT" 2>/dev/null; exit 1 ;;
  stop)
    "$NODE" "$CLI" proxy report --json 2>/dev/null
    [ -f "$PID" ] && { pkill -P "$(cat "$PID")" 2>/dev/null; kill "$(cat "$PID")" 2>/dev/null; rm -f "$PID"; } ;;
esac
