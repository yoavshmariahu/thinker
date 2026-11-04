#!/usr/bin/env python3
"""Inline every run's small data file into site/clearing.html, where the page reads `RUN_DATA`.
Run after site-data.py:  site-inline.py site
The session files stay beside the page and are fetched when the Session tab opens."""
import glob, json, os, re, sys
site = sys.argv[1] if len(sys.argv) > 1 else 'site'
runs = {}
for f in sorted(glob.glob(f'{site}/clearing-*.json')):
    if f.endswith('-session.json'): continue
    d = json.load(open(f)); runs[d['id']] = d
p = f'{site}/clearing.html'; s = open(p).read()
new = 'const RUN_DATA = /*RUN_DATA*/' + json.dumps(runs, separators=(',', ':')) + ';'
s, n = re.subn(r'const RUN_DATA = /\*RUN_DATA\*/.*?;\n', new + '\n', s, count=1, flags=re.S)
assert n == 1, 'RUN_DATA marker not found'
open(p, 'w').write(s); print('inlined', list(runs), file=sys.stderr)
