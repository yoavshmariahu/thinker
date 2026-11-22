"""Public-source bounded review tasks, no cache or historical findings served."""
import json,os,hashlib,subprocess,difflib
from pathlib import Path
assert os.environ.get('THINKER_TEST')=='1'
HERE=Path(__file__).resolve().parent
OLD=HERE.parent/'review-loop-round2'
UP=Path('/private/tmp/autoscaler-review')
BASE='40889a675092c0939c59160fc5270273db4e0555'
manifest=json.loads((HERE.parent/'autoscaler-reviews/cases.json').read_text())
def git(*args):return subprocess.check_output(['git','-C',str(UP),*args],text=True)
def save(p,x):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(x,indent=2)+'\n')
for id in ['A-10349','A-10141','A-10178','C-aws-rename']:
 old=json.loads((OLD/'scenarios'/f'{id}.json').read_text())
 s=old['state']; source={}
 if id.startswith('A-'):
  c=next(c for c in manifest['cases'] if c['id']==id)
  for f in c['files']:
   if f.endswith('.go') and not f.endswith('_test.go'):source[f]=git('show',BASE+':'+f)
  # Apply only the public production Go patch in an isolated temporary upstream worktree.
  wt=HERE/'.prep'/id
  subprocess.run(['git','-C',str(UP),'worktree','add','--detach',str(wt),BASE],check=True,capture_output=True)
  try:
   patch=git('diff','--binary',c['parent'],c['sha'])
   subprocess.run(['git','-C',str(wt),'apply','--reverse'],input=patch,text=True,check=True)
   source={f:(wt/f).read_text() for f in source}
  finally:subprocess.run(['git','-C',str(UP),'worktree','remove','--force',str(wt)],check=True)
  if id=='A-10178':
   f='vertical-pod-autoscaler/pkg/recommender/checkpoint/checkpoint_writer.go';source[f]=git('show',BASE+':'+f)
 else:
  f=next(iter(s['source']));source[f]=(OLD/'fixtures/aws-renamed.go.txt').read_text()
 task={
 'task':'Review the supplied Go change for actionable defects. Establish local behavior from source, qualify downstream consequences that lack evidence, and avoid findings on a behavior-preserving change. Stay within the supplied task directory. Do not read external files, use network, edit files, or run tests whose dependencies are unavailable. No historical reports or evaluator tests are supplied.',
 'contracts':s['contracts'],'diff':s['diff'],'source':source,
 'findings':[],'coverage':'No review performed yet.','limitations':['Only the staged source files are available; external implementations and upstream integration tests are not supplied.'],
 'history':[],'roundsUsed':0,'maxRounds':3,
 'availableActions':s['availableActions']}
 save(HERE/'tasks'/f'{id}.json',task)
# Exactly two diagnostic open-loop inputs. No tuning or closed-loop replay of these reports.
raw=json.loads((OLD/'scenarios/A-10178.json').read_text())['state']
save(HERE/'open-inputs/cleanup-original.json',raw)
qualified=json.loads(json.dumps(raw))
qualified['findings'][1]['message']='Writing and garbage collection share the writing deadline. If writing exhausts that deadline, cleanup receives an expired context. Restore independent timeout contexts. Whether deletion actually fails is not established because the concrete deletion client is absent.'
save(HERE/'open-inputs/cleanup-qualified.json',qualified)
save(HERE/'inputs.sha256.json',{str(p.relative_to(HERE)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['tasks','open-inputs'] for p in sorted((HERE/folder).glob('*.json'))})
print('Prepared four grounded tasks and two open-loop diagnostic states.')
