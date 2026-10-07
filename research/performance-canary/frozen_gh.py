#!/usr/bin/env python3
"""Read-only GitHub replay for minePrs: no network, no unfrozen evidence."""
import json
import os
import sys
from guardrails import checked_execution, read, run_dir


def replay(args, corpus):
    if args == ['--version']:
        return 'gh frozen PR benchmark replay'
    expected = ['pr', 'list', '--repo', corpus['repository'], '--state', 'merged', '--limit',
                str(min(max(corpus['limit'] * 3, 60), 250)), '--search', f"merged:<{corpus['before']}",
                '--json', 'number,title,body,mergedAt,additions,files']
    if args != expected:
        raise ValueError('Unfrozen GitHub request forbidden: PR benchmarks replay only their frozen corpus')
    return json.dumps(corpus['prs'])


if __name__ == '__main__':
    out = run_dir()
    checked_execution(out)
    corpus = read(out / 'prs.json')['tasks'][os.environ['THINKER_FROZEN_PR_TASK']]
    print(replay(sys.argv[1:], corpus))
