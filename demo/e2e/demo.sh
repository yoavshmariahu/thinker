#!/usr/bin/env bash
# The demo, up: the collector on its own database and the three machines, with the history already
# on the page. Safe to run twice -- anything already up is left alone.
set -uo pipefail
cd "$(dirname "$0")"
exec bash ./fleet.sh demo
