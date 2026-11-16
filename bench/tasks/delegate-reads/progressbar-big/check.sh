#!/bin/bash
# Run in the session worktree. Last line is the outcome: the suite summary and the probe.
SUITE=$(.venv/bin/python -m pytest -q 2>&1 | tail -1)
PROBE=$(.venv/bin/python - <<'PY' 2>&1 | tail -1
import io, click
# with a non-tty file Click's iteration is hidden and never moves pos, so only update() can fire the callback
seen=[]
with click.progressbar(length=10, on_update=seen.append, file=io.StringIO()) as bar:
    bar.update(4); bar.update(3)
assert seen==[4,7], seen
with click.progressbar(range(2), file=io.StringIO()) as bar:
    for _ in bar: pass
print('PROBE OK')

PY
)
echo "${PROBE:-PROBE NONE} | $SUITE"
