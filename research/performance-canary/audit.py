"""Extract native tool inputs for review and check immutable experiment records."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
RAW = OUT / 'raw'
execution = json.loads((OUT / 'execution.json').read_text())
checks = {}
for name, key in [('tasks.json', 'tasksSha256'), ('run.py', 'runnerSha256'),
                  ('memory.mjs', 'memoryHarnessSha256'), ('verify.py', 'testHarnessSha256'),
                  ('model-pins.patch', 'modelPinPatchSha256')]:
    frozen = RAW / 'frozen-harness' / name
    source = frozen if frozen.exists() else OUT / name
    checks[name] = hashlib.sha256(source.read_bytes()).hexdigest() == execution[key]
calls, flagged, invocations, learning_trees = [], [], [], []
for file in sorted(RAW.glob('*-invocation.json')):
    invocation = json.loads(file.read_text())
    name = file.name.removesuffix('-invocation.json')
    cohort = name.split('-')[-2]
    pin_valid = invocation['model'] == execution['models'][cohort] and invocation['effort'] == 'high'
    invocations.append({'id': name, 'pinValid': pin_valid,
                        'revisionValid': invocation['thinkerCommit'] == execution['thinkerCommit']})
    if name.endswith('-learn'):
        repo = Path(invocation['cwd'])
        if repo.exists():
            changes = subprocess.check_output(['git', 'diff', 'HEAD', '--name-only'], cwd=repo, text=True)
            learning_trees.append({'id': name, 'trackedChanges': changes.splitlines()})
    file = RAW / (name + ('.transcript.jsonl' if cohort == 'gemini' else '.events.jsonl'))
    if not file.exists() and cohort == 'gemini':
        file = RAW / (name + '-interrupted.transcript.jsonl')
    if not file.exists():
        continue
    for line in file.read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        extracted = []
        if cohort == 'gemini':
            extracted = [{'tool': t.get('name'), 'input': t.get('args')} for t in event.get('tool_calls', [])]
        elif cohort == 'opus' and event.get('type') == 'assistant':
            extracted = [{'tool': t.get('name'), 'input': t.get('input')} for t in event.get('message', {}).get('content', []) if t.get('type') == 'tool_use']
        elif cohort == 'sol' and event.get('type') == 'item.completed':
            item = event['item']
            if item.get('type') == 'command_execution':
                extracted = [{'tool': 'command_execution', 'input': item['command']}]
            elif item.get('type') == 'file_change':
                extracted = [{'tool': 'file_change', 'input': item.get('changes')}]
        for call in extracted:
            row = {'id': name, **call}
            calls.append(row)
            text = json.dumps(call['input'])
            # These are review candidates, not automatic contamination verdicts.
            if re.search(r'git\s+(?:log|show|fetch|pull|clone|remote)|\b(?:curl|wget|pip\s+install|spawn_agent)\b|(?:^|\s)\.\./|thinker_lookup|https?://|/raw/|verify-gold', text):
                flagged.append(row)
note_checks = []
for file in sorted(RAW.glob('*-note-hashes.json')):
    directory = RAW / file.name.replace('-note-hashes.json', '-notes')
    expected = json.loads(file.read_text())
    actual = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.glob('*.json')}
    note_checks.append({'id': file.stem, 'unchanged': actual == expected, 'count': len(actual)})
report = {'hashChecks': checks, 'invocations': invocations, 'learningTrees': learning_trees,
          'immutableNotes': note_checks, 'nativeToolCalls': len(calls), 'reviewCandidates': flagged,
          'scope': 'Checks recorded tool inputs and tracked exploration files; not a claim of OS-level hermetic isolation.'}
(RAW / 'tool-inputs.jsonl').write_text(''.join(json.dumps(c) + '\n' for c in calls))
(OUT / 'audit.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'hashChecks': checks, 'invocations': len(invocations), 'toolCalls': len(calls),
                  'reviewCandidates': len(flagged), 'learningChanges': [r for r in learning_trees if r['trackedChanges']]}, indent=2))
