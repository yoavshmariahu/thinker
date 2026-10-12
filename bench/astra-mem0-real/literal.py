"""Literal arm: the same solver protocol as run.py, with the verbatim session chunks as memory; then score with verify.py's method."""
import json,os,subprocess,sys,time,shutil,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];RAW=ROOT/'research/astra-mem0-real/raw';STATE=ROOT/'bench/worktrees/astra-mem0-real';PY=ROOT/'.venv-astra-mem0/bin/python'
TASKS=json.loads((ROOT/'bench/astra-mem0-real/tasks.json').read_text())
ENV={**os.environ,'THINKER_TEST':'1','THINKER_TELEMETRY':'off','THINKER_HOOKS':'off','THINKER_MCP':'off','THINKER_NO_LEARN':'1','THINKER_NO_BG_VERIFY':'1','THINKER_NO_AUTO_UPDATE':'1','THINKER_LOG':'off','PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1'}
ARM='literal'
def solve(task):
 name=task['id']+'-'+ARM;out=RAW/(name+'.json')
 if out.exists():return
 cwd=STATE/name;home=STATE/('home-'+name);home.mkdir(exist_ok=True)
 if not (home/'auth.json').exists():(home/'auth.json').symlink_to(ROOT/'bench/codex-home/auth.json')
 (home/'config.toml').write_text('model_reasoning_effort = "medium"\nproject_doc_max_bytes = 0\n')
 memory=json.loads((RAW/(name+'-retrieval.json')).read_text())['context']
 rules=f'Work only within this repository. Do not access sibling directories, external websites, git remotes or history, reference patches or hidden evaluator tests. Do not install dependencies, create commits, or delegate to other agents. Machine-wide memory hooks are disabled. Resolve any memory file pointers relative to this repository, not the original learning directory. You may use the preinstalled test interpreter {ROOT}/.venv-astra-mem0/bin/python; run tests with PYTHONPATH=src. '
 prompt=rules+'Implement the requested change, add tests where appropriate, and run relevant tests. Leave the patch uncommitted and summarize the result.\n\nMEMORIES FROM EARLIER SESSIONS:\n'+(memory or '(none)')+'\n\nREQUEST:\n'+task['prompt']
 (RAW/(name+'-prompt.txt')).write_text(prompt);start=time.perf_counter();print('START',name,flush=True)
 cmd=[str(ROOT/'bench/astra-mem0-real/codex-wrapper.py'),'exec','--json','--ephemeral','--ignore-rules','--model','gpt-6-astra','--sandbox','workspace-write','--cd',str(cwd),'-']
 env={**ENV,'CODEX_HOME':str(home),'ASTRA_CALL_LABEL':name,'ASTRA_TEXT_ONLY':'0'}
 try:p=subprocess.run(cmd,input=prompt,cwd=cwd,env=env,text=True,capture_output=True,timeout=1200)
 except subprocess.TimeoutExpired:
  (RAW/(name+'-error.json')).write_text(json.dumps({'timeout':True}));raise
 (RAW/(name+'.events.jsonl')).write_text(p.stdout);(RAW/(name+'.stderr')).write_text(p.stderr)
 events=[json.loads(l) for l in p.stdout.splitlines() if l.startswith('{')]
 failures=[e for e in events if e.get('type') in ['turn.failed','error']]
 if p.returncode or failures:raise RuntimeError((name,p.returncode,failures,p.stderr[-1000:]))
 items=[e['item'] for e in events if e.get('type')=='item.completed'];uu=[e['usage'] for e in events if e.get('type')=='turn.completed'];assert uu
 usage={k:sum(u.get(k,0) for u in uu) for k in ['input_tokens','cached_input_tokens','output_tokens']}
 result={'id':name,'model':'gpt-6-astra','reasoning':'medium','wall_ms':(time.perf_counter()-start)*1000,'usage':usage,'tools':len([i for i in items if i.get('type') not in ['agent_message','reasoning']]),'answer':'\n'.join(i['text'] for i in items if i.get('type')=='agent_message')}
 subprocess.run(['git','add','-A'],cwd=cwd,env=env,check=True)
 patch=subprocess.check_output(['git','diff','--cached','--binary','--no-color'],cwd=cwd,env=env)
 (RAW/(name+'.patch')).write_bytes(patch)
 out.write_text(json.dumps(result,indent=2));print('DONE',name,result['wall_ms'],result['usage'],flush=True)
def score(task):
 name=task['id']+'-'+ARM
 if (RAW/(name+'-validation.json')).exists():return
 wt=STATE/(name+'-score');bare=STATE/(task['id']+'.git')
 if not wt.exists():subprocess.run(['git','worktree','add','-q','--detach',str(wt),'base'],cwd=bare,check=True)
 subprocess.run(['git','reset','--hard','-q','base'],cwd=wt,check=True);subprocess.run(['git','clean','-fdq'],cwd=wt,check=True)
 gold=RAW/(task['id']+'-gold');subprocess.run(['git','apply',str(RAW/(name+'.patch'))],cwd=wt,check=True)
 shutil.copyfile(gold/'tests.py',wt/task['test_file'])
 env={**ENV,'PYTHONPATH':str(wt/'src')};results={}
 for kind,args in [('acceptance',[task['test_file'],'-k',task['acceptance']]),('suite',['tests'])]:
  xml=RAW/(name+'-'+kind+'.xml');cmd=[str(PY),'-m','pytest','-q',*args,'--junitxml='+str(xml)];start=time.perf_counter()
  r=subprocess.run(cmd,cwd=wt,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
  (RAW/(name+'-'+kind+'.log')).write_text(r.stdout)
  suites=ET.parse(xml).getroot().findall('testsuite')
  counts={k:sum(int(s.attrib.get(k,0)) for s in suites) for k in ['tests','failures','errors','skipped']}
  counts['passed']=counts['tests']-counts['failures']-counts['errors']-counts['skipped']
  results[kind]={'returncode':r.returncode,'wall_s':time.perf_counter()-start,**counts}
 (RAW/(name+'-validation.json')).write_text(json.dumps(results,indent=2));print(name,results,flush=True)
for t in TASKS:
 if sys.argv[1]=='solve':solve(t)
 else:score(t)
