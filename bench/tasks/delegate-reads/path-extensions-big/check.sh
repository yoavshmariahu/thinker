#!/bin/bash
# Run in the session worktree. Last line is the outcome: the suite summary and the probe.
SUITE=$(.venv/bin/python -m pytest -q 2>&1 | tail -1)
PROBE=$(.venv/bin/python - <<'PY' 2>&1 | tail -1
import click
p=click.Path(extensions=['.txt'])
try:
    p.convert('notes.md', None, None); raise SystemExit('md accepted')
except click.BadParameter as e:
    assert '.txt' in str(e), str(e)
assert p.convert('notes.TXT', None, None)=='notes.TXT'
assert click.Path().convert('notes.md', None, None)=='notes.md'
assert p.to_info_dict().get('extensions') is not None
print('PROBE OK')

PY
)
echo "${PROBE:-PROBE NONE} | $SUITE"
