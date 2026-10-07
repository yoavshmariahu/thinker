import io,json,os,subprocess,tarfile,shlex
from pathlib import Path
from guardrails import run_dir, checked_execution
assert os.environ.get('THINKER_TEST')=='1'
ROOT=Path(__file__).resolve().parents[2]; OUT=run_dir(); STATE=OUT/'state'; RAW=OUT/'raw'; SOURCE=Path('/Users/yoavshmariahu/src/thinker/bench/repos/click')
checked_execution(OUT)
TASKS=json.loads((OUT/'tasks.json').read_text())
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
 for suffix in ['verify-base','verify-gold']+[f'{m}-{a}' for m in ['opus','sol','gemini'] for a in ['learn','baseline','thinker','baseline-score','thinker-score']]:
  wt=STATE/(t['id']+'-'+suffix)
  if not wt.exists():subprocess.run(['git','worktree','add','-q','--detach',str(wt),'base'],cwd=bare,check=True)
 gold=RAW/(t['id']+'-gold');gold.mkdir(exist_ok=True)
 (gold/'tests.py').write_bytes(git('show',t['fixed']+':'+t['test_file']))
 (gold/'source.patch').write_bytes(git('diff',t['base'],t['fixed'],'--','src'))
 (gold/'LICENSE.txt').write_bytes(git('show',t['fixed']+':LICENSE.txt'))
 print(t['id'],git('rev-parse','base',cwd=bare).decode().strip())

# The helper is created by setup, not by an unrecorded manual shell step.
helper=STATE/'bin'/'thinker_lookup';helper.parent.mkdir(exist_ok=True)
helper.write_text('#!/bin/sh\nexec node '+shlex.quote(str(Path(__file__).resolve().parent/'memory.mjs'))+' lookup "$@"\n')
helper.chmod(0o755)
