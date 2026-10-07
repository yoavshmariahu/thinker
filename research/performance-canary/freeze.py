"""Create a fresh protocol without calls; archived runs cannot be resumed."""
import argparse
import json
import re
from pathlib import Path
import subprocess
from guardrails import HERE, ROOT, SOURCES, MODELS, digest, require_running, source_hashes

parser = argparse.ArgumentParser()
parser.add_argument('--out', type=Path, required=True)
parser.add_argument('--tasks', type=Path, required=True)
parser.add_argument('--agent-seconds', type=int, default=600)
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
adapter = (ROOT / 'src/llm.js').read_text()
if not all(x in adapter for x in ['THINKER_CLAUDE_EFFORT', 'THINKER_CODEX_REASONING_EFFORT', 'THINKER_GEMINI_EFFORT']):
    raise SystemExit('Apply the reviewed exact-model/high-effort adapter before freezing; no silent default effort')
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
    if any(not isinstance(t.get(k),str) or not t[k].strip() for k in ['prompt','learning','acceptance']):
        raise SystemExit('Task prompts and acceptance selector are required')
a.out.mkdir(parents=True)
(a.out / 'tasks.json').write_text(json.dumps(tasks, indent=2) + '\n')
e = {'guardrailsVersion': 1, 'thinkerCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
     'models': MODELS, 'effort': 'high', 'fallback': False, 'testMode': True, 'jev': 'jev-1.13.0',
     'tasksSha256': digest(a.out / 'tasks.json'), 'agentSeconds': a.agent_seconds,
     'cacheBuildPath': 'distillFile', 'sourceHashes': source_hashes()}
(a.out / 'execution.json').write_text(json.dumps(e, indent=2) + '\n')
print(a.out.resolve())
