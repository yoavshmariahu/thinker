"""Focused mechanism probes of actual pinned/reversed source, not full upstream tests.
Dependencies: locally installed numpy/pandas and Node; no package installation.
Python AST methods are extracted without importing entire projects. JS snippets
are extracted with type annotations removed; test doubles isolate the mechanism.
"""
import ast, functools, gc, hashlib, inspect, json, os, pathlib, re, secrets, subprocess, tempfile, types, weakref
assert os.environ.get('THINKER_TEST') == '1'
ROOT=pathlib.Path(__file__).resolve().parent
REPOS={'grafana':pathlib.Path('/Users/yoavshmariahu/src/thinker/bench/repos/grafana'),'posthog':pathlib.Path('/Users/yoavshmariahu/src/thinker/bench/repos/posthog'),'pandas':pathlib.Path('bench/suite-repos/pandas').resolve(),'sklearn':pathlib.Path('bench/suite-repos/scikit-learn').resolve(),'pydantic':pathlib.Path('bench/suite-repos/pydantic').resolve()}
def git(repo,*args): return subprocess.check_output(['git',*args],cwd=repo)
def sources(name,pr,file):
 m=json.loads((ROOT/name/'cases.json').read_text()); c=next(c for c in m['cases'] if c['pr']==pr)
 fixed=git(REPOS[name],'show',m['base']+':'+file)
 patch=git(REPOS[name],'diff',c['parent'],c['sha'],'--',file)
 with tempfile.TemporaryDirectory(dir=ROOT) as d:
  subprocess.run(['git','init','-q',d],check=True)
  p=pathlib.Path(d)/file;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(fixed)
  subprocess.run(['git','apply','--reverse','-'],cwd=d,input=patch,check=True)
  broken=p.read_bytes()
 return c,{'fixed':fixed.decode(),'reversed':broken.decode()}
def function(src,name,env,cls=None):
 tree=ast.parse(src)
 nodes=tree.body if cls is None else next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name==cls).body
 f=next(n for n in nodes if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name)
 f.decorator_list=[];f.returns=None
 for a in [*f.args.posonlyargs,*f.args.args,*f.args.kwonlyargs,f.args.vararg,f.args.kwarg]:
  if a:a.annotation=None
 exec(compile(ast.fix_missing_locations(ast.Module(body=[f],type_ignores=[])),'<extracted upstream function>','exec'),env)
 return env[name]
results=[]
def probe(name,pr,file,check):
 c,ss=sources(name,pr,file);row={'id':c['id'],'file':file,'kind':'isolated source mechanism probe','sourceSha256':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in ss.items()}}
 for arm,src in ss.items():
  try: detail=check(src);row[arm]={'pass':True,'detail':detail}
  except Exception as e:row[arm]={'pass':False,'detail':type(e).__name__+': '+str(e)}
 row['reproduced']=row['fixed']['pass'] and not row['reversed']['pass']
 if not row['reproduced']:row['limitation']='Local dependency differs from pinned repository; this probe does not validate the regression.'
 if name=='pandas' and pr==69446:
  m=json.loads((ROOT/'pandas'/'cases.json').read_text());file='pandas/core/indexes/base.py'
  extra=git(REPOS['pandas'],'show',m['base']+':'+file)
  row['additionalPinnedSource']={'file':file,'base':m['base'],'sha256':hashlib.sha256(extra).hexdigest(),'function':'Index.take'}
 results.append(row);print(json.dumps(row),flush=True)
def secret(src):
 class Secret:
  def __init__(self,v):self.v=v
  def get_secret_value(self):return self.v
 Secret.__eq__=function(src,'__eq__',{'secrets':secrets},'SecretStr')
 for value in ['ascii','caf\u00e9','\ud800']:
  assert Secret(value)==Secret(value)
 return 'ASCII, non-ASCII and lone-surrogate equality succeed'
