"""Freeze controller fixtures; no note cache is built or served."""
import difflib
import hashlib
import json
import os
from pathlib import Path

assert os.environ.get('THINKER_TEST') == '1'
HERE = Path(__file__).resolve().parent
OLD = HERE.parent / 'review-loop-pilot'
(HERE / 'scenarios').mkdir(parents=True, exist_ok=True)
for cid in ['A-10349', 'A-10141', 'A-10178']:
    raw = (OLD / 'scenarios' / f'{cid}.json').read_bytes()
    (HERE / 'scenarios' / f'{cid}.json').write_bytes(raw)

aws_path = 'cluster-autoscaler/cloudprovider/aws/aws_cloud_provider.go'
source = (OLD / 'fixtures/A-10349.fixed.go.txt').read_text()
start = source.index('func AwsRefFromProviderId')
end = source.index('\n}', start) + 2
old = source[start:end]
new = old.replace('var name string', 'var parsedName string').replace('name = matches', 'parsedName = matches').replace('Name:       name,', 'Name:       parsedName,')
assert new != old and new.count('parsedName') == 4
changed = source[:start] + new + source[end:]
lines = changed.splitlines()
snippet = '\n'.join(f'{i}: {line}' for i, line in enumerate(lines, 1) if 212 <= i <= 251)
patch = ''.join(difflib.unified_diff(source.splitlines(True), changed.splitlines(True), fromfile='a/' + aws_path, tofile='b/' + aws_path, n=5))
control = json.loads((OLD / 'scenarios/A-10349.json').read_text())
s = control['state']
s.update({
    'revision': {'base': '40889a675092c0939c59160fc5270273db4e0555', 'change': 'Local-only identifier rename in the fixed provider-ID parser'},
    'diff': patch,
    'source': {aws_path: snippet},
    'findings': [],
    'coverage': 'Initial review checkpoint; inspect the supplied change against the explicit contracts.',
    'limitations': ['No upstream integration tests are supplied. Review scope is the provided parser and change.'],
})
# The same complete bounded source is available to both arms. No answer label is supplied.
control['additionalSource'] = {aws_path: snippet}
(HERE / 'scenarios/C-aws-rename.json').write_text(json.dumps(control, indent=2) + '\n')
ambiguous = json.loads(json.dumps(control))
ambiguous['state']['contracts'] = [
    'Requirement A: a placeholder instance name beginning with i-placeholder- must retain subsequent slashes and be accepted.',
    'Requirement B: every placeholder instance name containing a slash must be rejected as invalid.',
    'Requirements A and B have equal authority; no precedence, scope exception, or approved resolution has been supplied.',
    'AWS provider IDs must start with aws:/// and preserve the original ProviderID when accepted.'
]
(HERE / 'scenarios/U-conflicting-contracts.json').write_text(json.dumps(ambiguous, indent=2) + '\n')
(HERE / 'fixtures').mkdir(exist_ok=True)
(HERE / 'fixtures/aws-renamed.go.txt').write_text(changed)
(HERE / 'inputs.sha256.json').write_text(json.dumps({p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((HERE / 'scenarios').glob('*.json'))}, indent=2) + '\n')
print('Frozen five scenarios; three inherited byte-for-byte, two new controlled variants.')
