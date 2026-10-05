"""Create history-free bare snapshots and isolated worktrees; hold gold tests outside solvers."""
import io,json,os,subprocess,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
STATE=ROOT/'bench/worktrees/astra-mem0-real'
RAW=ROOT/'research/astra-mem0-real/raw'
SOURCE=Path(os.environ['CLICK_REPO'])
TASKS=json.loads((ROOT/'bench/astra-mem0-real/tasks.json').read_text())

def git(*args,cwd=SOURCE,input=None):
 return subprocess.check_output(['git',*args],cwd=cwd,input=input)

STATE.mkdir(parents=True,exist_ok=True);RAW.mkdir(parents=True,exist_ok=True)
for t in TASKS:
 bare=STATE/(t['id']+'.git')
 if not bare.exists():
  subprocess.run(['git','init','--bare','-q',str(bare)],check=True)
  archive=tarfile.open(fileobj=io.BytesIO(git('archive',t['base'])))
  stream=b'commit refs/heads/base\ncommitter Benchmark <benchmark@localhost> 1700000000 +0000\ndata 17\nPre-task snapshot\n'
  for member in archive:
   if not member.isfile() and not member.issym():continue
   content=archive.extractfile(member).read() if member.isfile() else member.linkname.encode()
   mode='120000' if member.issym() else '100755' if member.mode&0o111 else '100644'
   stream+=f'M {mode} inline {json.dumps(member.name)}\ndata {len(content)}\n'.encode()+content+b'\n'
  stream+=b'\ndone\n'
  subprocess.run(['git','fast-import','--quiet'],cwd=bare,input=stream,check=True)
 for arm in ['learn','control','thinker','mem0','verify-base','verify-gold']:
  wt=STATE/(t['id']+'-'+arm)
  if not wt.exists():subprocess.run(['git','worktree','add','-q','--detach',str(wt),'base'],cwd=bare,check=True)
 gold=RAW/(t['id']+'-gold');gold.mkdir(exist_ok=True)
 (gold/'tests.py').write_bytes(git('show',t['fixed']+':'+t['test_file']))
 (gold/'source.patch').write_bytes(git('diff',t['base'],t['fixed'],'--','src'))
 (gold/'tests.patch').write_bytes(git('diff',t['base'],t['fixed'],'--',t['test_file']))
 print(t['id'],git('rev-parse','base',cwd=bare).decode().strip())
