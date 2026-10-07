import json,os,subprocess,sys,time,shutil,xml.etree.ElementTree as ET
from pathlib import Path
assert os.environ.get('THINKER_TEST')=='1'
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'research/performance-canary';STATE=OUT/'state';RAW=OUT/'raw';PY=ROOT/'.venv-perf/bin/python'
TASKS=json.loads((OUT/'tasks.json').read_text())
for t in TASKS:
 arms=['verify-base','verify-gold'] if sys.argv[1]=='preflight' else [f'{m}-{a}' for m in ['opus','sol','gemini'] for a in ['baseline','thinker']]
 for arm in arms:
  name=t['id']+'-'+arm;dest=RAW/(name+'-validation.json')
  if dest.exists():continue
  wt=STATE/(name if arm.startswith('verify-') else name+'-score')
  patch=RAW/(t['id']+'-gold')/'source.patch' if arm=='verify-gold' else RAW/(name+'.patch')
  if arm!='verify-base' and not patch.exists():continue
  subprocess.run(['git','reset','--hard','-q','base'],cwd=wt,check=True);subprocess.run(['git','clean','-fdq'],cwd=wt,check=True)
  if arm!='verify-base' and patch.stat().st_size:subprocess.run(['git','apply',str(patch)],cwd=wt,check=True)
  # Agent tests cannot weaken the untouched upstream test module.
  shutil.copyfile(RAW/(t['id']+'-gold')/'tests.py',wt/t['test_file'])
  env={**os.environ,'PYTHONPATH':str(wt/'src'),'PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1','THINKER_LOG':'local','THINKER_TELEMETRY':'off'}
  result={}
  for kind,args in [('acceptance',[t['test_file'],'-k',t['acceptance']]),('module',[t['test_file']])]:
   xml=RAW/(name+'-'+kind+'.xml');start=time.monotonic()
   try:r=subprocess.run([str(PY),'-m','pytest','-q',*args,'--junitxml='+str(xml)],cwd=wt,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=180)
   except subprocess.TimeoutExpired as e:result[kind]={'timeout':True};continue
   (RAW/(name+'-'+kind+'.log')).write_text(r.stdout)
   suites=ET.parse(xml).getroot().findall('testsuite') if xml.exists() else []
   counts={k:sum(int(s.attrib.get(k,0)) for s in suites) for k in ['tests','failures','errors','skipped']};counts['passed']=counts['tests']-counts['failures']-counts['errors']-counts['skipped']
   result[kind]={'returncode':r.returncode,'wallSeconds':time.monotonic()-start,**counts}
  dest.write_text(json.dumps(result,indent=2)+'\n');print(name,result,flush=True)
