"""Astra counters include cached input already; report correctness independently."""
import json,hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];RAW=ROOT/'research/astra-mem0-real/raw'
def read(name):return json.loads((RAW/name).read_text())
def total(u):return u['input_tokens']+u['output_tokens']
TASKS=['click-3364','click-3391'];calls=[read(f.name) for f in RAW.glob('*.call.json')]
assert calls
for c in calls:
 assert c['model']=='gpt-6-astra' and c['reasoning']=='medium'
 assert c['returncode']==0 and c['usage']
 assert not c['text_only'] or c['tool_calls']==0
 assert not any(e.get('type') in ['turn.failed','error'] for e in c['events'])
rows=[];learning=[]
for t in TASKS:
 d=read(t+'-learn.json');learning.append({'task':t,'tokens':total(d['usage']),'wall_ms':d['wall_ms'],'usage':d['usage']})
 evidence=(RAW/(t+'-learn-evidence.txt')).read_text();sha=hashlib.sha256(evidence.encode()).hexdigest()
 for arm in ['control','thinker','mem0']:
  name=t+'-'+arm;d=read(name+'.json');v=read(name+'-validation.json')
  row={'task':t,'arm':arm,'usage':d['usage'],'solver_tokens':total(d['usage']),'solver_wall_ms':d['wall_ms'],'tool_calls':d['tools'],'validation':v,'build_tokens':0,'build_wall_ms':0,'retrieval_wall_ms':0}
  if arm!='control':
   b=read(name+'-build.json');r=read(name+'-retrieval.json');assert b['evidence_sha256']==sha
   matched=[c for c in calls if c['label']==name+'-build'] if arm=='thinker' else [c for c in calls if c['label']=='mem0-build' and evidence in c['prompt']]
   assert matched,(t,arm)
   row.update(build_tokens=sum(total(u) for c in matched for u in c['usage']),build_wall_ms=b['wall_ms'],build_model_calls=len(matched),retrieval_wall_ms=r['wall_ms'],memory_estimated_tokens=r['estimated_tokens'])
  row['build_solve_tokens']=row['build_tokens']+row['solver_tokens'];rows.append(row)
summary={'model':'gpt-6-astra','reasoning':'medium','token_definition':'input + output; cached_input_tokens is a subset of input, not an extra charge','rows':rows,'learning':learning,'totals':{},'model_audit':{'calls':len(calls),'all_model_reasoning_match':True,'text_only_calls_used_no_tools':True}}
for arm in ['control','thinker','mem0']:
 rr=[r for r in rows if r['arm']==arm]
 summary['totals'][arm]={k:sum(r[k] for r in rr) for k in ['solver_tokens','build_tokens','build_solve_tokens','solver_wall_ms','build_wall_ms','retrieval_wall_ms','tool_calls']}
 summary['totals'][arm]['acceptance_tasks_passed']=sum(r['validation']['acceptance'].get('returncode')==0 for r in rr)
 summary['totals'][arm]['full_suites_passed']=sum(r['validation']['suite'].get('returncode')==0 for r in rr)
(RAW/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary['totals'],indent=2))
