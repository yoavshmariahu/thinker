"""Emit tool-input audit for manual review; does not claim OS read isolation."""
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];RAW=ROOT/'research/astra-mem0-real/raw';records=[]
for f in sorted(RAW.glob('*.call.json')):
 d=json.loads(f.read_text())
 for e in d['events']:
  if e.get('type')!='item.completed':continue
  item=e['item'];kind=item.get('type')
  if kind in ['agent_message','reasoning']:continue
  if kind=='command_execution':inp=item.get('command','')
  elif kind=='file_change':inp=json.dumps(item.get('changes',[]))
  else:inp=json.dumps(item)
  cleaned=inp.replace(d['cwd'],'<own>').replace(str(ROOT/'.venv-astra-mem0/bin/python'),'<test-python>')
  flags=re.findall(r'bench/worktrees/astra-mem0-real/|research/astra-mem0|\.thinker/|\.codex/|git (?:show|log|fetch|pull)|\bcurl\b|\bwget\b',cleaned)
  records.append({'call':f.name,'kind':kind,'input':inp,'flags':flags})
(RAW/'access-audit.json').write_text(json.dumps(records,indent=2)+'\n')
print('Audit flags:',[(r['call'],r['flags']) for r in records if r['flags']])
