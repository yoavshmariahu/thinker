#!/bin/sh
# Run a browser spec: bring the test site up on a reserved port, run the bench, take the site down.
#
#   bench/browser/run.sh bench/experiments/browser-pages.json --dry
#   bench/browser/run.sh bench/experiments/browser-pages.json [--only a,b] [--arms x,y] [--reps n]
#
# The site's address reaches the spec as $BENCH_SITE (its `vars.SITE`). One site serves every session of the
# run; each session's pages and state are its own (site.mjs, `/s/<session>/`).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
PORTS=${CLAUDE_PORT:-$HOME/.claude/bin/claude-port}
NODE=${THINKER_NODE:-node}
if [ -x "$PORTS" ]; then PORT=$("$PORTS" reserve thinker browser-bench-site); else PORT=$("$NODE" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'); fi
"$NODE" "$HERE/site.mjs" "$PORT" >/dev/null 2>&1 &
SITE_PID=$!
trap 'kill $SITE_PID 2>/dev/null; [ -x "$PORTS" ] && "$PORTS" release thinker browser-bench-site >/dev/null 2>&1' EXIT INT TERM
i=0; until curl -s "http://127.0.0.1:$PORT/__health" >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 40 ] && { echo "the site did not start"; exit 1; }; sleep 0.25; done
BENCH_SITE="http://127.0.0.1:$PORT" "$NODE" "$HERE/../bench.mjs" run "$@"
