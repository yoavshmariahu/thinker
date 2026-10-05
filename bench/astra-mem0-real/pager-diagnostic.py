"""Balanced post-run diagnostic; never replaces original suite verdicts."""
import json,os,subprocess,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];RAW=ROOT/'research/astra-mem0-real/raw';STATE=ROOT/'bench/worktrees/astra-mem0-real'
arms=['control-score','thinker-score','mem0-score','verify-gold','verify-base'];rows=[]
for repeat in range(10):
 for arm in arms[repeat%5:]+arms[:repeat%5]:
  wt=STATE/('click-3391-'+arm);name=f'pager-{arm}-{repeat}';xml=RAW/(name+'.xml')
  env={**os.environ,'THINKER_TEST':'1','THINKER_TELEMETRY':'off','PYTEST_DISABLE_PLUGIN_AUTOLOAD':'1','PYTHONPATH':str(wt/'src')}
  p=subprocess.run([str(ROOT/'.venv-astra-mem0/bin/python'),'-m','pytest','-q','tests/test_utils.py','-k','echo_via_pager and (test5 or test6)','--junitxml='+str(xml)],cwd=wt,env=env,text=True,capture_output=True,timeout=30)
  (RAW/(name+'.log')).write_text(p.stdout+p.stderr)
  root=ET.parse(xml).getroot();bad=[t.attrib['name'] for t in root.iter('testcase') if t.find('failure') is not None or t.find('error') is not None]
  rows.append({'arm':arm,'repeat':repeat,'exit_code':p.returncode,'failures':bad})
result={'reason':'Investigate original pager-only suite failure without changing original scores. Same tests on every arm and reference, rotating order; no model reruns.','rows':rows,'failed_runs':{a:sum(r['exit_code']!=0 for r in rows if r['arm']==a) for a in arms}}
(RAW/'pager-diagnostic.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result['failed_runs'],indent=2))
