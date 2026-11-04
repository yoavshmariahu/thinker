#!/usr/bin/env python3
"""Inline the run index into site/compression.html, and the default run's data.
Reads site/clearing-runs.json (the manifest: id, label, group, when, default) and every
site/clearing-<id>.json that exists, writes `RUN_INDEX` (one summary per run, in manifest order)
and `RUN_DATA` (the default run only; the page fetches the others on selection).
Run after site-data.py:  site-inline.py site"""
import json, os, re, sys
site = sys.argv[1] if len(sys.argv) > 1 else 'site'
manifest = json.load(open(f'{site}/clearing-runs.json'))
def summary(d):
    P = d['price']; out = {}
    for arm in ('control', 'cut'):
        c = d[arm]['calls']; cold = d['cold'] if arm == 'control' else 0
        tot = lambda k: sum(x[k] for x in c)
        base = tot('input') * P['input'] + tot('out') * P['out'] + tot('read') * P['read']
        out[arm] = dict(calls=len(c), reads=tot('read'), writes=tot('write') + cold, out=tot('out'), max=max(x['read'] + x['write'] + x['input'] for x in c) + (cold if False else 0),
                        cost1h=(base + (tot('input') * (P['w1h'] - P['input']) if d.get('costBounds') else 0) + (tot('write') + cold) * P['w1h']) / 1e6, cost5m=(base + (tot('write') + cold) * P['w5m']) / 1e6, outcome=d[arm].get('outcome'))
    cuts = [x['cut'] for x in d['cut']['calls'] if x.get('cut')]
    out['coldCost'] = {'1h': d['cold'] * P['w1h'] / 1e6, '5m': d['cold'] * P['w5m'] / 1e6}
    out['cuts'] = len(cuts); out['cutTokens'] = sum(x['tokens'] for x in cuts)
    out['refused'] = sum(1 for x in d['cut']['calls'] if x.get('held') and not x.get('cut'))
    out['rereads'] = len([n for n in d['cut']['notes'] if n['kind'] == 'reread'])
    if d.get('savings'): out['savings'] = d['savings']
    return out
assert len({m['group'] for m in manifest}) == len(manifest), 'one example per workload'
index, data, default = [], {}, None
for m in manifest:
    f = f'{site}/clearing-{m["id"]}.json'
    if not os.path.exists(f): raise FileNotFoundError(f)
    d = json.load(open(f)); index.append({**m, 'summary': summary(d)})
    if m.get('default') or default is None: default = m['id']; data = {m['id']: d}
assert default, 'no run data found'
p = f'{site}/compression.html'; s = open(p).read()
for marker, val in (('RUN_INDEX', index), ('RUN_DATA', data)):
    line = 'const ' + marker + ' = /*' + marker + '*/' + json.dumps(val, separators=(',', ':')) + ';\n'
    s, n = re.subn(r'const ' + marker + r' = /\*' + marker + r'\*/.*?;\n', lambda _: line, s, count=1, flags=re.S)
    assert n == 1, marker + ' marker not found'
open(p, 'w').write(s); print('inlined', [r['id'] for r in index], 'default', default, file=sys.stderr)
