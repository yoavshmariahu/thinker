"""Create a fresh protocol without calls; archived runs cannot be resumed."""
import argparse
import json
import re
from pathlib import Path
import subprocess
from pr_cache import CACHE_SOURCE, CACHE_BUILD_PATH, validate_pr_manifest
from guardrails import HERE, ROOT, MODELS, GUIDANCE, WIRING_MODE, digest, require_running, source_hashes

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--tasks', type=Path, required=True)
parser.add_argument('--prs', type=Path, required=True)
parser.add_argument('--source', type=Path, required=True, help='Read-only upstream clone for ancestry validation')
parser.add_argument('--agent-seconds', type=int, default=600)
parser.add_argument('--cohorts', default=','.join(MODELS), help='Model cohorts to compare, e.g. opus,sol')
a = parser.parse_args()
require_running(a.out)
if not (ROOT / '.git').is_file():
    raise SystemExit('Use an isolated git worktree')
if not a.out.resolve().is_relative_to(ROOT):
    raise SystemExit('Run output must stay inside the isolated worktree')
if a.out.resolve() == HERE or a.out.exists():
    raise SystemExit('Use a new, nonexistent run directory')
if not 1 <= a.agent_seconds <= 1200:
    raise SystemExit('Agent deadline must be 1..1200 seconds')
# The wired arm serves through Jev in the agent's own process, which needs a personal key on this
# machine (src/jev.js:testNetworkAllowed). Fail here rather than halfway through a cohort.
key = subprocess.run(['node', '-e', "import('./src/jev.js').then(m=>process.exit(m.jevKey()?0:1))"],
                     cwd=ROOT, capture_output=True)
if key.returncode != 0:
    raise SystemExit('A personal Jev key is required: the hosted proxy is not used for benchmarks')
adapter = (ROOT / 'src/llm.js').read_text()
if not all(x in adapter for x in ['THINKER_CLAUDE_EFFORT', 'THINKER_CODEX_REASONING_EFFORT', 'THINKER_GEMINI_EFFORT']):
    raise SystemExit('Apply the reviewed exact-model/high-effort adapter before freezing; no silent default effort')
cohort_names = [c.strip() for c in a.cohorts.split(',') if c.strip()]
if not cohort_names or any(c not in MODELS for c in cohort_names) or len(set(cohort_names)) != len(cohort_names):
    raise SystemExit(f'--cohorts must be a unique subset of {",".join(MODELS)}')
tasks = json.loads(a.tasks.read_text())
if not tasks or len({t['id'] for t in tasks}) != len(tasks):
    raise SystemExit('Nonempty unique tasks required')
for t in tasks:
    if not t['id'] or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in t['id']):
        raise SystemExit('Unsafe task ID')
    if any(not re.fullmatch(r'[0-9a-f]{40}', t.get(k,'')) for k in ['base','fixed']):
        raise SystemExit('Pin full base/fixed commit hashes')
    test_path=Path(t.get('test_file',''))
    if test_path.is_absolute() or '..' in test_path.parts or not str(test_path).startswith('tests/') or test_path.suffix != '.py':
        raise SystemExit('Test module must be a relative Python file under tests/')
    if any(not isinstance(t.get(k),str) or not t[k].strip() for k in ['prompt','acceptance']):
        raise SystemExit('Task prompts and acceptance selector are required')
corpus = validate_pr_manifest(json.loads(a.prs.read_text()), tasks, a.source)
for task in tasks:
    task.pop('learning', None)
a.out.mkdir(parents=True)
(a.out / 'prs.json').write_text(json.dumps(corpus, indent=2) + '\n')
(a.out / 'tasks.json').write_text(json.dumps(tasks, indent=2) + '\n')
e = {'guardrailsVersion': 3, 'thinkerCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
     'models': {c: MODELS[c] for c in cohort_names}, 'effort': 'high', 'fallback': False, 'testMode': True, 'jev': 'jev-1.13.0',
     # The arm is wired by the product itself; the guidance text it delivers is pinned by hash, so an
     # edit to cache-guidance.js after freezing fails the gate instead of changing the measurement.
     'wiring': {'mode': WIRING_MODE, 'guidanceSha256': digest(GUIDANCE), 'instructionsLimit': 2048, 'ranker': 'jev'},
     'tasksSha256': digest(a.out / 'tasks.json'), 'agentSeconds': a.agent_seconds,
     'cacheSource': CACHE_SOURCE, 'cacheBuildPath': CACHE_BUILD_PATH, 'prsSha256': digest(a.out / 'prs.json'), 'sourceHashes': source_hashes()}
(a.out / 'execution.json').write_text(json.dumps(e, indent=2) + '\n')
print(a.out.resolve())
