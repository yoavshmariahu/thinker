#!/usr/bin/env bash
# The e2e, from the host: a cleared collector, three containers that are three machines, a session on
# each, a setting saved centrally, and a second session that takes it.
#
#   COLLECTOR_PORT=6896 bash demo/e2e/fleet.sh all
#   bash demo/e2e/fleet.sh clear | build | up | round 1 | policy 50000 | round 2 | state | down
#
# Nothing here invents a figure. The collector prices what the machines send, through thinker's own
# pricing door; the machines send what their own sessions did.
set -uo pipefail
cd "$(dirname "$0")/../.."

PORT="${COLLECTOR_PORT:-6896}"
API="http://127.0.0.1:$PORT"
COLLECTOR="http://host.docker.internal:$PORT/v1/sessions"
DB="${FLEET_DB:?point FLEET_DB at the collector database file}"
MACHINES=(${MACHINES:-1 2 3})
IMAGE=thinker-e2e

name() { echo "thinker-e2e-$1"; }

clear_data() {
  echo "== clearing the collector =="
  node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('$DB');
for (const t of ['sessions', 'installs', 'settings']) { try { db.exec('delete from ' + t); } catch (e) { console.log(t, e.message); } }
for (const t of ['sessions', 'installs', 'settings']) console.log(t, db.prepare('select count(*) n from ' + t).get().n, 'rows');
"
}

build() { echo "== building $IMAGE =="; docker build -t "$IMAGE" -f demo/e2e/Dockerfile .; }

up() {
  echo "== three machines =="
  for m in "${MACHINES[@]}"; do
    docker rm -f "$(name "$m")" >/dev/null 2>&1
    docker run -d --name "$(name "$m")" -e COLLECTOR="$COLLECTOR" -e MACHINE="m$m" "$IMAGE" >/dev/null
  done
  for m in "${MACHINES[@]}"; do
    for _ in $(seq 1 120); do
      docker logs "$(name "$m")" 2>&1 | grep -q 'sessions run through docker exec' && break
      sleep 2
    done
    docker logs "$(name "$m")" 2>&1 | sed "s/^/[up] /" | tail -4
  done
}

round() {
  local n="${1:-1}"
  echo "== round $n: one session on each machine =="
  for m in "${MACHINES[@]}"; do
    docker exec -e MACHINE="m$m" "$(name "$m")" bash /thinker/demo/e2e/session.sh "$n" 2>&1 | sed "s/^/  /" &
  done
  wait
}

policy() {
  local trigger="${1:-50000}"
  echo "== an operator sets the fleet's cut trigger to $trigger =="
  curl -s -X PUT -H 'content-type: application/json' \
    -d "{\"config\":{\"proxy\":{\"trigger\":$trigger}}}" "$API/api/settings" | head -c 400; echo
}

state() {
  echo "== the fleet, as the dashboard reads it =="
  curl -s "$API/api/settings" | node --input-type=module -e "
let t = ''; process.stdin.on('data', c => t += c).on('end', () => {
  const d = JSON.parse(t);
  console.log('policy :', JSON.stringify(d.control?.config ?? {}), d.control?.at ? 'set ' + d.control.at : '(nothing set)');
  console.log('take-up:', JSON.stringify(d.fleet));
});"
  curl -s "$API/api/fleet" | node --input-type=module -e "
let t = ''; process.stdin.on('data', c => t += c).on('end', () => {
  const d = JSON.parse(t);
  for (const r of d.rows || []) console.log('row    :', JSON.stringify({ dim: r.dim, installs: r.installs, sessions: r.sessions, prompts: r.prompts, cuts: r.cuts, cleared: r.cleared, spend: r.spend, net: r.net }));
});"
}

# Everything a machine remembers of its own sessions: the usage log, the traces, the proxy's rows, the
# per-session cut records, the spool and the settings it was last told to run. The install id is NOT
# touched -- it is what makes this container the same machine across rounds.
reset_machines() {
  echo "== machines forget their sessions (install ids kept) =="
  for m in "${MACHINES[@]}"; do
    docker exec "$(name "$m")" bash -c '
      rm -f /workspace/app/.thinker/log.jsonl
      rm -f /workspace/app/.thinker/state/trace-*.jsonl /workspace/app/.thinker/state/session-*.json
      rm -rf /workspace/app/.thinker/delivery
      rm -f /root/.thinker/state/proxy.jsonl /root/.thinker/state/events-spool.jsonl /root/.thinker/state/managed.json
      rm -rf /root/.thinker/state/compression
      echo "  $(hostname): cleared"' 2>&1 | tail -1
  done
}

# The fixed tool, into running containers, without a rebuild: the image holds a copy of the checkout and
# these are the files a round is iterating on.
push() {
  echo "== pushing the working tree into the machines =="
  for m in "${MACHINES[@]}"; do
    for f in src/proxy.js src/proxy-service.js src/compression.js src/delivery.js src/commands/hooks.js src/events.js src/managed.js src/integrations/opencode-v2.js demo/e2e/model.mjs demo/e2e/session.sh; do
      docker cp "$f" "$(name "$m"):/thinker/$f" >/dev/null
    done
  done
  echo "  pushed to ${#MACHINES[@]} machines"
}

down() { for m in "${MACHINES[@]}"; do docker rm -f "$(name "$m")" >/dev/null 2>&1 && echo "removed $(name "$m")"; done; }

case "${1:-all}" in
  clear) clear_data ;;
  build) build ;;
  up) up ;;
  round) round "${2:-1}" ;;
  policy) policy "${2:-50000}" ;;
  state) state ;;
  reset) reset_machines ;;
  push) push ;;
  down) down ;;
  all) clear_data && build && up && round 1 && state && policy 50000 && round 2 && state ;;
  run) clear_data && push && reset_machines && round 1 && state && policy 50000 && round 2 && state ;;
  *) echo "usage: fleet.sh clear|build|up|push|reset|round N|policy TRIGGER|state|down|all|run" ; exit 2 ;;
esac
