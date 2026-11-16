#!/bin/bash
# Run in the session worktree. Last line is the outcome: the suite summary and the probe.
SUITE=$(.venv/bin/python -m pytest -q 2>&1 | tail -1)
PROBE=$(.venv/bin/python - <<'PY' 2>&1 | tail -1
import click
r=click.format_filename('a'*30+'.'+'b'*30, max_length=15)
assert len(r)==15 and '…' in r and r.startswith('aaa') and r.endswith('bbb'), repr(r)
assert click.format_filename('abc')=='abc'
r=click.format_filename('/x/y/'+'z'*40, shorten=True, max_length=10)
assert len(r)==10 and '/' not in r, repr(r)
assert click.format_filename('short.txt', max_length=20)=='short.txt'


print('PROBE OK')

PY
)
echo "${PROBE:-PROBE NONE} | $SUITE"
