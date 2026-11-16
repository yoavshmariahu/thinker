#!/bin/bash
# Run in the session worktree. Last line is the outcome: the suite summary and the probe.
SUITE=$(.venv/bin/python -m pytest -q 2>&1 | tail -1)
PROBE=$(.venv/bin/python - <<'PY' 2>&1 | tail -1
from click.utils import make_default_short_help as m
long='word '*40
r=m(long, 20, suffix='…'); assert r.endswith('…') and len(r)<=20, repr(r)
r=m(long, 20); assert r.endswith('...') and len(r)<=20, repr(r)
assert m('hi', 20)=='hi'
assert m('hi', 20, suffix='…')=='hi'


print('PROBE OK')

PY
)
echo "${PROBE:-PROBE NONE} | $SUITE"
