import json
from pathlib import Path
p=Path(__file__).resolve().parent;tasks=json.loads((p/'tasks.json').read_text())
for m in ['opus','sol','gemini']:
 learn=[];coding=[];scored=[]
 for t in tasks:
  f=p/'raw'/f"{t['id']}-{m}-learn.json"
  if f.exists():learn.append(json.loads(f.read_text()))
  for a in ['baseline','thinker']:
   f=p/'raw'/f"{t['id']}-{m}-{a}.json"
   if f.exists():coding.append(json.loads(f.read_text()))
   f=p/'raw'/f"{t['id']}-{m}-{a}-validation.json"
   if f.exists():scored.append(json.loads(f.read_text()))
 print(m,dict(learning=len(learn),learningValid=sum(r['valid'] for r in learn),coding=len(coding),codingValid=sum(r['valid'] for r in coding),graded=len(scored),acceptancePass=sum(r.get('acceptance',{}).get('returncode')==0 for r in scored)))
