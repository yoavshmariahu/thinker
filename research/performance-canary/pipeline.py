"""Two explicit phases: build all caches, then admit solvers through a global gate."""
import json
import os
from pathlib import Path
import subprocess
import sys
from guardrails import run_dir, validate_execution, checked_ready, assert_preflight, supervised, stop

HERE = Path(__file__).resolve().parent
out = run_dir()
try:
    execution = validate_execution(out)
    phase, model = sys.argv[1:3]
    if phase not in ['build', 'solve'] or model not in execution['models']:
        raise ValueError(f"pipeline.py build|solve {'|'.join(execution['models'])}")
    tasks = json.loads((out / 'tasks.json').read_text())
    assert_preflight(out, tasks)
    if phase == 'build':
        result = supervised(['node', str(HERE / 'memory.mjs'), 'build', model], cwd=HERE.parents[1], env=os.environ,
                            prefix=out / 'raw' / f'build-{model}', seconds=3600, batch=out)
        if result['reason']:
            raise ValueError(result['reason'])
        checked_ready(out, tasks, [model])
        print('Cache cohort ready. Build every other cohort before explicitly starting solve.')
    else:
        checked_ready(out, tasks)
        # The solver supervises each agent; avoid a second session around its process tree.
        os.execv(sys.executable, [sys.executable, str(HERE / 'run.py'), 'solve', model])
except Exception as error:
    stop(out, error)
    raise SystemExit(str(error))
