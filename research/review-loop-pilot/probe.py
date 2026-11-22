"""Execute extracted upstream mechanisms with stdlib-only Go test doubles.

These are focused reproduction checks, not upstream integration tests.
"""
import json
import os
from pathlib import Path
import re
import subprocess

assert os.environ.get('THINKER_TEST') == '1'
HERE = Path(__file__).resolve().parent
OUT = HERE / 'results' / 'probes'
OUT.mkdir(parents=True, exist_ok=True)
CACHE = HERE.parents[1] / '.pilot-go-cache'
env = dict(os.environ, GOCACHE=str(CACHE), GOPROXY='off', GOTOOLCHAIN='local')

def function(source, start):
    a = source.index(start)
    return source[a:source.index('\n}', a) + 2]

records = []
for case in ['A-10349', 'A-10141', 'A-10178']:
    for variant in ['fixed', 'reversed']:
        s = (HERE / 'fixtures' / f'{case}.{variant}.go.txt').read_text()
        if case == 'A-10349':
            regex = next(line for line in s.splitlines() if line.startswith('var validAwsRefIdRegex'))
            f = function(s, 'func AwsRefFromProviderId')
            program = '''package main
import("fmt";"regexp";"strings";"encoding/json";"os")
var _ = strings.Split
const placeholderInstanceNamePrefix = "i-placeholder-"
type AwsInstanceRef struct{ProviderID,Name string}
''' + regex + '\n' + f + '''
func main(){
 id:="aws:///us-east-1a/i-placeholder-some/arbitrary/cluster/local"
 ref,err:=AwsRefFromProviderId(id)
 _,bad:=AwsRefFromProviderId("junkaws:///us-east-1a/i-placeholder-some")
 json.NewEncoder(os.Stdout).Encode(map[string]bool{"slashPreserved":err==nil && ref.Name=="i-placeholder-some/arbitrary/cluster/local","malformedRejected":bad!=nil,"providerIDPreserved":err==nil && ref.ProviderID==id})
}
'''
        elif case == 'A-10141':
            a = s.index('\t\tif ds.Status.')
            m = re.search(r'return int\(ds.Status\.\w+\), nil', s[a:])
            body = s[a:a + m.end()]
            program = '''package main
import("fmt";"encoding/json";"os")
func replicas(desired,ready int)(int,error){
 ds:=struct{Status struct{DesiredNumberScheduled,NumberReady int}}{}
 ds.Status.DesiredNumberScheduled=desired;ds.Status.NumberReady=ready
 creator:=struct{Namespace,Name string}{"test","ds"}
''' + body + '''
}
func main(){a,e:=replicas(5,0);b,f:=replicas(5,2);json.NewEncoder(os.Stdout).Encode(map[string]bool{"zeroReadyReturnsDesired":e==nil&&a==5,"partialReadyReturnsDesired":f==nil&&b==5})}
'''
        else:
            f = function(s, 'func (r *recommender) MaintainCheckpoints')
            returns = 'error' if variant == 'fixed' else ''
            ret = 'return fmt.Errorf("simulated listing failure")' if variant == 'fixed' else ''
            program = '''package main
import("context";"fmt";"time";"encoding/json";"os")
var _ = fmt.Errorf
var klog=struct{ErrorS func(error,string,...interface{})}{func(error,string,...interface{}){}}
type writer struct{}
func(*writer)StoreCheckpoints(ctx context.Context,n int){time.Sleep(5*time.Millisecond)}
type feeder struct{expired bool}
func(f *feeder)GarbageCollectCheckpoints(ctx context.Context) ''' + returns + ''' {f.expired=ctx.Err()!=nil;''' + ret + '''}
type recommender struct{useCheckpoints bool;checkpointWriter *writer;clusterStateFeeder *feeder;updateWorkerCount int;lastCheckpointGC time.Time;checkpointsGCInterval,checkpointsWriteTimeout,checkpointsGCTimeout time.Duration}
''' + f + '''
func main(){
 old:=time.Now().Add(-time.Hour)
 r:=&recommender{true,&writer{},&feeder{},1,old,time.Minute,time.Millisecond,time.Second}
 ctx:=context.Background()
''' + ('''step,cancel:=context.WithDeadline(ctx,time.Now().Add(r.checkpointsWriteTimeout));defer cancel();ctx=step
''' if variant == 'reversed' else '') + '''
 r.MaintainCheckpoints(ctx)
 json.NewEncoder(os.Stdout).Encode(map[string]bool{"failureDoesNotAdvanceCompletion":r.lastCheckpointGC.Equal(old),"gcStartsWithLiveContext":!r.clusterStateFeeder.expired})
}
'''
        p = OUT / f'{case}.{variant}.go'
        p.write_text(program)
        r = subprocess.run(['go', 'run', str(p)], cwd=HERE, env=env, capture_output=True, text=True, timeout=90)
        if r.returncode: raise RuntimeError(r.stderr)
        checks = json.loads(r.stdout)
        record = {'id': case, 'variant': variant, 'checks': checks, 'allChecksPass': all(checks.values())}
        records.append(record)
        print(json.dumps(record))
        assert record['allChecksPass'] == (variant == 'fixed'), record
(OUT / 'results.json').write_text(json.dumps(records, indent=2) + '\n')