probe('pydantic',13537,'pydantic/types.py',secret)
def callback(src):
 cache=functools.lru_cache()(inspect.signature)
 f=function(src,'_call_hooks',{'_cached_signature':cache},'CallbackContext')
 class Callback:
  def on_end(self,estimator,context):return False
 cb=Callback();ref=weakref.ref(cb);ctx=types.SimpleNamespace(_callbacks=[cb])
 assert f(ctx,None,'on_end') is False
 del cb,ctx;gc.collect();assert ref() is None,'signature cache retains callback instance'
 return 'callback is collectible after context release'
probe('sklearn',34837,'sklearn/callback/_callback_context.py',callback)
def hashing(src):
 import numpy as np
 from pandas._libs.hashing import hash_object_array
 f=function(src,'_hash_ndarray',{'np':np,'hash_object_array':hash_object_array,'_default_hash_key':'0123456789123456'})
 result=f(np.array([b'\xff',1],dtype=object),categorize=False)
 assert result.shape==(2,) and result.dtype==np.uint64
 return 'mixed non-ASCII bytes and integer hash successfully'
probe('pandas',70493,'pandas/core/util/hashing.py',hashing)
def excel(src):
 import pandas as pd
 line=next(l.strip() for l in src.splitlines() if 'values = levels.take(level_codes' in l)
 # The installed pandas 2.x Index.take has older fill semantics. Execute the
 # actual pinned upstream Index.take as well, against a real numeric Index.
 m=json.loads((ROOT/'pandas'/'cases.json').read_text())
 take_source=git(REPOS['pandas'],'show',m['base']+':pandas/core/indexes/base.py').decode()
 take_env=dict(pd.Index.take.__globals__)
 from pandas._libs.lib import no_default
 take_env['no_default']=no_default
 take=function(take_source,'take',take_env,'Index')
 index=pd.Index([1.,2.])
 env={'levels':types.SimpleNamespace(take=lambda *a,**kw:take(index,*a,**kw)),'level_codes':[0,-1]};exec(line,env)
 assert pd.isna(env['values'][1]),'missing label wraps to last level value'
 return 'missing MultiIndex code -1 becomes NaN; also executes pinned upstream Index.take, since installed pandas 2.x has older semantics'
probe('pandas',69446,'pandas/io/formats/excel.py',excel)
def node(script,timeout=5):
 r=subprocess.run(['node','-e',script],capture_output=True,text=True,timeout=timeout)
 assert r.returncode==0,r.stderr[-500:]
 return r.stdout.strip()
def regex(src):
 literal=re.search(r"'log-token-key': (/.+/[a-z]+),",src).group(1)
 # Long identifier without '=': only one boundary is a viable start in fixed pattern.
 return node(f"const r={literal};const t=performance.now();if(r.test('a'.repeat(100000)))throw Error('unexpected match');console.log(performance.now()-t)",timeout=2)
probe('grafana',132860,'public/app/features/logs/components/panel/grammar.ts',regex)
def merge(src):
 value=re.search(r'value: (buildPersonPropertyMergeValue\(property.name\)|`\{\{person.properties.*?`),',src).group(1)
 prefix=''
 if 'buildPersonPropertyMergeValue' in value:
  prefix=re.search(r'const BARE_IDENTIFIER_REGEX = .*?\n\}',src,re.S).group(0).replace('export function','function').replace('name: string','name').replace('): string',')')
 return node(prefix+'\n'+f"const property={{name:'full name'}};const value={value};if(value.includes('\"'))throw Error('double quote truncates href attribute');console.log(value)")
probe('posthog',91352,'frontend/src/scenes/hog-functions/email-templater/emailTemplaterLogic.tsx',merge)
import numpy,pandas,platform
out={'environment':{'python':platform.python_version(),'numpy':numpy.__version__,'pandas':pandas.__version__,'node':subprocess.check_output(['node','--version'],text=True).strip()},'limitation':'Extracted actual pinned/reversed source with dependencies or test doubles; not full project or upstream integration tests. Grafana uses a two-second performance budget.','results':results}
(ROOT/'reproductions.json').write_text(json.dumps(out,indent=2)+'\n')
