"""Run existing upstream test files at fixed base and with production-only reversions.
Tests stay fixed for this validation; paired reviews use the complete reverse diff.
"""
import json, os, pathlib, subprocess, sys
if os.environ.get('THINKER_TEST') != '1': raise RuntimeError('THINKER_TEST=1 required')
repo=pathlib.Path(sys.argv[1]).resolve(); python=os.path.abspath(sys.argv[2])
root=pathlib.Path(__file__).resolve().parent
manifest=json.loads((root/'cases.json').read_text()); rows=[]
out=root/'reproductions';out.mkdir(exist_ok=True)
def git(args,cwd=repo,input=None):
 return subprocess.check_output(['git',*args],cwd=cwd,input=input,stderr=subprocess.PIPE)
for c in manifest['cases']:
 tests=[p for p in c['files'] if p.startswith('test/') and p.endswith('.py')]
 if not tests:
  rows.append({'id':c['id'],'status':'not-run','reason':'No upstream test file changed in the historical fix.'});continue
 wt=repo.parent/f"reproduce-{c['id']}"
 row={'id':c['id'],'tests':tests}
 try:
  git(['worktree','add','--detach',str(wt),manifest['base']])
  for arm in ['fixed','regressed']:
   if arm=='regressed':git(['apply','--reverse','-'],wt,git(['diff',c['parent'],c['sha'],'--',*c['production']]))
   env={**os.environ,'PYTHONPATH':str(wt)}
   run=subprocess.run([python,'-m','pytest','-q','--color=no','--timeout=30',*tests],cwd=wt,env=env,capture_output=True,text=True,timeout=180)
   (out/f"{c['id']}-{arm}.txt").write_text(run.stdout+run.stderr)
   row[arm]={'returncode':run.returncode,'summary':'\n'.join((run.stdout+run.stderr).splitlines()[-8:])}
  row['status']='reproduced' if row['fixed']['returncode']==0 and row['regressed']['returncode']==1 else 'unconfirmed'
 except Exception as e:row['error']=str(e)
 finally:
  try:git(['worktree','remove','--force',str(wt)])
  except Exception:pass
 rows.append(row);(out/'results.json').write_text(json.dumps(rows,indent=2)+'\n');print(c['id'],row.get('status'),flush=True)
(out/'results.json').write_text(json.dumps(rows,indent=2)+'\n')
