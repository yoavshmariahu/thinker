"""Score patches using immutable upstream tests, never model grading."""
import json,os,shutil,subprocess,sys,time,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];STATE=ROOT/'bench/worktrees/mem0-real';RAW=ROOT/'research/mem0-real-tasks/raw';PY=ROOT/'.venv-mem0/bin/python'
TASKS=json.loads((ROOT/'bench/mem0-real/tasks.json').read_text())
ENV={**os.environ,'THINKER_TELEMETRY':'off','MEM0_TELEMETRY':'false','OTEL_SDK_DISABLED':'true','PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1','THINKER_HOOKS':'off','THINKER_LOG':'off','THINKER_NO_LEARN':'1'}

def verify(task,arm):
 name=task['id']+'-'+arm
 wt=STATE/(name if arm.startswith('verify-') else name+'-score')
 bare=STATE/(task['id']+'.git')
 if not wt.exists():subprocess.run(['git','worktree','add','-q','--detach',str(wt),'base'],cwd=bare,check=True)
 subprocess.run(['git','reset','--hard','-q','base'],cwd=wt,check=True)
 subprocess.run(['git','clean','-fdq'],cwd=wt,check=True)
 gold=RAW/(task['id']+'-gold')
 patch=gold/'source.patch' if arm=='verify-gold' else RAW/(name+'.patch')
 if arm!='verify-base' and patch.exists():subprocess.run(['git','apply',str(patch)],cwd=wt,check=True)
 # Replace this test module with pristine upstream post-fix tests.
 shutil.copyfile(gold/'tests.py',wt/task['test_file'])
 env={**ENV,'PYTHONPATH':str(wt/'src')}
 results={}
 for kind,args in [('acceptance',[task['test_file'],'-k',task['acceptance']]),('suite',['tests'])]:
  xml=RAW/(name+'-'+kind+'.xml');cmd=[str(PY),'-m','pytest','-q',*args,'--junitxml='+str(xml)]
  start=time.perf_counter()
  try:r=subprocess.run(cmd,cwd=wt,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
  except subprocess.TimeoutExpired as e:
   (RAW/(name+'-'+kind+'.log')).write_text(str(e.stdout));results[kind]={'timeout':True};continue
  (RAW/(name+'-'+kind+'.log')).write_text(r.stdout)
  suites=ET.parse(xml).getroot().findall('testsuite')
  counts={k:sum(int(s.attrib.get(k,0)) for s in suites) for k in ['tests','failures','errors','skipped']}
  counts['passed']=counts['tests']-counts['failures']-counts['errors']-counts['skipped']
  results[kind]={'returncode':r.returncode,'wall_s':time.perf_counter()-start,**counts}
 (RAW/(name+'-validation.json')).write_text(json.dumps(results,indent=2));print(name,results,flush=True)

for t in TASKS:
 for arm in (['verify-base','verify-gold'] if sys.argv[1]=='preflight' else ['control','thinker','mem0']):
  if (RAW/(t['id']+'-'+arm+'-validation.json')).exists():continue
  verify(t,arm)
