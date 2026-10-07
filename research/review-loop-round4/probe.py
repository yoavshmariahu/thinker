"""Exact extracted predicates/branches, not upstream integration tests."""
import json,os,re,subprocess,hashlib
from pathlib import Path
assert os.environ.get('THINKER_TEST')=='1'
H=Path(__file__).resolve().parent;out=H/'results/probes';out.mkdir(parents=True,exist_ok=True)
env={**os.environ,'GOCACHE':str(H.parents[1]/'.round4-go-cache'),'GOPROXY':'off','GOTOOLCHAIN':'local'}
def fn(s,name):a=s.index('func '+name+'(');return s[a:s.index('\n}',a)+2]
rows=[]
for id in ['A-10325','A-10258','A-10094']:
 for variant in ['fixed','reversed']:
  src=json.loads((H/('evaluator/'+id+'.fixed.json' if variant=='fixed' else 'tasks/'+id+'.json')).read_text())
  if variant=='reversed':src=src['source']
  s=next(iter(src.values()))
  if id=='A-10325':
   predicate=re.search(r'if (terminationState.Terminated != nil.*?) \{',s,re.S).group(1)
   program='''package main
import("time";"encoding/json";"os")
type Stamp struct{time.Time}
type Terminated struct{Reason string;StartedAt,FinishedAt Stamp}
func quick(start,finish,now time.Time)bool{
 terminationState:=struct{Terminated *Terminated}{&Terminated{"OOMKilled",Stamp{start},Stamp{finish}}}
 evictOOMThreshold:=10*time.Minute
 _=now
 return '''+predicate+'''
}
func main(){now:=time.Unix(1000000,0);old:=now.Add(-240*time.Hour);recent:=now.Add(-time.Minute);json.NewEncoder(os.Stdout).Encode(map[string]bool{"staleQuickIgnored":!quick(old.Add(-2*time.Minute),old,now),"recentQuickRecognized":quick(recent.Add(-2*time.Minute),recent,now),"longRuntimeIgnored":!quick(recent.Add(-time.Hour),recent,now)})}
'''
  elif id=='A-10258':
   code=fn(s,'extractNodeLabels')+'\n'+fn(s,'setLabelIfNotEmpty');code=code.replace('corev1.Node','Node');code=re.sub(r'corev1\.(Label\w+)',lambda m:'"'+m.group(1)+'"',code)
   program='''package main
import("encoding/json";"os")
type Node struct{Labels map[string]string}
'''+code+'''
func main(){labels:=extractNodeLabels(&Node{map[string]string{"LabelTopologyZone":"zone-a","LabelZoneFailureDomain":"legacy-a"}});json.NewEncoder(os.Stdout).Encode(map[string]bool{"stableZonePreserved":labels["LabelTopologyZone"]=="zone-a","legacyZonePreserved":labels["LabelZoneFailureDomain"]=="legacy-a","nilLabelsAccepted":len(extractNodeLabels(&Node{}))==0})}
'''
  else:
   code=s[s.index('case utils.ResizeStatusError:'):s.index('default:',s.index('case utils.ResizeStatusError:'))];code=code.replace('case utils.ResizeStatusError:','').replace('utils.InPlaceInfeasible','"InPlaceInfeasible"').replace('utils.InPlaceDeferred','"InPlaceDeferred"');code='\n'.join(l for l in code.splitlines() if 'klog.' not in l)
   program='''package main
import("encoding/json";"os")
func reachedResizeErrorBranch()string{
'''+code+'''
}
func main(){json.NewEncoder(os.Stdout).Encode(map[string]bool{"transientErrorDeferred":reachedResizeErrorBranch()=="InPlaceDeferred"})}
'''
  f=out/(id+'.'+variant+'.go');f.write_text(program)
  r=subprocess.run(['go','run',str(f)],cwd=H,env=env,text=True,capture_output=True,timeout=90);assert r.returncode==0,r.stderr
  checks=json.loads(r.stdout);assert all(checks.values())==(variant=='fixed')
  rows.append({'id':id,'variant':variant,'sourceSha256':hashlib.sha256(s.encode()).hexdigest(),'checks':checks})
clean=json.loads((H/'tasks/C-zone-rename.json').read_text())['source'];fixed=json.loads((H/'evaluator/A-10258.fixed.json').read_text());assert next(iter(clean.values())).replace('nodeLabels','m')==next(iter(fixed.values()))
rows.append({'id':'C-zone-rename','identifierOnly':True})
# Execute the actual tiny synthetic functions; withheld from model states.
scope=json.loads((H/'controls/scope-bait.json').read_text())['state']['source']['src/retry.js'];reveal=json.loads((H/'controls/evidence-reveal.json').read_text())['steps'][1]['addSource']['src/client.js']
js=scope.replace('export ','')+'\n'+reveal.replace('export ','')+'''\nconst c=new AbortController();c.abort();const store={deleted:false};const result=remove(c.signal,store);console.log(JSON.stringify({extraRetryAtLimit:shouldRetry(3,3),deletesDespiteAbort:store.deleted&&result==='deleted-despite-cancel'}));'''
r=subprocess.run(['node','--input-type=module','-'],input=js,text=True,capture_output=True,env=env,check=True);checks=json.loads(r.stdout);assert all(checks.values());rows.append({'id':'synthetic-controls','checks':checks})
(out/'results.json').write_text(json.dumps({'scope':'Exact extracted local predicates/branches with stdlib wrappers. Zone constant names mapped to distinct string keys; not Kubernetes integration or whole caller-path verification. Synthetic controls execute their complete supplied functions.','records':rows},indent=2)+'\n')
print(json.dumps(rows,indent=2))
