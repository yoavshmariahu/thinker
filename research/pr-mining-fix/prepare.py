"""Restore diagnostic inputs in an isolated worktree. No model or network calls."""
import hashlib,json,os,pathlib,shutil,subprocess,tarfile
assert os.environ.get('THINKER_TEST')=='1'
root=pathlib.Path(__file__).resolve().parents[2]
research=root/'research/pr-mining-fix';inputs=research/'inputs';base=root/'bench/runs/pr-mining-fix'
manifest=json.loads((research/'inputs.json').read_text())
for name,sha in manifest['files'].items():
    assert hashlib.sha256((inputs/name).read_bytes()).hexdigest()==sha,name
base.mkdir(parents=True,exist_ok=True)
for name in ['prs.json','tasks.json']:shutil.copy2(inputs/name,base/name)
shutil.copytree(inputs/'partial-caches',base/'partial-caches',dirs_exist_ok=True)
gitdir=base/'click.git'
if gitdir.exists():raise SystemExit('Use a fresh diagnostic directory; click.git already exists')
subprocess.run(['git','init','--bare',str(gitdir)],check=True,stdout=subprocess.DEVNULL)
stream=bytearray();entries=[]
with tarfile.open(inputs/'click-base.tar.gz') as archive:
    for item in archive:
        if not(item.isfile() or item.issym()):continue
        data=item.linkname.encode() if item.issym() else archive.extractfile(item).read()
        mark=len(entries)+1
        stream.extend(f'blob\nmark :{mark}\ndata {len(data)}\n'.encode()+data+b'\n')
        mode='120000' if item.issym() else '100755' if item.mode&0o111 else '100644'
        entries.append(f'M {mode} :{mark} {json.dumps(item.name)}\n')
message=b'Frozen Click dependency snapshot'
stream.extend(b'commit refs/heads/base\ncommitter Thinker Test <test@thinker.dev> 1 +0000\n'+f'data {len(message)}\n'.encode()+message+b'\n')
stream.extend(''.join(entries).encode()+b'\n')
subprocess.run(['git','--git-dir='+str(gitdir),'fast-import','--quiet'],input=stream,check=True)
actual=subprocess.check_output(['git','--git-dir='+str(gitdir),'rev-parse','base^{tree}'],text=True).strip()
assert actual==manifest['snapshotTree'],(actual,manifest['snapshotTree'])
(research/'raw').mkdir(exist_ok=True)
