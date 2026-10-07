import io,json,os,subprocess,tarfile
from pathlib import Path
from guardrails import run_dir, checked_execution, cohorts, cohorts
assert os.environ.get('THINKER_TEST')=='1'
ROOT=Path(__file__).resolve().parents[2]; OUT=run_dir(); STATE=OUT/'state'; RAW=OUT/'raw'; SOURCE=Path(os.environ.get('THINKER_BENCH_SOURCE','')).expanduser()
EXECUTION=checked_execution(OUT)
if not SOURCE.is_dir():raise SystemExit('Set THINKER_BENCH_SOURCE to the read-only upstream clone')
TASKS=json.loads((OUT/'tasks.json').read_text());COHORTS=list(cohorts(OUT));COHORTS=list(cohorts(OUT))
def git(*args,cwd=SOURCE):return subprocess.check_output(['git',*args],cwd=cwd)
STATE.mkdir(exist_ok=True);RAW.mkdir(exist_ok=True)
for t in TASKS:
 bare=STATE/(t['id']+'.git')
 if not bare.exists():
  subprocess.run(['git','init','--bare','-q',str(bare)],check=True)
  archive=tarfile.open(fileobj=io.BytesIO(git('archive',t['base'])))
  stream=b'commit refs/heads/base\ncommitter Benchmark <benchmark@localhost> 1700000000 +0000\ndata 17\nPre-task snapshot\n'
  for m in archive:
   if not m.isfile() and not m.issym():continue
   data=archive.extractfile(m).read() if m.isfile() else m.linkname.encode();mode='120000' if m.issym() else '100755' if m.mode&0o111 else '100644'
   stream+=f'M {mode} inline {json.dumps(m.name)}\ndata {len(data)}\n'.encode()+data+b'\n'
  subprocess.run(['git','fast-import','--quiet'],cwd=bare,input=stream+b'\ndone\n',check=True)
 # Only the cohorts this run froze get checkouts; a dropped cohort leaves no stray worktree.
 for suffix in ['verify-base','verify-gold']+[f'{m}-{a}' for m in COHORTS for a in ['pr-cache','baseline','thinker','baseline-score','thinker-score']]:
  wt=STATE/(t['id']+'-'+suffix)
  if not wt.exists():subprocess.run(['git','worktree','add','-q','--detach',str(wt),'base'],cwd=bare,check=True)
 gold=RAW/(t['id']+'-gold');gold.mkdir(exist_ok=True)
 (gold/'tests.py').write_bytes(git('show',t['fixed']+':'+t['test_file']))
 (gold/'source.patch').write_bytes(git('diff',t['base'],t['fixed'],'--','src'))
 (gold/'LICENSE.txt').write_bytes(git('show',t['fixed']+':LICENSE.txt'))
 print(t['id'],git('rev-parse','base',cwd=bare).decode().strip())

# Live wiring gives the arm the product's own `lookup` over MCP, so the shell helper that the pasted
# retrieval needed is gone: leaving it in the agent's PATH would offer a route nothing describes.
(STATE/'bin').mkdir(exist_ok=True)
