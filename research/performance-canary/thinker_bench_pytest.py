"""Explicit pytest plugin: caps collection and runtime regardless of -o addopts=."""
import json
import os
from pathlib import Path
import signal
import pytest

MAX_TESTS = 2000
MAX_SECONDS = 120
_previous = None


def violation(reason):
    path = os.environ.get('THINKER_BENCH_VIOLATION')
    if path:
        Path(path).write_text(json.dumps({'reason': reason}))


def expired(_sig, _frame):
    violation('pytest exceeded 120 seconds')
    os._exit(124)


def pytest_configure(config):
    global _previous
    if os.environ.get('THINKER_TEST') != '1' or not os.environ.get('THINKER_BENCH_VIOLATION'):
        raise pytest.UsageError('Benchmark test guard requires test mode and a violation log')
    _previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, MAX_SECONDS)


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(config, items):
    if len(items) > MAX_TESTS or any(item.get_closest_marker('stress') is not None for item in items):
        reason = f'Blocked stress or oversized test selection ({len(items)} tests); keep default exclusions and run relevant tests'
        violation(reason)
        raise pytest.UsageError(reason)


def pytest_unconfigure(config):
    signal.setitimer(signal.ITIMER_REAL, 0)
    if _previous is not None:
        signal.signal(signal.SIGALRM, _previous)
