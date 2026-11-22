"""Freeze three reconstructed review checkpoints. No model or network calls."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

assert os.environ.get('THINKER_TEST') == '1'
ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
REPO = Path(os.environ.get('AUTOSCALER_REPO', '/private/tmp/autoscaler-review'))
manifest = json.loads((ROOT / 'research/autoscaler-reviews/cases.json').read_text())
SELECTED = ['A-10349', 'A-10141', 'A-10178']

def git(cwd, *args, input=None):
    return subprocess.check_output(['git', '-C', str(cwd), *args], input=input).decode()

def excerpt(source, lo, hi):
    return '\n'.join(f'{i}: {line}' for i, line in enumerate(source.splitlines(), 1) if lo <= i <= hi)

def flatten(findings):
    result = []
    for f in findings:
        result.append({k: f[k] for k in ['file', 'line', 'severity', 'message', 'evidence']})
        for sub in f.get('locations', []):
            result.append({k: sub.get(k, f.get(k)) for k in ['file', 'line', 'severity', 'message', 'evidence']})
    return result

for cid in SELECTED:
    c = next(c for c in manifest['cases'] if c['id'] == cid)
    wt = ROOT / '.pilot-worktrees' / cid
    wt.parent.mkdir(exist_ok=True)
    git(REPO, 'worktree', 'add', '--detach', str(wt), manifest['base'])
    try:
        fix = git(REPO, 'diff', '--binary', c['parent'], c['sha'])
        git(wt, 'apply', '--reverse', input=fix.encode())
        patch = git(wt, 'diff', '--no-color', '-U5', '--', '*.go', ':!*test.go')
        old = json.loads((OUT / f'{cid}.historical.json').read_text())
        findings = flatten(old['report']['findings'])
        primary = findings[0]['file']
        source = (wt / primary).read_text()
        if cid == 'A-10349':
            snippets = {primary: excerpt(source, 212, 247)}
            extra = {primary: excerpt(source, 124, 182)}
            contracts = ['AWS provider IDs must start with aws:///.', 'A placeholder instance name beginning with i-placeholder- must retain subsequent slashes.', 'Preserve the original ProviderID.']
        elif cid == 'A-10141':
            snippets = {primary: excerpt(source, 138, 159)}
            extra = {primary: excerpt(source, 163, 252)}
            contracts = ['DaemonSet replica counts use desired scheduled pods, even when none are ready.', 'Distinguish a demonstrated local failure from an unverified downstream recovery consequence.']
        else:
            snippets = {primary: excerpt(source, 155, 198)}
            feeder = 'vertical-pod-autoscaler/pkg/recommender/input/cluster_feeder.go'
            fs = (wt / feeder).read_text()
            start = next(i for i, line in enumerate(fs.splitlines(), 1) if line.startswith('func ') and 'GarbageCollectCheckpoints(' in line)
            snippets[feeder] = excerpt(fs, start, start + 78)
            extra = {primary: excerpt(source, 155, 210)}
            contracts = ['Only record checkpoint GC completion after success, so failures can retry.', 'Sequential checkpoint writing and GC need independently started timeouts.']
        state = {
            'task': 'Finish this bounded code review. Preserve supported distinct defects and accurately scope their impact. Do not claim whole-repository completeness.',
            'revision': {'base': manifest['base'], 'reversedFix': c['sha']},
            'contracts': contracts,
            'diff': patch,
            'source': snippets,
            'findings': findings,
            'coverage': 'Reconstructed checkpoint from archived postprocessed findings; original final verification explanations withheld. Not an exact original model prompt.',
            'limitations': ['No upstream integration tests have run in this checkpoint.'],
            'availableActions': {
                'verify_existing': 'Check existing findings against the supplied source; correct or limit unsupported claims.',
                'inspect_callers': 'Fetch the predeclared additional source excerpt and inspect the caller/control flow.',
                'investigate_remaining': 'Inspect the current diff and source for distinct unreported contract violations.',
                'finalize': 'Finish with supported findings and explicit scope limits.',
                'manual_review': 'Stop with an unresolved question that requires human intent or unavailable evidence.'
            },
            'roundsUsed': 0,
            'maxRounds': 2,
            'history': []
        }
        (OUT / 'scenarios').mkdir(exist_ok=True)
        (OUT / 'scenarios' / f'{cid}.json').write_text(json.dumps({'state': state, 'additionalSource': extra}, indent=2) + '\n')
        # Save exact source snapshots for evaluator probes, never passed wholesale to either model.
        (OUT / 'fixtures').mkdir(exist_ok=True)
        (OUT / 'fixtures' / f'{cid}.reversed.go.txt').write_text(source)
        (OUT / 'fixtures' / f'{cid}.fixed.go.txt').write_text(git(REPO, 'show', manifest['base'] + ':' + primary))
    finally:
        git(REPO, 'worktree', 'remove', '--force', str(wt))

files = sorted((OUT / 'scenarios').glob('*.json'))
(OUT / 'inputs.sha256.json').write_text(json.dumps({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}, indent=2) + '\n')
print('Frozen:', ', '.join(p.name for p in files))
