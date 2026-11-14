#!/usr/bin/env bash
# One machine of the fleet, prepared and then left running. The sessions themselves are session.sh,
# run through `docker exec`, because a machine is not a job: its THINKER_HOME has to outlive a session
# for the install id to stay the same and for a fleet setting to still be there on the next one.
set -euo pipefail

COLLECTOR="${COLLECTOR:?name the fleet sink, e.g. http://host.docker.internal:6896/v1/sessions}"
MACHINE="${MACHINE:-machine}"
REPO=/workspace/app
MODEL_PORT="${MODEL_PORT:-4010}"
PROXY_PORT="${PROXY_PORT:-4020}"
FILES_N="${FILES_N:-14}"
CLI=/thinker/src/cli.js

say() { echo "[$MACHINE] $*"; }

# ---------------------------------------------------------------- the repository this machine works in
if [ ! -d "$REPO/.git" ]; then
  mkdir -p "$REPO/src" && cd "$REPO"
  git init -q
  # Modules big enough that reading them fills a context: one read of each is ~58k characters, and
  # fourteen of them pass the cut's 140k-token trigger without anybody lowering it for the demo.
  for i in $(seq 1 "$FILES_N"); do
    name="src/module_$(printf '%02d' "$i").py"
    { echo "\"\"\"Module $i of the service: queue workers, retries and settings.\"\"\""
      echo "import dataclasses, time"
      for b in $(seq 1 420); do
        echo ""
        echo "def handler_${i}_${b}(payload, *, attempt=0, deadline=None):"
        echo "    \"\"\"Handle payload $b in module $i. Retries with a ladder, gives up past the deadline.\"\"\""
        echo "    started = time.monotonic()"
        echo "    waits = [0.25, 0.5, 1.0, 2.0, 4.0]"
        echo "    if attempt >= len(waits):"
        echo "        raise RuntimeError('handler_${i}_${b} gave up after %d attempts' % attempt)"
        echo "    if deadline is not None and started > deadline:"
        echo "        return {'ok': False, 'why': 'deadline', 'module': $i, 'block': $b}"
        echo "    return {'ok': True, 'module': $i, 'block': $b, 'waited': waits[attempt]}"
      done
    } > "$name"
  done
  printf '# The service\n\nFourteen modules of queue handlers. See src/.\n' > README.md
  git add -A && git commit -qm "the service, as it stands" >/dev/null
  say "repository ready: $(du -sh "$REPO/src" | cut -f1) over $FILES_N modules"
fi

# ---------------------------------------------------------------- who this machine is
# The install id is what the collector keys a machine on, and thinker makes a fresh one the first time
# it is asked (`telemetry.js:getInstallId`). A container rebuilt is then a new machine, and a demo's
# history splits in two: six rows where there were three. So each of these three machines has an id of
# its own, written once and only where thinker has not already made one, which keeps a rebuilt
# container the same machine as the one whose sessions are already on the page. Made-up ids, in a
# fixture; nothing is derived from this host.
case "$MACHINE" in
  m1) INSTALL_ID=c29edad2-147f-459f-a894-1b56005cf861 ;;
  m2) INSTALL_ID=8e5ba4f0-860c-44bb-8c3d-f1a6eb91020a ;;
  m3) INSTALL_ID=c6724cda-a477-41f6-8178-ccdec0227c76 ;;
  *)  INSTALL_ID="" ;;
esac
if [ -n "$INSTALL_ID" ] && [ ! -f "$THINKER_HOME/state/install-id" ]; then
  mkdir -p "$THINKER_HOME/state"
  echo "$INSTALL_ID" > "$THINKER_HOME/state/install-id"
  say "install id $INSTALL_ID"
fi

# ---------------------------------------------------------------- thinker's machine config
# Where this machine ships its sessions, and what its proxy routes to. Nothing else is set here:
# the four settings an operator controls are the fleet's to send, and they arrive on the sink's answer.
mkdir -p "$THINKER_HOME"
cat > "$THINKER_HOME/config.json" <<JSON
{
  "events": "$COLLECTOR",
  "proxy": { "upstream": "http://127.0.0.1:$MODEL_PORT" }
}
JSON

# The delegation trigger stays off in this container, and by the environment rather than by a setting:
# its subagent runs through the `claude` CLI, which is not installed here, so leaving it settable would
# mean a dashboard switch could make every read wait for a subagent that cannot run. Said out loud
# because it is the one managed setting this e2e does not exercise.
export THINKER_DELEGATE=off

cd "$REPO"
say "wiring opencode ($(opencode --version))"
node "$CLI" connect --clients opencode >/dev/null 2>&1 || node "$CLI" connect --clients opencode || true

# OpenCode's own config: the model and the provider. The baseURL is written by thinker's own wiring
# below, not by hand, so what this run tests is thinker's route and not a route invented for the test.
mkdir -p "$REPO/.opencode"
cat > "$REPO/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-5-5",
  "provider": {
    "anthropic": {
      "options": { "apiKey": "e2e-fixture-not-a-credential" },
      "models": { "claude-sonnet-5-5": { "name": "Claude Sonnet 5.5 (loopback fixture)" } }
    }
  },
  "permission": { "read": "allow", "bash": "allow", "edit": "allow", "webfetch": "deny" }
}
JSON
export ANTHROPIC_API_KEY=e2e-fixture-not-a-credential

# thinker's own door, so the baseURL shape is thinker's: wireAgents writes
# provider.anthropic.options.baseURL into the OpenCode config it finds.
node --input-type=module -e "
import { wireAgents, urlFor } from '/thinker/src/proxy-service.js';
const r = wireAgents(urlFor($PROXY_PORT), { agents: ['opencode'] });
console.log('[wire]', JSON.stringify(r));
" || true
# A repository-scope config is the one OpenCode reads here, and wireAgents writes the user-scope one,
# so the route is copied across rather than typed: same value, thinker's own.
node --input-type=module -e "
import fs from 'node:fs';
const user = process.env.XDG_CONFIG_HOME || (process.env.HOME + '/.config');
const f = user + '/opencode/opencode.json';
let url = null;
try { url = JSON.parse(fs.readFileSync(f, 'utf8'))?.provider?.anthropic?.options?.baseURL || null; } catch {}
if (!url) { console.log('[wire] thinker wrote no baseURL for opencode; nothing to copy'); process.exit(0); }
const repo = '$REPO/opencode.json';
const cfg = JSON.parse(fs.readFileSync(repo, 'utf8'));
cfg.provider.anthropic.options.baseURL = url;
fs.writeFileSync(repo, JSON.stringify(cfg, null, 2) + '\n');
console.log('[wire] opencode routes to', url);
"

say "ready; sessions run through docker exec (demo/e2e/session.sh)"
exec tail -f /dev/null
