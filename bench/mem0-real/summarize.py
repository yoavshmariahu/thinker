"""Aggregate frozen solver records and immutable upstream-test verdicts."""
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]; RAW=ROOT/'research/mem0-real-tasks/raw'
KEYS=['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens']
def read(name):return json.loads((RAW/name).read_text())
def counters(u):return {**{k:u[k] for k in KEYS},'total':sum(u[k] for k in KEYS)}
llms=[]
for f in sorted(RAW.glob('llm-*.json')):
 d=read(f.name)
 matches=[t for t in ['click-3364','click-3391'] if (RAW/(t+'-learn-evidence.txt')).read_text() in '\n'.join(m['content'] for m in d['request']['messages'])]
 assert len(matches)==1, (f.name,matches)
 llms.append({'task':matches[0],'source':f.name,'usage':counters(d['response']['usage']),'wall_ms':d['wall_ms'],'modelUsage':d['response']['modelUsage']})
if llms:(RAW/'mem0-model-usage.json').write_text(json.dumps(llms,indent=2)+'\n')
else:llms=read('mem0-model-usage.json')
rows=[];learning=[]
for t in ['click-3364','click-3391']:
 d=read(t+'-learn.json');learning.append({'task':t,'tokens':counters(d['usage']),'wall_ms':d['wall_ms']})
 for arm in ['control','thinker','mem0']:
  name=t+'-'+arm;d=read(name+'.json');row={'task':t,'arm':arm,'solver_tokens':counters(d['usage']),'solver_wall_ms':d['wall_ms'],'tool_calls':d['tools']['calls'],'validation':read(name+'-validation.json')}
  row.update(build_tokens=0,build_wall_ms=0,retrieval_wall_ms=0)
  if arm!='control':
   b=read(name+'-build.json');r=read(name+'-retrieval.json')
   u=counters(b['distilled']['usage']) if arm=='thinker' else next(x['usage'] for x in llms if x['task']==t)
   row.update(build_tokens=u['total'],build_wall_ms=b['wall_ms'],retrieval_wall_ms=r['wall_ms'],memory_tokens=r['estimated_tokens'])
  row['build_solve_tokens']=row['solver_tokens']['total']+row['build_tokens'];rows.append(row)
summary={'token_definition':'Sum of input, cache creation, cache read and output counters; not a billed-money estimate.','rows':rows,'learning':learning,'totals':{}}
for arm in ['control','thinker','mem0']:
 rr=[r for r in rows if r['arm']==arm];summary['totals'][arm]={k:sum(r[k] for r in rr) for k in ['build_tokens','build_solve_tokens','solver_wall_ms','build_wall_ms','retrieval_wall_ms','tool_calls']};summary['totals'][arm]['solver_tokens']=sum(r['solver_tokens']['total'] for r in rr)
(RAW/'summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary['totals'],indent=2))
# A review aid, not an OS sandbox: flag access commands mentioning other arms,
# hidden evidence, home config, history or networking. Complete events remain available.
audit=[]
for f in sorted(RAW.glob('*.events.json')):
 name=f.name.removesuffix('.events.json');own=str(ROOT/'bench/worktrees/mem0-real'/name)
 for e in read(f.name):
  if e['t']!='tool':continue
  inp=e.get('input',{});s=json.dumps(inp)
  s=s.replace(own,'<own>').replace(str(ROOT/'.venv-mem0/bin/python'),'<test-python>')
  hits=re.findall(r'research/|\.thinker/|\.claude/|\.codex/|git (?:show|log|fetch|pull)|\bcurl\b|\bwget\b|bench/worktrees/mem0-real/',s)
  audit.append({'session':name,'tool':e['name'],'flags':hits,'input':inp})
(RAW/'access-audit.json').write_text(json.dumps(audit,indent=2)+'\n');print('Access flags:',[(x['session'],x['flags']) for x in audit if x['flags']])
