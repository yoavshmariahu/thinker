import json,os,subprocess,sys,time
from pathlib import Path
assert os.environ.get('THINKER_TEST')=='1'
p=Path('research/performance-canary');m=sys.argv[1];tasks=json.loads((p/'tasks.json').read_text());deadline=time.monotonic()+3600
if (p/'STOPPED.json').exists():raise SystemExit('Canary stopped: do not resume the invalid experiment.')
for t in tasks:
 for arm in ['verify-base','verify-gold']:
  v=json.loads((p/'raw'/f"{t['id']}-{arm}-validation.json").read_text());assert v['acceptance']['tests']>0
  assert v['acceptance']['returncode']!=(0 if arm=='verify-base' else 1)
while True:
 files=[p/'raw'/f"{t['id']}-{m}-learn.json" for t in tasks]
 for f in files:
  if f.exists() and not json.loads(f.read_text())['valid']:raise SystemExit('Invalid learning session: '+str(f))
 if all(f.exists() for f in files):break
 if time.monotonic()>deadline:raise SystemExit('Learning not finished within one hour')
 time.sleep(5)
subprocess.run(['node',str(p/'memory.mjs'),'build',m],check=True)
subprocess.run(['python3',str(p/'run.py'),'solve',m],check=True)
