#!/bin/bash
# Run in the session worktree. Last line is the outcome: the suite summary and the probe.
SUITE=$(.venv/bin/python -m pytest -q 2>&1 | tail -1)
PROBE=$(.venv/bin/python - <<'PY' 2>&1 | tail -1
import click
g=click.Group(sort_commands=False); g.add_command(click.Command('b')); g.add_command(click.Command('a'))
assert g.list_commands(click.Context(g))==['b','a'], g.list_commands(click.Context(g))
g2=click.Group(); g2.add_command(click.Command('b')); g2.add_command(click.Command('a'))
assert g2.list_commands(click.Context(g2))==['a','b']
@click.group(sort_commands=False)
def cli(): pass
@cli.command()
def zeta(): pass
@cli.command()
def alpha(): pass
from click.testing import CliRunner
out=CliRunner().invoke(cli, ['--help']).output
assert out.index('zeta')<out.index('alpha'), out


print('PROBE OK')

PY
)
echo "${PROBE:-PROBE NONE} | $SUITE"
