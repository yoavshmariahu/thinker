#!/usr/bin/env bash
# One agent session on this machine, start to finish: the proxy started from the settings in force,
# the loopback model, a real `opencode run`, then what came of it.
#
#   docker exec <machine> bash /thinker/demo/e2e/session.sh [round]
set -uo pipefail

MACHINE="${MACHINE:-machine}"
REPO=/workspace/app
MODEL_PORT="${MODEL_PORT:-4010}"
PROXY_PORT="${PROXY_PORT:-4020}"
CLI=/thinker/src/cli.js
ROUND="${1:-1}"
export MODEL_CALLS_FILE=/tmp/model-calls-$ROUND.json
export THINKER_DELEGATE=off
export ANTHROPIC_API_KEY=e2e-fixture-not-a-credential
cd "$REPO"

say() { echo "[$MACHINE] $*"; }
files=$(ls src/*.py | paste -sd, -)

# ---------------------------------------------------------------- the settings in force
# thinker's own translation of the machine config into the proxy's arguments (proxy-service.js:serviceArgs),
# so the trigger this proxy runs with is the one the merged config says -- the fleet's where an operator has
# set it, the machine's own where nobody has. A cloud harness starting a container per job gets this for
# free; it is also why a setting saved on the dashboard is in force on the next session and not this one.
ARGS=$(node --input-type=module -e "
import { serviceArgs } from '/thinker/src/proxy-service.js';
console.log(serviceArgs(process.env.THINKER_HOME, { port: $PROXY_PORT }).join(' '));
")
say "round $ROUND: proxy args from the config in force -> $ARGS"

# ---------------------------------------------------------------- model, then proxy
pkill -f 'demo/e2e/model.mjs' >/dev/null 2>&1
pkill -f 'cli.js proxy' >/dev/null 2>&1
sleep 0.4
node /thinker/demo/e2e/model.mjs --port "$MODEL_PORT" --files "$files" > "/tmp/model-$ROUND.log" 2>&1 &
MODEL_PID=$!
node "$CLI" $ARGS > "/tmp/proxy-$ROUND.log" 2>&1 &
PROXY_PID=$!
for _ in $(seq 1 40); do
  curl -s -m 1 -o /dev/null "http://127.0.0.1:$PROXY_PORT/" && break
  sleep 0.25
done
say "model on $MODEL_PORT (pid $MODEL_PID), proxy on $PROXY_PORT (pid $PROXY_PID)"

# ---------------------------------------------------------------- the session
# Three prompts in one session, not one prompt with everything in it, because that is the shape a real
# session has and the shape the cut works on: the newest turn is kept whole, so the results a cut may
# take are the ones from earlier turns. Named with --session, so the wrapper knows the id before the
# agent starts and does not have to go looking for it afterwards.
# OpenCode validates the id it is handed: it must start with "ses" (checked live on 2.3.0, which
# refuses anything else with `Expected a string starting with "ses"`).
# A nonce, so a round is always a fresh conversation: --session continues an id that already exists,
# and a half-finished session from an earlier attempt is not this run's session.
SESSION="ses_e2e${MACHINE}r${ROUND}$(date +%s)"
: > "/tmp/opencode-$ROUND.log"
P1="Read src/module_01.py through src/module_05.py in full with the read tool, one after another. Then say which of them look alike."
P2="Now read src/module_06.py through src/module_10.py in full, the same way, and say whether they follow the same pattern."
P3="Now read the rest of src/ in full and then tell me in two sentences what this service does."
for i in 1 2 3; do
  eval "PROMPT=\$P$i"
  say "opencode run (prompt $i of 3, session $SESSION)"
  timeout 900 opencode run --session "$SESSION" "$PROMPT" >> "/tmp/opencode-$ROUND.log" 2>&1
  say "  prompt $i exited $?"
done

# ---------------------------------------------------------------- the end of the session
# The wrapper ends the session, and this is the integration point rather than a workaround.
#
# OpenCode 2.3.0 does emit `session.execution.succeeded`, and thinker's plugin does answer it by running
# the stop hook -- but `location.shutdown` arrives in the same breath when the agent was started as
# `opencode run`, and the spawned hook is killed before it can write the session or ship it. Measured
# here: the plugin's own event log carries the succeeded event, the hook leaves no row, and running the
# same hook by hand on the same session writes the row and ships it. A harness that owns the job's
# lifecycle knows when the job is over and does not have to race a shutdown, so it says so, which is
# what a cloud wrapper is for. An interactive OpenCode keeps its server alive and the plugin's own call
# stands.
sleep 2
say "wrapper ends session $SESSION"
echo "{\"session_id\":\"$SESSION\",\"cwd\":\"$REPO\",\"hook_event_name\":\"SessionEnd\"}" \
  | node "$CLI" hook stop --client opencode > "/tmp/stop-$ROUND.log" 2>&1

# ---------------------------------------------------------------- what came of it
echo "---- [$MACHINE] round $ROUND ----"
node --input-type=module -e "
import fs from 'node:fs';
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const rows = read('$REPO/.thinker/log.jsonl').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const kinds = {};
for (const r of rows) kinds[r.op] = (kinds[r.op] || 0) + 1;
console.log('log rows:', JSON.stringify(kinds));
const s = rows.filter(r => r.op === 'session').pop();
console.log('session row:', s ? JSON.stringify({ session: s.session, client: s.client, model: s.model, prompts: s.prompts, tokens: s.tokens, cleared: s.cleared }) : 'NONE -- no session event could have shipped');
const calls = JSON.parse(read('$MODEL_CALLS_FILE') || '[]');
console.log('model calls:', calls.length, calls.length ? \`paths \${[...new Set(calls.map(c => c.path))].join(' ')}; context \${calls[0].input} -> \${Math.max(...calls.map(c => c.input))} tokens; cleared results seen \${Math.max(0, ...calls.map(c => c.cleared))}\` : '');
const managed = read(process.env.THINKER_HOME + '/state/managed.json');
console.log('settings from the sink:', managed ? JSON.stringify(JSON.parse(managed)) : 'none taken');
const spool = read(process.env.THINKER_HOME + '/state/events-spool.jsonl').trim();
console.log('spooled (unshipped) events:', spool ? spool.split('\n').length : 0);
"
tail -3 "/tmp/proxy-$ROUND.log" | sed "s/^/[$MACHINE proxy] /"
kill "$MODEL_PID" "$PROXY_PID" >/dev/null 2>&1
wait "$MODEL_PID" 2>/dev/null
echo "---- [$MACHINE] end of round $ROUND ----"
