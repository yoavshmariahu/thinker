#!/bin/sh
# A bench arm behind a thinker proxy of its own, for any policy.
#
# The bench's rule is that no session inherits this machine's proxy (bench/README.md), so an arm that is
# about the proxy starts its own: its own policy, its own log in the session's directory, and a port of
# its own that is reserved when it starts and released when it stops (never a number written in a spec).
# The proxy is this checkout's (`src/cli.js` beside this script), so the arm measures the code it sits in.
#
#   proxy-arm.sh start <cwd> [proxy flags ...]   start it with that policy; hand the agent its address
#   proxy-arm.sh stop  <cwd>                    print the session's figures as JSON, stop it, release the port
#
# The policy arrives as the proxy's own flags (--long-turn, --ephemeral ...), passed straight to
# `thinker proxy`: no variable is invented for an arm. The agent's address goes back through `.bench-env`,
# which the bench merges into the session's environment (bench.mjs).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
CLI=${THINKER_CLI:-$HERE/../../src/cli.js}
NODE=${THINKER_NODE:-node}
PORTS=${CLAUDE_PORT:-$HOME/.claude/bin/claude-port}
ACT=$1; CWD=$2; shift 2
DIR=$CWD/.thinker-bench
LABEL=bench-$(basename "$CWD")
mkdir -p "$DIR"

case "$ACT" in
  start)
    [ -f "$DIR/proxy.pid" ] && { kill "$(cat "$DIR/proxy.pid")" 2>/dev/null; sleep 0.3; }
    if [ -x "$PORTS" ]; then PORT=$("$PORTS" reserve thinker "$LABEL"); else PORT=$("$NODE" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'); fi
    echo "$PORT" > "$DIR/proxy.port"
    export THINKER_TEST=1 THINKER_PROXY_LOG=$DIR/proxy.jsonl
    printf '%s\n' "$@" > "$DIR/policy.flags"
    "$NODE" "$CLI" proxy --port "$PORT" --holdout 0 "$@" >> "$DIR/proxy.out" 2>&1 </dev/null &
    echo $! > "$DIR/proxy.pid"
    i=0
    while [ $i -lt 30 ]; do
      if grep -q "thinker proxy on" "$DIR/proxy.out" 2>/dev/null; then
        echo "ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT" > "$CWD/.bench-env"
        head -1 "$DIR/proxy.out"; exit 0
      fi
      i=$((i+1)); sleep 0.5
    done
    echo "PROXY FAILED"; cat "$DIR/proxy.out" 2>/dev/null; exit 1 ;;
  stop)
    export THINKER_TEST=1 THINKER_PROXY_LOG=$DIR/proxy.jsonl
    "$NODE" "$HERE/proxy-figures.mjs" "$DIR/proxy.jsonl" 2>/dev/null
    [ -f "$DIR/proxy.pid" ] && { kill "$(cat "$DIR/proxy.pid")" 2>/dev/null; rm -f "$DIR/proxy.pid"; }
    [ -x "$PORTS" ] && "$PORTS" release thinker "$LABEL" >/dev/null 2>&1
    exit 0 ;;
esac
